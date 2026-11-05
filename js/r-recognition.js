/**
 * Conservative structural recognition for the visual data.table forms.
 *
 * This matches arguments, not formatted source strings. Expressions that need
 * an option the form cannot represent stay as R. Nothing is evaluated here.
 */
import {rString, rName, findOperation} from './catalog.js';
import {tokenizeR, significantTokens, normalizedR, splitTopLevel, rStatements, decodeRLiteral} from './r-syntax.js';

const text = value => String(value ?? '').trim();
const constants = new Set(['TRUE','FALSE','NULL','NA','NA_integer_','NA_real_','NA_complex_','NA_character_','Inf','NaN','if','else','repeat','while','function','for','in','next','break']);
const has = (object, key) => Object.hasOwn(object, key);
const only = (object, keys) => Object.keys(object).every(key => keys.includes(key));
const same = (left, right) => normalizedR(left) === normalizedR(right);
const result = (op, params = {}) => ({op, params});
const fieldNames = values => values.map(value => /[,\n\r\t"'`\\]/.test(value) || value.trim() !== value ? rString(value) : value).join(', ');

export function topLevelOperator(code, values) {
  let depth = 0;
  for (const token of tokenizeR(code)) {
    if (token.type === 'open') depth += 1;
    else if (token.type === 'close') depth -= 1;
    else if (!depth && values.includes(token.value)) return token;
  }
  return null;
}

function encloses(tokens, start, end = tokens.length - 1) {
  let depth = 0;
  for (let i = start; i <= end; i += 1) {
    if (tokens[i].type === 'open') depth += 1;
    if (tokens[i].type === 'close') depth -= 1;
    if (!depth) return i === end;
  }
  return false;
}

/** Parentheses around values are safe to inspect; around a pipe RHS are not. */
function ungroup(code) {
  let value = text(code), tokens = significantTokens(value);
  while (tokens[0]?.value === '(' && tokens.at(-1)?.value === ')' && encloses(tokens, 0)) {
    value = value.slice(tokens[0].end, tokens.at(-1).start).trim();
    tokens = significantTokens(value);
  }
  return value;
}

export function literalName(code, grouped = true) {
  const tokens = significantTokens(grouped ? ungroup(code) : code);
  return tokens.length === 1 && tokens[0].type === 'name' && !constants.has(tokens[0].value) ? tokens[0].name : null;
}

function stringLiteral(code) {
  const tokens = significantTokens(ungroup(code));
  if (tokens.length !== 1 || tokens[0].type !== 'string') return null;
  const token = tokens[0];
  if (!token.raw) return decodeRLiteral(token.value);
  const prefix = /^[rR](["'])(-*)([([{])/.exec(token.value);
  return prefix ? token.value.slice(prefix[0].length, -prefix[2].length - 2) : null;
}

function argumentsOf(inside) {
  if (!significantTokens(inside).length) return [];
  return splitTopLevel(inside).map(raw => {
    const assignment = topLevelOperator(raw, ['=']);
    const left = assignment ? significantTokens(raw.slice(0, assignment.start)) : [];
    if (assignment && left.length === 1 && ['name','string'].includes(left[0].type)) {
      return {key:left[0].name ?? decodeRLiteral(left[0].value), value:raw.slice(assignment.end).trim(), raw:raw.trim()};
    }
    return {value:raw.trim(), raw:raw.trim()};
  });
}

function callParts(code, grouped = true) {
  const value = grouped ? ungroup(code) : text(code), tokens = significantTokens(value);
  const open = tokens.findIndex(token => token.value === '(');
  if (open < 1 || tokens.at(-1)?.value !== ')' || !encloses(tokens, open)) return null;
  const fn = tokens.slice(0, open);
  if (!(fn.length === 1 && fn[0].type === 'name') &&
      !(fn.length === 3 && fn[0].type === 'name' && ['::',':::'].includes(fn[1].value) && fn[2].type === 'name')) return null;
  const inside = value.slice(tokens[open].end, tokens.at(-1).start);
  return {name:fn.at(-1).name, package:fn.length === 3 ? fn[0].name : '', access:fn.length === 3 ? fn[1].value : '', args:argumentsOf(inside), inside};
}

const callIs = (call, names, packages = ['data.table']) => Boolean(call &&
  (Array.isArray(names) ? names : [names]).includes(call.name) && (!call.package || packages.includes(call.package)));
const tableMethod = (call, name, genericPackage, exported = false) => callIs(call,name,[genericPackage]) || Boolean(call &&
  call.name === `${name}.data.table` && ((exported && !call.package) || (call.package === 'data.table' && (exported || call.access === ':::'))));
const directDot = code => literalName(code, false) === '.';

/**
 * R matches exact names, unique partial names before ..., then positional
 * arguments. Keep ... explicit so no unknown argument can be discarded.
 * Magrittr inserts its input only when there is no direct dot argument.
 */
function bindArguments(call, formals, {pipe = false, missing = false} = {}) {
  if (!call) return null;
  const supplied = call.args.slice();
  if (pipe && !supplied.some(arg => directDot(arg.value))) supplied.unshift({value:'.'});
  if (!missing && supplied.some(arg => !significantTokens(arg.value).length)) return null;
  const values = {}, dots = [], done = new Set(), used = new Set();
  const dotsAt = formals.indexOf('...');
  const positional = formals.slice(0, dotsAt < 0 ? formals.length : dotsAt);
  for (let i = 0; i < supplied.length; i += 1) {
    const arg = supplied[i];
    if (arg.key == null || !formals.includes(arg.key) || arg.key === '...') continue;
    if (used.has(arg.key)) return null;
    values[arg.key] = arg.value; used.add(arg.key); done.add(i);
  }
  for (let i = 0; i < supplied.length; i += 1) {
    const arg = supplied[i];
    if (done.has(i) || arg.key == null) continue;
    const matches = positional.filter(key => key.startsWith(arg.key));
    if (matches.length > 1 || (matches.length === 1 && used.has(matches[0]))) return null;
    if (matches.length === 1) {
      values[matches[0]] = arg.value; used.add(matches[0]); done.add(i);
    } else if (dotsAt < 0) return null;
  }
  let next = 0;
  for (let i = 0; i < supplied.length; i += 1) {
    if (done.has(i)) continue;
    const arg = supplied[i];
    if (arg.key != null) { dots.push(arg); continue; }
    while (next < positional.length && used.has(positional[next])) next += 1;
    if (next < positional.length) {
      const key = positional[next++]; values[key] = arg.value; used.add(key);
    } else if (dotsAt >= 0) dots.push(arg);
    else return null;
  }
  return {values, dots};
}

function bound(call, formals, pipe = false) {
  const match = bindArguments(call, formals, {pipe});
  return match && !match.dots.length ? match.values : null;
}

function tableArguments(call, formals, pipe = true) {
  const values = bound(call, formals, pipe);
  return values && directDot(values[formals[0]]) ? values : null;
}

function booleanLiteral(code) {
  const tokens = significantTokens(ungroup(code));
  if (tokens.length !== 1) return null;
  return ['TRUE','T'].includes(tokens[0].value) ? true : ['FALSE','F'].includes(tokens[0].value) ? false : null;
}
const flag = (values, name, fallback) => has(values, name) ? booleanLiteral(values[name]) : fallback;
const isConstant = (value, name) => significantTokens(ungroup(value)).length === 1 && significantTokens(ungroup(value))[0].value === name;
const isNull = value => isConstant(value, 'NULL');

function numberLiteral(code) {
  const value = ungroup(code), tokens = significantTokens(value);
  let sign = 1, number = tokens;
  if (tokens[0]?.value === '-' || tokens[0]?.value === '+') {
    sign = tokens[0].value === '-' ? -1 : 1;
    number = significantTokens(ungroup(value.slice(tokens[0].end)));
  }
  if (number.length !== 1 || number[0].type !== 'number' || /i$/.test(number[0].value)) return null;
  const parsed = Number(number[0].value.replace(/L$/, '')) * sign;
  return Number.isFinite(parsed) ? parsed : null;
}
const integerLiteral = (code, minimum = -2147483647) => {
  const number = numberLiteral(code);
  return number != null && Number.isInteger(number) && number >= minimum && number <= 2147483647 ? number : null;
};

function numericVector(code) {
  const scalar = numberLiteral(code);
  if (scalar != null) return {values:[scalar], names:[]};
  const call = callParts(code);
  if (!callIs(call, 'c', ['base']) || !call.args.length) return null;
  const values = call.args.map(arg => numberLiteral(arg.value));
  if (values.some(value => value == null)) return null;
  const names = call.args.some(arg => arg.key != null) ? call.args.map(arg => arg.key) : [];
  return {values, names};
}

/** A character vector is distinct from list("a") or .(a) in R. */
function columnVector(code) {
  const scalar = stringLiteral(code);
  if (scalar != null) return scalar.length ? [scalar] : null;
  const call = callParts(code);
  if (callIs(call, 'character', ['base']) && (!call.args.length ||
      (call.args.length === 1 && !call.args[0].key && numberLiteral(call.args[0].value) === 0))) return [];
  if (!callIs(call, 'c', ['base']) || call.args.some(arg => arg.key != null)) return null;
  const values = call.args.map(arg => stringLiteral(arg.value));
  return values.some(value => value == null || value === '') ? null : values;
}

function listCall(code, grouped = true) {
  const call = callParts(code, grouped);
  return callIs(call, '.', []) || callIs(call, 'list', ['base']) ? call : null;
}

function groupColumns(code, knownColumns = new Set()) {
  if (!text(code)) return [];
  // data.table inspects by's syntax. Parenthesizing it is not equivalent to
  // grouping a regular function argument and can change evaluation or error.
  if (significantTokens(code)[0]?.value === '(') return null;
  const strings = columnVector(code);
  if (strings) return strings;
  const name = literalName(code);
  if (name && knownColumns.has(name) && !['T','F','.EACHI'].includes(name)) return [name];
  const call = listCall(code);
  if (!call || call.args.some(arg => arg.key != null)) return null;
  const names = call.args.map(arg => literalName(arg.value, false));
  return names.every(name => name != null && !['T','F'].includes(name)) ? names : null;
}

function directionNames(call) {
  const columns = [], directions = [];
  for (const arg of call) {
    if (arg.key != null) return null;
    const value = text(arg.value), tokens = significantTokens(value);
    if (tokens[0]?.value === '(') return null;
    const direction = tokens[0]?.value === '-' ? -1 : 1;
    const column = literalName(['-','+'].includes(tokens[0]?.value) ? value.slice(tokens[0].end) : value, false);
    if (!column) return null;
    columns.push(column); directions.push(direction);
  }
  return columns.length ? {columns:fieldNames(columns), directions:directions.join(', ')} : null;
}

function sortDirections(code, count) {
  const vector = numericVector(code);
  return vector && vector.values.every(value => value === 1 || value === -1) &&
    (vector.values.length === 1 || vector.values.length === count) ? vector.values.join(', ') : null;
}

// Source labels only follow transparent single-argument wrappers.
export function underlyingSource(code) {
  const expression = ungroup(code);
  if (literalName(expression)) return expression;
  const call = callParts(expression);
  if (!callIs(call, ['copy','as.data.table']) || call.args.length !== 1) return expression;
  const value = bound(call, ['x']);
  return value?.x ? underlyingSource(value.x) : expression;
}

function recognizeCall(code) {
  // Parenthesizing the entire RHS changes magrittr evaluation. Do not strip it.
  const call = callParts(code, false);
  if (!call) return null;
  if (callIs(call, 'setorderv')) {
    const a = tableArguments(call, ['x','cols','order','na.last']);
    if (!a) return null;
    // Explicit columns also work with the deployed stable data.table. Inferring
    // cols from names(order) is a newer development-version API.
    const columns = has(a, 'cols') ? columnVector(a.cols) : null;
    const directions = columns?.length ? sortDirections(a.order ?? '1L', columns.length) : null;
    const naLast = flag(a, 'na.last', false);
    if (columns?.length && directions && naLast != null) return result('sort', {columns:fieldNames(columns), directions, naLast});
  }
  if (callIs(call, 'setorder')) {
    const match = bindArguments(call, ['x','...','na.last'], {pipe:true});
    const sort = match && directDot(match.values.x) && directionNames(match.dots);
    const naLast = match ? flag(match.values, 'na.last', false) : null;
    if (sort && naLast != null) return result('sort', {...sort, naLast});
  }
  if (callIs(call, ['head','tail'], ['utils'])) {
    const a = tableArguments(call, ['x','n','...']);
    const n = a ? integerLiteral(a.n ?? '6L') : null;
    if (n != null) return result('head-tail', {end:call.name, n});
  }
  if (callIs(call, 'copy') && tableArguments(call, ['x'])) return result('copy');
  if (callIs(call, 'setnames')) {
    const a = tableArguments(call, ['x','old','new','skip_absent']);
    const oldNames = a && columnVector(a.old), newNames = a && columnVector(a.new);
    const skipAbsent = a ? flag(a, 'skip_absent', false) : null;
    if (oldNames?.length && newNames?.length === oldNames.length && skipAbsent != null)
      return result('rename', {old:fieldNames(oldNames), new:fieldNames(newNames), skipAbsent});
  }
  if (callIs(call, 'setcolorder')) {
    const a = tableArguments(call, ['x','neworder','before','after','skip_absent']);
    const columns = a && columnVector(a.neworder);
    if (columns?.length && (!has(a, 'before') || isNull(a.before)) && (!has(a, 'after') || isNull(a.after)) && flag(a, 'skip_absent', false) === false)
      return result('relocate', {columns:fieldNames(columns)});
  }
  if (callIs(call, ['setkeyv','setindexv'])) {
    const a = tableArguments(call, call.name === 'setkeyv' ? ['x','cols','verbose','physical'] : ['x','cols','verbose']);
    if (!a || has(a, 'verbose')) return null;
    const physical = call.name === 'setkeyv' ? flag(a, 'physical', true) : false;
    if (physical == null) return null;
    if (isNull(a.cols)) return result('clear-key', {kind:physical ? 'key' : 'index'});
    const columns = columnVector(a.cols);
    if (columns?.length) return result(physical ? 'set-key' : 'set-index', {columns:fieldNames(columns)});
  }
  if (callIs(call, ['setkey','setindex'])) {
    const match = bindArguments(call, ['x','...','verbose','physical'], {pipe:true});
    if (!match || !directDot(match.values.x) || has(match.values, 'verbose')) return null;
    const physical = call.name === 'setkey' ? flag(match.values, 'physical', true) : false;
    if (physical == null || (call.name === 'setindex' && has(match.values, 'physical'))) return null;
    if (match.dots.length === 1 && !match.dots[0].key && isNull(match.dots[0].value)) return result('clear-key', {kind:physical ? 'key' : 'index'});
    const names = match.dots.map(arg => !arg.key && literalName(arg.value));
    if (names.length && names.every(Boolean)) return result(physical ? 'set-key' : 'set-index', {columns:fieldNames(names)});
  }
  if (tableMethod(call, 'unique', 'base')) {
    const a = tableArguments(call, ['x','incomparables','fromLast','by','cols','...']);
    if (!a || flag(a, 'incomparables', false) !== false || (has(a, 'cols') && !isNull(a.cols))) return null;
    const columns = has(a, 'by') ? columnVector(a.by) : [];
    const fromLast = flag(a, 'fromLast', false);
    if (columns && (!has(a, 'by') || columns.length) && fromLast != null) return result('distinct', {columns:fieldNames(columns), fromLast});
  }
  if (tableMethod(call, 'na.omit', 'stats')) {
    const a = tableArguments(call, ['object','cols','invert','...']);
    const columns = a && (has(a, 'cols') ? columnVector(a.cols) : []);
    const invert = a ? flag(a, 'invert', false) : null;
    if (columns && (!has(a, 'cols') || columns.length) && invert != null) return result('drop-na', {columns:fieldNames(columns), invert});
  }
  if (tableMethod(call, 'merge', 'base', true)) {
    const a = tableArguments(call, ['x','y','by','by.x','by.y','all','all.x','all.y','sort','suffixes','no.dups','allow.cartesian','incomparables','...']);
    if (!a || !a.y || ['suffixes','no.dups','incomparables'].some(key => has(a,key))) return null;
    // Explicit by.x/by.y must be supplied as a pair. R does not use by to
    // fill a missing side, and a supplied by is ignored when both sides exist.
    if (has(a,'by.x') !== has(a,'by.y') || (has(a,'by') && has(a,'by.x'))) return null;
    const left = columnVector(a['by.x'] ?? a.by), right = columnVector(a['by.y'] ?? a.by);
    const all = flag(a, 'all', false), allX = flag(a, 'all.x', all), allY = flag(a, 'all.y', all);
    // The form explicitly preserves incoming order and sets a Cartesian policy.
    // Session-dependent policies or different sort behaviour remain custom R.
    const cartesian = has(a, 'allow.cartesian') ? booleanLiteral(a['allow.cartesian']) : null;
    if (left?.length && right?.length === left.length && [allX,allY,cartesian].every(value => value != null) && flag(a, 'sort', true) === false)
      return result('join', {table:a.y, leftKeys:fieldNames(left), rightKeys:fieldNames(right), how:allX ? allY ? 'full' : 'left' : allY ? 'right' : 'inner', cartesian});
  }
  if (callIs(call, ['fintersect','funion','fsetdiff'])) {
    const a = tableArguments(call, ['x','y','all']);
    const all = a ? flag(a, 'all', false) : null;
    if (a?.y && all != null) return result('set-operation', {fun:call.name, table:a.y, all});
  }
  if (callIs(call, 'setnafill')) {
    const a = tableArguments(call, ['x','type','fill','nan','cols']);
    const columns = a && columnVector(a.cols), type = a && (has(a, 'type') ? stringLiteral(a.type) : 'const');
    if (columns?.length && ['const','locf','nocb'].includes(type) && (!has(a,'nan') || isConstant(a.nan,'NA')))
      return result('set-nafill', {columns:fieldNames(columns), type, fill:a.fill ?? 'NA'});
  }
  if (callIs(call, ['melt','melt.data.table'])) {
    const a = tableArguments(call, ['data','id.vars','measure.vars','variable.name','value.name','...','na.rm','variable.factor','value.factor','verbose']);
    if (!a || !has(a, 'id.vars') || has(a, 'verbose') || flag(a, 'value.factor', false) !== false) return null;
    const id = columnVector(a['id.vars']), values = has(a, 'measure.vars') ? columnVector(a['measure.vars']) : [];
    const variableName = has(a, 'variable.name') ? stringLiteral(a['variable.name']) : 'variable';
    const valueName = has(a, 'value.name') ? stringLiteral(a['value.name']) : 'value';
    const removeNA = flag(a, 'na.rm', false), factor = flag(a, 'variable.factor', true);
    if (id && values && (!has(a, 'measure.vars') || values.length) && variableName && valueName && removeNA != null && factor != null)
      return result('melt', {idColumns:fieldNames(id), valueColumns:fieldNames(values), variableName, valueName, removeNA, factor});
    const valueNames = has(a, 'value.name') ? columnVector(a['value.name']) : ['value'];
    if (id && a['measure.vars'] && valueNames?.length && variableName && removeNA != null && factor === true)
      return result('melt-advanced', {idColumns:fieldNames(id), measures:a['measure.vars'], valueNames:fieldNames(valueNames), variableName, removeNA});
  }
  if (callIs(call, ['dcast','dcast.data.table'])) {
    const a = tableArguments(call, ['data','formula','fun.aggregate','sep','...','margins','subset','fill','drop','value.var','verbose','value.var.in.dots','value.var.in.LHSdots','value.var.in.RHSdots']);
    if (!a || !a.formula || !topLevelOperator(ungroup(a.formula), ['~']) ||
        ['margins','subset'].some(key => has(a,key) && !isNull(a[key])) || has(a,'verbose') ||
        ['value.var.in.dots','value.var.in.LHSdots','value.var.in.RHSdots'].some(key => has(a,key) && booleanLiteral(a[key]) !== false) ||
        (has(a,'sep') && stringLiteral(a.sep) !== '_')) return null;
    const columns = columnVector(a['value.var']), drop = flag(a, 'drop', true);
    if (columns?.length && drop != null) return result('dcast', {formula:a.formula, valueColumns:fieldNames(columns), aggregate:isNull(a['fun.aggregate']) ? '' : a['fun.aggregate'] ?? '', fill:a.fill ?? 'NULL', drop});
  }
  if (callIs(call, 'transpose')) {
    const a = tableArguments(call, ['l','fill','ignore.empty','keep.names','make.names','list.cols']);
    if (!a || flag(a, 'ignore.empty', false) !== false) return null;
    const nameColumn = !has(a, 'keep.names') || isNull(a['keep.names']) ? '' : stringLiteral(a['keep.names']);
    const namesFrom = !has(a, 'make.names') || isNull(a['make.names']) ? '' : stringLiteral(a['make.names']);
    const listCols = flag(a, 'list.cols', false);
    if (nameColumn != null && namesFrom != null && listCols != null) return result('transpose', {nameColumn, namesFrom, fill:a.fill ?? 'NA', listCols});
  }
  return null;
}

function bracketParts(code, base = '.', grouped = true) {
  const value = grouped ? ungroup(code) : text(code), tokens = significantTokens(value);
  if (tokens[0]?.name !== base || tokens[1]?.value !== '[' || tokens.at(-1)?.value !== ']' || !encloses(tokens,1) || tokens[2]?.value === '[') return null;
  const inside = value.slice(tokens[1].end, tokens.at(-1).start);
  const args = argumentsOf(inside);
  const match = bindArguments({args}, ['i','j','by','keyby','with','nomatch','mult','roll','rollends','which','.SDcols','verbose','allow.cartesian','drop','on','env','showProgress'], {missing:true});
  return match ? {args, values:match.values, inside} : null;
}

function recognizeRowFilter(code) {
  const expression = ungroup(code), first = significantTokens(expression)[0];
  const inverted = first?.value === '!';
  const inner = inverted ? ungroup(expression.slice(first.end)) : expression;
  const member = topLevelOperator(inner, ['%in%','%chin%']);
  let lowerOperator = false, depth = 0;
  for (const token of significantTokens(inner)) {
    if (token.type === 'open') depth += 1;
    else if (token.type === 'close') depth -= 1;
    else if (!depth && token.type === 'operator' && token.start !== member?.start && ![':','^','**','$','@','::',':::'].includes(token.value)) lowerOperator = true;
  }
  if (member && !lowerOperator) {
    const column = literalName(inner.slice(0, member.start));
    const values = ungroup(inner.slice(member.end));
    if (column && values) return result('filter-values', {column, values, operator:member.value, invert:inverted});
  }
  const call = callParts(inner);
  if (!inverted && callIs(call, ['between','inrange'])) {
    const a = bound(call, call.name === 'between' ? ['x','lower','upper','incbounds','NAbounds','check','ignore_tzone'] : ['x','lower','upper','incbounds']);
    if (!a || (call.name === 'between' && (flag(a,'NAbounds',true) !== true || flag(a,'check',false) !== false || flag(a,'ignore_tzone',false) !== false))) return null;
    const column = literalName(a.x), inclusive = flag(a, 'incbounds', true);
    if (column && a.lower && a.upper && inclusive != null) return result(call.name, {column, lower:a.lower, upper:a.upper, inclusive});
  }
  if (callIs(call, 'like')) {
    const a = bound(call, ['vector','pattern','ignore.case','fixed','perl']);
    if (!a || flag(a, 'perl', false) !== false) return null;
    const column = literalName(a.vector), pattern = stringLiteral(a.pattern), ignoreCase = flag(a, 'ignore.case', false), fixed = flag(a, 'fixed', false);
    if (column && pattern != null && ignoreCase != null && fixed != null) return result('text-filter', {column, pattern, ignoreCase, fixed, invert:inverted});
  }
  if (!inverted && tableMethod(call, 'duplicated', 'base')) {
    const a = tableArguments(call, ['x','incomparables','fromLast','by','...'], false);
    if (!a || flag(a, 'incomparables', false) !== false) return null;
    const columns = has(a, 'by') ? columnVector(a.by) : [], fromLast = flag(a, 'fromLast', false);
    if (columns && (!has(a, 'by') || columns.length) && fromLast != null) return result('duplicates', {columns:fieldNames(columns), fromLast});
  }
  // base::order bypasses data.table's ordering optimisation. Keep that spelling
  // in a general filter instead of changing it when another sort field edits.
  if (!inverted && callIs(call, 'order', [])) {
    const match = bindArguments(call, ['...','na.last','decreasing','method']);
    const naLast = match ? flag(match.values, 'na.last', true) : null;
    if (match?.dots.length && naLast != null) {
      const remaining = call.args.filter(arg => arg.key !== 'na.last');
      return result('order-expression', {expressions:remaining.map(arg => arg.raw).join(', '), naLast});
    }
  }
  return null;
}

function lapplyParts(code) {
  const call = callParts(code);
  if (!callIs(call, 'lapply', ['base'])) return null;
  const a = bound(call, ['X','FUN','...']);
  return a && literalName(a.X) === '.SD' && a.FUN ? a : null;
}

function recognizeAssignment(name, expression, groups, sdColumns) {
  const common = {name, groups:fieldNames(groups)};
  const call = callParts(expression);
  if (!sdColumns && literalName(expression) === '.GRP' && groups.length) return result('group-id', common);
  if (!sdColumns && callIs(call, 'seq_len', ['base'])) {
    const a = bound(call, ['length.out']);
    if (a && literalName(a['length.out']) === '.N') return result('row-number', common);
  }
  if (sdColumns?.length && callIs(call, ['frankv','rleidv','rowidv'])) {
    if (call.name === 'frankv') {
      const a = bound(call, ['x','cols','order','na.last','ties.method']);
      if (!a || literalName(a.x) !== '.SD' || has(a,'cols')) return null;
      const directions = sortDirections(a.order ?? '1L', sdColumns.length);
      const ties = has(a,'ties.method') ? stringLiteral(a['ties.method']) : 'average';
      const missing = has(a,'na.last') ? booleanLiteral(a['na.last']) : true;
      const naLast = missing != null ? String(missing).toUpperCase() : stringLiteral(a['na.last']);
      if (directions && ['dense','average','min','max','first','last'].includes(ties) && ['TRUE','FALSE','keep'].includes(naLast))
        return result('rank', {...common, columns:fieldNames(sdColumns), directions, ties, naLast});
    } else if (!groups.length) {
      const a = bound(call, ['x','cols','prefix']);
      const prefix = a && (!has(a,'prefix') || isNull(a.prefix) ? '' : stringLiteral(a.prefix));
      if (a && literalName(a.x) === '.SD' && !has(a,'cols') && prefix != null)
        return result(call.name === 'rleidv' ? 'run-id' : 'row-id', {name, columns:fieldNames(sdColumns), prefix});
    }
    return null;
  }
  if (sdColumns) return null;
  if (callIs(call, 'shift')) {
    const a = bound(call, ['x','n','fill','type','give.names']);
    if (!a || flag(a,'give.names',false) !== false) return null;
    const column = literalName(a.x), n = integerLiteral(a.n ?? '1L', 0), type = has(a,'type') ? stringLiteral(a.type) : 'lag';
    if (column && n != null && ['lag','lead'].includes(type)) return result('shift', {...common, column, n, type, fill:a.fill ?? 'NA'});
  }
  if (callIs(call, ['frollmean','frollsum','frollmin','frollmax','frollprod','frollmedian','frollvar','frollsd'])) {
    const a = bound(call, ['x','n','fill','algo','align','na.rm','has.nf','adaptive','partial','give.names','hasNA']);
    if (!a || (has(a,'fill') && !isConstant(a.fill,'NA')) || (has(a,'algo') && stringLiteral(a.algo) !== 'fast') ||
        ['has.nf','hasNA'].some(key => has(a,key) && !isConstant(a[key],'NA')) ||
        ['adaptive','partial','give.names'].some(key => flag(a,key,false) !== false)) return null;
    const column = literalName(a.x), n = integerLiteral(a.n,1), align = has(a,'align') ? stringLiteral(a.align) : 'right', removeNA = flag(a,'na.rm',false);
    if (column && n != null && ['right','left','center'].includes(align) && removeNA != null)
      return result('rolling', {...common, column, fun:call.name, n, align, removeNA});
  }
  if (callIs(call, 'frollapply')) {
    const a = bound(call, ['X','N','FUN','...','by.column','fill','align','adaptive','partial','give.names','simplify','x','n']);
    if (!a || (has(a,'X') && has(a,'x')) || (has(a,'N') && has(a,'n')) ||
        flag(a,'by.column',true) !== true || flag(a,'simplify',true) !== true ||
        (has(a,'fill') && !isConstant(a.fill,'NA')) || ['adaptive','partial','give.names'].some(key => flag(a,key,false) !== false)) return null;
    const column = literalName(a.X ?? a.x), n = integerLiteral(a.N ?? a.n,1), align = has(a,'align') ? stringLiteral(a.align) : 'right';
    if (column && n != null && a.FUN && ['right','left','center'].includes(align)) return result('rolling-apply', {...common, column, n, fun:a.FUN, align});
  }
  if (callIs(call, ['cumsum','cumprod','cummin','cummax'], ['base'])) {
    const a = bound(call, ['x']), column = a && literalName(a.x);
    if (column) return result('cumulative', {...common, column, fun:call.name});
  }
  if (callIs(call, 'fifelse')) {
    const a = bound(call, ['test','yes','no','na']);
    if (a?.test && a.yes && a.no) return result('if-else', {...common, condition:a.test, yes:a.yes, no:a.no, na:a.na ?? 'NA'});
  }
  if (callIs(call, 'fcase')) {
    const match = bindArguments(call, ['...','default']);
    if (match && match.dots.length && match.dots.length % 2 === 0 && match.dots.every(arg => arg.key == null && arg.value))
      return result('case', {...common, cases:match.dots.map(arg => arg.value).join(', '), fallback:match.values.default ?? 'NA'});
  }
  if (!groups.length && callIs(call, 'fcoalesce') && call.args.every(arg => arg.key == null)) {
    const names = call.args.map(arg => literalName(arg.value));
    const fallback = names.at(-1) == null ? call.args.at(-1)?.value ?? '' : '';
    const columns = fallback ? names.slice(0,-1) : names;
    if (columns.length && columns.every(Boolean)) return result('coalesce', {name, columns:fieldNames(columns), fallback});
  }
  if (!groups.length && callIs(call, ['as.IDate','as.ITime'])) {
    const a = bound(call, ['x','format','...']);
    const column = a && literalName(a.x), format = a && (has(a,'format') ? stringLiteral(a.format) : '');
    if (column && format != null) return result('date', {name, column, kind:call.name, format});
  }
  if (!groups.length && callIs(call, ['year','quarter','month','week','isoweek','isoyear','yday','mday','wday','hour','minute','second','yearmon','yearqtr'])) {
    const a = bound(call, ['x']), column = a && literalName(a.x);
    if (column) return result('date-part', {name, column, part:call.name});
  }
  return null;
}

function recognizeBracket(code, knownColumns) {
  const bracket = bracketParts(code, '.', false);
  if (!bracket) return null;
  const a = bracket.values, i = a.i ?? '', j = a.j ?? '';
  if (only(a, ['i','j']) && i && !j) return recognizeRowFilter(i) || result('filter', {condition:i});
  if (!i && only(a, ['i','j','with']) && flag(a,'with',true) === false) {
    const columns = columnVector(j);
    if (columns?.length) return result('select', {columns:fieldNames(columns)});
  }
  if (!i && literalName(j) === '.SD' && only(a,['i','j','.SDcols'])) {
    const columns = columnVector(a['.SDcols']);
    if (columns?.length) return result('select', {columns:fieldNames(columns)});
    const selector = ungroup(a['.SDcols']), first = significantTokens(selector)[0], invert = first?.value === '!';
    const call = callParts(invert ? selector.slice(first.end) : selector);
    if (callIs(call,'patterns')) {
      const args = bound(call,['...','cols','ignore.case','perl','fixed','useBytes']);
      if (!args && call.args.length === 1 && !call.args[0].key) {
        const pattern = stringLiteral(call.args[0].value);
        if (pattern != null) return result('select-pattern', {pattern, invert});
      }
    }
    const predicate = literalName(selector);
    if (['is.numeric','is.character','is.factor','is.logical','is.integer'].includes(predicate)) return result('select-type', {predicate, invert:false});
    const fn = /^function\s*\(\s*x\s*\)\s*!\s*(is\.(?:numeric|character|factor|logical|integer))\s*\(\s*x\s*\)$/.exec(selector);
    if (fn) return result('select-type', {predicate:fn[1], invert:true});
  }
  const grouped = has(a,'by') || has(a,'keyby');
  const groups = groupColumns(a.by ?? a.keyby ?? '', knownColumns);
  const sorted = has(a,'keyby');
  if (has(a,'by') && has(a,'keyby')) return null;
  if (groups && (!grouped || groups.length) && only(a,['i','j','by','keyby','.SDcols'])) {
    const sdColumns = has(a,'.SDcols') ? columnVector(a['.SDcols']) : null;
    const assignmentText = text(j), assignment = topLevelOperator(assignmentText,[':=']);
    if (assignment && !sorted) {
      const left = assignmentText.slice(0,assignment.start), expression = assignmentText.slice(assignment.end).trim();
      const name = literalName(left, false);
      const columns = columnVector(left);
      if (name && !has(a,'.SDcols')) {
        if (!i && !groups.length && isNull(expression)) return result('drop-columns', {columns:fieldNames([name])});
        const special = !i && recognizeAssignment(name, expression, groups, null);
        return special || result('mutate', {name, expression, where:i, groups:fieldNames(groups)});
      }
      if (name && !i && sdColumns?.length) {
        const special = recognizeAssignment(name,expression,groups,sdColumns);
        if (special) return special;
      }
      if (!i && !groups.length && !has(a,'.SDcols') && columns?.length && isNull(expression)) return result('drop-columns', {columns:fieldNames(columns)});
      if (!i && columns?.length && sdColumns?.length && JSON.stringify(columns) === JSON.stringify(sdColumns)) {
        const apply = lapplyParts(expression);
        if (apply) {
          const to = literalName(apply.FUN);
          if (!groups.length && ['as.numeric','as.integer','as.character','as.logical','as.factor','as.IDate','as.ITime'].includes(to)) return result('convert', {columns:fieldNames(columns), to});
          return result('map-columns', {columns:fieldNames(columns), fun:apply.FUN, groups:fieldNames(groups)});
        }
        const fill = callParts(expression);
        if (callIs(fill,'nafill')) {
          const v = bound(fill,['x','type','fill','nan']);
          const type = v && (has(v,'type') ? stringLiteral(v.type) : 'const');
          if (v && literalName(v.x) === '.SD' && ['const','locf','nocb'].includes(type) && (!has(v,'nan') || isConstant(v.nan,'NA')))
            return result('fill-na', {columns:fieldNames(columns), type, fill:v.fill ?? 'NA', groups:fieldNames(groups)});
        }
      }
    }
    const call = callParts(j, false);
    if (!sorted && !has(a,'.SDcols') && callIs(call,[':=','let'],[]) && call.args.length && call.args.every(arg => arg.key != null && arg.value))
      return result('mutate-many', {assignments:call.inside.trim(), where:i, groups:fieldNames(groups)});
    if (!i && sdColumns?.length) {
      const apply = lapplyParts(j);
      if (apply) return result('summarize-columns', {columns:fieldNames(sdColumns), fun:apply.FUN, groups:fieldNames(groups), sorted});
    }
    if (!i && !has(a,'.SDcols')) {
      const list = listCall(j, false);
      if (list?.args.length) {
        if (list.args.length === 1 && list.args[0].key && literalName(list.args[0].value) === '.N')
          return result('count', {name:list.args[0].key, groups:fieldNames(groups), sorted});
        if (!groups.length && list.args.every(arg => arg.key == null && knownColumns.has(literalName(arg.value, false))))
          return result('select', {columns:fieldNames(list.args.map(arg => literalName(arg.value, false)))});
        return result('summarize', {expressions:list.inside.trim(), groups:fieldNames(groups), sorted});
      }
      const rows = bracketParts(j,'.SD');
      if (!sorted && groups.length && rows?.values.i && only(rows.values,['i','j']) && !rows.values.j)
        return result('group-slice', {groups:fieldNames(groups), rows:rows.values.i});
    }
  }
  // Named i/j and unexpected positions cannot safely be reordered in a form.
  const [first,second,...extra] = bracket.args;
  if (second?.value && first?.key == null && second.key == null)
    return result('custom-bracket', {i:first?.value ?? '', j:second.value, arguments:extra.map(arg => arg.raw).join(', ')});
  return null;
}

function recognizeBlock(code) {
  const value = text(code), tokens = significantTokens(value);
  if (tokens[0]?.value !== '{' || tokens.at(-1)?.value !== '}' || !encloses(tokens,0)) return null;
  const body = value.slice(tokens[0].end,tokens.at(-1).start);
  const statements = rStatements(body).map(statement => body.slice(statement.expressionStart,statement.expressionEnd));
  if (statements.length === 2 && literalName(statements[1]) === '.') {
    const call = callParts(statements[0]);
    if (callIs(call,'stopifnot',['base']) && call.args.length === 1 && call.args[0].key && call.args[0].value)
      return result('assert', {message:call.args[0].key, condition:ungroup(call.args[0].value)});
  }
  if (statements.length === 1) {
    const call = callParts(statements[0]);
    if (callIs(call,'rbindlist')) {
      const a = bound(call,['l','use.names','fill','idcol','ignore.attr']);
      const inputs = a && listCall(a.l), fill = a ? flag(a,'fill',false) : null;
      const idColumn = a && (!has(a,'idcol') || isNull(a.idcol) ? '' : stringLiteral(a.idcol));
      if (!a || flag(a,'use.names',null) !== true || flag(a,'ignore.attr',false) !== false || !inputs || fill == null || idColumn == null) return null;
      const tables = bound(inputs,['current','other']);
      // Names produce the values in idcol, so both labels must match the form.
      if (tables && inputs.args.every(arg => arg.key != null) && directDot(tables.current) && tables.other)
        return result('bind-rows', {table:tables.other, fill, idColumn});
    }
  }
  return null;
}

/** T/F are variables. Evidence of rebinding makes their value unknowable here. */
export function shadowedLogicalAliases(code, columns = []) {
  const shadowed = new Set(columns.map(column => typeof column === 'string' ? column : column.name).filter(name => ['T','F'].includes(name)));
  const tokens = significantTokens(code);
  tokens.forEach((token, index) => {
    if (token.type === 'name' && ['T','F'].includes(token.name) &&
        (['<-','<<-','=',':='].includes(tokens[index + 1]?.value) || ['->','->>'].includes(tokens[index - 1]?.value))) shadowed.add(token.name);
  });
  if (tokens.some(token => token.type === 'name' && ['assign','delayedAssign','makeActiveBinding','list2env'].includes(token.name))) {
    tokens.filter(token => token.type === 'string').forEach(token => {
      const name = decodeRLiteral(token.value);
      if (['T','F'].includes(name)) shadowed.add(name);
    });
  }
  return shadowed;
}

function qualifiedCalls(code) {
  const tokens = significantTokens(code), result = [];
  tokens.forEach((token,index) => {
    if (token.type === 'name' && ['::',':::'].includes(tokens[index + 1]?.value) && tokens[index + 2]?.type === 'name' && tokens[index + 3]?.value === '(')
      result.push({name:tokens[index + 2].name, package:token.name, access:tokens[index + 1].value, reference:code.slice(token.start,tokens[index + 2].end)});
  });
  return result;
}

function preserveFunctionNamespace(recognized, source) {
  const primary = {
    between:'between', inrange:'inrange', 'text-filter':'like', 'head-tail':recognized.params.end,
    distinct:'unique', duplicates:'duplicated', 'drop-na':'na.omit', rename:'setnames', relocate:'setcolorder',
    convert:'lapply', 'map-columns':'lapply', 'summarize-columns':'lapply', sort:'setorderv',
    'set-key':'setkeyv', 'set-index':'setindexv', 'clear-key':recognized.params.kind === 'index' ? 'setindexv' : 'setkeyv',
    melt:'melt', 'melt-advanced':'melt', dcast:'dcast', transpose:'transpose', join:'merge',
    'set-operation':recognized.params.fun, 'row-number':'seq_len', shift:'shift', rolling:recognized.params.fun,
    'rolling-apply':'frollapply', rank:'frankv', 'run-id':'rleidv', 'row-id':'rowidv', cumulative:recognized.params.fun,
    'fill-na':'nafill', 'set-nafill':'setnafill', coalesce:'fcoalesce', 'if-else':'fifelse', 'case':'fcase',
    date:recognized.params.kind, 'date-part':recognized.params.part, copy:'copy', assert:'stopifnot', 'bind-rows':'rbindlist',
  }[recognized.op];
  const aliases = {
    setorderv:['setorder'], setkeyv:['setkey'], setindexv:['setindex','setkeyv','setkey'],
    merge:['merge.data.table'], unique:['unique.data.table'], duplicated:['duplicated.data.table'],
    'na.omit':['na.omit.data.table'], melt:['melt.data.table'], dcast:['dcast.data.table'],
  }[primary] || [];
  const original = qualifiedCalls(source);
  if (!original.length) return recognized;
  const qualified = primary && original.find(call => call.name === primary || aliases.includes(call.name));
  if (qualified) {
    const target = qualified.name.endsWith('.data.table') ? qualified.name : primary;
    recognized.params.rFunction = {name:primary, reference:`${qualified.package}${qualified.access}${rName(target)}`};
  }
  const operation = findOperation(recognized.op);
  const defaults = Object.fromEntries(operation.fields.map(field => [field.key, field.default ?? '']));
  const rebuilt = qualifiedCalls(operation.build({...defaults,...recognized.params}));
  // A namespace inside a raw field stays there. A qualifier consumed by an
  // unsupported normalisation must not disappear silently on a future edit.
  const remaining = rebuilt.map(call => normalizedR(call.reference));
  for (const call of original) {
    const expected = call === qualified ? recognized.params.rFunction.reference : call.reference;
    const index = remaining.indexOf(normalizedR(expected));
    if (index < 0) return null;
    remaining.splice(index,1);
  }
  return recognized;
}

export function recognizeStage(code, {shadowedAliases = new Set(), columns = []} = {}) {
  if (significantTokens(code).some(token => token.type === 'name' && shadowedAliases.has(token.name))) return null;
  const knownColumns = new Set(columns.map(column => typeof column === 'string' ? column : column.name));
  const recognized = recognizeBracket(code, knownColumns) || recognizeCall(code) || recognizeBlock(code);
  return recognized ? preserveFunctionNamespace(recognized,code) : null;
}
