import test from 'node:test';
import assert from 'node:assert/strict';
import {completionCandidates, completionContext, functionAt, R_FUNCTIONS, errorConsultationURL} from '../js/editor-support.js';

const tables = [{tableName:'sales 2026', label:'sales 2026.csv', columns:[{name:'gross, net', type:'numeric'}, {name:'unit price',type:'numeric'}]}];
const columns = tables[0].columns;
const complete = code => completionCandidates({code,offset:code.length,columns,tables});

test('general R completions include base, stats, utilities, graphics and data.table', () => {
  assert.ok(R_FUNCTIONS.length > 200);
  for (const name of ['Reduce','lapply','median','cor.test','read.csv','boxplot','stopifnot','fread']) assert.ok(R_FUNCTIONS.some(item => item.name === name), name);
  const result = complete('stats::med');
  assert.ok(result.items.some(item => item.name === 'median'));
  assert.ok(result.items.every(item => item.package === 'stats'));
  assert.equal(result.start, 7);
});

test('non-syntactic table and column completions quote symbols and preserve string context', () => {
  assert.equal(complete('sal').items.find(item => item.name === 'sales 2026').text, '`sales 2026`');
  assert.equal(complete('uni').items.find(item => item.name === 'unit price').text, '`unit price`');
  assert.equal(complete('c("uni').items.find(item => item.name === 'unit price').text, 'unit price');
  assert.equal(complete('`sales 2026`$uni').items.find(item => item.name === 'unit price').text, '`unit price`');
  assert.ok(complete('`sales 2026`$').items.every(item => item.kind === 'column'));
});

test('completion avoids comments and raw strings and handles escaped quotes', () => {
  assert.equal(completionContext('# sum').blocked, true);
  assert.equal(completionContext('r"--(sum').blocked, true);
  assert.equal(completionContext('"quoted\\\" text').quote, '"');
  assert.equal(completionContext('# note\nsum').blocked, false);
});

test('session exports and Unicode object names can be completed', () => {
  const result = completionCandidates({code:'otherpkg::tr',offset:12,symbols:[{name:'transform_it',kind:'function',package:'otherpkg'}]});
  assert.equal(result.items[0]?.name, 'transform_it');
  assert.equal(completionCandidates({code:'café <- 1\nca',offset:12}).items.some(item=>item.name==='café'),true);
});

test('F1 identifies namespace functions and an enclosing function call', () => {
  assert.equal(functionAt('stats::median(x)', 9), 'stats::median');
  assert.equal(functionAt('sum(value, na.rm = TRUE)', 9), 'sum');
});

test('error helper URL faithfully encodes the error and R code without tracking', () => {
  const message = 'object "a & b" not found\nnext line';
  const code = '`a & b` <- "# + ?"\nstop("oops")';
  const url = new URL(errorConsultationURL(message, code));
  assert.equal(url.origin, 'https://chat.mistral.ai');
  assert.equal(url.pathname, '/chat');
  assert.deepEqual([...url.searchParams.keys()], ['q']);
  assert.ok(url.searchParams.get('q').includes(message));
  assert.ok(url.searchParams.get('q').includes(code));
});
