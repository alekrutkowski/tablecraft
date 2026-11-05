/**
 * Small, side-effect-free helpers for R diagnostics.
 * preflight() is deliberately advisory; webR's R parser is authoritative.
 * String syntax: https://stat.ethz.ch/R-manual/R-devel/library/base/html/Quotes.html
 */

const pairs = { '(': ')', '[': ']', '{': '}' };
const closing = new Set(Object.values(pairs));
const identifierCharacter = /[\p{L}\p{N}._]/u;

/** Return 1-based locations for simple incomplete-edit warnings in linear time. */
export function preflight(code) {
  const source = String(code ?? '');
  const issues = [], stack = [];
  let i = 0, line = 1, column = 1;
  let comment = false, quoted = null, raw = null, pendingPipe = null;
  const rawStart = /[rR](["'])(-*)([([{])/y;

  const position = () => ({ line, column });
  const advance = (count = 1) => {
    const stop = i + count;
    while (i < stop) {
      if (source[i] === '\n') { line += 1; column = 1; }
      else column += 1;
      i += 1;
    }
  };
  const warn = (message, at, tip) => {
    if (issues.length < 6) issues.push({ severity: 'warning', message, ...at, tip });
  };
  const missingRightSide = () => {
    if (!pendingPipe) return;
    warn('The pipe needs another step.', pendingPipe,
      'Add an expression after %>%, such as .[units > 0], or remove the trailing pipe.');
    pendingPipe = null;
  };

  while (i < source.length) {
    const char = source[i];
    if (comment) {
      if (char === '\n') comment = false;
      advance();
      continue;
    }
    if (raw) {
      if (source.startsWith(raw.end, i)) {
        advance(raw.end.length);
        raw = null;
      } else advance();
      continue;
    }
    if (quoted) {
      if (char === '\\') advance(Math.min(2, source.length - i));
      else {
        if (char === quoted.mark) quoted = null;
        advance();
      }
      continue;
    }
    if (/\s/.test(char)) { advance(); continue; }
    if (char === '#') { comment = true; advance(); continue; }

    if ((char === 'r' || char === 'R') && !identifierCharacter.test(source[i - 1] || '')) {
      rawStart.lastIndex = i;
      const match = rawStart.exec(source);
      if (match) {
        raw = { end: pairs[match[3]] + match[2] + match[1], ...position() };
        pendingPipe = null;
        advance(match[0].length);
        continue;
      }
    }
    if (char === '"' || char === "'" || char === '`') {
      quoted = { mark: char, ...position() };
      pendingPipe = null;
      advance();
      continue;
    }
    if (char === '%') {
      // Ignore special-operator contents, which can contain bracket characters.
      let end = i + 1;
      while (end < source.length && source[end] !== '%' && source[end] !== '\n') end += 1;
      if (source[end] === '%') {
        const operator = source.slice(i, end + 1);
        if (operator === '%>%') {
          missingRightSide();
          pendingPipe = position();
        } else pendingPipe = null;
        advance(end - i + 1);
        continue;
      }
    }
    if (closing.has(char) || char === ',' || char === ';') missingRightSide();
    else pendingPipe = null;

    if (pairs[char]) stack.push({ mark: char, ...position() });
    else if (closing.has(char)) {
      const open = stack.at(-1);
      if (!open) {
        warn(`This ${char} has no opening delimiter.`, position(),
          'Remove the extra closing delimiter, or add the missing opening delimiter.');
      } else if (pairs[open.mark] === char) stack.pop();
      else {
        warn(`Expected ${pairs[open.mark]} before this ${char}.`, position(),
          `Check the ${open.mark} opened on line ${open.line}. Parentheses, brackets, and braces must close in order.`);
        // Recover at the nearest matching opener instead of cascading warnings.
        const matched = stack.findLastIndex(item => pairs[item.mark] === char);
        if (matched >= 0) stack.splice(matched);
      }
    }
    advance();
  }

  if (raw) warn('This raw string is not closed.', { line: raw.line, column: raw.column },
    `Add ${raw.end} to close the raw string. Its closing delimiter must match its opening delimiter.`);
  else if (quoted) warn(quoted.mark === '`' ? 'This quoted column name is not closed.' : 'This quoted string is not closed.',
    { line: quoted.line, column: quoted.column },
    `Add a matching ${quoted.mark}. Escape a literal quote inside the text with a backslash.`);
  else {
    missingRightSide();
    const open = stack.at(-1);
    if (open) warn(`This ${open.mark} still needs a closing ${pairs[open.mark]}.`,
      { line: open.line, column: open.column },
      `Close the expression with ${pairs[open.mark]}. R will check the full syntax when ready.`);
  }
  return issues;
}

function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(
      current[j - 1] + 1, previous[j] + 1,
      previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}

const quotedName = name => '`' + name.replace(/`/g, '\\`') + '`';

function nearestColumns(name, columns) {
  if (!name || name.length > 128) return [];
  const threshold = name.length <= 2 ? 0 : Math.min(3, Math.max(1, Math.floor(name.length / 3)));
  return [...new Set(columns.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean))]
    .filter(candidate => candidate !== name && candidate.length <= 128 && Math.abs(candidate.length - name.length) <= threshold)
    .map(candidate => ({ name: candidate, score: distance(name.toLowerCase(), candidate.toLowerCase()) }))
    .filter(candidate => candidate.score <= threshold)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 2).map(candidate => candidate.name);
}

function missingName(message) {
  const patterns = [
    /object\s+['"`‘“]([^'"`’”]+)['"`’”]\s+not found/i,
    /column(?:\(s\)|s)?\s+['"`‘“]([^'"`’”]+)['"`’”]\s+(?:not found|does not exist|is not|not present)/i,
    /\.SDcols\s+is\s+['"`‘“]([^'"`’”]+)['"`’”]/i,
    /(?:column(?:\(s\)|s)? not found|columns? are not in the data\.table|not column names|non-existing columns?)\s*:?\s*\[?\s*['"`‘“]?([^'"`’”,\]\n]+)/i,
  ];
  return patterns.map(pattern => message.match(pattern)?.[1]?.trim()).find(Boolean) || null;
}

/** Keep the original R message; add an approachable explanation and next step. */
export function explainError(message, { columns = [], line = null, stepLabel = null } = {}) {
  const original = String(message?.message ?? message ?? '').trim() || 'R could not finish this transformation.';
  const foundLine = original.match(/(?:<text>|[^\s:]+\.R):(\d+):\d+/i)?.[1]
    || original.match(/\bat line\s+(\d+)\b/i)?.[1];
  const lineNumber = Number(line ?? foundLine);
  let title = 'R could not run this step';
  let tip = 'Check the highlighted line and the column names after the previous step. Run a shorter pipeline to locate the first failing transformation.';
  const name = missingName(original);

  if (/there is no package called|package\s+['"‘“][^'"’”]+['"’”].*(?:not installed|not found|not available)/i.test(original)) {
    title = 'A required package is unavailable';
    tip = 'Check the package name and your connection. This browser needs webR-compatible package builds; retry or restart R to reload the app\'s standard packages.';
  } else if (/could not find function/i.test(original)) {
    const fn = original.match(/could not find function\s+['"`‘“]([^'"`’”]+)/i)?.[1];
    title = 'R cannot find this function';
    tip = fn === '%>%'
      ? 'Add library(magrittr) before the pipeline so R knows the %>% operator.'
      : ['fread', 'fwrite', 'melt', 'dcast', 'fifelse', 'fcase', 'fcoalesce', 'shift', 'rleid', ':='].includes(fn)
        ? 'Add library(data.table) before the pipeline and check that R finished initializing.'
        : 'Check the function\'s spelling and load its package before using it. Additional packages need a compatible webR build.';
  } else if (/cannot allocate|out of memory|memory access out of bounds|array buffer allocation failed/i.test(original)) {
    title = 'The calculation reached a memory limit';
    tip = 'Try fewer input rows or columns, and check whether a join or reshape greatly expands the table. Pause Live preview and restart R to release the current session.';
  } else if (/cannot open.*(?:file|connection)|no such file or directory|file.*(?:does not exist|not found)/i.test(original)) {
    title = 'The input file is unavailable';
    tip = 'Import the file again in this browser session and check its filename in the script. Saved recipes contain file metadata, not the input file bytes.';
  } else if (/incompatible join types|join.*incompatible.*type|types.*incompatible.*join/i.test(original)) {
    title = 'The join columns have different types';
    tip = 'Convert both key columns to the same type before joining, such as character or integer. Check that the selected keys correspond to each other.';
  } else if (/allow\.cartesian|join results in\s+\d+\s+rows|cartesian product.*join/i.test(original)) {
    title = 'The join creates many matching rows';
    tip = 'Several rows match the same key on both sides. Check for duplicates or aggregate first; allow a Cartesian join only when those extra matches are intended.';
  } else if (/when i is a data\.table|must (?:be )?specif(?:y|ied).*on=|columns to join by must|must specify.*on\b/i.test(original)) {
    title = 'Choose the join keys';
    tip = 'Set the matching columns in the join step, or use on = .(id). For different names use on = .(left_id = right_id).';
  } else if (/check that is\.data\.table|:=.*(?:defined for use in j|only defined|outside|must be used)/i.test(original)) {
    title = 'Assignment needs a data.table';
    tip = 'Use := inside the second part of a data.table call, for example .[, new_column := expression]. Keep a data.table on the left of the pipe.';
  } else if (/fun\.aggregate.*(?:length|single|scalar)|aggregating function.*(?:length|single value)/i.test(original)) {
    title = 'The aggregation must return one value';
    tip = 'Choose a function such as sum, mean, or length that returns one value for each output cell.';
  } else if (/aggregation function missing|fun\.aggregate.*(?:missing|needed)|dcast.*(?:duplicate|unique)|formula.*(?:single observation|not.*unique)/i.test(original)) {
    title = 'Several rows map to the same output cell';
    tip = 'Choose an aggregation such as sum or mean, or add identifier columns to the dcast formula so each output cell has one value.';
  } else if (/invalid ['"]?type['"]?\s*\([^)]*\)\s*of argument|non-numeric argument|argument is not numeric|must be (?:a )?(?:numeric|integer)|not meaningful for factors/i.test(original)) {
    title = 'This calculation needs numeric values';
    tip = 'Check the column type. Clean text before converting it to numbers; for factors, convert through as.character first. Missing values may also need na.rm = TRUE.';
  } else if (name) {
    const nearest = nearestColumns(name, Array.isArray(columns) ? columns : []);
    title = `R cannot find ${quotedName(name)}`;
    tip = nearest.length
      ? `Did you mean ${nearest.map(quotedName).join(' or ')}? Names are case-sensitive. Check whether an earlier step renamed or removed the column.`
      : 'Check spelling and capitalization. A column may have been renamed or removed earlier; text values need quotes and names with spaces need backticks.';
    if (/\.SDcols/i.test(original)) tip += ' Supply .SDcols as a character vector of existing column names.';
  } else if (/\.SDcols.*(?:missing|invalid|not|column|which)|(?:missing|invalid).*\.SDcols/i.test(original)) {
    title = 'Check the selected columns';
    tip = 'Supply existing names in .SDcols, for example .SDcols = c("x", "y"). Check for columns renamed or removed earlier in the pipeline.';
  } else if (/unexpected end of input|incomplete (?:expression|string)|unexpected INCOMPLETE_STRING/i.test(original)) {
    title = 'The R expression is unfinished';
    tip = 'Close any open quotes, parentheses, brackets, or braces. A trailing %>% also needs another operation.';
  } else if (/unexpected symbol|unexpected string constant/i.test(original)) {
    title = 'R expected a separator or operator';
    tip = 'Look just before the highlighted word for a missing comma or operator. Put names containing spaces in backticks and text values in quotes.';
  } else if (/unexpected.*["']=["']/i.test(original)) {
    title = 'Check how this equals sign is used';
    tip = 'Use == for a comparison, such as region == "North". Use := to update a data.table column and commas to separate arguments.';
  } else if (/unexpected|unrecognized escape|nul character/i.test(original)) {
    title = 'Check this R syntax';
    tip = /escape|backslash/i.test(original)
      ? 'Use forward slashes in file paths, or escape each backslash with another backslash. Check the surrounding quotes.'
      : 'Check the highlighted position and the character just before it for an extra delimiter, missing comma, or unclosed quote.';
  } else if (/formula.*(?:must|invalid)|invalid.*formula/i.test(original)) {
    title = 'Check the reshape formula';
    tip = 'For dcast, use a formula such as id ~ category. Join several identifiers with + and set value.var to the column containing the values.';
  } else if (/supplied \d+ items.*assigned to|replacement.*length|RHS.*length|number of items.*replace/i.test(original)) {
    title = 'The number of values does not match the rows';
    tip = 'Return one value to repeat for the selected rows, or one value per selected row. With grouping, check the size within each group using .N.';
  } else if (/final (?:expression|result).*(?:data\.table|data\.frame|table)|result must.*(?:data\.table|data\.frame|table)/i.test(original)) {
    title = 'Finish with a table';
    tip = 'Return a data.table or data.frame as the final expression. Wrap a scalar summary in .(), for example .[, .(total = sum(value))].';
  }

  return {
    title: stepLabel ? `${title} · ${String(stepLabel).slice(0, 80)}` : title,
    message: original,
    tip,
    ...(Number.isInteger(lineNumber) && lineNumber > 0 ? { line: lineNumber } : {}),
    severity: 'error',
  };
}
