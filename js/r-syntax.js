/**
 * Small lexical helpers for editing R without evaluating it. This is deliberately
 * not an R interpreter. Unknown constructs remain editable as their original R.
 */
const identifierStart = /[\p{L}._]/u;
// R's accepted non-ASCII continuation characters vary with LC_CTYPE. Name
// generation is more conservative; token discovery also recognizes Unicode Nd.
const identifierPart = /[\p{L}\p{Nd}._]/u;
const opening = new Set(['(', '[', '{']);
const closing = new Set([')', ']', '}']);
const expectedClose = {'(': ')', '[': ']', '{': '}'};
const binary = new Set(['<-', '<<-', '->', '->>', '=', ':=', '+', '-', '*', '/', '^', '**', ':', '~', '>', '<', '>=', '<=', '==', '!=', '&', '&&', '|', '||', '|>', '?']);

export function decodeRLiteral(value) {
  const text = String(value ?? '');
  if (!/^['"`]/.test(text) || text.at(-1) !== text[0]) return text;
  return text.slice(1, -1).replace(/\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|U([\da-fA-F]{8})|x([\da-fA-F]{1,2})|([0-7]{1,3})|([\s\S]))/g,
    (_, braced, short, long, hex, octal, escaped) => {
      if (braced || short || long || hex) {
        const point = parseInt(braced || short || long || hex, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : _;
      }
      if (octal) return String.fromCharCode(parseInt(octal, 8));
      return ({a:'\x07', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t', v:'\v'})[escaped] ?? escaped;
    });
}

/** Tokens retain byte-for-byte source slices, including strings and comments. */
export function tokenizeR(code) {
  const source = String(code ?? '');
  const tokens = [];
  let i = 0;
  const add = (type, start, end, extra = {}) => tokens.push({type, value:source.slice(start, end), start, end, ...extra});
  while (i < source.length) {
    const start = i, c = String.fromCodePoint(source.codePointAt(i));
    if (/\s/.test(c)) {
      while (i < source.length && /\s/.test(source[i])) i += 1;
      add('space', start, i); continue;
    }
    if (c === '#') {
      while (i < source.length && !['\r', '\n'].includes(source[i])) i += 1;
      add('comment', start, i); continue;
    }
    // R raw strings can use (), [] or {} delimiters and optional hyphens.
    const raw = /^[rR](["'])(-*)([([{])/.exec(source.slice(i));
    if (raw) {
      const terminator = expectedClose[raw[3]] + raw[2] + raw[1];
      const at = source.indexOf(terminator, i + raw[0].length);
      i = at < 0 ? source.length : at + terminator.length;
      add('string', start, i, {closed:at >= 0, raw:true}); continue;
    }
    if (['"', "'", '`'].includes(c)) {
      i += 1;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += Math.min(2, source.length - i); continue; }
        if (source[i++] === c) { closed = true; break; }
      }
      add(c === '`' ? 'name' : 'string', start, i, {closed, ...(c === '`' ? {name:decodeRLiteral(source.slice(start, i))} : {})});
      continue;
    }
    if (c === '%') {
      const end = source.indexOf('%', i + 1);
      if (end >= 0 && !/[\r\n]/.test(source.slice(i, end))) {
        i = end + 1; add('operator', start, i); continue;
      }
    }
    const numeric = /^(?:0[xX][\da-fA-F]+(?:\.[\da-fA-F]*)?(?:[pP][+-]?\d+)?|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)[Li]?/.exec(source.slice(i));
    if (numeric) { i += numeric[0].length; add('number', start, i); continue; }
    if (identifierStart.test(c)) {
      i += c.length;
      while (i < source.length) {
        const character = String.fromCodePoint(source.codePointAt(i));
        if (!identifierPart.test(character)) break;
        i += character.length;
      }
      add('name', start, i, {name:source.slice(start, i)}); continue;
    }
    const operator = /^(?:<<-|->>|:::|<-|->|::|:=|>=|<=|==|!=|&&|\|\||\|>|\*\*)/.exec(source.slice(i));
    if (operator) { i += operator[0].length; add('operator', start, i); continue; }
    i += c.length;
    add(opening.has(c) ? 'open' : closing.has(c) ? 'close' : ',;'.includes(c) ? 'separator' : 'operator', start, i);
  }
  return tokens;
}

export const significantTokens = code => tokenizeR(code).filter(token => !['space', 'comment'].includes(token.type));
export const referencedNames = code => [...new Set(tokenizeR(code).filter(token => token.type === 'name').map(token => token.name))];
export const normalizedR = code => significantTokens(code).map(token => token.value).join('\u0001');

/**
 * Remove only lexical R comments. Preserve every other source character,
 * including line endings: newlines can terminate R expressions, and retained
 * comment-only lines keep compiler/error line mappings valid. Hashes inside
 * normal/raw strings, backticked names and special infix operators are data.
 * The caller retains the original source if comments should be shown again.
 */
export function stripRComments(code) {
  return tokenizeR(code).filter(token => token.type !== 'comment').map(token => token.value).join('');
}

export const removeRComments = stripRComments;

function sourceLines(source) {
  const parts = source.split(/(\r\n|\r|\n)/);
  const lines = [];
  let start = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i], ending = parts[i + 1] || '';
    lines.push({start, end:start + text.length, text, ending, parts:[]});
    start += text.length + ending.length;
  }
  return lines;
}

function sourceLineAt(lines, position) {
  let low = 0, high = lines.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle].start <= position) low = middle;
    else high = middle;
  }
  return low;
}

