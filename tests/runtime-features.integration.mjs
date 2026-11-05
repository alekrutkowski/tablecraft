/** Real R coverage for filename symbols, package discovery, and independent analysis. */
import assert from 'node:assert/strict';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { File } from 'node:buffer';
import { REngine, tableNameFromFile } from '../js/runtime.js';
import { DATASETS } from '../js/datasets.js';

const module = process.env.TABLECRAFT_WEBR_MODULE ? pathToFileURL(resolve(process.env.TABLECRAFT_WEBR_MODULE)).href : import.meta.resolve('webr');
const baseUrl = dirname(fileURLToPath(module)) + '/';
let moduleUrl = module, bridgeDirectory;
if (process.env.TABLECRAFT_R_LIBRARY) {
  const parent = process.env.TABLECRAFT_TEST_TMP || tmpdir();
  await mkdir(parent, {recursive:true});
  bridgeDirectory = await mkdtemp(join(parent, 'tablecraft-features-'));
  const bridge = join(bridgeDirectory, 'bridge.mjs');
  await writeFile(bridge, `
import {WebR as OriginalWebR, ChannelType} from ${JSON.stringify(module)};
export {ChannelType};
export class WebR extends OriginalWebR {
  async init() {
    const result = await super.init();
    await this.FS.mkdir('/integration-library');
    await this.FS.mount('NODEFS', {root:${JSON.stringify(resolve(process.env.TABLECRAFT_R_LIBRARY))}}, '/integration-library');
    await this.evalRVoid('.libPaths(c("/integration-library", .libPaths()))');
    return result;
  }
  async installPackages(packages) {
    for (const name of Array.isArray(packages) ? packages : [packages]) {
      if (!await this.evalRBoolean('requireNamespace(' + JSON.stringify(name) + ', quietly=TRUE)')) throw new Error('Local compatible Wasm package missing: '+name);
    }
  }
}
`);
  moduleUrl = pathToFileURL(bridge).href;
}
const engine = new REngine({moduleUrl,baseUrl});
const report=[];
const passed = name => {report.push({name,passed:true}); console.log('PASS',name);};
const csv = name => new File(['id,value\n1,10\n2,20\n'],name);
try {
  await engine.init();
  assert.equal(tableNameFromFile('sales.csv'),'sales_2');
  assert.equal(tableNameFromFile('North America.csv',['North America']),'North America_2');
  assert.equal(tableNameFromFile('....csv'),'..._2');
  assert.equal(tableNameFromFile('..1.csv'),'..1_2');
  const names = ['North America.csv','2026-results.csv','if.csv','café revenue.csv','tick`table.csv'];
  const tables=[];
  for (const name of names) {
    const table=await engine.importFile(csv(name));
    tables.push(table);
    assert.equal(table.tableName,name.slice(0,-4));
    assert.equal(table.originalFileName,name);
    assert.ok(table.sourceCode.startsWith('`'),table.sourceCode);
    assert.ok(table.portableReadCode.includes(JSON.stringify(name)),table.portableReadCode);
    const read = await engine.run(table.tablesCode+'\ncopy('+table.sourceCode+')');
    assert.deepEqual(read.rows,[{id:1,value:10},{id:2,value:20}]);
  }
  const duplicate=await engine.importFile(csv('North America.csv'));
  assert.equal(duplicate.tableName,'North America_2');
  assert.equal(duplicate.fileName,'North America_2.csv');
  passed('file-based non-syntactic and Unicode names, safe backticks, and deterministic collisions');

  const packages=await engine.packageDependencies(`
# library(ignored_comment)
text <- "fake::function(); library(ignored_string)"
quote(ignored_quoted::fun())
expression(ignored_expression::fun())
library(glue)
require(package = "cli")
requireNamespace("rlang", quietly=TRUE)
base::library(magrittr)
jsonlite::toJSON(list(a = data.table:::cedta()))
library(dynamic_package, character.only=TRUE)
`);
  assert.deepEqual([...packages].sort(),['base','cli','data.table','glue','jsonlite','magrittr','rlang'].sort());
  passed('R AST detects package calls while ignoring comments, strings, quotes, and dynamic names');

  const installCalls=[];
  const install=engine._webR.installPackages.bind(engine._webR);
  engine._webR.installPackages=async packages=>{installCalls.push(packages);return install(packages);};
  delete engine.packages.glue;
  const packageResult=await engine.run('data.table(text=as.character(glue::glue("answer {42}")))');
  assert.equal(packageResult.rows[0].text,'answer 42');
  assert.ok(installCalls.some(names=>names.includes('glue')));
  const dynamic=await engine.run('pkg <- "glue"\nlibrary(pkg, character.only=TRUE)\ndata.table(text=as.character(glue("dynamic {7}")))');
  assert.equal(dynamic.rows[0].text,'dynamic 7');
  await assert.rejects(engine.run('TablecraftMissingPackage987::f()'),error=>error.code==='PACKAGE_INSTALL_FAILED' && error.message.includes('TablecraftMissingPackage987'));
  assert.equal(engine.ready,true);
  passed('automatic package-install request, dynamic library loading, and recoverable install diagnostics');

  const main=await engine.run('custom_orders <- data.table(id=1:3,amount=c(10,20,30))\ncustom_function <- function(x) x+1\nsource_dt <- custom_orders\nresult <- custom_orders[,.(total=sum(amount))]\nresult');
  assert.deepEqual(main.rows,[{total:60}]);
  const custom=await engine.previewTable('custom_orders',{setupCode:'',limit:2});
  assert.equal(custom.totalRows,3);
  assert.deepEqual(custom.rows,[{id:1,amount:10},{id:2,amount:20}]);
  const imported=await engine.previewTable(tables[0].sourceCode,{limit:1});
  assert.equal(imported.totalRows,2);
  const builtin=DATASETS.find(x=>x.id==='iris');
  const iris=await engine.previewTable(builtin.sourceCode,{limit:3});
  assert.equal(iris.totalRows,150);
  assert.deepEqual((await engine.preview()).rows,main.rows);
  passed('imported, built-in, and last-run object previews preserve the pipeline result');

  const analysis=await engine.runAnalysis('custom_orders[, amount := 999]\nmessage("analysis note")\nwarning("analysis warning")\ncat("analysis output\\n")\ncustom_orders[,.(total=sum(amount))]');
  assert.deepEqual(analysis.rows,[{total:2997}]);
  assert.ok(analysis.stdout.includes('analysis output'));
  assert.ok(analysis.warnings.some(x=>x.includes('analysis note')));
  assert.ok(analysis.warnings.some(x=>x.includes('analysis warning')));
  assert.deepEqual((await engine.preview()).rows,main.rows);
  assert.deepEqual((await engine.previewTable('custom_orders')).rows,[{id:1,amount:10},{id:2,amount:20},{id:3,amount:30}]);
  await assert.rejects(engine.runAnalysis('custom_orders[, amount := 0]\nstop("analysis failed")'),error=>error.name==='RExecutionError' && error.message.includes('analysis failed'));
  assert.deepEqual((await engine.preview()).rows,main.rows);
  passed('analysis captures console and warnings with data.table mutation and error isolation');

  const serialized=await Promise.all([
    engine.run('data.table(marker=456)'),
    engine.previewTable('result'),
    engine.runAnalysis('result[, .(marker=marker+1)]'),
    engine.preview(),
  ]);
  assert.deepEqual(serialized.map(x=>x.rows[0].marker),[456,456,457,456]);
  passed('runs, previews, and analyses use one serialized execution queue');

  await engine.run('custom_orders <- data.table(id=1:3)\ncustom_function <- function(x) x+1\ncustom_orders');
  const symbols=await engine.completionSymbols();
  assert.ok(symbols.some(x=>x.name==='custom_orders' && x.kind==='table'));
  assert.ok(symbols.some(x=>x.name==='custom_function' && x.kind==='function'));
  assert.ok(symbols.some(x=>x.name==='fread' && x.package==='data.table'));
  assert.ok(symbols.some(x=>x.name==='North America' && x.kind==='table'));
  const help=await engine.helpFor('fread','data.table');
  assert.ok(help.text?.includes('fread'));
  const missingHelp=await engine.helpFor('tablecraft_no_such_help_topic','data.table');
  assert.equal(missingHelp.text,null);
  passed('completions combine user objects and loaded exports; package help is read from R documentation');

  const products=DATASETS.find(table=>table.id==='products');
  const customers=DATASETS.find(table=>table.id==='customers');
  const exampleResult=await engine.run(products.tablesCode+'\n'+customers.tablesCode+'\nproducts');
  const importsBefore=engine.imports.map(({tableName,fileName})=>({tableName,fileName}));
  assert.equal(await engine.removeTable('products'),false);
  assert.equal((await engine.previewTable('products')).totalRows,6);
  assert.ok((await engine.completionSymbols()).some(symbol=>symbol.name==='products' && symbol.kind==='table'));
  assert.equal(await engine.removeTable('products',{includeSession:true}),true);
  await assert.rejects(engine.previewTable('products'),/not found/);
  assert.ok(!(await engine.completionSymbols()).some(symbol=>symbol.name==='products' && symbol.kind==='table'));
  assert.deepEqual((await engine.preview()).rows,exampleResult.rows);
  assert.equal((await engine.previewTable('customers')).totalRows,40);
  assert.equal((await engine.previewTable(tables[0].sourceCode)).totalRows,2);
  assert.deepEqual(engine.imports.map(({tableName,fileName})=>({tableName,fileName})),importsBefore);
  assert.equal(await engine.removeTable('customers',{includeSession:true}),true);
  await assert.rejects(engine.previewTable('customers'),/not found/);
  assert.ok(!(await engine.completionSymbols()).some(symbol=>symbol.name==='customers' && symbol.kind==='table'));
  assert.deepEqual((await engine.preview()).rows,exampleResult.rows);
  passed('example table deletion removes session bindings and completions while preserving results and uploads');

  const selected=tables[0];
  assert.equal(await engine.removeTable(selected.tableName),true);
  assert.equal(await engine.removeTable(selected.tableName),false);
  assert.ok(!engine.imports.some(x=>x.tableName===selected.tableName));
  await assert.rejects(engine.previewTable(selected.sourceCode),/not found/);
  await assert.rejects(engine._webR.FS.readFile('/home/web_user/'+selected.fileName));
  assert.equal((await engine.previewTable(duplicate.sourceCode)).totalRows,2);
  engine.close();
  await engine.init();
  assert.ok(!engine.imports.some(x=>x.tableName===selected.tableName));
  assert.equal((await engine.previewTable(duplicate.sourceCode)).totalRows,2);
  passed('deletion removes the correct symbol and file and survives runtime restart');

  const result={verifiedAt:new Date().toISOString(),runtime:'Production REngine in Node webR',packageDelivery:process.env.TABLECRAFT_R_LIBRARY?'Compatible Wasm packages mounted locally':'Public Wasm package repository',versions:engine.versions,groups:report.length,report};
  if(process.env.TABLECRAFT_FEATURE_REPORT) await writeFile(resolve(process.env.TABLECRAFT_FEATURE_REPORT),JSON.stringify(result,null,2)+'\n');
  console.log(`SUCCESS: ${report.length} runtime feature groups.`);
} finally {
  engine.close();
  if(bridgeDirectory) await rm(bridgeDirectory,{recursive:true,force:true});
}
