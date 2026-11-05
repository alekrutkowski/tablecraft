/**
 * Optional DOM integration checks. These run the real UI and vendored editor
 * against a controlled R-engine double. They do not validate browser layout
 * or R semantics; runtime.integration.mjs exercises actual webR separately.
 * Run: npm install && npm run test:ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as catalog from '../js/catalog.js';
import * as compiler from '../js/compiler.js';
import * as datasets from '../js/datasets.js';
import * as diagnostics from '../js/diagnostics.js';
import * as icons from '../js/icons.js';
import * as editorSupport from '../js/editor-support.js';
import * as analysisSupport from '../js/analysis.js';
import { MAX_FILE_BYTES, buildImportCode, normaliseImportOptions, tableNameFromFile, cleanHelpText } from '../js/runtime.js';
import { WorkspaceStore } from '../js/persistence.js';
import { IDBFactory } from 'fake-indexeddb';
import { File } from 'node:buffer';

const { JSDOM, VirtualConsole } = process.env.TABLECRAFT_JSDOM_PATH
  ? createRequire(import.meta.url)(process.env.TABLECRAFT_JSDOM_PATH)
  : await import('jsdom');
const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const appSource = await readFile(new URL('js/app.js', root), 'utf8');
const editorFiles = ['codemirror.js', 'r.js', 'matchbrackets.js', 'closebrackets.js', 'show-hint.js'];
const editorSources = await Promise.all(editorFiles.map(file => readFile(new URL(`vendor/${file}`, root), 'utf8')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`);
    await delay(8);
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
const cancelled = () => Object.assign(new Error('R session restarted.'), { cancelled: true });
function resultPage({ label = 'result', totalRows = 250, offset = 0, limit = 100 } = {}) {
  return {
    rows: Array.from({ length: Math.min(limit, Math.max(0, totalRows - offset)) }, (_, index) => ({ id: offset + index + 1, value: `${label}:${offset + index + 1}` })),
    columns: [{ name: 'id', type: 'integer' }, { name: 'value', type: 'character' }],
    totalRows, totalColumns: 2, elapsedMs: 8, offset, limit, warnings: [], stdout: [],
  };
}

async function app(t, options = {}) {
  const errors = [], downloads = [], clipboard = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {
    url: 'https://example.test/tablecraft/', runScripts: 'outside-only',
    pretendToBeVisual: true, virtualConsole: console,
  });
  const w = dom.window, d = w.document;
  w.structuredClone = structuredClone;
  w.Blob = Blob;
  w.File = File;
  w.indexedDB = options.indexedDB || new IDBFactory();
  if(options.storage)Object.defineProperty(w,'localStorage',{value:options.storage});
  w.focus = () => {};
  w.scrollTo = () => {};
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  w.Range.prototype.getClientRects = () => [];
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const blobs = new Map();
  w.URL.createObjectURL = blob => { const url = `blob:test-${blobs.size}`; blobs.set(url, blob); return url; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {
    if (this.download) downloads.push({ filename: this.download, blob: blobs.get(this.href) });
  };
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => { clipboard.push(text); } } });
  w.addEventListener('error', event => errors.push(event.message));

  const control = {
    runs: [], inspections: [], previews: [], exports: [], imports: [], resets: 0,
    runPlans: [], previewPlans: [], initPlans: [],
    holdRun() { const task = deferred(); this.runPlans.push(task); return task; },
    failRun(message) { this.runPlans.push({ error: new Error(message) }); },
    holdPreview() { const task = deferred(); this.previewPlans.push(task); return task; },
  };
  if (options.holdInitialInit) control.initialInit = deferred(), control.initPlans.push(control.initialInit);

  class FakeEngine extends w.EventTarget {
    constructor() {
      super(); control.engine = this; this.generation = 0; this.pending = new Set();
      this.versions = { webR: '0.6.0', R: 'test-double' }; this.packages = {};
      this.current = null; this.nextImport = 1; this.records = new Map(); this.ready = false;
    }
    status(state, message) { this.dispatchEvent(new w.CustomEvent('status', { detail: { state, message } })); }
    async wait(plan) {
      if (plan?.error) throw plan.error;
      if (!plan?.promise) return plan;
      const cancellation = deferred(); this.pending.add(cancellation);
      try { return await Promise.race([plan.promise, cancellation.promise]); }
      finally { this.pending.delete(cancellation); }
    }
    async init() {
      const generation = this.generation;
      this.status('loading', 'Preparing test R engine');
      await this.wait(control.initPlans.shift());
      if (generation !== this.generation) throw cancelled();
      this.ready = true; this.status('ready', 'Test R engine ready'); return this.versions;
    }
    async inspect(code) {
      control.inspections.push(code);
      const badLine = code.split('\n').findIndex(line => line.includes('SYNTAX_ERROR')) + 1;
      return code.includes('SYNTAX_ERROR')
        ? { ok: false, diagnostics: [{ severity: 'error', message: `<text>:${badLine}:1: unexpected symbol`, line: badLine, column: 1, precise: true }] }
        : { ok: true, diagnostics: [] };
    }
    async run(code, settings = {}) {
      const generation = this.generation;
      control.runs.push({ code, settings });
      const number = control.runs.length;
      const value = await this.wait(control.runPlans.shift());
      if (generation !== this.generation) throw cancelled();
      this.current = { label: value?.label || `run-${number}`, totalRows: value?.totalRows ?? options.totalRows ?? 250 };
      return resultPage({ ...this.current, ...settings });
    }
    async preview(settings) {
      const generation = this.generation;
      control.previews.push(settings);
      const value = await this.wait(control.previewPlans.shift());
      if (generation !== this.generation) throw cancelled();
      return resultPage({ ...this.current, ...value, ...settings });
    }
    async exportCSV() {
      control.exports.push(this.current?.label);
      return new TextEncoder().encode(`value\n${this.current?.label}\n`);
    }
    async runAnalysis(code, options) {control.analyses ??= [];control.analyses.push({code,options});return {...resultPage({label:'analysis',totalRows:3}),images:[]};}
    async previewTable(expression, options) { control.tablePreviews ??= [];control.tablePreviews.push({expression,options});return resultPage({label:'table-preview',totalRows:8}); }
    async removeTable(name) {this.records.delete(name);control.deleted ??= [];control.deleted.push(name);}
    async completionSymbols() {return [{name:'new_custom_function',kind:'function',package:'user'}];}
    async helpFor(name, packageName) {return {text:options.helpText || `R help for ${name}`,package:packageName || 'base'};}
    async excelSheets() { return ['Sales', 'Products']; }
    async importFile(file, settings) {
      control.imports.push({ file, settings });
      if(options.failImports?.includes(file.name))throw new Error('Invalid input columns in '+file.name);
      const tableName = settings.tableName || tableNameFromFile(file.name,[...this.records.keys()]);
      const normalized = normaliseImportOptions(file.name, settings);
      const fileName = settings.fileName || file.name;
      const readCode = buildImportCode(fileName, normalized);
      const metadata = {
        id: tableName, tableName, label: file.name, fileName, originalName: file.name,
        sourceCode: catalog.rName(tableName), tablesCode: `${catalog.rName(tableName)} <- ${readCode}`, readCode,
        options: normalized, totalRows: 8, totalColumns: 3,
        columns: options.importColumns || [{ name: 'region', type: 'character' }, { name: 'units', type: 'integer' }, { name: 'price', type: 'numeric' }],
      };
      this.records.set(tableName, metadata); return metadata;
    }
    close({preserveFiles=true}={}) {
      this.generation += 1; this.ready = false; this.current = null;
      for (const cancellation of this.pending) {
        if (options.cancellationDelay) setTimeout(() => cancellation.reject(cancelled()), options.cancellationDelay);
        else cancellation.reject(cancelled());
      }
      this.pending.clear(); this.status('idle', 'R stopped');
      if(!preserveFiles)this.records.clear();
    }
    async reset() { control.resets += 1; this.close(); return this.init(); }
  }

  w.__dependencies = {
    ...catalog, ...compiler, ...datasets, ...diagnostics, ...icons, ...editorSupport, ...analysisSupport,
    hydrateIcons: (element = d) => icons.hydrateIcons(element), REngine: FakeEngine, MAX_FILE_BYTES, buildImportCode, cleanHelpText,
    WorkspaceStore:class extends WorkspaceStore {constructor(settings){super(settings);control.store=this;}},
  };
  editorSources.forEach((source, index) => w.eval(`${source}\n//# sourceURL=vendor/${editorFiles[index]}`));
  const importedNames = [...appSource.matchAll(/^import\s*\{([^}]+)\}\s*from/gm)].flatMap(match => match[1].split(',').map(name => name.trim()));
  const source = appSource.replace(/^import\s+[^\n]+\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
  new vm.Script(`'use strict';\nconst {${importedNames.join(',')}} = globalThis.__dependencies;\n${source}`, { filename: 'tablecraft-app-under-test.js' }).runInContext(dom.getInternalVMContext());
  const query = selector => d.querySelector(selector);
  const click = selector => { const element = query(selector); assert.ok(element, `Missing control: ${selector}`); element.click(); return element; };
  const input = (selector, value) => {
    const element = query(selector); assert.ok(element, `Missing field: ${selector}`);
    element.focus(); element.value = value; element.dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  const pause = () => { query('#auto-run').checked = false; query('#auto-run').dispatchEvent(new w.Event('change', { bubbles: true })); };
  const selectFile = (selector, file) => {
    Object.defineProperty(query(selector), 'files', { value: Array.isArray(file) ? file : [file], configurable: true });
    query(selector).dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const openRecipe = recipe => selectFile('#recipe-file', { name: 'recipe.json', size: JSON.stringify(recipe).length, text: async () => JSON.stringify(recipe) });
  t.after(async () => {await control.store?.close();dom.window.close();assert.deepEqual(errors, [], 'No uncaught UI or editor errors');});
  if(options.recovery)await until(()=>control.engine?.ready && query('#runtime-notice').hidden && !query('#run-button').disabled,'restored runtime',5000);
  else if (!options.holdInitialInit) await until(() => query('#result-state').textContent === 'Up to date', 'initial automatic run');
  else await until(() => !!control.engine && !!query('.CodeMirror'), 'engine and editor creation');
  return { w, d, query, click, input, pause, selectFile, openRecipe, control, downloads, clipboard, editor: () => query('.CodeMirror').CodeMirror };
}

test('initial wizard and real CodeMirror show the compiled magrittr pipeline', async t => {
  const a = await app(t);
  assert.equal(a.d.querySelectorAll('.step-item').length, 4);
  assert.equal(a.query('#step-count').textContent, '4');
  assert.match(a.editor().getValue(), /library\(data\.table\)/);
  assert.match(a.editor().getValue(), /%>%/);
  assert.ok(a.query('.CodeMirror-code'));
  assert.match(a.query('#source-name').textContent, /sales/i);
  assert.equal(a.query('#export-csv-button').disabled, false);
  a.click('[data-action="copy-code"]');
  await until(() => a.clipboard.length === 1, 'copy code');
  assert.equal(a.clipboard[0], a.editor().getValue());
});

test('choosing a dataset, adding a form, and editing it changes the executable code', async t => {
  const a = await app(t); a.pause();
  a.click('[data-action="source"]'); a.click('[data-dataset="iris"]');
  assert.equal(a.query('#step-count').textContent, '0');
  assert.match(a.editor().getValue(), /datasets::iris/);
  a.click('#add-step-button'); a.click('[data-operation="filter"]');
  a.input('#field-condition', 'Sepal.Length > 5.5');
  assert.match(a.editor().getValue(), /\.\[Sepal\.Length > 5\.5\]/);
  assert.doesNotMatch(a.editor().getValue(), /units >=/);
  a.click('#run-button');
  await until(() => a.control.runs.at(-1).code.includes('Sepal.Length > 5.5'), 'updated run');
});

test('pausing live preview still inspects syntax and waits for an explicit run', async t => {
  const a = await app(t); a.pause();
  const runs = a.control.runs.length, inspections = a.control.inspections.length;
  a.click('.step-item'); a.input('#field-condition', 'units >= 7');
  await delay(850);
  assert.equal(a.control.runs.length, runs);
  assert.ok(a.control.inspections.length > inspections);
  assert.equal(a.query('#export-csv-button').disabled, true);
  a.click('#run-button');
  await until(() => a.control.runs.length > runs && !a.query('#export-csv-button').disabled, 'explicit run');
});

test('manual editor changes synchronize into visual steps and retain the recoverable text draft', async t => {
  const a = await app(t); a.pause();
  const original = a.editor().getValue();
  const manual = original.replace('units >= 3', 'units >= 6');
  a.editor().setValue(manual);
  assert.equal(a.query('#text-mode-banner').hidden, false);
  assert.equal(a.query('#add-step-button').disabled, true);
  assert.equal(a.d.querySelectorAll('.step-item').length, 4);
  a.click('[data-action="visual-mode"]');
  assert.match(a.editor().getValue(), /units >= 6/);
  a.click('.step-item');
  assert.equal(a.query('#field-condition').value, 'units >= 6');
  assert.equal(a.query('#restore-text-button').hidden, false);
  a.click('#restore-text-button');
  assert.equal(a.editor().getValue(), manual);
  assert.equal(a.query('#code-mode-badge').textContent, 'Text mode');
});

test('theme and operation search work through actual controls', async t => {
  const a = await app(t); a.pause();
  const oldTheme = a.d.documentElement.dataset.bsTheme;
  a.click('#theme-button');
  assert.notEqual(a.d.documentElement.dataset.bsTheme, oldTheme);
  assert.equal(a.w.localStorage.getItem('tablecraft.theme'), a.d.documentElement.dataset.bsTheme);
  a.click('#add-step-button'); a.input('#operation-search', 'melt');
  assert.ok(a.query('[data-operation="melt"]'));
  assert.ok(a.query('[data-operation="melt-advanced"]'));
  assert.equal(a.query('[data-operation="filter"]'), null);
  a.click('[data-operation="melt"]');
  assert.ok(a.query('#field-idColumns'));
  assert.match(a.editor().getValue(), /melt\(id.vars/);
});

test('column completion quotes non-syntactic names appropriately for the editor context', async t => {
  const a = await app(t, { importColumns: [{ name: 'unit price', type: 'numeric' }] }); a.pause();
  a.click('[data-action="upload"]');
  a.selectFile('#data-file', { name: 'prices.csv', size: 50, arrayBuffer: async () => new ArrayBuffer(50) });
  a.click('#import-button');
  await until(() => a.query('#source-name').textContent === 'prices.csv', 'custom-name data imports');
  const complete = async code => {
    a.editor().setValue(code);
    a.editor().setCursor(0, code.indexOf('uni') + 3); a.editor().focus();
    a.editor().getInputField().dispatchEvent(new a.w.KeyboardEvent('keydown', {
      key: ' ', code: 'Space', keyCode: 32, which: 32, ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await until(() => [...a.d.querySelectorAll('.CodeMirror-hint')].some(element => element.firstElementChild?.textContent === 'unit price'), 'column completion appears');
    [...a.d.querySelectorAll('.CodeMirror-hint')].find(element => element.firstElementChild?.textContent === 'unit price').click();
    return a.editor().getValue();
  };
  assert.equal(await complete('result <- source_dt[, uni]'), 'result <- source_dt[, `unit price`]');
  assert.equal(await complete('result <- source_dt[, c("uni"), with = FALSE]'), 'result <- source_dt[, c("unit price"), with = FALSE]');
});

test('syntax diagnostics highlight the editor while retaining the last successful table', async t => {
  const a = await app(t); a.pause();
  const oldTable = a.query('#table-container').textContent;
  a.editor().setValue('library(data.table)\nresult <- data.table(x = 1L)\nSYNTAX_ERROR');
  await until(() => a.query('#diagnostics').textContent.includes('unexpected symbol'), 'syntax diagnostics');
  assert.equal(a.editor().lineInfo(2).gutterMarkers?.['lint-gutter']?.className, 'lint-dot');
  assert.equal(a.query('#table-container').textContent, oldTable);
  assert.equal(a.query('#export-csv-button').disabled, true);
});

test('a successful prefix preview preserves syntax errors in the unexecuted suffix', async t => {
  const a = await app(t); a.pause();
  a.click('#add-step-button'); a.click('[data-operation="custom"]');
  a.input('#field-expression', '.[SYNTAX_ERROR(');
  await until(() => a.query('#syntax-status').textContent.includes('Check your R syntax'), 'full-script parse failure');
  const badLine = a.editor().getValue().split('\n').findIndex(line => line.includes('SYNTAX_ERROR'));
  a.click('.step-item'); a.click('[data-action="preview-step"]');
  await until(() => a.query('#result-state').textContent === 'Through step 1', 'valid prefix result');
  assert.ok(!a.control.runs.at(-1).code.includes('SYNTAX_ERROR'));
  assert.match(a.query('#syntax-status').textContent, /Check your R syntax/);
  assert.ok(a.query('#diagnostics').textContent.includes('unexpected symbol'));
  assert.equal(a.editor().lineInfo(badLine).gutterMarkers?.['lint-gutter']?.className, 'lint-dot');
});

test('a superseded running result cannot overwrite the latest edited pipeline', async t => {
  const a = await app(t); a.pause();
  const pending = a.control.holdRun();
  const count = a.control.runs.length;
  a.click('#run-button');
  await until(() => a.control.runs.length === count + 1, 'held run begins');
  a.click('.step-item'); a.input('#field-condition', 'units >= 8'); a.click('#run-button');
  pending.resolve({ label: 'obsolete' });
  await until(() => a.control.runs.length === count + 2 && a.query('#result-state').textContent === 'Up to date', 'latest run completes');
  assert.match(a.control.runs.at(-1).code, /units >= 8/);
  assert.ok(!a.query('#table-container').textContent.includes('obsolete'));
  assert.equal(a.query('#export-csv-button').disabled, false);
});

test('a failed full run does not relabel or export the retained partial-step result', async t => {
  const a = await app(t); a.pause();
  a.d.querySelectorAll('.step-item')[1].click();
  const count = a.control.runs.length;
  a.click('[data-action="preview-step"]');
  await until(() => a.control.runs.length > count && a.query('#result-state').textContent.includes('Through step 2'), 'partial result');
  assert.equal(a.query('#export-csv-button').disabled, false);
  a.control.failRun("object 'revnue' not found");
  a.click('#run-button');
  await until(() => a.query('#diagnostics').textContent.includes('revnue'), 'full run fails');
  assert.equal(a.query('#export-csv-button').disabled, true);
  assert.notEqual(a.query('#result-state').textContent, 'Up to date');
  a.click('#export-csv-button');
  assert.equal(a.control.exports.length, 0);
  a.editor().setValue(a.editor().getValue() + '\n# Manual full-pipeline run\n');
  a.click('#run-button');
  await until(() => a.query('#result-state').textContent === 'Up to date', 'manual mode leaves partial preview scope');
  assert.equal(a.query('#code-mode-badge').textContent, 'Text mode');
});

test('a delayed successful syntax check cannot erase a runtime failure', async t => {
  const a = await app(t); a.pause();
  a.click('.step-item'); a.input('#field-condition', 'revnue > 0');
  a.control.failRun("object 'revnue' not found");
  a.click('#run-button');
  await until(() => a.query('#diagnostics').textContent.includes('revnue'), 'immediate runtime failure');
  await delay(600);
  assert.ok(a.query('#diagnostics').textContent.includes('revnue'));
  assert.equal(a.query('#diagnostics').hidden, false);
  assert.equal(a.query('#export-csv-button').disabled, true);
});

test('paging cannot update a restarted session and page-size controls stay locked while busy', async t => {
  const a = await app(t, { cancellationDelay: 30 }); a.pause();
  const page = a.control.holdPreview(); a.click('#next-page');
  await until(() => a.control.previews.length === 1, 'page request starts');
  assert.equal(a.query('#page-size').disabled, true);
  a.click('#stop-button');
  await until(() => a.control.resets === 1 && a.query('#runtime-notice').hidden, 'worker restarts');
  const run = a.control.holdRun(); a.click('#run-button');
  await until(() => a.control.runs.length === 2, 'new-session calculation starts');
  await delay(50);
  assert.equal(a.query('#stop-button').hidden, false);
  assert.equal(a.query('#page-size').disabled, true);
  page.resolve({ label: 'old-page' }); run.resolve({ label: 'fresh-session' });
  await until(() => a.query('#table-container').textContent.includes('fresh-session'), 'new result shown');
  assert.ok(!a.query('#table-container').textContent.includes('old-page'));
  assert.equal(a.query('#page-size').disabled, false);
});

test('a failed initialization can be retried using the Restart control', async t => {
  const a = await app(t, { holdInitialInit: true });
  a.control.initialInit.reject(new Error('Runtime download failed'));
  await until(() => !a.query('#restart-button').disabled && a.query('#runtime-notice').classList.contains('failed'), 'startup failure is reported');
  a.click('#restart-button');
  await until(() => a.query('#result-state').textContent === 'Up to date', 'replacement startup');
  assert.equal(a.query('#runtime-notice').hidden, true);
  assert.equal(a.query('#engine-status').textContent, 'R engine ready');
  assert.doesNotMatch(a.query('#syntax-status').textContent, /unavailable/);
});

test('undoing recipe replacement restores upload definitions and invalid recipes leave state intact', async t => {
  const a = await app(t); a.pause();
  a.click('[data-action="upload"]');
  a.selectFile('#data-file', { name: 'sales.csv', size: 100, arrayBuffer: async () => new ArrayBuffer(100) });
  a.click('#import-button');
  await until(() => a.query('#source-name').textContent === 'sales.csv', 'file import');
  const original = a.editor().getValue();
  assert.match(original, /sales_2 <- fread/);
  a.click('[data-action="save-recipe"]');
  const saved = JSON.parse(await a.downloads.at(-1).blob.text());
  assert.equal(saved.uploads.length, 1);
  assert.ok(!JSON.stringify(saved).includes('base64'));

  const replacement = { ...saved, source: { ...datasets.DATASETS.find(dataset => dataset.id === 'iris'), kind: 'builtin' }, uploads: [], steps: [], manual: false };
  a.openRecipe(replacement);
  await until(() => /Iris/.test(a.query('#source-name').textContent), 'recipe source replacement');
  a.click('#undo-button');
  assert.equal(a.query('#source-name').textContent, 'sales.csv');
  assert.match(a.editor().getValue(), /sales_2 <- fread/);
  assert.equal(a.query('#upload-count').textContent, '1');

  a.openRecipe({ ...replacement, source: { ...replacement.source, id: 'not-a-dataset' } });
  await delay(30);
  assert.equal(a.query('#source-name').textContent, 'sales.csv');
  assert.match(a.editor().getValue(), /sales_2 <- fread/);
});

test('reselecting a file restores a text-mode recipe without replacing its edited code', async t => {
  const first = await app(t); first.pause();
  first.click('[data-action="upload"]');
  first.selectFile('#data-file', { name: 'sales.csv', size: 100, arrayBuffer: async () => new ArrayBuffer(100) });
  first.click('#import-button');
  await until(() => first.query('#source-name').textContent === 'sales.csv', 'first session imports data');
  const manual = first.editor().getValue() + '\n# Hand-edited calculation\nresult <- result[, .(total = sum(units))]\nresult\n';
  first.editor().setValue(manual);
  first.click('[data-action="save-recipe"]');
  const saved = JSON.parse(await first.downloads.at(-1).blob.text());

  const second = await app(t); second.pause();
  second.openRecipe(saved);
  await until(() => second.query('#code-mode-badge').textContent === 'Text mode', 'text recipe opens');
  assert.equal(second.editor().getValue(), manual);
  const initialRuns = second.control.runs.length;
  second.click('#run-button');
  await until(() => second.query('#diagnostics').textContent.includes('Reselect'), 'missing input is reported');
  assert.equal(second.control.runs.length, initialRuns);

  second.click('[data-action="source"]'); second.click('[data-action="source-loaded"]');
  second.click('[data-action="reselect-file"]');
  second.selectFile('#data-file', { name: 'renamed-sales.csv', size: 100, arrayBuffer: async () => new ArrayBuffer(100) });
  second.click('#import-button');
  await until(() => second.control.imports.length === 1 && !second.query('#import-button').disabled, 'saved table reselected');
  assert.equal(second.control.imports[0].settings.tableName, 'sales_2');
  assert.equal(second.control.imports[0].settings.fileName, 'sales.csv');
  assert.equal(second.query('#code-mode-badge').textContent, 'Text mode');
  assert.equal(second.editor().getValue(), manual);
  second.click('#run-button');
  await until(() => second.control.runs.length === initialRuns + 1, 'restored manual script runs');
  assert.equal(second.control.runs.at(-1).code, manual);
});

const fixtureFile = name => new File([new Uint8Array(100)],name);

test('one selection imports every file, preserves filenames in names, and emits every import', async t => {
  const a = await app(t); a.pause();
  a.click('[data-action="upload"]');
  a.selectFile('#data-file', [fixtureFile('orders 2026.csv'), fixtureFile('customers-west.csv'), fixtureFile('orders 2026.csv')]);
  assert.equal(a.query('#data-file').multiple, true);
  a.click('#import-button');
  await until(()=>a.control.imports.length===3&&!a.query('#import-button').disabled,'batch import');
  const code=a.editor().getValue();
  for(const name of ['orders 2026','customers-west','orders 2026_2']) assert.ok(code.includes(catalog.rName(name)+' <-'),name);
  assert.equal(a.query('#upload-count').textContent,'3');
  assert.equal(a.query('#source-name').textContent,'orders 2026.csv');
  assert.equal(a.d.querySelectorAll('.loaded-table[data-kind="upload"]').length,3);
});

test('table names insert backticked code and table manager search, preview and deletion work', async t => {
  const a=await app(t);a.pause();
  a.click('[data-action="upload"]');a.selectFile('#data-file',[fixtureFile('my orders.csv'),fixtureFile('lookup.csv')]);a.click('#import-button');
  await until(()=>a.control.imports.length===2&&!a.query('#import-button').disabled,'imports');
  a.d.querySelector('#source-dialog').close();
  a.editor().setValue('');a.editor().focus();
  a.click('#table-name-list [data-table="my orders"][data-action="insert-table"]');
  assert.equal(a.editor().getValue(),'`my orders`',a.query('#toast-container').textContent);
  a.click('[data-action="manage-tables"]');a.input('#loaded-table-search','lookup.csv');
  assert.equal(a.d.querySelectorAll('.loaded-table').length,1);
  const oldResult=a.query('#table-container').textContent;
  a.click('#loaded-tables [data-action="preview-table"]');
  await until(()=>a.query('#table-preview-meta').textContent.includes('8 rows'),'table preview');
  assert.equal(a.query('#table-container').textContent,oldResult);
  a.query('#table-preview-dialog').close();
  a.click('#loaded-tables [data-action="delete-table"]');
  await until(()=>a.control.deleted?.includes('lookup')&&a.query('#upload-count').textContent==='1','delete');
  assert.equal(a.query('#upload-count').textContent,'1');
  assert.equal(a.query('#source-name').textContent,'my orders.csv');
});

test('visual fields propose table and column candidates and Code hints can be disabled', async t=>{
  const a=await app(t);a.pause();
  a.click('[data-action="source"]');a.click('[data-dataset="iris"]');
  a.click('#add-step-button');a.click('[data-operation="join"]');
  a.input('#field-table','iris_');
  assert.equal(a.query('#field-hints').hidden,false);
  assert.ok(a.query('#field-hints').textContent.includes('iris_lookup'));
  a.query('#field-hints [data-hint-index="0"]').dispatchEvent(new a.w.MouseEvent('mousedown',{bubbles:true,cancelable:true}));
  assert.equal(a.query('#field-table').value,'iris_lookup');
  a.input('#field-leftKeys','Sep');
  assert.ok(a.query('#field-hints').textContent.includes('Sepal.Length'));
  a.query('#intellisense-toggle').checked=false;a.query('#intellisense-toggle').dispatchEvent(new a.w.Event('change',{bubbles:true}));
  assert.equal(a.query('#field-hints').hidden,true);
  assert.equal(a.w.localStorage.getItem('tablecraft.completions'),'off');
  a.input('#field-leftKeys','Pet');assert.equal(a.query('#field-hints').hidden,true);
});

test('a join without uploads gets a compatible distinct example and all definitions', async t=>{
  const a=await app(t);a.pause();
  a.click('[data-action="source"]');a.click('[data-dataset="iris"]');
  a.click('#add-step-button');a.click('[data-operation="join"]');
  assert.equal(a.query('#field-table').value,'iris_lookup');
  assert.equal(a.query('#field-leftKeys').value,'Species');
  assert.match(a.editor().getValue(),/iris_lookup <- local/);
  assert.match(a.editor().getValue(),/unique\(as.data.table\(\.tc_example_source\)/);
  assert.match(a.editor().getValue(),/y = iris_lookup/);
  assert.ok(a.query('.step-documentation a').href.includes('merge'));
});

test('arbitrary R survives mode switching in a full-script card', async t=>{
  const a=await app(t);a.pause();
  const code='f <- function(x) x + 1\nvalue <- f(2)\nprint(value)\ndata.table(value=value)\n';
  a.editor().setValue(code);a.click('#visual-mode-button');
  assert.equal(a.editor().getValue(),code);
  assert.equal(a.d.querySelectorAll('.step-item').length,1);
  assert.equal(a.query('#field-code').value,code);
  assert.equal(a.query('#add-step-button').disabled,true);
  a.input('#field-code',code.replace('f(2)','f(3)'));
  assert.ok(a.editor().getValue().includes('f(3)'));
});

test('function help opens installed R help and runtime errors offer encoded external assistance', async t=>{
  const a=await app(t);a.pause();
  a.editor().setValue('sum(1:3)');a.editor().setCursor(0,2);a.click('#function-help-button');
  await until(()=>a.query('#function-help-text').textContent.includes('R help for sum'),'function help');
  assert.equal(a.query('#function-help-dialog').open,true);
  assert.ok(a.query('#function-help-link').href.startsWith('https://'));
  a.query('#function-help-dialog').close();
  a.control.failRun('object "x & y" not found');a.click('#run-button');
  await until(()=>a.query('.error-consultation a'),'error assistance');
  const url=new URL(a.query('.error-consultation a').href);
  assert.equal(url.origin,'https://chat.mistral.ai');
  assert.ok(url.searchParams.get('q').includes('object "x & y" not found'));
  assert.ok(url.searchParams.get('q').includes('sum(1:3)'));
});

test('data explorer generates reproducible R, runs independently, and copies and downloads its code',async t=>{
  const a=await app(t);a.pause();
  const preview=a.query('#table-container').textContent;
  a.click('[data-action="analysis"]');
  assert.equal(a.query('#analysis-dialog').open,true);
  assert.ok(a.query('#analysis-code').value.includes('result <- local({'));
  assert.ok(a.query('#analysis-code').value.includes('library(data.table)'));
  a.click('.analysis-run');
  await until(()=>a.control.analyses?.length&&a.query('#analysis-results').textContent.includes('analysis:1'),'independent analysis');
  assert.equal(a.query('#table-container').textContent,preview);
  assert.equal(a.query('#export-csv-button').disabled,false);
  a.click('#analysis-code-tab');a.click('[data-analysis-action="copy"]');
  await until(()=>a.clipboard.length>0,'copy analysis R');
  assert.equal(a.clipboard.at(-1),a.query('#analysis-code').value);
  a.click('[data-analysis-action="download"]');
  await until(()=>a.downloads.some(file=>file.filename==='tablecraft-profile.R'),'download analysis R');
  assert.equal(await a.downloads.at(-1).blob.text(),a.query('#analysis-code').value);
});

test('a failed batch member stays retryable and does not discard successful imports', async t=>{
  const a=await app(t,{failImports:['broken.csv']});a.pause();
  a.click('[data-action="upload"]');a.selectFile('#data-file',[fixtureFile('good.csv'),fixtureFile('broken.csv')]);a.click('#import-button');
  await until(()=>a.control.imports.length===2&&!a.query('#import-button').disabled,'partial batch');
  assert.equal(a.query('#upload-count').textContent,'1');
  assert.ok(a.editor().getValue().includes('good <- fread'));
  assert.equal(a.d.querySelectorAll('.pending-file').length,1);
  assert.ok(a.query('.pending-file').textContent.includes('broken.csv'));
  assert.ok(a.query('#pending-files .error-consultation a').href.includes('chat.mistral.ai'));
});

test('batch workbook settings and primary-table choice survive switching between files', async t=>{
  const a=await app(t);a.pause();
  a.click('[data-action="upload"]');a.selectFile('#data-file',[fixtureFile('first.xlsx'),fixtureFile('second.xlsx')]);
  await until(()=>a.query('#import-sheet').value==='Sales','first workbook sheets');
  a.query('#import-sheet').value='Products';a.query('#import-primary').checked=false;
  a.click('[data-action="select-import"][data-index="1"]');
  await until(()=>a.query('#file-drop-title').textContent==='second.xlsx'&&a.query('#import-sheet').value==='Sales','second workbook');
  a.click('[data-action="select-import"][data-index="0"]');
  await delay(20);
  assert.equal(a.query('#import-sheet').value,'Products');
  assert.equal(a.query('#import-primary').checked,false);
  a.click('#import-button');await until(()=>a.control.imports.length===2&&!a.query('#import-button').disabled,'workbook batch');
  assert.equal(a.control.imports[0].settings.sheet,'Products');
  assert.equal(a.control.imports[1].settings.sheet,'Sales');
  assert.equal(a.query('#source-name').textContent,'Shop sales');
});

test('auto-selected join keys preserve comma-containing column names',async t=>{
  const a=await app(t,{importColumns:[{name:'gross, net',type:'numeric'}]});a.pause();
  a.click('[data-action="upload"]');a.selectFile('#data-file',[fixtureFile('left.csv'),fixtureFile('right.csv')]);a.click('#import-button');
  await until(()=>a.control.imports.length===2&&!a.query('#import-button').disabled,'two tables');a.query('#source-dialog').close();
  a.click('#add-step-button');a.click('[data-operation="join"]');
  assert.deepEqual(catalog.parseColumns(a.query('#field-leftKeys').value),['gross, net']);
  assert.match(a.editor().getValue(),/by.x = c\("gross, net"\)/);
});

test('switching immediately to Visual hydrates referenced examples and preserves a new text source',async t=>{
  const a=await app(t);a.pause();
  a.editor().setValue('result <- sales %>% merge(y = products, by = "product", sort = FALSE)\nresult\n');a.click('#visual-mode-button');
  assert.match(a.editor().getValue(),/sales <- local/);
  assert.match(a.editor().getValue(),/products <- data.table/);
  a.editor().setValue('orders <- data.table(amount = 1:3)\nsource_dt <- orders\nout <- copy(source_dt) %>% .[amount > 1]\nout\n');a.click('#visual-mode-button');
  assert.equal(a.query('#source-name').textContent,'orders');
  assert.ok(a.query('#source-dimensions').textContent.includes('Source defined in R'));
  assert.equal(a.query('#column-count').textContent,'0');
  assert.ok(a.editor().getValue().includes('out <- copy(source_dt)'));
});

function sharedStorage() {
  const entries=new Map();
  return {getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,String(value)),removeItem:key=>entries.delete(key),
    key:index=>[...entries.keys()][index]??null,get length(){return entries.size;}};
}

test('refresh restores edited text, hidden comments, paused preview, hints, searches and theme',async t=>{
  const storage=sharedStorage(),indexedDB=new IDBFactory();
  const a=await app(t,{storage,indexedDB});a.pause();
  a.editor().setValue('# Keep this note\nresult <- data.table(value = 41) # explanation\nresult\n');
  a.click('#comments-toggle');
  a.editor().setValue(a.editor().getValue().replace('41','42'));
  a.query('#intellisense-toggle').checked=false;a.query('#intellisense-toggle').dispatchEvent(new a.w.Event('change',{bubbles:true}));
  a.input('#table-search','prod');a.click('#theme-button');
  const visible=a.editor().getValue();
  const b=await app(t,{storage,indexedDB,recovery:true});
  assert.equal(b.editor().getValue(),visible);
  assert.equal(b.query('#text-mode-banner').hidden,false);
  assert.equal(b.query('#auto-run').checked,false);
  assert.equal(b.query('#intellisense-toggle').checked,false);
  assert.equal(b.query('#comments-toggle').getAttribute('aria-pressed'),'false');
  assert.equal(b.query('#table-search').value,'prod');
  assert.equal(b.d.documentElement.dataset.bsTheme,'dark');
  assert.equal(b.control.runs.length,0,'paused state does not execute restored text');
  b.click('#comments-toggle');
  assert.match(b.editor().getValue(),/# Keep this note/);
  assert.match(b.editor().getValue(),/value = 42/);
  assert.doesNotMatch(b.editor().getValue(),/value = 41/);
});

test('refresh restores multiple exact file contents and import options without file selection',async t=>{
  const storage=sharedStorage(),indexedDB=new IDBFactory();
  const a=await app(t,{storage,indexedDB});a.pause();
  const first=new File(['id,amount\n1,2\n3,4\n'],'North America.csv',{type:'text/csv',lastModified:1234});
  const second=new File(['id\tamount\n5\t6\n'],'2026-results.tsv',{type:'text/tab-separated-values',lastModified:5678});
  a.click('[data-action="upload"]');a.selectFile('#data-file',[first,second]);
  a.query('#import-skip').value='1';a.click('#import-button');
  await until(()=>a.control.imports.length===2&&!a.query('#import-button').disabled,'saved batch');
  const code=a.editor().getValue();
  const b=await app(t,{storage,indexedDB,recovery:true});
  assert.equal(b.control.imports.length,2);
  assert.equal(b.query('#upload-count').textContent,'2');
  assert.equal(b.query('#source-name').textContent,'North America.csv');
  assert.equal(b.editor().getValue(),code);
  assert.equal(b.control.imports[0].file.name,first.name);
  assert.equal(b.control.imports[0].settings.tableName,'North America');
  assert.equal(b.control.imports[0].settings.skip,1);
  assert.equal(b.control.imports[1].settings.delimiter,'\t');
  assert.deepEqual(new Uint8Array(await b.control.imports[0].file.arrayBuffer()),new Uint8Array(await first.arrayBuffer()));
  assert.deepEqual(new Uint8Array(await b.control.imports[1].file.arrayBuffer()),new Uint8Array(await second.arrayBuffer()));
  b.click('[data-action="manage-tables"]');
  assert.equal(b.d.querySelectorAll('[data-action="reselect-file"]').length,0);
  b.click('[data-action="delete-table"][data-table="North America"]');
  await until(()=>b.query('#upload-count').textContent==='1','delete persisted table');
  const c=await app(t,{storage,indexedDB,recovery:true});
  assert.equal(c.query('#upload-count').textContent,'1');
  assert.equal(c.control.imports.some(item=>item.settings.tableName==='North America'),false);
});

test('Restart app requires confirmation and clears state, files and undo across refresh',async t=>{
  const storage=sharedStorage(),indexedDB=new IDBFactory();storage.setItem('unrelated.app','keep');
  const a=await app(t,{storage,indexedDB});a.pause();
  a.click('[data-action="upload"]');a.selectFile('#data-file',new File(['id\n1\n'],'private input.csv'));a.click('#import-button');
  await until(()=>a.query('#upload-count').textContent==='1'&&!a.query('#import-button').disabled,'saved file');
  a.query('#source-dialog').close();
  a.editor().setValue('# private note\nresult <- data.table(value = 987654)\nresult');
  const previous=a.editor().getValue();
  a.click('#restart-app-button');
  assert.equal(a.query('#restart-app-dialog').open,true);
  assert.equal(a.editor().getValue(),previous);
  a.click('#restart-app-dialog .dialog-footer [data-close]');
  assert.equal(a.query('#restart-app-dialog').open,false);
  assert.equal(a.editor().getValue(),previous);
  a.click('#restart-app-button');a.click('#confirm-restart-app');
  await until(()=>!a.query('#restart-app-dialog').open&&a.query('#result-state').textContent==='Up to date','confirmed full restart');
  assert.equal(a.query('#upload-count').textContent,'0');
  assert.equal(a.query('#text-mode-banner').hidden,true);
  assert.equal(a.query('#step-count').textContent,'4');
  assert.equal(a.query('#undo-button').disabled,true);
  assert.match(a.editor().getValue(),/units >= 3/);
  assert.doesNotMatch(a.editor().getValue(),/987654|private note/);
  assert.equal(a.control.engine.records.size,0);
  assert.equal(storage.getItem('unrelated.app'),'keep');
  const b=await app(t,{storage,indexedDB,recovery:true});
  assert.equal(b.query('#upload-count').textContent,'0');
  assert.equal(b.query('#step-count').textContent,'4');
  assert.doesNotMatch(b.editor().getValue(),/987654|private note/);
});

test('comment toggle affects editor, copy, download and run while preserving R string hashes and edits',async t=>{
  const a=await app(t);a.pause();
  a.editor().setValue('# Heading\nresult <- data.table(value = 1, text = "# literal") # Inline note\nresult\n');
  a.click('#comments-toggle');
  const hidden=a.editor().getValue();
  assert.doesNotMatch(hidden,/# Heading|# Inline note/);
  assert.match(hidden,/'# literal'|"# literal"/);
  a.editor().setValue(hidden.replace('value = 1','value = 2'));
  a.click('#copy-code-button');await until(()=>a.clipboard.length>0,'copy without comments');
  assert.equal(a.clipboard.at(-1),a.editor().getValue());
  a.click('[data-action="download-r"]');await until(()=>a.downloads.length>0,'download without comments');
  assert.equal(await a.downloads.at(-1).blob.text(),a.editor().getValue()+'\n');
  a.click('#run-button');await until(()=>a.control.runs.at(-1).code.includes('value = 2'),'run without comments');
  assert.doesNotMatch(a.control.runs.at(-1).code,/# Heading|# Inline note/);
  a.click('#comments-toggle');
  assert.match(a.editor().getValue(),/# Heading/);assert.match(a.editor().getValue(),/# Inline note/);
  assert.match(a.editor().getValue(),/value = 2/);
  a.click('#comments-toggle');
  a.editor().setValue(a.editor().getValue()+'\n# New comment');
  assert.equal(a.query('#comments-toggle').getAttribute('aria-pressed'),'true');
  assert.match(a.editor().getValue(),/# New comment/);
});

test('F1 help cleans legacy terminal overstrikes before rendering',async t=>{
  const a=await app(t,{helpText:'_\bF_\ba_\bs_\bt row reordering\n\nUsage:\n  setorderv(x)'});a.pause();
  a.editor().setValue('setorderv(x, "revenue")');a.editor().setCursor({line:0,ch:5});
  a.click('#function-help-button');
  await until(()=>a.query('#function-help-text').textContent.includes('Fast row reordering'),'plain help');
  assert.doesNotMatch(a.query('#function-help-text').textContent,/[\b\x1b]/);
});

test('sort remains a visual sort after editing and restoring na.last in Text mode',async t=>{
  const a=await app(t);a.pause();
  assert.match(a.editor().getValue(),/setorderv\(cols = c\("revenue"\), order = c\(-1L\), na.last = TRUE\)/);
  a.editor().setValue(a.editor().getValue().replace('na.last = TRUE','na.last = FALSE'));
  a.click('#visual-mode-button');a.click('.step-item:nth-child(4)');
  assert.ok(a.query('#field-naLast'),'sort checkbox exists after edit');
  assert.equal(a.query('#field-naLast').checked,false);
  a.click('#text-mode-button');
  a.editor().setValue(a.editor().getValue().replace('na.last = FALSE','na.last = TRUE'));
  a.click('#visual-mode-button');a.click('.step-item:nth-child(4)');
  assert.equal(a.query('#field-naLast').checked,true);
  assert.doesNotMatch(a.query('#pipeline-list').textContent,/Custom R pipe step/);
});

test('a recipe read started before Restart app cannot restore old work afterward',async t=>{
  const a=await app(t);a.pause();
  a.click('[data-action="save-recipe"]');await until(()=>a.downloads.length>0,'saved recipe fixture');
  const recipe=JSON.parse(await a.downloads.at(-1).blob.text());
  recipe.manual=true;recipe.code='result <- data.table(stale_secret = 987654)\nresult';recipe.annotatedCode=recipe.code;
  const read=deferred();a.selectFile('#recipe-file',{name:'slow.json',size:200,text:()=>read.promise});
  a.click('#restart-app-button');a.click('#confirm-restart-app');
  await until(()=>!a.query('#restart-app-dialog').open&&a.query('#result-state').textContent==='Up to date','fresh workspace');
  read.resolve(JSON.stringify(recipe));await delay(50);
  assert.doesNotMatch(a.editor().getValue(),/stale_secret|987654/);
  assert.equal(a.query('#text-mode-banner').hidden,true);
  const saved=await a.control.store.load();
  assert.doesNotMatch(saved.code,/stale_secret|987654/);
});

test('Run shortcuts cannot enter R while a confirmed app restart waits for storage',async t=>{
  const a=await app(t);a.pause();
  const gate=deferred(),clear=a.control.store.clear.bind(a.control.store);
  a.control.store.clear=async()=>{await gate.promise;return clear();};
  const before=a.control.runs.length;
  a.click('#restart-app-button');a.click('#confirm-restart-app');
  a.d.body.dispatchEvent(new a.w.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));
  await delay(40);
  assert.equal(a.control.runs.length,before);
  gate.resolve();
  await until(()=>!a.query('#restart-app-dialog').open&&a.query('#result-state').textContent==='Up to date','restart after storage');
});

test('products and customers can be removed from the sidebar and manager and stay removed after refresh',async t=>{
  const storage=sharedStorage(),indexedDB=new IDBFactory();
  const a=await app(t,{storage,indexedDB});a.pause();
  a.click('#table-name-list [data-action="delete-table"][data-table="products"]');
  await until(()=>!a.query('#table-name-list [data-action="insert-table"][data-table="products"]'),'remove products');
  a.click('[data-action="manage-tables"]');
  a.click('#loaded-tables [data-action="delete-table"][data-table="customers"]');
  await until(()=>!a.query('#table-name-list [data-action="insert-table"][data-table="customers"]'),'remove customers');
  assert.ok(a.control.deleted.includes('products'));assert.ok(a.control.deleted.includes('customers'));
  assert.equal(a.query('#step-count').textContent,'4');
  a.query('#source-dialog').close();
  const b=await app(t,{storage,indexedDB,recovery:true});
  assert.equal(b.query('#table-name-list [data-action="insert-table"][data-table="products"]'),null);
  assert.equal(b.query('#table-name-list [data-action="insert-table"][data-table="customers"]'),null);
  b.click('[data-action="source"]');
  assert.ok(b.query('[data-action="restore-example"][data-table="products"]'));
  b.click('[data-action="restore-example"][data-table="products"]');
  assert.ok(b.query('#table-name-list [data-action="insert-table"][data-table="products"]'));
  assert.equal(b.query('#table-name-list [data-action="insert-table"][data-table="customers"]'),null);
});

test('new joins do not silently restore a removed built-in or reuse a removed companion name',async t=>{
  const a=await app(t);a.pause();
  a.click('#table-name-list [data-action="delete-table"][data-table="products"]');
  await until(()=>!a.query('#table-name-list [data-table="products"]'),'products removed');
  a.click('#table-name-list [data-action="delete-table"][data-table="customers"]');
  await until(()=>!a.query('#table-name-list [data-table="customers"]'),'customers removed');
  a.click('#add-step-button');a.click('[data-operation="join"]');
  const companion=a.query('#field-table').value.replace(/^`|`$/g,'');
  assert.notEqual(companion,'products');assert.notEqual(companion,'customers');
  a.click(`#table-name-list [data-action="delete-table"][data-table="${companion}"]`);
  await until(()=>!a.query(`#table-name-list [data-table="${companion}"]`),'companion removed');
  a.click('#add-step-button');a.click('[data-operation="join"]');
  assert.notEqual(a.query('#field-table').value.replace(/^`|`$/g,''),companion);
  assert.equal(a.query('#table-name-list [data-table="products"]'),null);
  assert.equal(a.query('#table-name-list [data-table="customers"]'),null);
});
