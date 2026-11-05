/**
 * Tablecraft operation recipes.
 *
 * Literal names use rName()/rString(); expression fields are intentionally R.
 * Every build() result is one magrittr pipe stage returning a data.table.
 * Documentation: https://rdatatable.gitlab.io/data.table/reference/index.html
 */
import {createAssertionOperations} from './assertions.js';
import {documentationFor} from './documentation.js';
import {decodeRLiteral, significantTokens} from './r-syntax.js';
export {documentationFor, GENERAL_R_FUNCTIONS} from './documentation.js';

const RESERVED = new Set(['if', 'else', 'repeat', 'while', 'function', 'for', 'in', 'next', 'break', 'TRUE', 'FALSE', 'NULL', 'Inf', 'NaN', 'NA', 'NA_integer_', 'NA_real_', 'NA_complex_', 'NA_character_']);

export const rString = (value) => JSON.stringify(String(value ?? ''));
export const rName = (value) => {
  const name = String(value ?? '');
  return /^[\p{L}.][\p{L}0-9._]*$/u.test(name) && !/^\.[0-9]/.test(name) && !RESERVED.has(name)
    ? name
    : '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/[\x00-\x1f\x7f]/g, char => ({'\n':'\\n','\r':'\\r','\t':'\\t','\b':'\\b','\f':'\\f','\v':'\\v'})[char] || `\\x${char.charCodeAt(0).toString(16).padStart(2,'0')}`) + '`';
};

/** Comma/newline separated literal names; quoted names may contain commas. */
export function parseColumns(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value ?? '').trim();
  const result = [];
  let current = '', quote = '', escaped = false;
  const push = () => {
    const literal = current.trim();
    const name = decodeRLiteral(literal);
    if (name) result.push(name);
    current = '';
  };
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote) {
      current += char;
      escaped = true;
    } else if (quote) {
      current += char;
      if (char === quote) quote = '';
    } else if (['"', "'", '`'].includes(char) && !current.trim()) {
      quote = char;
      current += char;
    } else if (char === ',' || char === '\n') {
      push();
    } else {
      current += char;
    }
  }
  if (current.trim()) push();
  return result;
}

