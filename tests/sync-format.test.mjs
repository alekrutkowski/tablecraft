import test from 'node:test';
import assert from 'node:assert/strict';
import {OPERATIONS, operationDocumentation, documentationFor} from '../js/catalog.js';
import {compilePipeline, parsePipeline, buildStep, defaultsFor, rName, parseColumns, referencedNames, formatRCode, tokenizeR, validateStep} from '../js/compiler.js';
import {normalizedR, splitTopLevel} from '../js/r-syntax.js';
import {assertionCases} from './assertion-cases.mjs';

const step = (op, params, id = op) => ({id, op, params, enabled:true});
const columns = [{name:'id',type:'integer'},{name:'units',type:'integer'},{name:'region',type:'character'}];

test('identifier quoting covers Unicode, reserved names, punctuation and controls', () => {
  assert.equal(rName('café'), 'café');
  assert.equal(rName('if'), '`if`');
  assert.equal(rName('2026 sales'), '`2026 sales`');
  assert.equal(rName('gross-net'), '`gross-net`');
  assert.equal(rName('a`b\\c\t'), '`a\\`b\\\\c\\t`');
  assert.equal(rName('.1'), '`.1`');
  assert.equal(rName('_x'), '`_x`');
  assert.equal(rName('a١'), '`a١`');
  assert.equal(rName('.١'), '`.١`');
});

test('table fields quote literal loaded names but preserve R expressions', () => {
  const params = {table:'2026 sales',leftKeys:'id'};
  assert.match(buildStep(step('join',params),{tables:['2026 sales']}), /y = `2026 sales`/);
  assert.match(buildStep(step('join',{...params,table:'head(other, 2L)'}),{tables:['2026 sales']}), /y = head\(other, 2L\)/);
  assert.match(buildStep(step('join',{...params,table:'`2026 sales`'}),{tables:['2026 sales']}), /y = `2026 sales`/);
});

test('column-list defaults preserve commas, escapes and significant whitespace', () => {
  const names = ['gross, net',' tab\tname ','a\\b','line\nname','with`tick'];
  assert.deepEqual(parseColumns(names.map(name => JSON.stringify(name)).join(', ')),names);
  const weirdColumns = names.map(name => ({name,type:'numeric'}));
  assert.deepEqual(parseColumns(defaultsFor('select',weirdColumns).columns),names.slice(0,4));
  assert.deepEqual(parseColumns(defaultsFor('convert',weirdColumns).columns),names.slice(0,1));
});

test('references ignore comments and strings but decode backticked names', () => {
  const names = referencedNames('merge(`2026 sales`, customers) # products\nlabel <- "iris"\nx <- r"-(mtcars %>% sales)-"');
  assert.ok(names.includes('2026 sales'));
  assert.ok(names.includes('customers'));
  assert.ok(!names.includes('products'));
  assert.ok(!names.includes('iris'));
  assert.ok(!names.includes('mtcars'));
  assert.deepEqual(splitTopLevel('f(a %>% b) %>% .[x == "%>%"] %>% { . # %>%\n}', '%>%').length, 3);
});

test('generated R hard-wraps at lexical boundaries with nesting indentation', () => {
  const source = 'merge(y = products, by.x = c("long product key", "long regional key"), by.y = c("long product key", "long regional key"), all.x = TRUE, all.y = FALSE, sort = FALSE, allow.cartesian = FALSE)';
  const wrapped = formatRCode(source, {width:64,baseIndent:2});
  assert.equal(normalizedR(wrapped), normalizedR(source));
  assert.ok(wrapped.split('\n').every(line => line.length <= 64));
  assert.ok(wrapped.split('\n').slice(1).some(line => line.startsWith('    ')));
  assert.equal(formatRCode(wrapped,{width:64,baseIndent:2}),wrapped);
});

test('formatting preserves normal/raw string contents and wraps comments safely', () => {
  const source = 'x <- r"-(first line\n    literal second line)-"\ny <- "a # is not a comment" # A long explanatory comment that should be wrapped without changing R statements\nprint(x)';
  const wrapped = formatRCode(source,{width:52});
  assert.equal(normalizedR(wrapped), normalizedR(source));
  assert.ok(wrapped.includes('    literal second line)-"'));
  assert.ok(wrapped.includes('\n# '));
  const literal = '"' + 'x'.repeat(100) + '"';
  assert.equal(tokenizeR(formatRCode(`x <- ${literal}`,{width:30})).find(token => token.type === 'string').value,literal);
});

test('edited filters, assignments and grouping recover their visual fields', () => {
  const code = `library(data.table)
library(magrittr)
sales <- data.table(id = 1:3, units = 2:4, region = c("A", "A", "B"))
source_dt <- sales
result <- copy(source_dt) %>%
  .[units >= 3] %>%
  .[, \`gross total\` := units * 10, by = "region"] %>%
  .[, .(n = .N, total = sum(\`gross total\`)), by = .(region)]
result
`;
  const parsed = parsePipeline(code,{columns});
  assert.equal(parsed.mode,'pipeline');
  assert.deepEqual(parsed.steps.map(item => item.op),['filter','mutate','summarize']);
  assert.equal(parsed.steps[0].params.condition,'units >= 3');
  assert.equal(parsed.steps[1].params.name,'gross total');
  assert.equal(parsed.steps[2].params.groups,'region');
  assert.equal(normalizedR(compilePipeline(parsed).code),normalizedR(code));
  parsed.steps[0].params.condition = 'units >= 4';
  assert.match(compilePipeline(parsed).code,/\.\[units >= 4\]/);
});

