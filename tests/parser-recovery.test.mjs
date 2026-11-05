import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStep, compilePipeline, parsePipeline, validateStep} from '../js/compiler.js';
import {normalizedR} from '../js/r-syntax.js';
import {recognitionCases, conservativeCases, knownColumns} from './parser-cases.mjs';

const script = expression => `library(data.table)\nlibrary(magrittr)\nresult <- sales %>%\n  ${expression}\nresult\n`;
const recovered = (expression, options = {}) => parsePipeline(script(expression), {columns:knownColumns,...options});

test('sort survives TRUE to FALSE to TRUE edits and recovers from an earlier generic card', () => {
  const initial = {id:'sort-1',op:'sort',enabled:true,params:{columns:'revenue',directions:'-1',naLast:true}};
  let previousSteps = [initial];
  for (const naLast of [false,true,false,true]) {
    const parsed = recovered(`setorderv(cols = c("revenue"), order = c(-1L), na.last = ${naLast ? 'TRUE' : 'FALSE'})`, {previousSteps});
    assert.equal(parsed.steps[0].op,'sort');
    assert.equal(parsed.steps[0].params.naLast,naLast);
    assert.equal(parsed.steps[0].params.directions,'-1');
    previousSteps = parsed.steps;
  }
  const expression = 'setorderv(cols = c("revenue"), order = c(-1L), na.last = TRUE)';
  const oldFallback = {id:'old-fallback',op:'custom',enabled:true,params:{expression}};
  assert.equal(recovered(expression,{previousSteps:[oldFallback]}).steps[0].op,'sort');
});

test('structured recovery binds R arguments and retains edited values without previous steps', () => {
  for (const [expression,op,expected] of recognitionCases) {
    const parsed = recovered(expression), item = parsed.steps[0];
    assert.equal(item.op,op,expression);
    for (const [key,value] of Object.entries(expected)) assert.deepEqual(item.params[key],value,`${expression}: ${key}`);
    assert.deepEqual(validateStep(item).filter(issue=>issue.severity==='error'),[],expression);
    assert.equal(normalizedR(compilePipeline(parsed).code),normalizedR(script(expression)),`${expression}: source must stay exact until edited`);
  }
});

test('unsupported and ambiguous arguments remain lossless R', () => {
  for (const expression of conservativeCases) {
    const parsed = recovered(expression);
    assert.ok(['custom','custom-bracket'].includes(parsed.steps[0].op),`${expression}: ${parsed.steps[0].op}`);
    assert.equal(normalizedR(compilePipeline(parsed).code),normalizedR(script(expression)),expression);
  }
});

test('R aliases T/F are never assumed constant when assigned or masked by a column', () => {
  for (const preamble of ['T <- FALSE','F = TRUE','FALSE -> T','assign("T", FALSE)','T <- readRDS("flag.rds")']) {
    const expression = 'setorderv(cols = "revenue", na.last = T)';
    const parsed = parsePipeline(`${preamble}\n${script(expression)}`);
    const alias = preamble.startsWith('F') && !preamble.includes('-> T') ? 'F' : 'T';
    if (alias === 'T') assert.equal(parsed.steps[0].op,'custom',preamble);
    assert.equal(normalizedR(compilePipeline(parsed).code),normalizedR(`${preamble}\n${script(expression)}`));
  }
  const masked = recovered('setorderv(cols = "revenue", na.last = F)', {columns:[{name:'F'}]});
  assert.equal(masked.steps[0].op,'custom');
  assert.equal(parsePipeline(`F <- TRUE\n${script('setorderv(cols = "revenue", na.last = F)')}`).steps[0].op,'custom');
  const expression = 'setorderv(cols = "revenue", na.last = T)';
  const previousSteps = recovered(expression).steps;
  assert.equal(parsePipeline(`T <- FALSE\n${script(expression)}`,{previousSteps}).steps[0].op,'custom');
  assert.equal(parsePipeline(`assign(value = FALSE, x = "T")\n${script(expression)}`).steps[0].op,'custom');
});

test('changing a recovered sort field retains the other parsed controls', () => {
  const parsed = recovered('data.table::setorderv(., "revenue", -1, FALSE)');
  parsed.steps[0].params.columns = 'region, revenue';
  assert.match(buildStep(parsed.steps[0]),/cols = c\("region", "revenue"\)/);
  assert.match(buildStep(parsed.steps[0]),/order = c\(-1L\)/);
  assert.match(buildStep(parsed.steps[0]),/na.last = FALSE/);
  parsed.steps[0].params.directions = '1, -1';
  assert.equal(recovered(buildStep(parsed.steps[0])).steps[0].op,'sort');
});

test('NSE recovery requires column evidence and keeps external grouping expressions intact', () => {
  assert.equal(recovered('.[, .(region, revenue)]',{columns:[]}).steps[0].op,'summarize');
  assert.equal(recovered('.[, .(answer)]').steps[0].op,'summarize');
  const dynamic = parsePipeline(`keep_cols <- "region"\n${script('.[, .(total = sum(units)), by = keep_cols]')}`, {columns:knownColumns});
  assert.equal(dynamic.steps[0].op,'custom-bracket');
  assert.ok(compilePipeline(dynamic).code.includes('by = keep_cols'));
});

test('qualified functions survive visual edits without rewriting calls in raw fields', () => {
  const expression = 'data.table::setorderv(cols = "revenue", order = -1L, na.last = TRUE)';
  const parsed = parsePipeline(`setorderv <- function(...) stop("masked")\n${script(expression)}`, {columns:knownColumns});
  parsed.steps[0].params.naLast = false;
  assert.match(buildStep(parsed.steps[0]),/^data.table::setorderv\(/);
  const mixed = recovered('.[, flag := data.table::fifelse(units > 0, stats::median(revenue), median(backup), na = NA_real_)]').steps[0];
  mixed.params.condition = 'units > 1';
  const code = buildStep(mixed);
  assert.match(code,/data.table::fifelse\(/);
  assert.match(code,/stats::median\(revenue\)/);
  assert.match(code,/, median\(backup\),/);
  const rows = recovered('utils::head(n = 2L)').steps[0];
  rows.params.end = 'tail';
  assert.match(buildStep(rows),/^utils::tail\(/);
});
