import test from 'node:test';
import assert from 'node:assert/strict';
import {OPERATIONS, HELPERS} from '../js/catalog.js';
import {compilePipeline, defaultsFor, validateStep, buildStep, rString, rName, parseColumns} from '../js/compiler.js';

const columns = [
  {name:'order_id',type:'integer'}, {name:'date',type:'IDate'},
  {name:'region',type:'character'}, {name:'product',type:'character'},
  {name:'units',type:'integer'}, {name:'unit_price',type:'numeric'},
  {name:'channel',type:'character'}, {name:'customer_id',type:'integer'}
];
const step = (op, params, id = op) => ({id, op, params, enabled:true});

test('literal names cannot escape the generated R string or symbol', () => {
  assert.equal(rString('total "quoted"\\path\n'), '"total \\"quoted\\"\\\\path\\n"'.replaceAll('\\\\"', '\\"'));
  assert.equal(rName('unit price'), '`unit price`');
  assert.equal(rName('if'), '`if`');
  assert.equal(rName('.2'), '`.2`');
  assert.equal(rName('a`b'), '`a\\`b`');
  assert.equal(rName('a\\b'), '`a\\\\b`');
  const generated = buildStep(step('mutate', {name:'x`); stop("oops") #', expression:'1'}));
  assert.ok(generated.includes('`x\\`); stop("oops") #` := 1'));
});

test('column lists support names with spaces and quoted commas', () => {
  assert.deepEqual(parseColumns('region, unit price, "gross, net", `strange name`'), ['region', 'unit price', 'gross, net', 'strange name']);
  assert.deepEqual(parseColumns(['region', 'unit price']), ['region', 'unit price']);
  assert.deepEqual(parseColumns(''), []);
  assert.equal(validateStep(step('select', {columns:'"unfinished'}))[0].severity, 'error');
});

test('compilation preserves source data and uses magrittr throughout', () => {
  const {code, issues} = compilePipeline({sourceCode:'sales', steps:[
    step('filter', {condition:'units >= 2'}),
    step('mutate', {name:'revenue',expression:'units * unit_price'}),
    step('summarize', {expressions:'revenue = sum(revenue), n = .N',groups:'region'}),
    step('sort', {columns:'revenue',directions:'-1',naLast:true})
  ]});
  assert.deepEqual(issues, []);
  assert.match(code, /library\(data.table\)\nlibrary\(magrittr\)/);
  assert.match(code, /copy\(as.data.table\(source_dt\)\) %>%/);
  assert.equal((code.match(/%>%/g) || []).length, 4);
  assert.ok(!code.includes('|>'));
  assert.match(code, /by = c\("region"\)/);
  assert.match(code, /order = c\(-1L\)/);
  assert.match(code, /\nresult\n$/);
});