const cv = (value) => {
  const names = parseColumns(value);
  return names.length ? `c(${names.map(rString).join(', ')})` : 'character()';
};
const raw = (value, fallback = '') => String(value ?? fallback).trim();
const bool = (value) => value === true || value === 'true' ? 'TRUE' : 'FALSE';
const group = (value, sorted = false) => parseColumns(value).length ? `, ${sorted ? 'keyby' : 'by'} = ${cv(value)}` : '';
const assign = (name, expression, groups, where = '') => `.[${raw(where)}, ${rName(name)} := ${expression}${group(groups)}]`;
const nvec = (value, fallback = '1') => `c(${raw(value, fallback).split(',').map(x => `${x.trim().replace(/L$/, '')}L`).join(', ')})`;
const namesOf = (columns = []) => columns.map(c => typeof c === 'string' ? c : c.name).filter(Boolean);
const numericColumns = (columns = []) => columns.filter(c => /numeric|double|integer/.test(String(c.type || c.class || '')) && !/date|time/i.test(String(c.type || c.class || '')));
const numberOf = (columns = []) => numericColumns(columns).find(c => !/(^id$|_id$|^index$|^row$|^year$|^month$)/i.test(c.name))?.name || numericColumns(columns)[0]?.name || namesOf(columns)[0] || 'value';
const categoryOf = (columns = []) => columns.find(c => /^(group|region|species|product|category|segment|type|treatment|channel|feed|supp|cyl|dose|month)$/i.test(c.name))?.name || columns.find(c => /character|factor|logical/.test(String(c.type || c.class || '')) && !/(^id$|_id$)/i.test(c.name))?.name || namesOf(columns)[0] || 'group';
const dateOf = (columns = []) => columns.find(c => /date|time/i.test(String(c.type || c.class || '') + ' ' + c.name))?.name || namesOf(columns)[0] || 'date';
const columnFieldName = name => /[,\n\r\t"'`\\]/.test(name) || name.trim() !== name ? rString(name) : name;
const firstNames = (columns, n = 2) => namesOf(columns).slice(0, n).map(columnFieldName).join(', ');

const text = (key, label, value = '', extra = {}) => ({key, label, type: 'text', default: value, ...extra});
const expr = (key, label, value = '', extra = {}) => ({key, label, type: 'textarea', default: value, help: 'R expression. Use backticks around names containing spaces.', ...extra});
const cols = (key = 'columns', label = 'Columns', value = '', extra = {}) => ({key, label, type: 'columns', default: value, help: 'Column names separated by commas. Quote names that contain commas.', ...extra});
const col = (key = 'column', label = 'Column', value = 'value', extra = {}) => ({key, label, type: 'column', default: value, required: true, ...extra});
const check = (key, label, value = false, extra = {}) => ({key, label, type: 'checkbox', default: value, ...extra});
const select = (key, label, value, options, extra = {}) => ({key, label, type: 'select', default: value, options, ...extra});
const number = (key, label, value, extra = {}) => ({key, label, type: 'number', default: value, min: 0, ...extra});
const groups = () => cols('groups', 'Group by (optional)');
const newName = (value = 'new_column') => text('name', 'Output column', value, {required: true, help: 'A literal name, without quotes or backticks.'});
const otherTable = () => expr('table', 'Other table', 'lookup', {required: true, help: 'R table name or expression. Use a table from the Data panel.'});
const joinKeys = () => [cols('leftKeys', 'Keys in this table', 'id', {required: true}), cols('rightKeys', 'Keys in the other table', '', {help: 'Leave blank to use the same names. Match the order of the left keys.'})];
const onVector = (p) => {
  const left = parseColumns(p.leftKeys);
  const right = parseColumns(p.rightKeys).length ? parseColumns(p.rightKeys) : left;
  return `c(${left.map((x, i) => `${rString(x)} = ${rString(right[i] || x)}`).join(', ')})`;
};
const joinValidation = (p) => parseColumns(p.rightKeys).length && parseColumns(p.leftKeys).length !== parseColumns(p.rightKeys).length
  ? [{severity: 'error', field: 'rightKeys', message: 'Use the same number of keys on both sides of the join.'}] : [];
const directionsValidation = (p) => {
  const values = raw(p.directions, '1').split(',').map(x => x.trim().replace(/L$/, ''));
  if (values.some(x => x !== '1' && x !== '-1')) return [{severity: 'error', field: 'directions', message: 'Use 1 for ascending or -1 for descending, separated by commas.'}];
  if (values.length !== 1 && values.length !== parseColumns(p.columns).length) return [{severity: 'error', field: 'directions', message: 'Use one direction for all columns, or one direction per column.'}];
  return [];
};

export const OPERATIONS = [
  {
    id: 'filter', label: 'Filter rows', category: 'Rows',
    description: 'Keep rows that meet an R condition.', functions: ['[', '%in%', '%chin%', 'between', 'like'],
    fields: [expr('condition', 'Keep rows where', 'value > 0', {required: true, placeholder: 'units >= 2 & region == "North"'})],
    defaults: c => ({condition: `${rName(numberOf(c))} > 0`}),
    build: p => `.[${raw(p.condition)}]`,
    tips: ['Combine conditions with & (and) or | (or). Use == to test equality. Missing results are excluded.']
  },
  {
    id: 'filter-values', label: 'Keep matching values', category: 'Rows',
    description: 'Match a column against a vector of values.', functions: ['%in%', '%chin%'],
    fields: [col(), expr('values', 'Values (R vector)', 'c("North", "West")', {required: true}), select('operator', 'Match using', '%in%', ['%in%', '%chin%']), check('invert', 'Exclude these values')],
    defaults: c => ({column: categoryOf(c)}),
    build: p => `.[${p.invert ? '!' : ''}(${rName(p.column)} ${p.operator} (${raw(p.values)}))]`,
    tips: ['%chin% is for character vectors. Use %in% for numbers, dates, or factors.']
  },
  {
    id: 'between', label: 'Filter a range', category: 'Rows',
    description: 'Keep values between lower and upper bounds.', functions: ['between', '%between%'],
    fields: [col(), text('lower', 'Lower bound (R)', '0', {required: true}), text('upper', 'Upper bound (R)', '100', {required: true}), check('inclusive', 'Include both bounds', true)],
    defaults: c => ({column: numberOf(c)}),
    build: p => `.[between(${rName(p.column)}, ${raw(p.lower)}, ${raw(p.upper)}, incbounds = ${bool(p.inclusive)})]`
  },
  {
    id: 'inrange', label: 'Filter multiple ranges', category: 'Rows',
    description: 'Keep values inside any supplied interval.', functions: ['inrange', '%inrange%'],
    fields: [col(), expr('lower', 'Lower bounds (R vector)', 'c(0, 10)', {required: true}), expr('upper', 'Upper bounds (R vector)', 'c(5, 20)', {required: true}), check('inclusive', 'Include bounds', true)],
    defaults: c => ({column: numberOf(c)}),
    build: p => `.[inrange(${rName(p.column)}, ${raw(p.lower)}, ${raw(p.upper)}, incbounds = ${bool(p.inclusive)})]`,
    tips: ['Supply the same number of lower and upper bounds.']
  },
  {
    id: 'text-filter', label: 'Find text', category: 'Rows',
    description: 'Filter with a regular expression or literal text.', functions: ['like', '%like%', '%ilike%', '%flike%', '%plike%'],
    fields: [col(), text('pattern', 'Text or regular expression', '', {required: true}), check('ignoreCase', 'Ignore case', true), check('fixed', 'Treat as literal text'), check('invert', 'Keep non-matches')],
    defaults: c => ({column: categoryOf(c), pattern: '.'}),
    build: p => `.[${p.invert ? '!' : ''}like(${rName(p.column)}, ${rString(p.pattern)}, ignore.case = ${bool(p.ignoreCase)}, fixed = ${bool(p.fixed)})]`
  },
  {
    id: 'slice', label: 'Select row positions', category: 'Rows',
    description: 'Take rows by position, including the last rows.', functions: ['[', '.N', '.I'],
    fields: [expr('rows', 'Row positions (R)', 'seq_len(min(.N, 10L))', {required: true, help: 'For example 1:10, c(1, 4, 9), -.N, or seq_len(min(.N, 10L)).'})],
    build: p => `.[${raw(p.rows)}]`,
    tips: ['1:10 includes out-of-range positions in a short table. Use seq_len(min(.N, 10L)) to cap safely.']
  },
  {
    id: 'head-tail', label: 'First or last rows', category: 'Rows',
    description: 'Take a limited number of rows from either end.', functions: ['head', 'tail'],
    fields: [select('end', 'Take from', 'head', [{value:'head',label:'Start (head)'},{value:'tail',label:'End (tail)'}]), number('n', 'Number of rows', 10, {required: true, integer: true, min: -2147483647, help: 'A negative number excludes that many rows from the opposite end, as in head() and tail().'})],
    build: p => `${p.end}(n = ${p.n}L)`
  },
  {
    id: 'sample', label: 'Sample rows', category: 'Rows',
    description: 'Take a reproducible random sample, optionally per group.', functions: ['[', '.N', '.SD', 'sample.int'],
    fields: [number('n', 'Rows per sample', 10, {required: true, integer: true}), number('seed', 'Random seed', 42, {required: true, integer: true}), groups()],
    build: p => `{ set.seed(${p.seed}); ${parseColumns(p.groups).length ? `.[, .SD[sample.int(.N, min(.N, ${p.n}L))]${group(p.groups)}]` : `.[sample.int(.N, min(.N, ${p.n}L))]`} }`
  },
  {
    id: 'distinct', label: 'Remove duplicates', category: 'Rows',
    description: 'Keep one row for each unique key or whole row.', functions: ['unique'],
    fields: [cols('columns', 'Compare these columns (optional)', '', {help: 'Leave blank to compare all columns. Other columns are kept.'}), check('fromLast', 'Keep the last occurrence')],
    build: p => `unique(${parseColumns(p.columns).length ? `by = ${cv(p.columns)}, ` : ''}fromLast = ${bool(p.fromLast)})`
  },
  {
    id: 'duplicates', label: 'Find duplicate rows', category: 'Rows',
    description: 'Keep repeated occurrences of a key or whole row.', functions: ['duplicated'],
    fields: [cols('columns', 'Compare these columns (optional)'), check('fromLast', 'Compare from the end')],
    build: p => `.[duplicated(.${parseColumns(p.columns).length ? `, by = ${cv(p.columns)}` : ''}, fromLast = ${bool(p.fromLast)})]`,
    tips: ['This keeps duplicate occurrences, not the first occurrence of each duplicated value.']
  },
  {
    id: 'drop-na', label: 'Drop missing rows', category: 'Rows',
    description: 'Remove rows with missing values in selected columns.', functions: ['na.omit'],
    fields: [cols('columns', 'Check these columns (optional)'), check('invert', 'Keep only rows with missing values')],
    build: p => `na.omit(${parseColumns(p.columns).length ? `cols = ${cv(p.columns)}, ` : ''}invert = ${bool(p.invert)})`
  },
  {
    id: 'select', label: 'Choose columns', category: 'Columns',
    description: 'Keep columns in the order you choose.', functions: ['[', '.SD', '.SDcols'],
    fields: [cols('columns', 'Keep columns', 'value', {required: true})],
    defaults: c => ({columns: firstNames(c, 4)}),
    build: p => `.[, ${cv(p.columns)}, with = FALSE]`
  },
  {
    id: 'select-pattern', label: 'Choose columns by pattern', category: 'Columns',
    description: 'Select column names with a regular expression.', functions: ['patterns', '.SD', '.SDcols'],
    fields: [text('pattern', 'Column-name regular expression', '.', {required: true}), check('invert', 'Exclude matching columns')],
    build: p => `.[, .SD, .SDcols = ${p.invert ? '!' : ''}patterns(${rString(p.pattern)})]`
  },
  {
    id: 'select-type', label: 'Choose columns by type', category: 'Columns',
    description: 'Select numeric, character, logical, or factor columns.', functions: ['.SD', '.SDcols'],
    fields: [select('predicate', 'Keep columns matching', 'is.numeric', ['is.numeric', 'is.character', 'is.factor', 'is.logical', 'is.integer']), check('invert', 'Exclude matching columns')],
    build: p => `.[, .SD, .SDcols = ${p.invert ? `function(x) !${p.predicate}(x)` : p.predicate}]`
  },
  {
    id: 'drop-columns', label: 'Remove columns', category: 'Columns',
    description: 'Delete selected columns by reference.', functions: [':='],
    fields: [cols('columns', 'Remove columns', 'value', {required: true})],
    defaults: c => ({columns: firstNames(c, 1)}),
    build: p => `.[, (${cv(p.columns)}) := NULL]`
  },
  {
    id: 'mutate', label: 'Create or update a column', category: 'Columns',
    description: 'Calculate a column, optionally for selected rows or groups.', functions: [':=', '['],
    fields: [newName(), expr('expression', 'Calculate (R)', 'value * 2', {required: true}), groups(), expr('where', 'Only update rows where (optional)', '', {help: 'An R condition. Leave blank to update every row.'})],
    defaults: c => ({expression: `${rName(numberOf(c))} * 2`}),
    build: p => assign(p.name, raw(p.expression), p.groups, p.where)
  },
  {
    id: 'mutate-many', label: 'Update several columns', category: 'Columns',
    description: 'Set several named expressions in one step.', functions: [':=', 'let'],
    fields: [expr('assignments', 'Named expressions (R)', 'double = value * 2, rounded = round(value)', {required: true, help: 'For example revenue = units * price, taxed = units * price * 1.2. Expressions use the incoming table.'}), groups(), expr('where', 'Only update rows where (optional)')],
    defaults: c => ({assignments: `double = ${rName(numberOf(c))} * 2, rounded = round(${rName(numberOf(c))})`}),
    build: p => `.[${raw(p.where)}, \`:=\`(${raw(p.assignments)})${group(p.groups)}]`,
    tips: ['A new column in this assignment is available to the next pipeline step, not the other expressions in the same assignment.']
  },
  {
    id: 'rename', label: 'Rename columns', category: 'Columns',
    description: 'Change one or more column names without copying data.', functions: ['setnames'],
    fields: [cols('old', 'Current names', 'value', {required: true}), cols('new', 'New names', 'renamed_value', {required: true}), check('skipAbsent', 'Skip names that are absent')],
    defaults: c => ({old: firstNames(c, 1), new: `${namesOf(c)[0] || 'value'}_renamed`}),
    validate: p => parseColumns(p.old).length === parseColumns(p.new).length ? [] : [{severity: 'error', field: 'new', message: 'Provide one new name for each current name.'}],
    build: p => `setnames(old = ${cv(p.old)}, new = ${cv(p.new)}, skip_absent = ${bool(p.skipAbsent)})`
  },
  {
    id: 'rename-pattern', label: 'Rename with a pattern', category: 'Columns',
    description: 'Replace text in every column name.', functions: ['setnames'],
    fields: [text('pattern', 'Find (regular expression)', '\\.', {required: true}), text('replacement', 'Replace with', '_')],
    build: p => `{ setnames(., gsub(${rString(p.pattern)}, ${rString(p.replacement)}, names(.), perl = TRUE)); . }`
  },
  {
    id: 'relocate', label: 'Reorder columns', category: 'Columns',
    description: 'Move selected columns to the front, in your chosen order.', functions: ['setcolorder'],
    fields: [cols('columns', 'Put these columns first', 'value', {required: true})],
    defaults: c => ({columns: firstNames(c, 2)}),
    build: p => `setcolorder(neworder = ${cv(p.columns)})`
  },
  {
    id: 'convert', label: 'Convert column types', category: 'Columns',
    description: 'Apply a type conversion to selected columns.', functions: [':=', '.SD', '.SDcols', 'as.IDate', 'as.ITime'],
    fields: [cols('columns', 'Columns to convert', 'value', {required: true}), select('to', 'Convert to', 'as.numeric', ['as.numeric', 'as.integer', 'as.character', 'as.logical', 'as.factor', 'as.IDate', 'as.ITime'])],
    defaults: c => ({columns: numberOf(c)}),
    build: p => `.[, (${cv(p.columns)}) := lapply(.SD, ${p.to}), .SDcols = ${cv(p.columns)}]`,
    tips: ['Converting non-numeric text to numbers produces missing values. Use a separate expression to clean the text first.']
  },
  {
    id: 'map-columns', label: 'Transform selected columns', category: 'Columns',
    description: 'Apply one function to several columns using lapply(.SD).', functions: [':=', '.SD', '.SDcols'],
    fields: [cols('columns', 'Columns to transform', 'value', {required: true}), expr('fun', 'Function (R)', 'function(x) round(x, 2)', {required: true}), groups()],
    defaults: c => ({columns: numberOf(c)}),
    build: p => `.[, (${cv(p.columns)}) := lapply(.SD, ${raw(p.fun)})${group(p.groups)}, .SDcols = ${cv(p.columns)}]`
  },
  {
    id: 'summarize', label: 'Summarize', category: 'Group & summarize',
    description: 'Calculate one or more summaries, optionally by group.', functions: ['[', '.N', 'uniqueN', 'first', 'last'],
    fields: [expr('expressions', 'Named summaries (R)', 'mean_value = mean(value, na.rm = TRUE), n = .N', {required: true}), groups(), check('sorted', 'Sort the groups (keyby)')],
    defaults: c => ({expressions: `mean_value = mean(${rName(numberOf(c))}, na.rm = TRUE), n = .N`, groups: categoryOf(c)}),
    build: p => `.[, .(${raw(p.expressions)})${group(p.groups, p.sorted)}]`
  },
  {
    id: 'count', label: 'Count rows', category: 'Group & summarize',
    description: 'Count all rows or rows in each group.', functions: ['.N'],
    fields: [groups(), newName('n'), check('sorted', 'Sort the groups (keyby)')],
    defaults: c => ({groups: categoryOf(c)}),
    build: p => `.[, .(${rName(p.name)} = .N)${group(p.groups, p.sorted)}]`
  },
  {
    id: 'summarize-columns', label: 'Summarize several columns', category: 'Group & summarize',
    description: 'Apply the same summary function to selected columns.', functions: ['.SD', '.SDcols', 'uniqueN'],
    fields: [cols('columns', 'Value columns', 'value', {required: true}), expr('fun', 'Summary function (R)', 'function(x) mean(x, na.rm = TRUE)', {required: true}), groups(), check('sorted', 'Sort the groups (keyby)')],
    defaults: c => ({columns: numberOf(c), groups: categoryOf(c)}),
    build: p => `.[, lapply(.SD, ${raw(p.fun)})${group(p.groups, p.sorted)}, .SDcols = ${cv(p.columns)}]`
  },
  {
    id: 'group-slice', label: 'Take rows within each group', category: 'Group & summarize',
    description: 'Keep first, last, or chosen rows separately in each group.', functions: ['.SD', '.N'],
    fields: [cols('groups', 'Group by', 'group', {required: true}), expr('rows', 'Positions within each group (R)', 'seq_len(min(.N, 3L))', {required: true})],
    defaults: c => ({groups: categoryOf(c)}),
    build: p => `.[, .SD[${raw(p.rows)}]${group(p.groups)}]`,
    tips: ['Sort the table first to take the largest or smallest rows of each group. Use .N for the last row.']
  },
  {
    id: 'group-id', label: 'Add group identifiers', category: 'Group & summarize',
    description: 'Number each group using .GRP.', functions: ['.GRP', '.BY'],
    fields: [cols('groups', 'Group by', 'group', {required: true}), newName('group_id')],
    defaults: c => ({groups: categoryOf(c)}),
    build: p => assign(p.name, '.GRP', p.groups)
  },
  {
    id: 'sort', label: 'Sort rows', category: 'Sort & index',
    description: 'Sort efficiently by one or more columns.', functions: ['setorderv', 'setorder'],
    fields: [cols('columns', 'Sort by', 'value', {required: true}), text('directions', 'Directions: 1 ascending, -1 descending', '1', {required: true, help: 'Use one direction for all columns, or a comma-separated direction for each column.'}), check('naLast', 'Place missing values last', true)],
    defaults: c => ({columns: numberOf(c)}), validate: directionsValidation,
    build: p => `setorderv(cols = ${cv(p.columns)}, order = ${nvec(p.directions)}, na.last = ${bool(p.naLast)})`
  },
  {
    id: 'order-expression', label: 'Sort by expressions', category: 'Sort & index',
    description: 'Sort with expressions, such as -units or nchar(name).', functions: ['[', 'order'],
    fields: [expr('expressions', 'Sort expressions (R)', '-value', {required: true}), check('naLast', 'Place missing values last', true)],
    defaults: c => ({expressions: `-${rName(numberOf(c))}`}),
    build: p => `.[order(${raw(p.expressions)}, na.last = ${bool(p.naLast)})]`
  },
  {
    id: 'set-key', label: 'Set a key', category: 'Sort & index',
    description: 'Sort by key columns and mark the table for fast lookups.', functions: ['setkey', 'setkeyv', 'key'],
    fields: [cols('columns', 'Key columns', 'id', {required: true})],
    defaults: c => ({columns: firstNames(c, 1)}),
    build: p => `setkeyv(cols = ${cv(p.columns)})`
  },
  {
    id: 'set-index', label: 'Add a secondary index', category: 'Sort & index',
    description: 'Create a lookup index while preserving row order.', functions: ['setindex', 'setindexv', 'indices'],
    fields: [cols('columns', 'Index columns', 'id', {required: true})],
    defaults: c => ({columns: firstNames(c, 1)}),
    build: p => `setindexv(cols = ${cv(p.columns)})`
  },
  {
    id: 'clear-key', label: 'Remove a key or indexes', category: 'Sort & index',
    description: 'Clear lookup metadata without changing rows.', functions: ['setkeyv', 'setindexv'],
    fields: [select('kind', 'Remove', 'key', [{value:'key',label:'Key'},{value:'index',label:'All secondary indexes'}])],
    build: p => `${p.kind === 'index' ? 'setindexv' : 'setkeyv'}(cols = NULL)`
  },
  {
    id: 'melt', label: 'Pivot longer (melt)', category: 'Reshape',
    description: 'Turn wide value columns into rows.', functions: ['melt'],
    fields: [cols('idColumns', 'Keep as identifiers'), cols('valueColumns', 'Value columns (optional)', '', {help: 'Leave blank to melt every non-identifier column.'}), text('variableName', 'Column for former column names', 'variable', {required: true}), text('valueName', 'Column for values', 'value', {required: true}), check('removeNA', 'Drop missing values'), check('factor', 'Store former names as a factor')],
    defaults: c => ({idColumns: categoryOf(c), valueColumns: (numericColumns(c).map(x => x.name).filter(n => n !== categoryOf(c) && !/(^id$|_id$)/i.test(n)).slice(0, 3)).map(columnFieldName).join(', ')}),
    build: p => `melt(id.vars = ${cv(p.idColumns)}${parseColumns(p.valueColumns).length ? `, measure.vars = ${cv(p.valueColumns)}` : ''}, variable.name = ${rString(p.variableName)}, value.name = ${rString(p.valueName)}, na.rm = ${bool(p.removeNA)}, variable.factor = ${bool(p.factor)})`
  },
  {
    id: 'melt-advanced', label: 'Melt multiple measures', category: 'Reshape',
    description: 'Reshape several value sets using lists, patterns(), or measure().', functions: ['melt', 'patterns', 'measure', 'measurev'],
    fields: [cols('idColumns', 'Keep as identifiers'), expr('measures', 'measure.vars (R)', 'patterns("^value")', {required: true, help: 'For example patterns("^sales", "^cost") or list(c("q1", "q2")).'}), cols('valueNames', 'Names for value columns', 'value', {required: true}), text('variableName', 'Variable column', 'variable', {required: true}), check('removeNA', 'Drop missing values')],
    defaults: c => ({idColumns: categoryOf(c), measures: `list(${cv(numberOf(c))})`}),
    build: p => `melt(id.vars = ${cv(p.idColumns)}, measure.vars = ${raw(p.measures)}, value.name = ${cv(p.valueNames)}, variable.name = ${rString(p.variableName)}, na.rm = ${bool(p.removeNA)})`
  },
  {
    id: 'dcast', label: 'Pivot wider (dcast)', category: 'Reshape',
    description: 'Turn category values into columns, with optional aggregation.', functions: ['dcast'],
    fields: [expr('formula', 'Rows ~ new columns (R formula)', 'group ~ variable', {required: true, help: 'For example region ~ product, or region + year ~ product.'}), cols('valueColumns', 'Value columns', 'value', {required: true}), expr('aggregate', 'Aggregation function (R)', 'sum', {help: 'Use sum, mean, length, a function, or list(sum, mean). Leave blank if each cell is unique.'}), text('fill', 'Empty-cell value (R)', '0', {required: true}), check('drop', 'Drop unused combinations', true)],
    defaults: c => {
      const names = namesOf(c), g = categoryOf(c);
      const other = columnsByKind(c, /character|factor/).find(n => n !== g) || names.find(n => n !== g) || g;
      return {formula: `${rName(g)} ~ ${rName(other)}`, valueColumns: numberOf(c)};
    },
    validate: p => raw(p.formula).includes('~') ? [] : [{severity: 'error', field: 'formula', message: 'Use a formula with ~, such as region ~ product.'}],
    build: p => `dcast(formula = ${raw(p.formula)}, value.var = ${cv(p.valueColumns)}${raw(p.aggregate) ? `, fun.aggregate = ${raw(p.aggregate)}` : ''}, fill = ${raw(p.fill)}, drop = ${bool(p.drop)})`,
    tips: ['If several rows map to the same cell, choose an aggregation function. Multiple value columns and aggregation functions are supported.']
  },
  {
    id: 'transpose', label: 'Transpose rows and columns', category: 'Reshape',
    description: 'Swap the table axes and optionally preserve column names.', functions: ['transpose'],
    fields: [text('nameColumn', 'Column for original names', 'column'), text('namesFrom', 'Use values from this column as new names (optional)'), text('fill', 'Fill value (R)', 'NA', {required: true}), check('listCols', 'Preserve mixed types in list columns')],
    build: p => `transpose(keep.names = ${raw(p.nameColumn) ? rString(p.nameColumn) : 'NULL'}, make.names = ${raw(p.namesFrom) ? rString(p.namesFrom) : 'NULL'}, fill = ${raw(p.fill)}, list.cols = ${bool(p.listCols)})`,
    tips: ['Mixed numeric and text columns become text unless list columns are enabled.']
  },
  {
    id: 'expand-grid', label: 'Expand value combinations', category: 'Reshape',
    description: 'Create the Cartesian product of unique column values.', functions: ['CJ'],
    fields: [cols('columns', 'Combine values from', 'group', {required: true}), check('sorted', 'Sort the combinations', true)],
    defaults: c => ({columns: categoryOf(c)}),
    build: p => `{\n  .tc_grid <- do.call(CJ, c(unname(lapply(.[, ${cv(p.columns)}, with = FALSE], unique)), list(sorted = ${bool(p.sorted)}, unique = TRUE)))\n  setnames(.tc_grid, ${cv(p.columns)})\n}`,
    tips: ['The number of rows is the product of the unique value counts. Choose low-cardinality columns.']
  },
  {
    id: 'complete', label: 'Complete missing combinations', category: 'Reshape',
    description: 'Add absent combinations of selected columns.', functions: ['CJ', 'merge'],
    fields: [cols('columns', 'Complete combinations of', 'group', {required: true})],
    defaults: c => ({columns: categoryOf(c)}),
    build: p => `{\n  .tc_grid <- do.call(CJ, c(unname(lapply(.[, ${cv(p.columns)}, with = FALSE], unique)), list(unique = TRUE)))\n  setnames(.tc_grid, ${cv(p.columns)})\n  merge(.tc_grid, ., by = ${cv(p.columns)}, all.x = TRUE, sort = FALSE, allow.cartesian = TRUE)\n}`,
    tips: ['Newly added rows have NA in other columns. Add a missing-value step to replace them.']
  },
  {
    id: 'join', label: 'Join tables', category: 'Join & combine',
    description: 'Match keys with an inner, left, right, or full join.', functions: ['merge'],
    fields: [otherTable(), ...joinKeys(), select('how', 'Join type', 'left', [{value:'left',label:'Left: keep this table'},{value:'inner',label:'Inner: matching rows only'},{value:'full',label:'Full: keep both tables'},{value:'right',label:'Right: keep the other table'}]), check('cartesian', 'Allow many-to-many expansion')],
    defaults: c => ({leftKeys: firstNames(c, 1)}), validate: joinValidation,
    build: p => `merge(x = ., y = ${raw(p.table)}, by.x = ${cv(p.leftKeys)}, by.y = ${cv(parseColumns(p.rightKeys).length ? p.rightKeys : p.leftKeys)}, all.x = ${bool(['left', 'full'].includes(p.how))}, all.y = ${bool(['right', 'full'].includes(p.how))}, sort = FALSE, allow.cartesian = ${bool(p.cartesian)})`,
    tips: ['Check key uniqueness before enabling many-to-many expansion. Unmatched values become NA.']
  },
  {
    id: 'semi-join', label: 'Keep matching rows (semi join)', category: 'Join & combine',
    description: 'Keep rows with a match, without adding columns.', functions: ['[', 'unique'],
    fields: [otherTable(), ...joinKeys()],
    defaults: c => ({leftKeys: firstNames(c, 1)}), validate: joinValidation,
    build: p => `{ .[sort(unique(.[unique(as.data.table(${raw(p.table)}), by = ${cv(parseColumns(p.rightKeys).length ? p.rightKeys : p.leftKeys)}), on = ${onVector(p)}, nomatch = NULL, which = TRUE]))] }`
  },
  {
    id: 'anti-join', label: 'Keep unmatched rows (anti join)', category: 'Join & combine',
    description: 'Exclude rows whose keys appear in another table.', functions: ['['],
    fields: [otherTable(), ...joinKeys()],
    defaults: c => ({leftKeys: firstNames(c, 1)}), validate: joinValidation,
    build: p => `.[!(${raw(p.table)}), on = ${onVector(p)}]`
  },
  {
    id: 'rolling-join', label: 'Rolling lookup', category: 'Join & combine',
    description: 'Match the nearest preceding, following, or closest key.', functions: ['['],
    fields: [otherTable(), ...joinKeys(), select('roll', 'Roll unmatched keys', 'Inf', [{value:'Inf',label:'Previous value (Inf)'},{value:'-Inf',label:'Next value (-Inf)'},{value:'"nearest"',label:'Nearest value'}]), check('keepUnmatched', 'Keep unmatched query rows', true)],
    defaults: c => ({leftKeys: dateOf(c)}), validate: joinValidation,
    build: p => `.[${raw(p.table)}, on = ${onVector(p)}, roll = ${p.roll}, nomatch = ${p.keepUnmatched ? 'NA' : 'NULL'}]`,
    tips: ['The incoming table supplies lookup values; rows follow the other table. The last join key is the rolling key. For a bounded roll, edit the R code to use a numeric distance.']
  },
  {
    id: 'non-equi-join', label: 'Join by inequalities', category: 'Join & combine',
    description: 'Match rows using <, <=, >, or >= conditions.', functions: ['['],
    fields: [otherTable(), expr('on', 'Join conditions (R)', 'value >= lower, value <= upper', {required: true, help: 'For example value >= lower, value <= upper. Left names belong to this table; right names to the other table.'}), select('mult', 'When several rows match', 'all', ['all', 'first', 'last']), check('keepUnmatched', 'Keep unmatched query rows'), check('cartesian', 'Allow many-to-many expansion')],
    defaults: c => ({on: `${rName(numberOf(c))} >= lower, ${rName(numberOf(c))} <= upper`}),
    build: p => `.[${raw(p.table)}, on = .(${raw(p.on)}), mult = ${rString(p.mult)}, nomatch = ${p.keepUnmatched ? 'NA' : 'NULL'}, allow.cartesian = ${bool(p.cartesian)}]`,
    tips: ['Compute arithmetic expressions into columns before joining. Use x.column and i.column in a custom join to explicitly retain both sides of inequality keys.']
  },
  {
    id: 'update-join', label: 'Update from another table', category: 'Join & combine',
    description: 'Update matched rows by reference using i.column values.', functions: [':=', '[', '.EACHI'],
    fields: [otherTable(), ...joinKeys(), expr('assignments', 'Updates (R)', 'value = i.value', {required: true, help: 'Named updates such as price = i.price, label = i.label. Prefix other-table columns with i.'}), check('each', 'Aggregate separately for each match (.EACHI)')],
    defaults: c => ({leftKeys: firstNames(c, 1), assignments: `${rName(numberOf(c))} = ${rName(`i.${numberOf(c)}`)}`}), validate: joinValidation,
    build: p => `.[${raw(p.table)}, \`:=\`(${raw(p.assignments)}), on = ${onVector(p)}${p.each ? ', by = .EACHI' : ''}]`,
    tips: ['An update join keeps the rows and columns of this table. The other table supplies values for matched keys.']
  },
  {
    id: 'aggregate-join', label: 'Summarize each join match', category: 'Join & combine',
    description: 'Calculate grouped results for every row of a lookup table.', functions: ['[', '.EACHI', '.N'],
    fields: [otherTable(), ...joinKeys(), expr('expressions', 'Named summaries (R)', 'n = .N', {required: true}), check('keepUnmatched', 'Keep unmatched query rows', true)],
    defaults: c => ({leftKeys: firstNames(c, 1), expressions: `n = .N, total = sum(${rName(numberOf(c))}, na.rm = TRUE)`}), validate: joinValidation,
    build: p => `.[${raw(p.table)}, .(${raw(p.expressions)}), on = ${onVector(p)}, by = .EACHI, nomatch = ${p.keepUnmatched ? 'NA' : 'NULL'}]`
  },
  {
    id: 'overlap-join', label: 'Join overlapping intervals', category: 'Join & combine',
    description: 'Match overlapping ranges with foverlaps().', functions: ['foverlaps', 'setkeyv'],
    fields: [otherTable(), cols('leftKeys', 'This table: optional groups, start, end', 'start, end', {required: true}), cols('rightKeys', 'Other table: optional groups, start, end', 'start, end', {required: true}), select('type', 'Overlap rule', 'any', ['any', 'within', 'start', 'end', 'equal']), check('keepUnmatched', 'Keep unmatched rows', true)],
    validate: p => [...joinValidation(p), ...(parseColumns(p.leftKeys).length < 2 ? [{severity:'error',field:'leftKeys',message:'Choose at least a start and an end column, in that order.'}] : [])],
    build: p => `foverlaps(y = setkeyv(copy(as.data.table(${raw(p.table)})), ${cv(p.rightKeys)}), by.x = ${cv(p.leftKeys)}, by.y = ${cv(p.rightKeys)}, type = ${rString(p.type)}, nomatch = ${p.keepUnmatched ? 'NA' : 'NULL'})`,
    tips: ['The last two keys must be numeric or date interval endpoints, with start <= end. Optional grouping keys go before them. The other table is copied before keying.']
  },
  {
    id: 'cross-join', label: 'Combine every pair of rows', category: 'Join & combine',
    description: 'Create a Cartesian product of two tables.', functions: ['CJ', 'setnames'],
    fields: [otherTable()],
    build: p => `{\n  .tc_other <- as.data.table(${raw(p.table)})\n  .tc_pairs <- CJ(left = seq_len(nrow(.)), right = seq_len(nrow(.tc_other)))\n  .tc_out <- cbind(.[.tc_pairs$left], .tc_other[.tc_pairs$right])\n  setnames(.tc_out, make.unique(names(.tc_out)))\n  .tc_out\n}`,
    tips: ['Output rows equal the product of both row counts. Start with small tables. Duplicate column names receive numeric suffixes.']
  },
  {
    id: 'bind-rows', label: 'Stack tables (rbindlist)', category: 'Join & combine',
    description: 'Append rows, matching columns by name.', functions: ['rbindlist'],
    fields: [otherTable(), check('fill', 'Fill absent columns with NA', true), text('idColumn', 'Source-label column (optional)', '', {help:'If supplied, values are "current" and "other".'})],
    build: p => `{ rbindlist(list(current = ., other = ${raw(p.table)}), use.names = TRUE, fill = ${bool(p.fill)}${raw(p.idColumn) ? `, idcol = ${rString(p.idColumn)}` : ''}) }`
  },
  {
    id: 'bind-columns', label: 'Attach columns by row position', category: 'Join & combine',
    description: 'Combine columns of equally sized tables.', functions: ['cbind', 'setnames'],
    fields: [otherTable()],
    build: p => `{\n  .tc_other <- as.data.table(${raw(p.table)})\n  if (nrow(.) != nrow(.tc_other)) stop("Both tables must have the same number of rows for a column bind.")\n  .tc_out <- cbind(., .tc_other)\n  setnames(.tc_out, make.unique(names(.tc_out)))\n  .tc_out\n}`,
    tips: ['Rows match by position. Use a key-based join when row order may differ.']
  },
  {
    id: 'set-operation', label: 'Combine row sets', category: 'Join & combine',
    description: 'Intersect, union, or subtract whole rows.', functions: ['fintersect', 'funion', 'fsetdiff'],
    fields: [otherTable(), select('fun', 'Set operation', 'fintersect', [{value:'fintersect',label:'Intersection: rows in both'},{value:'funion',label:'Union: rows in either'},{value:'fsetdiff',label:'Difference: rows only here'}]), check('all', 'Keep duplicate multiplicities')],
    build: p => `${p.fun}(x = ., y = ${raw(p.table)}, all = ${bool(p.all)})`,
    tips: ['Both tables must have compatible columns. With duplicates enabled, intersection takes the smaller multiplicity and difference subtracts multiplicities.']
  },
  {
    id: 'merge-many', label: 'Merge several tables', category: 'Join & combine',
    description: 'Reduce a list of tables through a sequence of merges.', functions: ['merge', 'Reduce'],
    fields: [expr('tables', 'List of other tables (R)', 'list(lookup)', {required: true}), cols('columns', 'Shared key columns', 'id', {required: true}), select('how', 'Join type', 'left', ['left', 'inner', 'full'])],
    defaults: c => ({columns: firstNames(c, 1)}),
    build: p => `{ Reduce(function(x, y) merge(x, y, by = ${cv(p.columns)}, all.x = ${bool(p.how !== 'inner')}, all.y = ${bool(p.how === 'full')}, sort = FALSE), c(list(.), ${raw(p.tables)})) }`
  },
  {
    id: 'row-number', label: 'Add row numbers', category: 'Window & rank',
    description: 'Number rows, optionally restarting within each group.', functions: [':=', '.N'],
    fields: [newName('row_number'), groups()],
    build: p => assign(p.name, 'seq_len(.N)', p.groups)
  },
  {
    id: 'shift', label: 'Lag or lead a column', category: 'Window & rank',
    description: 'Add an earlier or later value using shift().', functions: ['shift'],
    fields: [col(), newName('lag_value'), select('type', 'Shift direction', 'lag', ['lag', 'lead']), number('n', 'Positions', 1, {required: true, integer: true}), text('fill', 'Fill value (R)', 'NA', {required: true}), groups()],
    defaults: c => ({column: numberOf(c), name: `${numberOf(c)}_lag`}),
    build: p => assign(p.name, `shift(${rName(p.column)}, n = ${p.n}L, fill = ${raw(p.fill)}, type = ${rString(p.type)})`, p.groups),
    tips: ['Sort first. Window functions follow the table\'s current row order.']
  },
  {
    id: 'rolling', label: 'Rolling summaries', category: 'Window & rank',
    description: 'Calculate moving means, totals, extrema, medians, or variation.', functions: ['frollmean', 'frollsum', 'frollmin', 'frollmax', 'frollprod', 'frollmedian', 'frollvar', 'frollsd'],
    fields: [col(), newName('rolling_value'), select('fun', 'Function', 'frollmean', ['frollmean', 'frollsum', 'frollmin', 'frollmax', 'frollprod', 'frollmedian', 'frollvar', 'frollsd']), number('n', 'Window size', 3, {required: true, min: 1, integer: true}), select('align', 'Align window', 'right', ['right', 'center', 'left']), check('removeNA', 'Ignore missing values', true), groups()],
    defaults: c => ({column: numberOf(c)}),
    build: p => assign(p.name, `${p.fun}(${rName(p.column)}, n = ${p.n}L, align = ${rString(p.align)}, na.rm = ${bool(p.removeNA)})`, p.groups),
    tips: ['Sort first. The window counts rows, not elapsed time. Incomplete windows are filled with NA.']
  },
  {
    id: 'rolling-apply', label: 'Custom rolling function', category: 'Window & rank',
    description: 'Run a custom summary on each moving window.', functions: ['frollapply'],
    fields: [col(), newName('rolling_value'), number('n', 'Window size', 3, {required: true, min: 1, integer: true}), expr('fun', 'Function (R)', 'function(x) sd(x, na.rm = TRUE)', {required: true}), select('align', 'Align window', 'right', ['right', 'center', 'left']), groups()],
    defaults: c => ({column: numberOf(c)}),
    build: p => assign(p.name, `frollapply(${rName(p.column)}, ${p.n}L, FUN = ${raw(p.fun)}, align = ${rString(p.align)})`, p.groups),
    tips: ['The function must return one number for each window. Sort the data before applying it.']
  },
  {
    id: 'rank', label: 'Rank values', category: 'Window & rank',
    description: 'Rank one or several columns, optionally within groups.', functions: ['frank', 'frankv'],
    fields: [cols('columns', 'Rank by', 'value', {required: true}), text('directions', 'Directions: 1 ascending, -1 descending', '1', {required: true}), newName('rank'), select('ties', 'Ties', 'dense', ['dense', 'average', 'min', 'max', 'first', 'last']), select('naLast', 'Missing values', 'keep', [{value:'keep',label:'Keep rank as NA'},{value:'TRUE',label:'Rank last'},{value:'FALSE',label:'Rank first'}]), groups()],
    defaults: c => ({columns: numberOf(c)}), validate: directionsValidation,
    build: p => `.[, ${rName(p.name)} := frankv(.SD, order = ${nvec(p.directions)}, ties.method = ${rString(p.ties)}, na.last = ${p.naLast === 'keep' ? '"keep"' : p.naLast})${group(p.groups)}, .SDcols = ${cv(p.columns)}]`
  },
  {
    id: 'run-id', label: 'Identify consecutive runs', category: 'Window & rank',
    description: 'Number consecutive runs of identical values.', functions: ['rleid', 'rleidv'],
    fields: [cols('columns', 'Compare columns', 'group', {required: true}), newName('run_id'), text('prefix', 'Text prefix (optional)')],
    defaults: c => ({columns: categoryOf(c)}),
    build: p => `.[, ${rName(p.name)} := rleidv(.SD${raw(p.prefix) ? `, prefix = ${rString(p.prefix)}` : ''}), .SDcols = ${cv(p.columns)}]`,
    tips: ['Runs depend on current row order. A value that reappears later starts a new run.']
  },
  {
    id: 'row-id', label: 'Number repeated key values', category: 'Window & rank',
    description: 'Count occurrences within every combination of key values.', functions: ['rowid', 'rowidv'],
    fields: [cols('columns', 'Key columns', 'group', {required: true}), newName('occurrence'), text('prefix', 'Text prefix (optional)')],
    defaults: c => ({columns: categoryOf(c)}),
    build: p => `.[, ${rName(p.name)} := rowidv(.SD${raw(p.prefix) ? `, prefix = ${rString(p.prefix)}` : ''}), .SDcols = ${cv(p.columns)}]`
  },
  {
    id: 'cumulative', label: 'Cumulative calculation', category: 'Window & rank',
    description: 'Add a running sum, product, minimum, maximum, or mean.', functions: [':=', '.N', 'cumsum', 'cumprod', 'cummin', 'cummax'],
    fields: [col(), newName('cumulative_value'), select('fun', 'Calculation', 'cumsum', [{value:'cumsum',label:'Running sum'},{value:'cumprod',label:'Running product'},{value:'cummin',label:'Running minimum'},{value:'cummax',label:'Running maximum'},{value:'mean',label:'Running mean'}]), groups()],
    defaults: c => ({column: numberOf(c)}),
    build: p => assign(p.name, p.fun === 'mean' ? `cumsum(${rName(p.column)}) / seq_len(.N)` : `${p.fun}(${rName(p.column)})`, p.groups),
    tips: ['Sort first. An NA propagates through later cumulative values; fill missing values beforehand if needed.']
  },
  {
    id: 'difference', label: 'Change from the previous row', category: 'Window & rank',
    description: 'Calculate an absolute or relative change using shift().', functions: ['shift'],
    fields: [col(), newName('change'), select('kind', 'Change type', 'absolute', [{value:'absolute',label:'Difference'},{value:'relative',label:'Relative change'}]), number('n', 'Look back this many rows', 1, {required: true, integer: true, min: 1}), groups()],
    defaults: c => ({column: numberOf(c)}),
    build: p => assign(p.name, p.kind === 'relative' ? `${rName(p.column)} / shift(${rName(p.column)}, ${p.n}L) - 1` : `${rName(p.column)} - shift(${rName(p.column)}, ${p.n}L)`, p.groups)
  },
  {
    id: 'fill-na', label: 'Fill missing values', category: 'Missing values',
    description: 'Fill numeric columns with a constant or adjacent values.', functions: ['nafill'],
    fields: [cols('columns', 'Numeric columns', 'value', {required: true}), select('type', 'Fill method', 'const', [{value:'const',label:'Constant'},{value:'locf',label:'Last observation carried forward'},{value:'nocb',label:'Next observation carried backward'}]), text('fill', 'Constant or edge fill (R)', '0', {required: true}), groups()],
    defaults: c => ({columns: numberOf(c)}),
    build: p => `.[, (${cv(p.columns)}) := nafill(.SD, type = ${rString(p.type)}, fill = ${raw(p.fill)})${group(p.groups)}, .SDcols = ${cv(p.columns)}]`,
    tips: ['nafill() supports integer and double columns. Sort first when carrying values forward or backward.']
  },
  {
    id: 'set-nafill', label: 'Fill missing values by reference', category: 'Missing values',
    description: 'Use setnafill() directly on selected numeric columns.', functions: ['setnafill'],
    fields: [cols('columns', 'Numeric columns', 'value', {required: true}), select('type', 'Fill method', 'const', ['const', 'locf', 'nocb']), text('fill', 'Constant or edge fill (R)', '0', {required: true})],
    defaults: c => ({columns: numberOf(c)}),
    build: p => `setnafill(type = ${rString(p.type)}, fill = ${raw(p.fill)}, cols = ${cv(p.columns)})`
  },
  {
    id: 'coalesce', label: 'Choose the first non-missing value', category: 'Missing values',
    description: 'Combine compatible columns with fcoalesce().', functions: ['fcoalesce'],
    fields: [cols('columns', 'Try columns in this order', 'value, backup', {required: true}), newName('coalesced'), expr('fallback', 'Final fallback (R, optional)', '', {help: 'For example 0 for numeric, 0L for integer, or "unknown" for character. Use the same type as the columns.'})],
    defaults: c => ({columns: firstNames(c, 1)}),
    build: p => assign(p.name, `fcoalesce(${parseColumns(p.columns).map(rName).join(', ')}${raw(p.fallback) ? `, ${raw(p.fallback)}` : ''})`),
    tips: ['Input vectors must have compatible types and classes. Columns are tried from left to right.']
  },
  {
    id: 'if-else', label: 'Create a conditional value', category: 'Missing values',
    description: 'Choose values with type-stable fifelse().', functions: ['fifelse'],
    fields: [newName('flag'), expr('condition', 'If (R condition)', 'value > 0', {required: true}), expr('yes', 'Then (R)', '"positive"', {required: true}), expr('no', 'Otherwise (R)', '"other"', {required: true}), expr('na', 'When condition is NA (R)', 'NA_character_', {required: true}), groups()],
    defaults: c => ({condition: `${rName(numberOf(c))} > 0`}),
    build: p => assign(p.name, `fifelse(${raw(p.condition)}, ${raw(p.yes)}, ${raw(p.no)}, na = ${raw(p.na)})`, p.groups),
    tips: ['The yes, no, and NA values must use compatible types. Unlike base ifelse(), attributes are preserved.']
  },
  {
    id: 'case', label: 'Create values from several rules', category: 'Missing values',
    description: 'Evaluate ordered condition/value pairs using fcase().', functions: ['fcase'],
    fields: [newName('category'), expr('cases', 'Condition, value pairs (R)', 'value >= 10, "high", value >= 0, "low"', {required: true}), expr('fallback', 'Default value (R)', 'NA_character_', {required: true}), groups()],
    defaults: c => ({cases: `${rName(numberOf(c))} >= 10, "high", ${rName(numberOf(c))} >= 0, "low"`}),
    build: p => assign(p.name, `fcase(${raw(p.cases)}, default = ${raw(p.fallback)})`, p.groups),
    tips: ['The first matching condition wins. Values and the default must use compatible types.']
  },
  {
    id: 'split-text', label: 'Split a text column', category: 'Text & dates',
    description: 'Create columns from text components using tstrsplit().', functions: ['tstrsplit'],
    fields: [col(), text('separator', 'Separator or regular expression', '-', {required: true}), cols('names', 'Output column names', 'part_1', {required: true}), text('keep', 'Part positions to keep (R)', '1L', {required: true, help: 'For example 1L or c(1L, 3L). Supply one output name per selected part.'}), check('fixed', 'Use literal separator', true), check('convert', 'Convert numeric-looking parts', true)],
    defaults: c => ({column: categoryOf(c)}),
    build: p => `.[, (${cv(p.names)}) := tstrsplit(${rName(p.column)}, ${rString(p.separator)}, fixed = ${bool(p.fixed)}, keep = ${raw(p.keep)}, type.convert = ${bool(p.convert)})]`
  },
  {
    id: 'text-transform', label: 'Clean or replace text', category: 'Text & dates',
    description: 'Trim whitespace, change case, or replace a pattern.', functions: [':='],
    fields: [col(), newName('clean_text'), select('fun', 'Action', 'trimws', [{value:'trimws',label:'Trim whitespace'},{value:'tolower',label:'Lowercase'},{value:'toupper',label:'Uppercase'},{value:'gsub',label:'Replace a regular expression'}]), text('pattern', 'Find pattern (replace only)', '\\s+'), text('replacement', 'Replace with', ' ')],
    defaults: c => ({column: categoryOf(c)}),
    build: p => assign(p.name, p.fun === 'gsub' ? `gsub(${rString(p.pattern)}, ${rString(p.replacement)}, as.character(${rName(p.column)}), perl = TRUE)` : `${p.fun}(as.character(${rName(p.column)}))`)
  },
  {
    id: 'date', label: 'Parse a date or time', category: 'Text & dates',
    description: 'Create integer-backed IDate or ITime values.', functions: ['as.IDate', 'as.ITime'],
    fields: [col(), newName('parsed_date'), select('kind', 'Parse as', 'as.IDate', [{value:'as.IDate',label:'Date (IDate)'},{value:'as.ITime',label:'Time of day (ITime)'}]), text('format', 'Input format (optional)', '', {help:'For example %d/%m/%Y for a date, or %H:%M:%S for a time. Blank uses the R default.'})],
    defaults: c => ({column: dateOf(c)}),
    build: p => assign(p.name, `${p.kind}(${rName(p.column)}${raw(p.format) ? `, format = ${rString(p.format)}` : ''})`)
  },
  {
    id: 'date-part', label: 'Extract a date or time part', category: 'Text & dates',
    description: 'Extract year, quarter, month, week, or time components.', functions: ['year', 'quarter', 'month', 'week', 'isoweek', 'isoyear', 'yday', 'mday', 'wday', 'hour', 'minute', 'second', 'yearmon', 'yearqtr'],
    fields: [col(), newName('month'), select('part', 'Component', 'month', ['year', 'quarter', 'month', 'week', 'isoweek', 'isoyear', 'yday', 'mday', 'wday', 'hour', 'minute', 'second', 'yearmon', 'yearqtr'])],
    defaults: c => ({column: dateOf(c)}),
    build: p => assign(p.name, `${p.part}(${rName(p.column)})`),
    tips: ['Use a Date, IDate, POSIXct, or other supported date-time column. Parse text first when necessary.']
  },
  {
    id: 'lookup-position', label: 'Match text to a lookup vector', category: 'Text & dates',
    description: 'Get first-match positions with fast character matching.', functions: ['chmatch', 'chmatchdup', '%chin%'],
    fields: [col(), newName('match_position'), expr('values', 'Lookup values (R character vector)', 'c("North", "South", "East", "West")', {required: true}), check('duplicates', 'Match duplicate occurrences separately')],
    defaults: c => ({column: categoryOf(c)}),
    build: p => assign(p.name, `${p.duplicates ? 'chmatchdup' : 'chmatch'}(as.character(${rName(p.column)}), ${raw(p.values)}, nomatch = NA_integer_)`)
  },
  {
    id: 'profile', label: 'Profile columns', category: 'Advanced',
    description: 'Replace the result with a column-level quality summary.', functions: ['data.table', 'uniqueN'],
    fields: [],
    build: () => `{\n  data.table(\n    column = names(.),\n    type = vapply(., function(x) paste(class(x), collapse = "/"), character(1L)),\n    missing = vapply(., function(x) sum(is.na(x)), numeric(1L)),\n    distinct = vapply(., function(x) if (is.list(x)) length(unique(x)) else uniqueN(x), numeric(1L))\n  )\n}`
  },
  {
    id: 'copy', label: 'Copy the current table', category: 'Advanced',
    description: 'Make an explicit independent copy at this point.', functions: ['copy'],
    fields: [], build: () => 'copy()',
    tips: ['Tablecraft already copies the source before running a pipeline. Add this when an explicit extra copy is useful.']
  },
  {
    id: 'assert', label: 'Assert a custom condition', category: 'Assertions',
    description: 'Check any R condition with stopifnot() and keep the table unchanged.', functions: ['stopifnot', '[', 'uniqueN'],
    fields: [expr('condition', 'Must be TRUE (R)', 'nrow(.) > 0L', {required: true, help: 'Use . for the current table, e.g. uniqueN(.$id) == nrow(.) or all(.$value >= 0).'}), text('message', 'Error message', 'The table must contain at least one row.', {required: true})],
    build: p => `{\n  stopifnot(${rString(p.message)} = (${raw(p.condition)}))\n  .\n}`
  },
  ...createAssertionOperations({rName, rString, parseColumns}),
  {
    id: 'custom-bracket', label: 'Custom data.table expression', category: 'Advanced',
    description: 'Control i, j, and additional [.data.table arguments directly.', functions: ['[', ':=', '.SD', '.I', '.BY', '.GRP', '.N', '.EACHI'],
    fields: [expr('i', 'i: select rows (optional)'), expr('j', 'j: calculate or select (R)', '.SD', {required: true}), expr('arguments', 'Additional arguments (R, optional)', '', {help:'For example by = .(region), .SDcols = is.numeric, or on = .(id), nomatch = NULL.'})],
    build: p => `.[${raw(p.i)}, ${raw(p.j)}${raw(p.arguments) ? `, ${raw(p.arguments)}` : ''}]`
  },
  {
    id: 'custom', label: 'Custom R pipe step', category: 'Advanced',
    description: 'Use any R expression that returns the next table.', functions: ['%>%', '[', 'data.table'],
    fields: [expr('expression', 'Pipe step (R)', '.[]', {required: true, help: 'One pipe right-hand side. Use . for the table. For nested uses, write { your_expression(.) }. Return a table.'})],
    build: p => raw(p.expression),
    tips: ['A brace block prevents magrittr from inserting the incoming table as an additional first argument. This is useful for nested functions and multi-statement steps.']
  },
  {
    id: 'script', label: 'Preserved R script', category: 'Advanced', standalone:true,
    description: 'Edit a complete R script without changing its setup, expressions or output.', functions:['eval'],
    fields:[expr('code','Complete R script','as.data.table(iris)', {required:true, help:'The full script is preserved exactly. Edit here or in Text mode. Start a new pipeline to add separate transformation steps.'})],
    build:p => String(p.code ?? ''),
    tips:['This card keeps arbitrary R synchronized without attempting an unsafe conversion into pipeline forms.']
  }
];

// A recovered form can retain the explicitly qualified function it came from.
// Replace only its generated primary call, leaving raw expression fields and
// their independently qualified or masked calls untouched.
OPERATIONS.forEach(operation => {
  const build = operation.build;
  operation.build = (params, context) => {
    const code = build(params, context), reference = params?.rFunction;
    if (!reference?.name || !reference?.reference) return code;
    const parts = significantTokens(reference.reference);
    if (parts.length !== 3 || parts[0].type !== 'name' || !['::',':::'].includes(parts[1].value) || parts[2].type !== 'name') return code;
    const choice = {'head-tail':params.end, rolling:params.fun, 'set-operation':params.fun,
      date:params.kind, 'date-part':params.part, cumulative:params.fun === 'mean' ? 'cumsum' : params.fun,
      'clear-key':params.kind === 'index' ? 'setindexv' : 'setkeyv'}[operation.id];
    const name = choice || reference.name;
    const qualified = name === reference.name ? reference.reference : `${parts[0].value}${parts[1].value}${rName(name)}`;
    const tokens = significantTokens(code);
    const token = tokens.find((item,index) => item.type === 'name' && item.name === name &&
      tokens[index + 1]?.value === '(' && !['::',':::'].includes(tokens[index - 1]?.value));
    return token ? code.slice(0,token.start) + qualified + code.slice(token.end) : code;
  };
});

export function operationDocumentation(operation) {
  const op = typeof operation === 'string' ? OPERATIONS.find(item => item.id === operation) : operation;
  return [...new Set(op?.functions || [])].map(name => ({name, url:documentationFor(name)}));
}

function columnsByKind(columns = [], pattern) {
  return columns.filter(c => pattern.test(String(c.type || c.class || ''))).map(c => c.name);
}

// Helper snippets can be inserted in the editor. They are expressions, not
// automatically complete pipeline steps. Place them inside i, j, or a block.
const H = (name, category, signature, description, example) => ({name, category, signature, description, example});
export const HELPERS = [
  H('stopifnot', 'Assertions', 'stopifnot(..., exprs)', 'Stop if any assertion is not completely TRUE. Named conditions provide useful failure messages; return . to continue a pipeline.', '{ stopifnot("Expected rows" = nrow(.) > 0L); . }'),
  H('fread', 'Import & export', 'fread(file, sep = "auto", header = "auto", ...)', 'Read delimited text quickly. Import CSV/TSV from the Data panel, or use fread() on files in the R filesystem.', 'fread("data.csv", na.strings = c("", "NA"))'),
  H('fwrite', 'Import & export', 'fwrite(x, file, sep = ",", ...)', 'Write delimited data. The Export result control downloads the result; a direct fwrite() call writes inside webR.', 'fwrite(result, "result.csv")'),
  H('data.table', 'Construct & copy', 'data.table(...)', 'Construct a table from columns.', 'data.table(id = 1:3, value = c(10, 20, 30))'),
  H('as.data.table', 'Construct & copy', 'as.data.table(x, ...)', 'Convert a data.frame, matrix, or list into a data.table.', 'as.data.table(iris)'),
  H('setDT', 'Construct & copy', 'setDT(x, keep.rownames = FALSE)', 'Convert a data.frame or list by reference.', 'setDT(x)'),
  H('setDF', 'Construct & copy', 'setDF(x)', 'Convert to a base data.frame by reference. Convert back before another data.table step.', 'setDF(copy(result))'),
  H('copy', 'Construct & copy', 'copy(x)', 'Make an independent copy before modifying data by reference.', 'copy(source_dt)'),
  H('is.data.table', 'Construct & copy', 'is.data.table(x)', 'Check whether an object is a data.table.', 'is.data.table(result)'),
  H('[', 'Core syntax', 'DT[i, j, by]', 'Filter in i, calculate/select in j, and group in by.', '.[units > 1, .(total = sum(units)), by = .(region)]'),
  H(':=', 'Core syntax', 'DT[i, name := value, by]', 'Create, update, or remove columns by reference.', '.[, revenue := units * unit_price]'),
  H('.N', 'Core syntax', '.N', 'The row count of the current table or group.', '.[, .(n = .N), by = .(region)]'),
  H('.SD', 'Core syntax', '.SD', 'The data subset for the current group, excluding grouping columns.', '.[, lapply(.SD, mean), by = .(region), .SDcols = is.numeric]'),
  H('.SDcols', 'Core syntax', '.SDcols = columns', 'Choose the columns included in .SD using names, positions, patterns, or a predicate.', '.SDcols = c("units", "unit_price")'),
  H('.I', 'Core syntax', '.I', 'Row positions in the original table, available in j.', '.[, .(row = .I[which.max(units)]), by = .(region)]'),
  H('.GRP', 'Core syntax', '.GRP', 'An integer identifier for the current group.', '.[, group_id := .GRP, by = .(region)]'),
  H('.BY', 'Core syntax', '.BY', 'A named list of the current grouping values.', '.[, .(group_label = as.character(.BY[[1L]]), n = .N), by = .(region)]'),
  H('.EACHI', 'Core syntax', 'by = .EACHI', 'Aggregate separately for each row of the table supplied to i in a join.', '.[lookup, .(n = .N), on = .(id), by = .EACHI]'),
  H('keyby', 'Core syntax', 'keyby = columns', 'Group and key the output, returning sorted group keys.', '.[, .(n = .N), keyby = .(region)]'),
  H('set', 'By-reference updates', 'set(x, i = NULL, j, value)', 'Low-overhead assignment using row positions and literal column names.', '{ set(., j = "flag", value = TRUE); . }'),
  H('setnames', 'By-reference updates', 'setnames(x, old, new)', 'Rename columns by reference.', 'setnames(old = "units", new = "quantity")'),
  H('setcolorder', 'By-reference updates', 'setcolorder(x, neworder)', 'Move named columns to the chosen order by reference.', 'setcolorder(neworder = c("region", "product"))'),
  H('setattr', 'By-reference updates', 'setattr(x, name, value)', 'Set an object attribute by reference.', '{ setattr(., "note", "Reviewed"); . }'),
  H('setkey', 'Keys & sorting', 'setkey(x, ...)', 'Sort by unquoted columns and mark them as the table key.', 'setkey(region, product)'),
  H('setkeyv', 'Keys & sorting', 'setkeyv(x, cols)', 'Set the key using literal column names.', 'setkeyv(cols = c("region", "product"))'),
  H('key', 'Keys & sorting', 'key(x)', 'Return the table key column names.', 'key(result)'),
  H('haskey', 'Keys & sorting', 'haskey(x)', 'Check whether a table has a key.', 'haskey(result)'),
  H('setindex', 'Keys & sorting', 'setindex(x, ...)', 'Add a secondary index without changing row order.', 'setindex(region)'),
  H('setindexv', 'Keys & sorting', 'setindexv(x, cols)', 'Add indexes using literal column names.', 'setindexv(cols = c("region", "product"))'),
  H('indices', 'Keys & sorting', 'indices(x)', 'List secondary indexes.', 'indices(result)'),
  H('setorder', 'Keys & sorting', 'setorder(x, ..., na.last = FALSE)', 'Sort by unquoted columns; prefix a column with - for descending.', 'setorder(region, -units)'),
  H('setorderv', 'Keys & sorting', 'setorderv(x, cols, order = 1L)', 'Sort using literal column names and 1/-1 directions.', 'setorderv(cols = c("region", "units"), order = c(1L, -1L))'),
  H('between', 'Filter & match', 'between(x, lower, upper, incbounds = TRUE)', 'Test whether each value is within bounds.', 'between(units, 2, 10)'),
  H('%between%', 'Filter & match', 'x %between% c(lower, upper)', 'An inclusive range test in infix form.', 'units %between% c(2, 10)'),
  H('inrange', 'Filter & match', 'inrange(x, lower, upper)', 'Test membership in any of several intervals.', 'inrange(units, c(1, 10), c(3, 15))'),
  H('%inrange%', 'Filter & match', 'x %inrange% list(lower, upper)', 'An infix test against multiple ranges.', 'units %inrange% list(c(1, 10), c(3, 15))'),
  H('like', 'Filter & match', 'like(x, pattern, ignore.case = FALSE, fixed = FALSE)', 'Match character or factor values with a regular expression.', 'like(product, "^Pro", ignore.case = TRUE)'),
  H('%like%', 'Filter & match', 'x %like% pattern', 'Case-sensitive regular-expression matching.', 'product %like% "^Pro"'),
  H('%ilike%', 'Filter & match', 'x %ilike% pattern', 'Case-insensitive regular-expression matching.', 'product %ilike% "pro"'),
  H('%flike%', 'Filter & match', 'x %flike% text', 'Match a literal substring.', 'product %flike% "."'),
  H('%plike%', 'Filter & match', 'x %plike% pattern', 'Use a Perl-compatible regular expression.', 'product %plike% "\\\\bPro\\\\b"'),
  H('%chin%', 'Filter & match', 'x %chin% table', 'Fast membership test for character vectors.', 'region %chin% c("North", "West")'),
  H('chmatch', 'Filter & match', 'chmatch(x, table, nomatch = NA_integer_)', 'Find first matching positions for character values.', 'chmatch(region, c("North", "South", "East", "West"))'),
  H('chmatchdup', 'Filter & match', 'chmatchdup(x, table, nomatch = NA_integer_)', 'Match duplicate character occurrences without reusing a matched position.', 'chmatchdup(c("a", "a"), c("a", "b", "a"))'),
  H('chorder', 'Filter & match', 'chorder(x)', 'Order a character vector efficiently.', 'chorder(region)'),
  H('chgroup', 'Filter & match', 'chgroup(x)', 'Return positions that group identical character values together.', 'chgroup(region)'),
  H('unique', 'Distinct & sets', 'unique(x, by = names(x), fromLast = FALSE)', 'Keep the first or last occurrence for each selected key.', 'unique(by = c("region", "product"))'),
  H('duplicated', 'Distinct & sets', 'duplicated(x, by = names(x))', 'Mark duplicate rows or duplicate keys.', 'duplicated(., by = "order_id")'),
  H('anyDuplicated', 'Distinct & sets', 'anyDuplicated(x, by = names(x))', 'Return the first duplicate position, or zero.', 'anyDuplicated(result, by = "order_id")'),
  H('uniqueN', 'Distinct & sets', 'uniqueN(x, by, na.rm = FALSE)', 'Count unique values or rows without creating a full unique table.', 'uniqueN(customer_id)'),
  H('fintersect', 'Distinct & sets', 'fintersect(x, y, all = FALSE)', 'Return whole rows present in both tables.', 'fintersect(y = other)'),
  H('funion', 'Distinct & sets', 'funion(x, y, all = FALSE)', 'Return whole rows present in either table.', 'funion(y = other)'),
  H('fsetdiff', 'Distinct & sets', 'fsetdiff(x, y, all = FALSE)', 'Return rows present in the first table but absent from the second.', 'fsetdiff(y = other)'),
  H('fsetequal', 'Distinct & sets', 'fsetequal(x, y, all = TRUE)', 'Test whether tables contain the same rows, optionally ignoring multiplicities.', 'fsetequal(result, other, all = FALSE)'),
  H('first', 'Aggregate', 'first(x, n = 1L)', 'Take the first value or first n values.', 'first(unit_price)'),
  H('last', 'Aggregate', 'last(x, n = 1L)', 'Take the last value or last n values.', 'last(unit_price)'),
  H('shift', 'Windows & ranks', 'shift(x, n = 1L, fill = NA, type = "lag")', 'Compute fast lag or lead vectors, including several offsets.', 'shift(units, n = 1L, type = "lag")'),
  H('frollmean', 'Windows & ranks', 'frollmean(x, n, align = "right", na.rm = FALSE)', 'Calculate a rolling mean over a fixed number of rows.', 'frollmean(units, n = 3L, na.rm = TRUE)'),
  H('frollsum', 'Windows & ranks', 'frollsum(x, n, align = "right", na.rm = FALSE)', 'Calculate a rolling sum over a fixed number of rows.', 'frollsum(units, n = 3L, na.rm = TRUE)'),
  ...[
    ['frollmin', 'minimum'], ['frollmax', 'maximum'], ['frollprod', 'product'],
    ['frollmedian', 'median'], ['frollvar', 'variance'], ['frollsd', 'standard deviation']
  ].map(([name, summary]) => H(name, 'Windows & ranks', `${name}(x, n, align = "right", na.rm = FALSE)`, `Calculate a rolling ${summary}. Requires a recent data.table release.`, `${name}(units, n = 3L, na.rm = TRUE)`)),
  H('frollapply', 'Windows & ranks', 'frollapply(X, N, FUN, ..., align = "right")', 'Run a scalar-returning function on each rolling window.', 'frollapply(units, 3L, FUN = function(x) sd(x, na.rm = TRUE))'),
  H('frolladapt', 'Windows & ranks', 'frolladapt(x, n, align = "right", partial = FALSE)', 'Build time-aware window sizes from a sorted, unique index with no missing values. This recent API is experimental upstream.', 'frollmean(units, frolladapt(date, n = 7L, partial = TRUE), adaptive = TRUE)'),
  H('frank', 'Windows & ranks', 'frank(x, ..., ties.method = "average")', 'Fast ranks, including dense ranks and descending columns.', 'frank(units, ties.method = "dense")'),
  H('frankv', 'Windows & ranks', 'frankv(x, cols, order = 1L, ties.method = "average")', 'Rank multiple columns using a vector of names and directions.', 'frankv(.SD, order = -1L, ties.method = "dense")'),
  H('rleid', 'Windows & ranks', 'rleid(..., prefix = NULL)', 'Identify consecutive runs across one or more vectors.', 'rleid(region, product)'),
  H('rleidv', 'Windows & ranks', 'rleidv(x, cols = seq_along(x), prefix = NULL)', 'Identify consecutive runs using selected table columns.', 'rleidv(.SD)'),
  H('rowid', 'Windows & ranks', 'rowid(..., prefix = NULL)', 'Number occurrences within each value combination.', 'rowid(region, product)'),
  H('rowidv', 'Windows & ranks', 'rowidv(x, cols = seq_along(x), prefix = NULL)', 'Number key occurrences using selected table columns.', 'rowidv(.SD)'),
  H('nafill', 'Missing & conditions', 'nafill(x, type = "const", fill = NA)', 'Fill missing integer or double values with a constant, locf, or nocb.', 'nafill(units, type = "locf")'),
  H('setnafill', 'Missing & conditions', 'setnafill(x, type = "const", fill = NA, cols)', 'Fill missing values in place.', 'setnafill(type = "const", fill = 0, cols = "units")'),
  H('na.omit', 'Missing & conditions', 'na.omit(x, cols, invert = FALSE)', 'Remove rows missing values in selected columns.', 'na.omit(cols = c("units", "unit_price"))'),
  H('fcoalesce', 'Missing & conditions', 'fcoalesce(...)', 'Choose the first non-missing value across compatible vectors.', 'fcoalesce(primary_value, backup_value)'),
  H('fifelse', 'Missing & conditions', 'fifelse(test, yes, no, na = NA)', 'A fast conditional that preserves value types and attributes.', 'fifelse(units > 5, "large", "small", na = NA_character_)'),
  H('fcase', 'Missing & conditions', 'fcase(condition, value, ..., default = NA)', 'Select a value using the first matching condition.', 'fcase(units >= 10, "large", units >= 5, "medium", default = "small")'),
  H('melt', 'Reshape', 'melt(data, id.vars, measure.vars, ...)', 'Reshape wide columns into long rows.', 'melt(id.vars = "region", measure.vars = c("units", "unit_price"))'),
  H('dcast', 'Reshape', 'dcast(data, formula, value.var, fun.aggregate, ...)', 'Reshape category values into columns and optionally aggregate.', 'dcast(formula = region ~ product, value.var = "units", fun.aggregate = sum)'),
  H('patterns', 'Reshape', 'patterns(..., cols)', 'Match column names by regular expression; usable in melt() and .SDcols.', 'patterns("^sales", "^cost")'),
  H('measure', 'Reshape', 'measure(..., sep = "_", pattern, cols)', 'Capture metadata from column names while melting. Availability depends on the installed data.table version.', 'measure(value.name, period, sep = "_")'),
  H('measurev', 'Reshape', 'measurev(fun.list, sep = "_", pattern, cols)', 'Programmatic form of measure() using a named list of capture conversions.', 'measurev(list(value.name = NULL, period = as.integer), sep = "_")'),
  H('transpose', 'Reshape', 'transpose(l, fill = NA, keep.names = NULL, make.names = NULL)', 'Swap rows and columns of a list or table.', 'transpose(keep.names = "column")'),
  H('tstrsplit', 'Reshape', 'tstrsplit(x, split, ..., keep, type.convert = FALSE)', 'Split text and transpose the pieces into columns.', 'tstrsplit(product_code, "-", fixed = TRUE, keep = c(1L, 2L))'),
  H('CJ', 'Join & combine', 'CJ(..., sorted = TRUE, unique = FALSE)', 'Construct a cross-product table of supplied vectors.', 'CJ(region = c("North", "South"), month = 1:12)'),
  H('J', 'Join & combine', 'J(...)', 'Construct values for a keyed join in the i position.', '.[J("North")]'),
  H('SJ', 'Join & combine', 'SJ(...)', 'Construct and sort a join table.', 'SJ(region = c("North", "South"))'),
  H('merge', 'Join & combine', 'merge(x, y, by, all = FALSE, ...)', 'Join two tables with shared or separately named keys.', 'merge(y = lookup, by.x = "customer_id", by.y = "id", all.x = TRUE, sort = FALSE)'),
  H('mergelist', 'Join & combine', 'mergelist(l, on, how = "left", mult, join.many)', 'Merge a list of tables sequentially. This recent API is experimental upstream.', '{ mergelist(list(., other), on = "id", how = "left", mult = "all", join.many = FALSE) }'),
  H('setmergelist', 'Join & combine', 'setmergelist(l, on, how = "left", mult, join.many)', 'Merge a list while avoiding copies where possible. The example copies inputs to protect other tables. This recent API is experimental upstream.', '{ setmergelist(lapply(list(., other), copy), on = "id", how = "left") }'),
  H('foverlaps', 'Join & combine', 'foverlaps(x, y, by.x, by.y, type = "any", ...)', 'Join overlapping numeric intervals. The y table must be keyed.', 'foverlaps(y = lookup, by.x = c("start", "end"), by.y = c("start", "end"))'),
  H('rbindlist', 'Join & combine', 'rbindlist(l, use.names = TRUE, fill = FALSE, idcol = NULL)', 'Efficiently stack a list of tables.', '{ rbindlist(list(., other), use.names = TRUE, fill = TRUE) }'),
  H('as.IDate', 'Dates & times', 'as.IDate(x, ...)', 'Convert to an integer-backed Date class.', 'as.IDate(date, format = "%Y-%m-%d")'),
  H('as.ITime', 'Dates & times', 'as.ITime(x, ...)', 'Convert a time of day to integer seconds.', 'as.ITime(time, format = "%H:%M:%S")'),
  H('IDateTime', 'Dates & times', 'IDateTime(x, ...)', 'Split a timestamp into paired idate and itime columns.', 'IDateTime(timestamp)'),
  ...[
    ['year', 'Calendar year'], ['quarter', 'Calendar quarter, 1 to 4'], ['month', 'Calendar month, 1 to 12'],
    ['week', 'Week of year'], ['isoweek', 'ISO week number'], ['isoyear', 'ISO week-numbering year'], ['yday', 'Day of year'],
    ['mday', 'Day of month'], ['wday', 'Day of week, with Sunday as 1'], ['hour', 'Hour of day'],
    ['minute', 'Minute component'], ['second', 'Second component'], ['yearmon', 'Year and month'], ['yearqtr', 'Year and quarter']
  ].map(([name, description]) => H(name, 'Dates & times', `${name}(x)`, description + ' from a date-time vector.', `${name}(date)`)),
  H('setDTthreads', 'Performance', 'setDTthreads(threads = NULL, percent = NULL)', 'Control data.table threading. Browser WebAssembly builds may be limited to a single thread.', 'setDTthreads(1L)'),
  H('getDTthreads', 'Performance', 'getDTthreads(verbose = FALSE)', 'Inspect the available data.table thread count.', 'getDTthreads()'),
  H('tables', 'Inspect', 'tables()', 'Summarize data.tables in an R environment.', 'tables()'),
  H('address', 'Inspect', 'address(x)', 'Inspect an object address when studying reference semantics.', 'address(result)'),
  H('truelength', 'Inspect', 'truelength(x)', 'Inspect allocated storage slots, useful when studying column allocation.', 'truelength(result)'),
  H('setalloccol', 'Performance', 'setalloccol(DT, n)', 'Reserve column pointer slots before many by-reference additions.', 'setalloccol(n = 1024L)')
];

export const CATEGORIES = [...new Set(OPERATIONS.map(op => op.category))];
export const findOperation = (id) => OPERATIONS.find(op => op.id === id);