function commentLines(source) {
  const lines = sourceLines(source);
  const tokens = tokenizeR(source);
  for (const token of tokens) {
    const first = sourceLineAt(lines, token.start);
    if (token.type === 'comment') {
      lines[first].comment = token.value;
      continue;
    }
    if (token.type === 'space') continue;
    const last = sourceLineAt(lines, token.end - 1);
    for (let i = first; i <= last; i += 1) {
      const line = lines[i];
      line.parts.push(`${token.type}:${source.slice(Math.max(token.start, line.start), Math.min(token.end, line.end))}`);
      if (['name', 'string', 'number'].includes(token.type)) line.substantive = true;
      if (['name', 'string'].includes(token.type) &&
          (token.end > line.end || (token.end === line.end && token.closed === false))) line.openLiteral = true;
    }
  }
  for (const line of lines) line.key = line.parts.join('\u0001');
  return lines;
}

// Map unchanged lines by their tokens, ignoring indentation but retaining all
// literal contents. Prefix/suffix matches keep routine edits inexpensive.
function matchingLines(before, after) {
  const matches = [];
  let first = 0, oldEnd = before.length, newEnd = after.length;
  while (first < oldEnd && first < newEnd && before[first].key === after[first].key) {
    matches.push([first, first]); first += 1;
  }
  const suffix = [];
  while (oldEnd > first && newEnd > first && before[oldEnd - 1].key === after[newEnd - 1].key) {
    oldEnd -= 1; newEnd -= 1; suffix.push([oldEnd, newEnd]);
  }
  const oldCount = oldEnd - first, newCount = newEnd - first;
  if (oldCount && newCount && oldCount * newCount <= 250000) {
    const columns = newCount + 1;
    const lengths = new Uint32Array((oldCount + 1) * columns);
    for (let old = oldCount - 1; old >= 0; old -= 1) {
      for (let next = newCount - 1; next >= 0; next -= 1) {
        lengths[old * columns + next] = before[first + old].key === after[first + next].key
          ? 1 + lengths[(old + 1) * columns + next + 1]
          : Math.max(lengths[(old + 1) * columns + next], lengths[old * columns + next + 1]);
      }
    }
    let old = 0, next = 0;
    while (old < oldCount && next < newCount) {
      if (before[first + old].key === after[first + next].key) {
        matches.push([first + old, first + next]); old += 1; next += 1;
      } else if (lengths[(old + 1) * columns + next] >= lengths[old * columns + next + 1]) old += 1;
      else next += 1;
    }
  } else if (oldCount && newCount) {
    // Bound work for a wholesale replacement of a very large script. Unique
    // matching lines remain safe anchors; ambiguous rewritten comments drop.
    const positions = new Map();
    for (let next = first; next < newEnd; next += 1) {
      const key = after[next].key;
      positions.set(key, positions.has(key) ? -1 : next);
    }
    let nextMinimum = first;
    for (let old = first; old < oldEnd; old += 1) {
      const next = positions.get(before[old].key);
      if (next != null && next >= nextMinimum) {
        matches.push([old, next]); nextMinimum = next + 1;
      }
    }
  }
  return matches.concat(suffix.reverse());
}

function similarLine(before, after) {
  if (!before.parts.length || !after.parts.length) return 0;
  const old = before.key, next = after.key;
  let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix += 1;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old.at(-1 - suffix) === next.at(-1 - suffix)) suffix += 1;
  const shared = prefix + suffix;
  const oldChange = old.length - shared, newChange = next.length - shared;
  // Token type prefixes alone (for example "name:") are not an identity.
  const sameBoundaryToken = before.parts[0] === after.parts[0] || before.parts.at(-1) === after.parts.at(-1);
  const smallEdit = Math.max(oldChange, newChange) <= 2;
  if (!smallEdit && (!sameBoundaryToken || shared < Math.min(old.length, next.length) / 2)) return 0;
  return shared / Math.max(old.length, next.length) + (smallEdit ? 1 : 0);
}