test('disabled steps are omitted, while invalid enabled steps fail visibly', () => {
  const {code, issues, lineMap} = compilePipeline({steps:[
    {...step('custom', {expression:'stop("disabled")'}, 'disabled'), enabled:false},
    step('mutate', {name:'', expression:'1'}, 'invalid')
  ]});
  assert.ok(!code.includes('stop("disabled")'));
  assert.equal(issues[0].stepId, 'invalid');
  assert.equal(issues[0].field, 'name');
  assert.match(code, /\{ stop\(/);
  assert.deepEqual(lineMap.map(x=>x.stepId), ['invalid']);
});

test('multiline source and blocks keep 1-based step line mappings accurate', () => {
  const {code, lineMap} = compilePipeline({
    sourceCode:'fread(\n  "file.csv"\n)',
    tablesCode:'lookup <- data.table(\n  id = 1:3\n)',
    steps:[step('filter', {condition:'units > 0'}, 'filter'), step('custom', {expression:'{\n  .[, flag := TRUE]\n  .\n}'}, 'block')]
  });
  const lines = code.split('\n');
  assert.equal(lines[lineMap[0].startLine - 1].trim(), '.[units > 0] %>%');
  assert.equal(lines[lineMap[1].startLine - 1].trim(), '{');
  assert.equal(lines[lineMap[1].endLine - 1].trim(), '}');
  assert.equal(lineMap[1].endLine - lineMap[1].startLine, 3);
});

test('a trailing custom comment cannot swallow the following pipe', () => {
  const {code} = compilePipeline({steps:[
    step('custom', {expression:'.[] # keep the table\n# additional note'}),
    step('head-tail', {n:2})
  ]});
  assert.match(code, /\.\[\] %>% # keep the table\n  # additional note/);
});

test('join mappings quote both sides and reject unequal key counts', () => {
  const params = {table:'lookup',leftKeys:'order id, region',rightKeys:'id, area'};
  assert.match(buildStep(step('anti-join', params)), /c\("order id" = "id", "region" = "area"\)/);
  assert.equal(validateStep(step('join', {...params,rightKeys:'id'})).some(x=>x.severity === 'error'), true);
  assert.match(buildStep(step('join', {...params,how:'full'})), /all.x = TRUE, all.y = TRUE/);
});

test('sort directions and numeric parameters have structural validation', () => {
  assert.ok(validateStep(step('sort', {columns:'a,b',directions:'-1,2'})).some(x=>x.field === 'directions'));
  assert.ok(validateStep(step('sort', {columns:'a,b,c',directions:'1,-1'})).some(x=>x.field === 'directions'));
  assert.deepEqual(validateStep(step('sort', {columns:'a,b,c',directions:'-1'})), []);
  assert.ok(validateStep(step('rolling', {n:0})).some(x=>x.field === 'n'));
  assert.ok(validateStep(step('head-tail', {n:1.5})).some(x=>x.field === 'n'));
  assert.ok(validateStep(step('head-tail', {n:Infinity})).some(x=>x.field === 'n'));
  assert.ok(validateStep(step('head-tail', {end:'exec'})).some(x=>x.field === 'end'));
  assert.match(buildStep(step('head-tail', {n:'1e2'})), /100L/);
});

test('all recipes have unique IDs, valid defaults, and executable code text', () => {
  assert.equal(new Set(OPERATIONS.map(op=>op.id)).size, OPERATIONS.length);
  assert.ok(OPERATIONS.length >= 60);
  assert.ok(HELPERS.length >= 90);
  OPERATIONS.forEach(op => {
    op.fields.filter(field => field.options).forEach(field => {
      const values = field.options.map(option => typeof option === 'object' ? option.value : option);
      assert.equal(new Set(values).size, values.length, `Duplicate option in ${op.id}.${field.key}`);
    });
    const params = defaultsFor(op.id, columns);
    const item = step(op.id, params);
    const errors = validateStep(item, {columns}).filter(x=>x.severity === 'error');
    assert.deepEqual(errors, [], `${op.id}: ${JSON.stringify(errors)}`);
    assert.ok(buildStep(item, {columns}).length > 0, op.id);
  });
});

test('unknown or incomplete sources are reported without silent omission', () => {
  const missingOp = compilePipeline({steps:[step('missing', {})]});
  assert.ok(missingOp.issues.some(x=>x.message.includes('Unknown operation')));
  assert.match(missingOp.code, /stop\(/);
  const missingSource = compilePipeline({sourceCode:''});
  assert.ok(missingSource.issues.some(x=>x.message.includes('source table')));
});

test('melt and dcast preserve literal identifiers and explicit aggregation', () => {
  const melt = buildStep(step('melt', {idColumns:'order id',valueColumns:'q1, q2',variableName:'quarter',valueName:'amount'}));
  assert.match(melt, /id.vars = c\("order id"\)/);
  assert.match(melt, /measure.vars = c\("q1", "q2"\)/);
  const cast = buildStep(step('dcast', {formula:'region ~ product',valueColumns:'units',aggregate:'function(x) sum(x, na.rm = TRUE)',fill:'0'}));
  assert.match(cast, /fun.aggregate = function\(x\) sum\(x, na.rm = TRUE\)/);
});
