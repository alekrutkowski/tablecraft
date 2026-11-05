import test from 'node:test';
import assert from 'node:assert/strict';
import * as editor from '../js/editor-support.js';

const applyCompletion = (code, context, text) => code.slice(0,context.start) + text + code.slice(context.end);

test('completion in the middle of an identifier replaces its remaining suffix', () => {
  const code = 'sum(units)';
  const context = editor.completionCandidates({code,offset:7,columns:[{name:'units',type:'numeric'}]});
  const candidate = context.items.find(item => item.name === 'units');
  assert.ok(candidate);
  assert.equal(applyCompletion(code,context,candidate.text),code);
});

test('completion in a backticked name replaces its suffix and retains one closing tick', () => {
  const code = '`2026 sales`$`gross total`';
  const offset = code.indexOf('gross') + 'gross'.length;
  const context = editor.completionCandidates({code,offset,tables:[{tableName:'2026 sales',columns:[{name:'gross total',type:'numeric'}]}]});
  const candidate = context.items.find(item => item.name === 'gross total');
  assert.ok(candidate);
  assert.equal(applyCompletion(code,context,candidate.text),code);
});

test('literal-list completion respects a comma inside a quoted column name', () => {
  assert.equal(typeof editor.literalListContext,'function');
  const value = 'id, "gross, net", region';
  const context = editor.literalListContext(value,value.indexOf('net') + 1);
  assert.equal(context.prefix,'gross, n');
  assert.equal(applyCompletion(value,context,'"gross, new"'),'id, "gross, new", region');
});

test('literal-list completion decodes escaped quotes while finding the current name', () => {
  const name = 'gross "net, tax"';
  const value = JSON.stringify(name) + ', id';
  const context = editor.literalListContext(value,value.indexOf('tax') + 2);
  assert.equal(context.prefix,'gross "net, ta');
  assert.equal(applyCompletion(value,context,JSON.stringify(name)),value);
});

test('literal-list completion replaces an unquoted suffix without swallowing the next column', () => {
  const value = 'id, unit_price, region';
  const context = editor.literalListContext(value,value.indexOf('unit_price') + 4);
  assert.equal(applyCompletion(value,context,'unit_cost'),'id, unit_cost, region');
});

test('namespace hints retain the actual package origin of base assertion helpers', () => {
  const dataTableCode = 'data.table::st';
  const baseCode = 'base::st';
  assert.ok(!editor.completionCandidates({code:dataTableCode,offset:dataTableCode.length}).items.some(item => item.name === 'stopifnot'));
  const candidate = editor.completionCandidates({code:baseCode,offset:baseCode.length}).items.find(item => item.name === 'stopifnot');
  assert.equal(candidate?.package,'base');
});
