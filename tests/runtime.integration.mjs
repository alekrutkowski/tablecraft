/**
 * Optional real-Wasm integration test. Run from the project root:
 *   npm install --no-save webr@0.6.0
 *   node tests/runtime.integration.mjs
 *
 * These are test dependencies only. The deployed application needs no build.
 * TABLECRAFT_WEBR_MODULE can select an existing local webr/dist/webr.mjs.
 * TABLECRAFT_R_LIBRARY can select a compatible, unpacked Wasm R library if the
 * Node downloader cannot use the host's proxy. It is mounted only in this test.
 * TABLECRAFT_TEST_TMP and TABLECRAFT_REPORT select optional temporary/report paths.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { File } from 'node:buffer';
import { REngine } from '../js/runtime.js';
import { DATASETS } from '../js/datasets.js';

let webRModule;
try {
  webRModule = process.env.TABLECRAFT_WEBR_MODULE
    ? pathToFileURL(resolve(process.env.TABLECRAFT_WEBR_MODULE)).href
    : import.meta.resolve('webr');
} catch {
  throw new Error('This optional integration test needs webR 0.6.0. Run npm install --no-save webr@0.6.0, or set TABLECRAFT_WEBR_MODULE to an existing webr/dist/webr.mjs.');
}
const baseUrl = dirname(fileURLToPath(webRModule)) + '/';
let moduleUrl = webRModule;
let bridgeDirectory = null;
if (process.env.TABLECRAFT_R_LIBRARY) {
  const parent = process.env.TABLECRAFT_TEST_TMP || tmpdir();
  await mkdir(parent, {recursive:true});
  bridgeDirectory = await mkdtemp(join(parent, 'tablecraft-runtime-'));
  const bridge = join(bridgeDirectory, 'bridge.mjs');
  // The bridge changes package delivery only. All REngine and R evaluation code
  // exercised below is imported directly from the production runtime.js.
  await writeFile(bridge, `
import {WebR as OriginalWebR, ChannelType} from ${JSON.stringify(webRModule)};
export {ChannelType};
export class WebR extends OriginalWebR {
  async init() {
    const value = await super.init();
    await this.FS.mkdir('/integration-library');
    await this.FS.mount('NODEFS', {root:${JSON.stringify(resolve(process.env.TABLECRAFT_R_LIBRARY))}}, '/integration-library');
    await this.evalRVoid('.libPaths(c("/integration-library", .libPaths()))');
    return value;
  }
  async installPackages(packages) {
    for (const name of Array.isArray(packages) ? packages : [packages]) {
      if (!await this.evalRBoolean('requireNamespace(' + JSON.stringify(name) + ', quietly = TRUE)')) {
        throw new Error('Local compatible Wasm package missing: ' + name);
      }
    }
  }
}
`);
  moduleUrl = pathToFileURL(bridge).href;
}
const engine = new REngine({moduleUrl, baseUrl});
const report = [];
engine.addEventListener('status', ({detail}) => console.log('STATUS', detail.state, detail.message));
const passed = (name) => { report.push({name,passed:true}); console.log('PASS', name); };
const file = async (name) => new File([await readFile(new URL(`fixtures/${name}`, import.meta.url))], name);
try {
  await engine.init();
  assert.equal(engine.ready, true);
  assert.ok(engine.versions['data.table']);
  assert.equal(engine.versions.webR, '0.6.0');
  passed('initialization and version metadata');
  const syntax = await engine.inspect('x <- 1\nx + )');
  assert.equal(syntax.ok, false);
  assert.equal(syntax.diagnostics[0].line, 2);
  assert.equal(syntax.diagnostics[0].precise, true);
  passed('real R parser and exact error line');
  assert.equal((await engine.inspect('as.data.table(iris)')).ok, true);
  const sales = await engine.importFile(await file('sales.csv'));
  assert.equal(sales.totalRows, 8);
  assert.equal(sales.totalColumns, 7);
  const code = `${sales.tablesCode}\nresult <- copy(${sales.sourceCode}) %>% .[, units := units + 1L]\nresult`;
  const first = await engine.run(code, {limit:2});
  const second = await engine.run(code, {limit:2});
  assert.deepEqual(first.rows, second.rows);
  assert.equal(first.rows.length, 2);
  assert.equal(first.totalRows, 8);
  const page = await engine.preview({offset:2,limit:2});
  assert.equal(page.offset, 2);
  assert.equal(page.rows.length, 2);
  assert.notDeepEqual(page.rows, first.rows);
  passed('cached import, isolated mutation, and pagination');
  const csv = new TextDecoder().decode(await engine.exportCSV());
  assert.equal(csv.trim().split('\n').length, 9);
  passed('complete CSV export beyond preview limit');
  const sensors = await engine.importFile(await file('sensors.tsv'));
  const sensorResult = await engine.run(`${sensors.tablesCode}\ncopy(${sensors.sourceCode})`);
  assert.equal(sensorResult.totalRows, 6);
  passed('TSV import');
  const staff = await engine.importFile(await file('staff.fwf'), {format:'fwf',widths:'6,12,3,8',names:'employee_id,name,age,salary'});
  const staffResult = await engine.run(`${staff.tablesCode}\ncopy(${staff.sourceCode})`);
  assert.equal(staffResult.totalRows, 4);
  assert.equal(staffResult.rows.reduce((sum, row)=>sum+row.salary,0), 244000);
  passed('fixed-width import and salary total');
  const workbook = await file('workbook.xlsx');
  assert.deepEqual(await engine.excelSheets(workbook), ['Sales','Products']);
  const excel = await engine.importFile(workbook,{sheet:'Products',tableName:'uploaded_17'});
  assert.equal(excel.totalRows,3);
  assert.equal(excel.tableName,'uploaded_17');
  const excelResult = await engine.run(`${excel.tablesCode}\ncopy(${excel.sourceCode})`);
  assert.equal(excelResult.totalRows,3);
  passed('Excel sheet listing, named worksheet import, and saved symbol restore');
  const replacement = new File(['value\n7\n8\n'], 'replacement.csv');
  const replaced = await engine.importFile(replacement,{tableName:'uploaded_17'});
  assert.equal(replaced.totalRows,2);
  assert.equal(engine.imports.filter(x=>x.tableName==='uploaded_17').length,1);
  await assert.rejects(engine.importFile(replacement,{tableName:'x; stop()'}), /uploaded_1/);
  passed('explicit import replacement and symbol validation');
  const fwfBytes = await readFile(new URL('fixtures/staff.fwf', import.meta.url), 'utf8');
  const fwfHeader = ['id'.padEnd(6),'name'.padEnd(12),'age'.padEnd(3),'salary'.padEnd(8)].join('') + '\n';
  const headed = await engine.importFile(new File([fwfHeader,fwfBytes],'headed.fwf'),{format:'fwf',widths:[6,12,3,8],header:true});
  const headedResult = await engine.run(`${headed.tablesCode}\ncopy(${headed.sourceCode})`);
  assert.equal(headedResult.totalRows,4);
  assert.deepEqual(headedResult.columns.map(x=>x.name),['id','name','age','salary']);
  assert.equal(headedResult.rows.reduce((sum,row)=>sum+row.salary,0),244000);
  passed('fixed-width header extraction uses the same field widths');
  const preciseBytes = 'id;amount\n9007199254740993;12,5\n9007199254740994;25,25\n';
  const precise = await engine.importFile(new File([preciseBytes],'a "quoted" café.csv'),{delimiter:';',decimal:',',encoding:'UTF-8'});
  const preciseCode = `${precise.tablesCode}\ncopy(${precise.sourceCode})`;
  const preciseResult = await engine.run(preciseCode);
  assert.equal(preciseResult.rows[0].id,'9007199254740993');
  assert.equal(preciseResult.rows[1].amount,25.25);
  passed('fread int64 inference, decimal comma, UTF-8, and quoted filename');
  await engine._webR.FS.writeFile(`/home/web_user/${precise.fileName}`,new TextEncoder().encode(preciseBytes.replace('12,5','42,5')));
  assert.equal((await engine.run(preciseCode,{cacheImports:true})).rows[0].amount,12.5);
  assert.equal((await engine.run(preciseCode,{cacheImports:false})).rows[0].amount,42.5);
  passed('manual code can bypass import caching and re-read modified files');
  const suffix = await engine.importFile(new File(['value\n9\n'],'original.csv'),{tableName:'uploaded_40',fileName:'original_2.csv'});
  assert.equal(suffix.fileName,'original_2.csv');
  assert.ok(suffix.readCode.includes('"original_2.csv"'));
  assert.deepEqual((await engine.run('fread("original_2.csv")',{cacheImports:false})).rows,[{value:9}]);
  await assert.rejects(engine.importFile(new File(['value\n999\n'],'original.csv'),{tableName:'uploaded_41',fileName:'original_2.csv'}),/already used by another imported table/);
  assert.deepEqual((await engine.run('fread("original_2.csv")',{cacheImports:false})).rows,[{value:9}]);
  const exactReplacement = await engine.importFile(new File(['value\n17\n'],'original.csv'),{tableName:'uploaded_40',fileName:'original_2.csv'});
  assert.equal(exactReplacement.fileName,'original_2.csv');
  await assert.rejects(engine.importFile(new File(['not an Excel workbook'],'original.csv'),{format:'excel',tableName:'uploaded_40',fileName:'original_2.csv'}));
  assert.deepEqual((await engine.run('fread("original_2.csv")',{cacheImports:false})).rows,[{value:17}]);
  passed('saved suffixes stay exact, conflicts are rejected, and failed replacements roll back');
  const exactWorkbook = await engine.importFile(workbook,{sheet:'Sales',tableName:'uploaded_50',fileName:'workbook_2.xlsx'});
  assert.equal(exactWorkbook.fileName,'workbook_2.xlsx');
  assert.equal(exactWorkbook.totalRows,8);
  assert.deepEqual((await engine.run('as.data.table(readxl::read_excel("workbook_2.xlsx", sheet="Products"))',{cacheImports:false})).rows.map(x=>x.product),['Tea','Coffee','Cocoa']);
  passed('sheet inspection can precede exact workbook filename restoration');
  for (const invalid of ['', '.', '..', '../other.csv', 'nested/file.csv', 'nested\\file.csv', 'line\nbreak.csv', 'x'.repeat(241)]) {
    await assert.rejects(engine.importFile(replacement,{fileName:invalid}),/basename/);
  }
  passed('restored filenames reject paths and control characters');
  const lastExpression = await engine.run('result <- data.table(x=1:100)\nhead(result, 3)');
  assert.equal(lastExpression.totalRows,3);
  assert.deepEqual(lastExpression.rows,[{x:1},{x:2},{x:3}]);
  passed('text mode displays the actual last expression');
  const special = await engine.run('data.table(id=bit64::as.integer64(c("9007199254740993",NA)), x=c(Inf,NaN), date=as.IDate(c("2026-01-01",NA)))');
  assert.equal(special.rows[0].id,'9007199254740993');
  assert.equal(special.rows[1].id,null);
  assert.equal(special.rows[0].x,'Inf');
  assert.equal(special.rows[1].x,'NaN');
  assert.equal(special.rows[0].date,'2026-01-01');
  assert.equal(special.rows[1].date,null);
  passed('integer64 exactness, missing data, non-finite numbers, and date preview');
  const dup = await engine.run('data.table(a=1:2,a=3:4)');
  assert.equal(dup.columns[0].name,'a');
  assert.equal(dup.columns[1].name,'a');
  assert.notEqual(dup.columns[0].key,dup.columns[1].key);
  assert.deepEqual(Object.values(dup.rows[0]),[1,3]);
  passed('duplicate column names are not lost');
  const shortened = await engine.run('data.table(note=paste(rep("x",1000),collapse=""))');
  assert.equal(shortened.truncatedCells,1);
  assert.equal(shortened.rows[0].note.length,513);
  assert.ok(new TextDecoder().decode(await engine.exportCSV()).includes('x'.repeat(1000)));
  passed('bounded long-cell preview and full export');
  const empty = await engine.run('data.table(a=integer(),b=character())');
  assert.equal(empty.totalRows,0);
  assert.deepEqual(empty.rows,[]);
  assert.equal(empty.columns.length,2);
  passed('empty table preserves schema');
  await assert.rejects(engine.run('data.table(a=1) %>% .[missing_column > 0]'), (e) => e.name==='RExecutionError' && /missing_column/.test(e.message));
  passed('runtime errors are returned as structured diagnostics');
  const builtins = [];
  for (const dataset of DATASETS) {
    const result = await engine.run(dataset.sourceCode);
    assert.equal(result.totalRows,dataset.rows,dataset.id);
    assert.equal(result.totalColumns,dataset.columns.length,dataset.id);
    builtins.push(dataset.id);
  }
  passed('all 12 built-in datasets match declared schema sizes');
  const running = engine.run('repeat {}');
  await new Promise(resolve=>setTimeout(resolve,120));
  engine.close();
  await assert.rejects(running,e=>e.cancelled===true && e.code==='SESSION_RESET');
  assert.equal(engine.ready,false);
  passed('hard stop rejects a truly nonterminating worker call');
  await engine.init();
  const afterRestart = await engine.run(code);
  assert.equal(afterRestart.totalRows,8);
  assert.deepEqual(afterRestart.rows.slice(0,2),first.rows);
  const restored = engine.imports.find(item=>item.tableName==='uploaded_17');
  const afterReplacementRestart = await engine.run(`${restored.tablesCode}\ncopy(${restored.sourceCode})`);
  assert.deepEqual(afterReplacementRestart.rows,[{value:7},{value:8}]);
  assert.deepEqual((await engine.run('fread("original_2.csv")',{cacheImports:false})).rows,[{value:17}]);
  passed('restart rehydrates uploads, cache, and replaced symbols');
  const recent = await engine._webR.evalRString('.tc$json(intersect(c("frollmin","frollmax","frollprod","frollmedian","frollsd","frollvar","frolladapt","mergelist","setmergelist","setcoalesce","isoyear"), getNamespaceExports("data.table")))');
  console.log('RECENT_APIS',recent);
  const operationSource = await readFile(new URL('operations.integration.R', import.meta.url),'utf8');
  const operationOutput = await engine._webR.evalRString(operationSource);
  const operationCases = operationOutput.split(/\r?\n/).filter(line=>/^(PASS|FAIL) /.test(line));
  console.log(operationOutput);
  assert.equal(operationCases.filter(line=>line.startsWith('FAIL ')).length,0,'Generated operation tests failed');
  assert.ok(operationCases.length>=75,'Generated operation coverage unexpectedly shrank');
  const result = {
    verifiedAt:new Date().toISOString(),
    runtime:'Production REngine using webR PostMessage under Node',
    packageDelivery:process.env.TABLECRAFT_R_LIBRARY ? 'Compatible Wasm R packages mounted locally' : 'Public webR Wasm package repository',
    versions:engine.versions,packages:engine.packages,
    runtimeGroups:report.length,report,
    operationCount:operationCases.length,operationCases,
    recent:JSON.parse(recent),
  };
  if (process.env.TABLECRAFT_REPORT) await writeFile(resolve(process.env.TABLECRAFT_REPORT),JSON.stringify(result,null,2)+'\n');
  console.log(`SUCCESS: ${report.length} runtime groups, all 12 built-in datasets, and ${operationCases.length} generated R operation cases.`);
} finally {
  engine.close();
  if (bridgeDirectory) await rm(bridgeDirectory, {recursive:true, force:true});
}