/**
 * Apply edits made while comments are hidden to the annotated source. Only
 * comment text is recovered; executable text always comes from editedVisible.
 * Unchanged/token-edited lines, inserted/deleted lines and ordinary formatting
 * retain their comments. Comments inside an extensively replaced block can be
 * discarded when their association is ambiguous. New explicit comments win.
 *
 * Invariant: stripRComments(result) === stripRComments(editedVisible). In
 * particular, restoring comments cannot restore old code or alter a literal.
 */
export function reconcileRComments(annotated, editedVisible) {
  const original = String(annotated ?? ''), edited = String(editedVisible ?? '');
  const visible = stripRComments(original), target = stripRComments(edited);
  if (edited === visible) return original;
  const before = commentLines(original), after = commentLines(edited);
  if (!before.some(line => line.comment)) return edited;
  const pairs = matchingLines(before, after);
  const mappings = new Map(pairs);
  const anchors = [[-1, -1], ...pairs, [before.length, after.length]];
  for (let i = 1; i < anchors.length; i += 1) {
    const [oldStart, newStart] = anchors[i - 1], [oldEnd, newEnd] = anchors[i];
    const oldCount = oldEnd - oldStart - 1, newCount = newEnd - newStart - 1;
    if (!oldCount || !newCount) continue;
    if (oldCount === newCount) {
      for (let offset = 1; offset <= oldCount; offset += 1) {
        if (similarLine(before[oldStart + offset], after[newStart + offset])) mappings.set(oldStart + offset, newStart + offset);
      }
    } else if (oldCount * newCount <= 4096) {
      // Wrapping or joining a small block can change its number of lines.
      let nextMinimum = newStart + 1;
      for (let old = oldStart + 1; old < oldEnd; old += 1) {
        let selected = -1, best = 0;
        for (let next = nextMinimum; next < newEnd; next += 1) {
          const score = similarLine(before[old], after[next]);
          if (score > best) { selected = next; best = score; }
        }
        if (selected >= 0) { mappings.set(old, selected); nextMinimum = selected + 1; }
      }
    }
  }
  const hasSurvivingCode = [...mappings].some(([old, next]) => before[old].substantive && after[next].substantive);
  const onlyComments = !before.some(line => line.parts.length) && !after.some(line => line.parts.length);
  const restored = new Map();
  for (let old = 0; old < before.length; old += 1) {
    const comment = before[old].comment, next = mappings.get(old);
    if (!comment || next == null || after[next].comment || after[next].openLiteral || restored.has(next)) continue;
    if (!hasSurvivingCode && !onlyComments && target !== visible) continue;
    if (!before[old].parts.length && !onlyComments) {
      let previous = old - 1, following = old + 1;
      while (previous >= 0 && !before[previous].parts.length) previous -= 1;
      while (following < before.length && !before[following].parts.length) following += 1;
      if (!mappings.has(previous) && !mappings.has(following)) continue;
    }
    restored.set(next, comment);
  }
  const result = after.map((line, index) => line.text + (restored.get(index) || '') + line.ending).join('');
  return stripRComments(result) === target ? result : edited;
}

