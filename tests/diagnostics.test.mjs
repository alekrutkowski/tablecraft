import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight, explainError } from '../js/diagnostics.js';

test('preflight ignores delimiters and pipes inside comments, strings, and backticks', () => {
  const code = [
    '# ] } ( %>%',
    'result <- DT %>% .[, `odd]name` := "a # b ] } ("]',
    'pipe <- `%>%`',
    'label <- \'an unmatched [ in text\'',
    'result',
  ].join('\n');
  assert.deepEqual(preflight(code), []);
});

test('preflight handles escaped quotes and backslashes without losing string state', () => {
  const code = String.raw`x <- "a \\\" [ and # text"
y <- "C:\\folder\\file.csv"
DT[, value := x]`;
  assert.deepEqual(preflight(code), []);
});

test('preflight recognizes R raw strings, including custom dash delimiters', () => {
  const code = [
    'a <- r"(a # ] \' " ( text)"',
    'b <- R"--{a # ] ) " \\ }--"',
    'c <- r"[literal %>% and ( ]"',
    'DT[, label := a]',
  ].join('\n');
  assert.deepEqual(preflight(code), []);
});

test('preflight skips special infix operator names', () => {
  assert.deepEqual(preflight('x %[% y\nx %custom)#% y'), []);
});

test('preflight reports the source location of an unclosed delimiter', () => {
  const issues = preflight('x <- 1 # ]\nresult <- DT %>%\n  .[, sum(x)');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 3);
  assert.equal(issues[0].column, 4);
  assert.match(issues[0].message, /closing \]/);
  assert.equal(issues[0].severity, 'warning');
});

test('preflight identifies mismatched and extra closing delimiters', () => {
  assert.match(preflight('DT[, sum(x]')[0].message, /Expected \)/);
  assert.match(preflight('result)')[0].message, /no opening/);
});

test('unfinished normal strings, backtick names, and raw strings are explained', () => {
  assert.match(preflight('x <- "unfinished')[0].message, /quoted string/);
  assert.match(preflight('DT[, `odd name')[0].message, /column name/);
  const raw = preflight('x <- r"---(unfinished');
  assert.match(raw[0].message, /raw string/);
  assert.ok(raw[0].tip.includes(')---"'));
});

test('missing pipe RHS is found across comments and before a closing delimiter', () => {
  const trailing = preflight('DT %>% # another step goes here\n');
  assert.equal(trailing.length, 1);
  assert.equal(trailing[0].line, 1);
  assert.equal(trailing[0].column, 4);
  assert.match(trailing[0].message, /pipe needs another/);
  assert.match(preflight('identity(DT %>%)')[0].message, /pipe needs another/);
  assert.deepEqual(preflight('DT %>%\n { .[, .(total = sum(value))] }'), []);
});

test('column typo suggestions use the nearest known names and preserve the R message', () => {
  const message = "Error: object 'revnue' not found";
  const result = explainError(message, { columns: [{ name: 'revenue' }, { name: 'region' }, { name: 'units' }] });
  assert.equal(result.message, message);
  assert.match(result.tip, /Did you mean `revenue`/);
  assert.ok(!result.tip.includes('`units`'));
  assert.equal(result.severity, 'error');
});

test('case-only errors get a useful suggestion, but unrelated short names do not', () => {
  assert.match(explainError("object 'species' not found", { columns: ['Species'] }).tip, /`Species`/);
  assert.doesNotMatch(explainError("object 'x' not found", { columns: ['y', 'z'] }).tip, /Did you mean/);
});

test('missing .SDcols names receive both a suggestion and selection guidance', () => {
  const result = explainError("Item 1 of .SDcols is 'revnue' which is not a column name", { columns: ['revenue'] });
  assert.match(result.tip, /`revenue`/);
  assert.match(result.tip, /character vector/);
});

test('runtime call context containing := does not hide the real missing-object error', () => {
  const result = explainError("Error in `:=`(total, sum(revnue)): object 'revnue' not found", { columns: ['revenue'] });
  assert.match(result.title, /cannot find/);
  assert.match(result.tip, /`revenue`/);
});

test('join type, join-key, and Cartesian errors have distinct actionable tips', () => {
  assert.match(explainError('Incompatible join types: x.id (integer) and i.id (character)').tip, /same type/);
  assert.match(explainError("When i is a data.table, the columns to join by must be specified using 'on=' argument").tip, /on = \.\(id\)/);
  assert.match(explainError('Join results in 1000 rows; more than 50. Try allow.cartesian=TRUE').tip, /duplicates or aggregate/);
});

test('reshape aggregation diagnostics distinguish duplicates from non-scalar summaries', () => {
  assert.match(explainError('Aggregation function missing: defaulting to length').tip, /identifier columns/);
  assert.match(explainError('fun.aggregate must return a single value').tip, /one value/);
});

test('common R syntax, type, assignment, and package failures have targeted fixes', () => {
  assert.match(explainError("<text>:3:9: unexpected symbol").tip, /comma or operator/);
  assert.match(explainError("invalid 'type' (character) of argument").tip, /column type/);
  assert.match(explainError('Check that is.data.table(DT) == TRUE. := is defined for use in j').tip, /\[, new_column :=/);
  assert.match(explainError("there is no package called 'readxl'").tip, /webR-compatible/);
  assert.match(explainError('could not find function "%>%"').tip, /library\(magrittr\)/);
});

test('line information is extracted when available and explicit context takes priority', () => {
  assert.equal(explainError('<text>:12:4: unexpected symbol').line, 12);
  assert.equal(explainError('<text>:12:4: unexpected symbol', { line: 7 }).line, 7);
  assert.ok(!('line' in explainError('unknown error')));
  assert.match(explainError('unknown error', { stepLabel: 'Group totals' }).title, /Group totals/);
});