test('generated operations retain their visual identities across repeated switches', () => {
  const steps = [step('filter',{condition:'units > 0'}),step('join',{table:'products',leftKeys:'id',rightKeys:'id',how:'left',cartesian:false}),step('custom',{expression:'{ .[, flag := TRUE]; . }'})];
  const generated = compilePipeline({sourceCode:'sales',steps});
  const parsed = parsePipeline(generated.code,{previousSteps:steps,columns});
  assert.deepEqual(parsed.steps.map(item => item.op),steps.map(item => item.op));
  const once = compilePipeline(parsed).code;
  const twice = compilePipeline(parsePipeline(once,{previousSteps:parsed.steps,columns})).code;
  assert.equal(once,twice);
  assert.equal(normalizedR(once),normalizedR(generated.code));
});

test('reordered and edited steps receive distinct identities', () => {
  const previous = [step('filter',{condition:'units > 0'},'parsed-1'),step('head-tail',{end:'head',n:2},'parsed-2')];
  const parsed = parsePipeline('result <- sales %>% head(n = 2L) %>% .[units > 1]\nresult',{previousSteps:previous});
  assert.equal(new Set(parsed.steps.map(item => item.id)).size,2);
});

test('source metadata follows the edited pipeline head rather than stale source_dt setup', () => {
  const setup = 'source_dt <- sales\n';
  for (const head of ['products','copy(products)','as.data.table(products)','data.table::copy(as.data.table(products))']) {
    const parsed = parsePipeline(`${setup}result <- ${head} %>% head(n = 2L)\nresult`);
    assert.equal(parsed.sourceName,'products',head);
  }
  assert.equal(parsePipeline(`${setup}result <- copy(as.data.table(source_dt)) %>% head(n = 2L)\nresult`).sourceName,'sales');
  const complex = parsePipeline(`${setup}result <- merge(source_dt, products) %>% head(n = 2L)\nresult`);
  assert.equal(complex.sourceName,null);
  assert.equal(complex.sourceCode,'merge(source_dt, products)');
});

test('setup, imports, unusual stages and the final expression remain authoritative', () => {
  const code = `library(data.table)
library(magrittr)
\`my sales\` <- fread("different.csv", skip = 2)
threshold <- 7
output <- \`my sales\` %>%
  { .[, z := lapply(.SD, identity), .SDcols = "value"]; . } %>%
  head(n = 2L)
print(nrow(output))
head(output, 1)
`;
  const parsed = parsePipeline(code,{columns});
  assert.equal(parsed.resultName,'output');
  assert.equal(parsed.steps[0].op,'custom');
  assert.equal(parsed.steps[1].op,'head-tail');
  assert.ok(parsed.preambleCode.includes('skip = 2'));
  const regenerated = compilePipeline({...parsed,tablesCode:'`my sales` <- fread("wrong.csv")'}).code;
  assert.equal(normalizedR(regenerated),normalizedR(code));
  assert.ok(!regenerated.includes('wrong.csv'));
});

test('ambiguous merge policies remain editable custom R rather than changing semantics', () => {
  const parsed = parsePipeline('out <- sales %>% merge(y = products, by = "id")\nout');
  assert.equal(parsed.steps[0].op,'custom');
  assert.equal(normalizedR(compilePipeline(parsed).code),normalizedR(parsed.rawCode));
});

test('arbitrary and incomplete scripts are preserved exactly in a standalone card', () => {
  for (const code of ['x <- 2\nif (x > 0) print(x)\n', 'x <- 2\r\nprint(x)\r\n', 'result <- sales %>% .[\n', '# comment only\n', '']) {
    const parsed = parsePipeline(code);
    assert.equal(parsed.mode,'script');
    assert.equal(parsed.steps[0].op,'script');
    assert.equal(compilePipeline(parsed).code,code);
  }
});

test('every assertion has positive and negative coverage and passes its table through', () => {
  const assertions = OPERATIONS.filter(operation => operation.category === 'Assertions');
  assert.ok(assertions.length >= 36);
  const cases = assertionCases();
  assert.equal(cases.length,assertions.length * 2);
  for (const item of cases) {
    assert.deepEqual(validateStep(item.step,{columns}).filter(issue => issue.severity === 'error'),[]);
    assert.match(item.code,/stopifnot\(/);
    assert.match(buildStep(item.step),/\n  \.\n\}$/);
  }
});

test('every visual operation has a primary documentation route', () => {
  for (const op of OPERATIONS) {
    const links = operationDocumentation(op);
    assert.ok(links.length > 0,op.id);
    assert.ok(links.every(link => /^https:\/\//.test(link.url)),op.id);
  }
  assert.match(documentationFor('stopifnot'),/library\/base\/html\/stopifnot.html$/);
  assert.match(documentationFor('data.table::merge'),/data.table\/reference\/merge.html$/);
  assert.match(documentationFor('stats::sd'),/library\/stats\/html\/sd.html$/);
  assert.match(documentationFor('frollapply'),/reference\/frollapply.html$/);
  assert.match(documentationFor('is.data.table'),/reference\/as.data.table.html$/);
  assert.match(documentationFor('setmergelist'),/reference\/mergelist.html$/);
  assert.match(documentationFor('na.omit'),/reference\/na.omit.data.table.html$/);
  assert.match(documentationFor('stats::na.omit'),/library\/stats\/html\/na.fail.html$/);
  assert.match(documentationFor('base::unique'),/library\/base\/html\/unique.html$/);
});