/** Split only outside strings, comments and nested grouping. Empty slots matter. */
export function splitTopLevel(code, delimiter = ',') {
  const source = String(code ?? '');
  const parts = [];
  let start = 0, depth = 0;
  for (const token of tokenizeR(source)) {
    if (token.type === 'open') depth += 1;
    else if (token.type === 'close') depth -= 1;
    else if (!depth && token.value === delimiter) {
      parts.push(source.slice(start, token.start)); start = token.end;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function continues(token) {
  return token && (token.type === 'open' || token.value === ',' || binary.has(token.value) || /^%.*%$/.test(token.value) || ['$', '@', '::', ':::'].includes(token.value));
}

/** Top-level statement locations, preserving preceding comments for writeback. */
export function rStatements(code) {
  const source = String(code ?? '');
  const result = [];
  let start = 0, depth = 0, last = null, first = null;
  const push = end => {
    if (first) result.push({start, end, expressionStart:first.start, expressionEnd:last.end, text:source.slice(start, end)});
    start = end; first = last = null;
  };
  for (const token of tokenizeR(source)) {
    if (token.type === 'space') {
      if (!depth && last && !continues(last) && token.value.includes('\n')) push(token.start + token.value.indexOf('\n') + 1);
      continue;
    }
    if (token.type === 'comment') continue;
    if (token.value === ';' && !depth) { push(token.end); continue; }
    if (!first) first = token;
    last = token;
    if (token.type === 'open') depth += 1;
    else if (token.type === 'close') depth -= 1;
  }
  if (first) push(source.length);
  return result;
}

/**
 * Hard-wrap at R-safe boundaries. Never split a string, raw string, backticked
 * name or operator. An indivisible literal may therefore exceed the width.
 * Existing newlines remain meaningful; indentation follows lexical nesting.
 */
export function formatRCode(code, {width = 88, indent = 2, baseIndent = 0} = {}) {
  const source = String(code ?? '').replace(/\r\n?/g, '\n');
  const tokens = tokenizeR(source);
  if (!tokens.length) return source;
  const stack = [];
  let previous = null;
  for (const token of tokens) {
    token.depthBefore = stack.length;
    token.continuation = continues(previous);
    if (token.type === 'open') stack.push(token.value);
    if (token.type === 'close') stack.pop();
    token.depthAfter = stack.length;
    if (!['space', 'comment'].includes(token.type)) previous = token;
  }
  const output = [];
  let lineStart = 0;
  const physical = source.split('\n');
  for (const line of physical) {
    const lineEnd = lineStart + line.length;
    const lineOutputStart = output.length;
    const overlapping = tokens.filter(token => token.end > lineStart && token.start < lineEnd);
    const multilineLiteral = overlapping.find(token => ['string','name'].includes(token.type) && (token.start < lineStart || token.end > lineEnd));
    if (multilineLiteral) {
      // Indenting inside a multiline string changes its value.
      output.push(multilineLiteral.start < lineStart ? line : ' '.repeat(baseIndent) + line);
      lineStart = lineEnd + 1; continue;
    }
    if (!line.trim()) { output.push(''); lineStart = lineEnd + 1; continue; }
    const significant = overlapping.filter(token => token.type !== 'space');
    const first = significant[0];
    let position = lineStart + line.search(/\S/);
    let depth = first?.depthBefore || 0;
    if (first?.type === 'close') {
      let n = 0;
      while (significant[n]?.type === 'close') n += 1;
      depth = Math.max(0, depth - n);
    }
    // A continuation at top level needs one extra indentation level.
    let padding = baseIndent + depth * indent + (first?.continuation && !depth && first.type !== 'close' ? indent : 0);
    // Recompute indentation rather than adding to it. Repeated Visual/Text
    // round trips must never accumulate indentation.
    const comment = significant.find(token => token.type === 'comment');
    const codeEnd = comment?.start ?? lineEnd;
    while (position < codeEnd) {
      const remaining = source.slice(position, codeEnd).trimEnd();
      if (padding + remaining.length <= width) {
        output.push(' '.repeat(padding) + remaining);
        position = codeEnd;
        break;
      }
      const candidates = significant.filter(token => token.end > position && token.end <= codeEnd &&
        (token.value === ',' || token.value === ';' || token.type === 'open' ||
          (token.type === 'operator' && (binary.has(token.value) || /^%.*%$/.test(token.value)))))
        .map(token => ({token, end:token.end, length:source.slice(position, token.end).trimEnd().length}));
      const fitting = candidates.filter(point => padding + point.length <= width);
      // Prefer argument/statement boundaries over opening parentheses when
      // both fit, keeping nested function calls visually intact where possible.
      const argumentsFit = fitting.filter(point => point.token.type === 'separator' && point.length >= (width - padding) / 2);
      const good = fitting.filter(point => point.token.type !== 'open');
      const selected = argumentsFit.at(-1) || good.at(-1) || fitting.at(-1) || candidates[0];
      if (!selected || selected.end <= position) {
        output.push(' '.repeat(padding) + remaining); position = codeEnd; break;
      }
      output.push(' '.repeat(padding) + source.slice(position, selected.end).trimEnd());
      position = selected.end;
      while (position < codeEnd && /\s/.test(source[position])) position += 1;
      const next = significant.find(token => token.start >= position && token.type !== 'comment');
      let nextDepth = Math.max(0, selected.token.depthAfter);
      if (next?.type === 'close') nextDepth = Math.max(0, nextDepth - 1);
      padding = baseIndent + nextDepth * indent + (!nextDepth && continues(selected.token) ? indent : 0);
    }
    if (comment) {
      const commentText = comment.value.slice(1).trim();
      const commentPadding = baseIndent + Math.max(0, comment.depthBefore) * indent;
      let words = commentText.split(/\s+/), prefix = ' '.repeat(commentPadding) + '#';
      // Keep ordinary short trailing comments attached to their code.
      if (source.slice(lineStart, codeEnd).trim() && output.length > lineOutputStart && output.at(-1).length + 3 + commentText.length <= width) {
        output[output.length - 1] += ' # ' + commentText;
      } else if (!commentText) output.push(prefix);
      else {
        for (const word of words) {
          if (prefix.trim() !== '#' && prefix.length + word.length + 1 > width) {
            output.push(prefix); prefix = ' '.repeat(commentPadding) + '#';
          }
          prefix += ' ' + word;
        }
        output.push(prefix);
      }
    }
    lineStart = lineEnd + 1;
  }
  return output.join('\n');
}
