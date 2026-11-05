import { OPERATIONS, HELPERS, parseColumns, rString, documentationFor, operationDocumentation } from './catalog.js';
import { compilePipeline, defaultsFor, validateStep, rName, parsePipeline, referencedNames, formatRCode, stripRComments, reconcileRComments } from './compiler.js';
import { DATASETS, LOOKUP_TABLES } from './datasets.js';
import { REngine, MAX_FILE_BYTES, buildImportCode, cleanHelpText } from './runtime.js';
import { explainError, preflight } from './diagnostics.js';
import { icon, hydrateIcons, categoryIcon } from './icons.js';
import { completionCandidates, completionContext, literalListContext, functionAt, R_FUNCTIONS, errorConsultationURL } from './editor-support.js';
import { initAnalysis } from './analysis.js';
import { WorkspaceStore } from './persistence.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clone = value => structuredClone(value);
const uid = () => globalThis.crypto?.randomUUID?.() || `step-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const opFor = id => OPERATIONS.find(op => op.id === id);
const formatNumber = value => Number(value).toLocaleString('en-US');
const columnFieldValue = value => /[,\n\r\t`"'\\]/.test(value) || value.trim() !== value ? rString(value) : value;
const engine = new REngine();
const seed = [
  { id: uid(), op: 'filter', params: { condition: 'units >= 3' }, enabled: true },
  { id: uid(), op: 'mutate', params: { name: 'revenue', expression: 'round(units * unit_price, 2)', groups: '', where: '' }, enabled: true },
  { id: uid(), op: 'summarize', params: { expressions: 'orders = .N, revenue = sum(revenue), units = sum(units)', groups: 'region', sorted: false }, enabled: true },
  { id: uid(), op: 'sort', params: { columns: 'revenue', directions: '-1', naLast: true }, enabled: true },
];
const state = {
  source: { ...DATASETS.find(data => data.id === 'sales'), kind: 'builtin' },
  uploads: [], examples: [], removedExamples: [], steps: seed, selectedId: seed[2].id, manual: false, manualDraft: '', code: '', sync: null,
  compiled: { code: '', lineMap: [], issues: [] }, version: 0, syntaxVersion: -1,
  syntaxOK: null, autoRun: true, ready: false, busy: false, importing: false,
  result: null, resultVersion: -1, previewStepId: null, requestedThroughId: null, offset: 0, pageSize: 100,
  requestToken: 0, resultToken: -1, runFailed: false,
  diagnostics: [], syntaxDiagnostics: [], errorStepId: null, undo: [], redo: [], pendingFile: null,
  pendingRestoreTable: null, pendingFiles: [], pendingFileIndex: -1, fileSelectionToken: 0, columnsVisible: true, lastField: null,
  completions: true, symbols: [], helpSymbol: '', tableQuery: '', tablePreviewToken: 0,
  includeComments: true, annotatedCode: '', draftAnnotatedCode: '', restoring: false, resetting: false,
};
const initialState = clone(state);
let persistenceReady = false, recoveryUploads = [], recoveredView = null, savedAnalysisConfig = null;
let saveNotice = {state:'saving',message:'Preparing local recovery…'}, saveWarningShown = false;
let storage;
try { storage = window.localStorage; } catch {}
const workspaceStore = new WorkspaceStore({storage, indexedDB:window.indexedDB, pathname:location.pathname,
  onStatus:detail=>{saveNotice=detail;renderSaveStatus();}});
let cm, updatingEditor = false, lintMarks = [], lintLines = [], lastEditKey = null;
let analysis, hintTimer, fieldHintState = null;
let checkTimer, runTimer, pendingCheck = null, pendingRun = null, workerTask = null;
let taskGeneration = 0, operationCategory = 'All', draggedId = null, runtimeState = 'starting';
const schemaCache = new Map();
const resultIsCurrent = () => Boolean(state.result && state.resultVersion === state.version && state.resultToken === state.requestToken && !state.runFailed);
const stepsThrough = id => id ? state.steps.slice(0,state.steps.findIndex(step=>step.id===id)+1) : state.steps;
const schemaKey = steps => JSON.stringify([state.source.sourceCode, state.sync?.preambleCode, state.sync?.pipelineSource, tableDefinitions(steps), steps.filter(step=>step.enabled).map(step=>[step.op,step.params])]);

function toast(message, error = false) {
  const item = document.createElement('div');
  item.className = `app-toast${error ? ' error' : ''}`;
  item.textContent = message;
  $('#toast-container').append(item);
  setTimeout(() => item.remove(), error ? 6500 : 3300);
}

function typeInfo(type = '') {
  const text = String(type);
  if (/date|time/i.test(text)) return { mark: '◷', label: 'date', cls: 'date' };
  if (/integer64/.test(text)) return { mark: '#', label: 'int64', cls: 'numeric' };
  if (/integer/.test(text)) return { mark: '#', label: 'int', cls: 'numeric' };
  if (/numeric|double/.test(text)) return { mark: '#', label: 'dbl', cls: 'numeric' };
  if (/logical/.test(text)) return { mark: 'T/F', label: 'lgl', cls: 'logical' };
  if (/factor/.test(text)) return { mark: 'Aa', label: 'fct', cls: '' };
  if (/list/.test(text)) return { mark: '[]', label: 'list', cls: '' };
  return { mark: 'Aa', label: 'chr', cls: '' };
}

// Suggestions follow common schema-changing steps. R remains authoritative.
function suggestedColumns(beforeId = null) {
  const beforeIndex = state.steps.findIndex(step=>step.id===beforeId);
  const preceding = beforeIndex < 0 ? state.steps : state.steps.slice(0,beforeIndex);
  const cached = schemaCache.get(schemaKey(preceding));
  if (cached) return clone(cached);
  let columns = clone(state.source.columns || []);
  for (const step of state.steps) {
    if (step.id === beforeId) break;
    if (!step.enabled) continue;
    const p = step.params;
    const add = (name, type = 'numeric') => {
      if (!name) return;
      columns = columns.filter(c => c.name !== name).concat({ name, type });
    };
    if (opFor(step.op)?.fields.some(field=>field.key==='name')) {
      const type = step.op==='date' ? (p.kind==='as.ITime'?'ITime':'IDate') : ['text-transform','if-else','case'].includes(step.op) ? 'character' : step.op==='shift' ? columns.find(col=>col.name===p.column)?.type || 'numeric' : 'numeric';
      add(p.name,type);
    }
    if(step.op==='mutate-many')parseColumns(p.columns).forEach(name=>add(name));
    if (step.op === 'select') columns = parseColumns(p.columns).map(name => columns.find(c => c.name === name) || {name,type:'unknown'});
    if (['drop', 'drop-columns'].includes(step.op)) columns = columns.filter(c => !parseColumns(p.columns).includes(c.name));
    if (step.op === 'rename') {
      const oldNames = parseColumns(p.old || p.from || p.oldNames);
      const newNames = parseColumns(p.new || p.to || p.newNames);
      columns = columns.map(c => oldNames.includes(c.name) ? { ...c, name: newNames[oldNames.indexOf(c.name)] || c.name } : c);
    }
    if (step.op === 'summarize' || step.op === 'count') {
      const grouping = parseColumns(p.groups);
      columns = grouping.map(name => columns.find(c => c.name === name) || { name, type: 'character' });
      if (step.op === 'count') add(p.name || 'N', 'integer');
      else {
        const names = [...String(p.expressions || '').matchAll(/(?:^|,)\s*(`[^`]+`|[A-Za-z.][\w.]*)\s*=(?!=)/g)].map(match => match[1].replace(/^`|`$/g, ''));
        names.forEach(name => add(name));
      }
    }
    if (step.op === 'melt') {
      const ids = parseColumns(p.idColumns);
      columns = columns.filter(c => ids.includes(c.name));
      add(p.variableName || 'variable', p.factor ? 'factor' : 'character');
      add(p.valueName || p.value || 'value', 'numeric');
    }
  }
  return columns;
}

function context(beforeId = state.selectedId) {
  return { columns: suggestedColumns(beforeId), tables: availableTables().map(table => table.tableName) };
}

function availableTables({allExamples = false} = {}) {
  const tables = [...(allExamples ? DATASETS : LOOKUP_TABLES), ...state.examples, state.source, ...state.uploads];
  return [...new Map(tables.filter(table => table?.tableName && (table.kind === 'upload' || !state.removedExamples.includes(table.tableName))).map(table => [table.tableName, table])).values()];
}

function exampleTables() {
  return [...new Map([...DATASETS,...state.examples].map(table=>[table.tableName,table])).values()];
}
const removableTable = table => table?.kind === 'upload' || exampleTables().some(example=>example.tableName === table?.tableName);

function analysisTables() {
  const others = availableTables({allExamples:true}).filter(table => !table.missing);
  const tables = [state.source, ...others.filter(table => table.tableName !== state.source.tableName)].filter(table => !table.missing);
  if (resultIsCurrent()) tables.unshift({tableName:'result', label:'Current pipeline result', rows:state.result.totalRows,
    columns:clone(state.result.columns), sourceCode:'result',
    tablesCode:`result <- local({\n${formatRCode(state.code,{baseIndent:2})}\n})`});
  return [...new Map(tables.map(table => [table.tableName,table])).values()];
}

function snapshot() {
  return clone({ source: state.source, uploads:state.uploads, examples: state.examples, removedExamples:state.removedExamples, sync: state.sync, steps: state.steps, selectedId: state.selectedId, manual: state.manual, manualDraft: state.manualDraft, code: state.code,
    includeComments:state.includeComments, annotatedCode:state.annotatedCode, draftAnnotatedCode:state.draftAnnotatedCode });
}
function remember() {
  state.undo.push(snapshot());
  if (state.undo.length > 80) state.undo.shift();
  state.redo = [];
  updateHistoryButtons();
}
function restoreSnapshot(saved) {
  Object.assign(state, {removedExamples:[]}, clone(saved));
  state.requestedThroughId = null;
  renderSource(); renderPipeline(); renderConfig(); refreshMode();
  if (state.manual) { setEditor(state.code); changed(); }
  else updateGeneratedCode();
  updateHistoryButtons();
}
function undo(redo = false) {
  const from = redo ? state.redo : state.undo;
  if (!from.length) return;
  (redo ? state.undo : state.redo).push(snapshot());
  restoreSnapshot(from.pop());
}
function updateHistoryButtons() {
  $('#undo-button').disabled = !state.undo.length;
  $('#redo-button').disabled = !state.redo.length;
}

function renderSaveStatus() {
  const element = $('#save-status');
  if (!element) return;
  const filesNotSaved = state.uploads.some(table => table.missing || !table.storageKey);
  const partial = filesNotSaved || saveNotice.state === 'partial';
  element.textContent = state.resetting ? 'Restarting…' : state.restoring ? 'Restoring files…' : saveNotice.state === 'unavailable' ? 'Autosave unavailable' : partial ? 'Recovery incomplete' : saveNotice.state === 'saving' ? 'Saving…' : 'Saved in this browser';
  element.classList.toggle('warning', partial || saveNotice.state === 'unavailable');
  element.title = filesNotSaved ? 'Code and settings are saved when browser storage is available. Some uploaded files could not be saved; reselect them after a refresh.' : saveNotice.message || 'Code, pipeline, settings and imported files are saved locally for recovery after refresh.';
}

function workspaceSnapshot() {
  const preview = state.result && JSON.stringify(state.result).length < 250000 ? clone(state.result) : null;
  return {...snapshot(), format:'tablecraft-workspace', version:1,
    settings:{autoRun:state.autoRun,pageSize:state.pageSize,completions:state.completions,columnsVisible:state.columnsVisible,
      theme:document.documentElement.dataset.bsTheme,expanded:$('.workbench')?.classList.contains('expanded') || false},
    view:{cursor:cm?.getCursor(),scroll:cm ? {top:cm.getScrollInfo().top,left:cm.getScrollInfo().left} : null,
      tableSearch:$('#table-search')?.value || '',loadedSearch:$('#loaded-table-search')?.value || ''},
    history:{undo:clone(state.undo.slice(-24)),redo:clone(state.redo.slice(-24))},
    preview, analysisConfig:savedAnalysisConfig || analysis?.getConfig(),
  };
}

function persistWorkspace() {
  if (!persistenceReady || state.resetting) return true;
  try { const saved = workspaceStore.save(workspaceSnapshot()); renderSaveStatus(); return saved; }
  catch (error) {
    saveNotice={state:'unavailable',message:error.message};renderSaveStatus();
    if (!saveWarningShown) {saveWarningShown=true;toast('Automatic recovery could not save this workspace. Use Save recipe to keep a copy.',true);}
    return false;
  }
}

function validSavedSnapshot(saved) {
  return saved && typeof saved === 'object' && typeof saved.code === 'string' && saved.source
    && typeof saved.source.sourceCode === 'string' && typeof saved.source.tableName === 'string'
    && Array.isArray(saved.source.columns) && Array.isArray(saved.steps) && saved.steps.length <= 300
    && saved.steps.every(step => step && opFor(step.op) && step.params && typeof step.params === 'object')
    && Array.isArray(saved.uploads) && saved.uploads.every(table => table && typeof table.tableName === 'string' && typeof table.fileName === 'string' && Array.isArray(table.columns));
}

async function restoreWorkspace() {
  let saved;
  try { saved = await workspaceStore.load(); }
  catch (error) {saveNotice={state:'unavailable',message:error.message};renderSaveStatus();return false;}
  if (!saved) return false;
  if (saved.format !== 'tablecraft-workspace' || saved.version !== 1 || !validSavedSnapshot(saved)) {
    toast('The saved workspace could not be read. Your saved recipe files can still be opened.',true);return false;
  }
  Object.keys(snapshot()).forEach(key => {if (saved[key] !== undefined) state[key]=clone(saved[key]);});
  state.annotatedCode = typeof saved.annotatedCode === 'string' ? saved.annotatedCode : saved.code;
  state.draftAnnotatedCode = typeof saved.draftAnnotatedCode === 'string' ? saved.draftAnnotatedCode : saved.manualDraft || '';
  state.includeComments = saved.includeComments !== false;
  state.code = state.includeComments ? state.annotatedCode : stripRComments(state.annotatedCode);
  state.undo=(saved.history?.undo || []).filter(validSavedSnapshot).slice(-24);
  state.redo=(saved.history?.redo || []).filter(validSavedSnapshot).slice(-24);
  state.autoRun=saved.settings?.autoRun !== false;
  state.completions=saved.settings?.completions !== false;
  state.columnsVisible=saved.settings?.columnsVisible !== false;
  state.pageSize=[50,100,200,500].includes(saved.settings?.pageSize) ? saved.settings.pageSize : 100;
  if (['light','dark'].includes(saved.settings?.theme)) document.documentElement.dataset.bsTheme=saved.settings.theme;
  recoveredView=saved.view || {};
  recoveredView.expanded=saved.settings?.expanded === true;
  savedAnalysisConfig=saved.analysisConfig || null;
  if (saved.preview && Array.isArray(saved.preview.rows) && Array.isArray(saved.preview.columns)) state.result=saved.preview;
  // Restore cached imports from the retained undo history as well as the active
  // workspace. Current table metadata wins if a name was replaced later.
  const allTables=[...state.undo,...state.redo,{uploads:state.uploads}].flatMap(item=>item.uploads || []);
  recoveryUploads=[...new Map(allTables.filter(table=>table.storageKey).map(table=>[table.tableName,clone(table)])).values()];
  state.restoring=recoveryUploads.length > 0;
  state.uploads=state.uploads.map(table=>({...table,missing:true}));
  if (state.source.kind === 'upload') state.source={...state.source,missing:true};
  return true;
}

async function restoreUploadedFiles(generation) {
  if (!recoveryUploads.length) {
    if (state.uploads.some(table=>table.missing)) {state.autoRun=false;$('#auto-run').checked=false;toast('Your code was restored. Reselect the missing files under Manage before running.',true);}
    return;
  }
  state.restoring=true;updateBusy();renderSaveStatus();
  const entries=[...recoveryUploads], failed=[];
  try {
    for (const table of entries) {
      if (generation !== taskGeneration) return;
      $('#loading-message').textContent=`Restoring ${table.label || table.fileName}…`;
      try {
        const record=await workspaceStore.getFile(table.storageKey);
        if (generation !== taskGeneration) return;
        if (!record?.blob) throw new Error('The saved file is no longer in browser storage.');
        const file=new File([record.blob],record.name || table.originalName || table.fileName,{type:record.type || '',lastModified:record.lastModified || 0});
        const metadata=await engine.importFile(file,{...table.options,tableName:table.tableName,fileName:table.fileName});
        if (generation !== taskGeneration) return;
        const restored={...table,...metadata,kind:'upload',missing:false,storageKey:table.storageKey};
        state.uploads=state.uploads.map(item=>item.tableName === table.tableName ? restored : item);
        if (state.source.kind === 'upload' && state.source.tableName === table.tableName) state.source=clone(restored);
      } catch (error) {
        if (error.cancelled || generation !== taskGeneration) return;
        failed.push(table.label || table.fileName);
      }
    }
    recoveryUploads=[];
    if (failed.length || state.uploads.some(table=>table.missing)) {
      state.autoRun=false;$('#auto-run').checked=false;
      toast('Your code was restored. Some files need to be reselected under Manage before running.',true);
    }
  } finally {
    if (generation === taskGeneration) {state.restoring=false;renderSource();renderLoadedTables();updateBusy();persistWorkspace();renderSaveStatus();}
  }
}

async function restartApp() {
  if (state.resetting) return;
  state.resetting=true;state.ready=false;state.busy=false;taskGeneration++;pendingRun=null;pendingCheck=null;workerTask=null;
  clearTimeout(runTimer);clearTimeout(checkTimer);clearTimeout(hintTimer);
  $('#confirm-restart-app').disabled=true;updateBusy();renderSaveStatus();
  engine.close();
  try {
    const storageCleared=await workspaceStore.clear();
    engine.close({preserveFiles:false});
    persistenceReady=false;
    Object.assign(state,clone(initialState));
    state.steps=state.steps.map(step=>({...step,id:uid()}));state.selectedId=state.steps[2]?.id || null;
    recoveryUploads=[];recoveredView=null;savedAnalysisConfig=null;lastEditKey=null;schemaCache.clear();
    try {localStorage.removeItem('tablecraft.theme');localStorage.removeItem('tablecraft.completions');} catch {}
    document.documentElement.dataset.bsTheme=window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    $('#auto-run').checked=true;$('#intellisense-toggle').checked=true;$('#page-size').value='100';
    $('#table-search').value='';$('#loaded-table-search').value='';$('#data-file').value='';$('#recipe-file').value='';
    $$('#source-dialog input:not([type="file"]),#source-dialog select').forEach(element=>{
      if(element.type==='checkbox')element.checked=element.defaultChecked;
      else if(element.tagName==='SELECT')element.selectedIndex=[...element.options].findIndex(option=>option.defaultSelected) >= 0 ? [...element.options].findIndex(option=>option.defaultSelected) : 0;
      else element.value=element.defaultValue;
    });
    $('#file-drop-title').textContent='Drop files here, or choose files';
    $('#file-drop-detail').textContent='CSV, TSV, fixed-width, XLS or XLSX · up to 50 MiB per file';
    $('#import-feedback').textContent='';$('#excel-sheets').innerHTML='';sourceTab('examples');showImportFields();
    $('.workbench').classList.remove('expanded');
    closeDialogs();closeFieldHints();cm?.closeHint();analysis?.destroy();
    initializeAnalysis();refreshThemeButton();renderSource();renderLoadedTables();renderPipeline();renderConfig();refreshMode();updateHistoryButtons();
    $('#table-container').innerHTML='<div class="preview-empty"><h3>Starting a new workspace</h3><p>The example pipeline will run when R is ready.</p></div>';
    $('#result-metrics').textContent='Ready when you are';$('#page-info').textContent='0 of 0';$('#preview-stale').hidden=true;
    $('#result-state').textContent='Waiting for R';$('#result-state').className='mini-badge';
    $('#import-options').hidden=true;renderPendingFiles();$('#data-file').disabled=false;$('#import-button').disabled=false;
    $('#function-help-text').textContent='';$('#table-preview-content').textContent='';
    updateGeneratedCode();cm?.clearHistory();
    persistenceReady=true;persistWorkspace();updateBusy();
    toast(storageCleared ? 'The app has restarted with a fresh workspace.' : 'The app restarted, but the browser could not fully clear its saved data. Check browser storage settings before relying on recovery.',!storageCleared);
    await startRuntime();
  } catch (error) {
    state.resetting=false;state.ready=false;state.busy=false;state.importing=false;
    updateBusy();renderSaveStatus();
    toast(`Could not clear saved app data: ${error.message}. Close other Tablecraft tabs and try Restart app again.`,true);
  } finally {$('#confirm-restart-app').disabled=false;}
}

function initializeAnalysis() {
  analysis=initAnalysis({engine,getTables:analysisTables,getCode:()=>state.code,toast,document,window});
  analysis.element.addEventListener('input',persistWorkspace);
  analysis.element.addEventListener('change',persistWorkspace);
}

function tableDefinitions(steps = state.steps) {
  const names = new Set(referencedNames(steps.filter(step => step.enabled).flatMap(step => Object.values(step.params || {}).filter(value => typeof value === 'string')).join('\n')));
  names.add(state.source.tableName);
  // Import every file, including currently unused uploads, in the exported R.
  const examples = availableTables({allExamples: true}).filter(table => table.kind !== 'upload' && !state.uploads.some(upload => upload.tableName === table.tableName));
  return [...examples.filter(table => names.has(table.tableName)), ...state.uploads]
    .map(table => table.tablesCode || `${rName(table.tableName)} <- ${table.sourceCode}`).join('\n\n');
}
function compile(throughId = null, includeComments = state.includeComments) {
  const index = state.steps.findIndex(step => step.id === throughId);
  const steps = throughId && index >= 0 ? state.steps.slice(0, index + 1) : state.steps;
  return compilePipeline({ sourceCode: rName(state.source.tableName), steps, tablesCode: tableDefinitions(steps), columns: state.source.columns, tables: context().tables, ...(state.sync || {}), includeComments });
}

function renderSource() {
  $('#source-name').textContent = state.source.label;
  const rows = state.source.totalRows ?? state.source.rows;
  $('#source-dimensions').textContent = state.source.missing ? 'Reselect this file to run' : state.source.kind === 'text' && rows == null ? 'Source defined in R · run to inspect' : `${formatNumber(rows ?? 0)} rows · ${state.source.columns?.length || 0} columns`;
  $('#upload-count').textContent = state.uploads.length;
  renderTableNames();
}

function renderTableNames() {
  const query = ($('#table-search')?.value || '').toLocaleLowerCase();
  const tables = availableTables().filter(table => !query || `${table.tableName} ${table.label}`.toLocaleLowerCase().includes(query));
  $('#table-name-list').innerHTML = tables.map(table => `<div class="table-name-row"><button class="column-chip table-chip" data-action="insert-table" data-table="${esc(table.tableName)}" title="Insert ${esc(rName(table.tableName))}">${icon('table')}<code>${esc(table.tableName)}</code>${table.tableName === state.source.tableName ? '<span class="mini-badge">Source</span>' : ''}</button><button class="btn btn-icon btn-xs" data-action="preview-table" data-table="${esc(table.tableName)}" title="Preview ${esc(table.tableName)}" aria-label="Preview ${esc(table.tableName)}">${icon('eye')}</button>${removableTable(table) ? `<button class="btn btn-icon btn-xs step-delete" data-action="delete-table" data-table="${esc(table.tableName)}" title="Remove ${esc(table.tableName)}" aria-label="Remove ${esc(table.tableName)}">${icon('trash')}</button>` : ''}</div>`).join('') || '<p class="tiny-note">No matching tables.</p>';
  $('#table-name-count').textContent = availableTables().length;
}

function stepSummary(step) {
  const p = step.params || {};
  if (step.op === 'filter') return p.condition;
  if (step.op === 'mutate') return `${p.name} := ${p.expression}`;
  if (step.op === 'summarize') return p.groups ? `by ${p.groups}` : p.expressions;
  if (step.op === 'sort') return `${String(p.directions).startsWith('-') ? '↓' : '↑'} ${p.columns}`;
  if (p.columns) return p.columns;
  if (p.column) return p.name ? `${p.name} ← ${p.column}` : p.column;
  if (p.table) return `with ${p.table}`;
  return String(Object.values(p).find(value => typeof value === 'string' && value.trim()) || opFor(step.op)?.functions?.[0] || '');
}
function renderPipeline() {
  $('#step-count').textContent = state.steps.length;
  $('#add-step-button').disabled = state.manual || state.steps.some(step => opFor(step.op)?.standalone);
  $('#pipeline-hint').innerHTML = state.manual ? 'Return to Visual to parse your edited R into steps.' : state.steps.some(step => opFor(step.op)?.standalone) ? 'This script is preserved as an editable R step.' : 'Each step feeds the next with <code>%&gt;%</code>.';
  $('#pipeline-list').innerHTML = state.steps.length ? state.steps.map((step, index) => {
    const active = step.id === state.selectedId;
    const op = opFor(step.op);
    return `<div class="step-item${active ? ' active' : ''}${step.enabled ? '' : ' disabled'}${step.id === state.errorStepId ? ' has-error' : ''}" data-step="${esc(step.id)}" tabindex="0" role="button" aria-label="Step ${index + 1}: ${esc(op?.label || step.op)}${step.enabled ? '' : ', disabled'}" aria-pressed="${active}" draggable="${!state.manual}"><span class="step-number">${index + 1}</span><div class="step-content"><div class="step-title">${esc(op?.label || step.op)}${state.previewStepId === step.id ? icon('eye') : ''}</div><div class="step-summary" title="${esc(stepSummary(step))}">${esc(stepSummary(step))}</div>${active && !state.manual ? `<div class="step-actions"><button class="btn btn-icon btn-xs" data-action="move-up" data-id="${esc(step.id)}" title="Move up" aria-label="Move step up" ${index === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button><button class="btn btn-icon btn-xs" data-action="move-down" data-id="${esc(step.id)}" title="Move down" aria-label="Move step down" ${index === state.steps.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button><button class="btn btn-icon btn-xs" data-action="duplicate" data-id="${esc(step.id)}" title="Duplicate" aria-label="Duplicate step" ${op?.standalone ? 'disabled' : ''}>${icon('copy')}</button><button class="btn btn-icon btn-xs" data-action="toggle-step" data-id="${esc(step.id)}" title="${step.enabled ? 'Disable' : 'Enable'} step" aria-label="${step.enabled ? 'Disable' : 'Enable'} step">${icon(step.enabled ? 'pause' : 'play')}</button><button class="btn btn-icon btn-xs" data-action="preview-step" data-id="${esc(step.id)}" title="Preview through this step" aria-label="Preview through this step">${icon('eye')}</button><button class="btn btn-icon btn-xs step-delete" data-action="delete-step" data-id="${esc(step.id)}" title="Remove step" aria-label="Remove step">${icon('trash')}</button></div>` : ''}</div></div>`;
  }).join('') : '<div class="empty-pipeline">A fresh start.<br>Add your first transformation.</div>';
  updateHistoryButtons();
  renderColumns();
}

function renderColumns() {
  const columns = context().columns;
  $('#column-count').textContent = columns.length;
  $('#schema-scope').textContent = state.manual ? 'Visual pipeline suggestions' : state.selectedId === state.steps[0]?.id || !state.selectedId ? 'Source columns' : 'Suggested input columns';
  $('#column-list').hidden = !state.columnsVisible;
  $('#schema-scope').hidden = !state.columnsVisible;
  $('[data-action="toggle-columns"]').setAttribute('aria-expanded',String(state.columnsVisible));
  $('#column-list').innerHTML = columns.map(col => {
    const type = typeInfo(col.type);
    return `<button class="column-chip" data-action="insert-column" data-column="${esc(col.name)}" title="Insert ${esc(col.name)} into the focused expression"><span class="type-icon ${type.cls}">${type.mark}</span><code>${esc(col.name)}</code><small>${type.label}</small></button>`;
  }).join('') || '<span class="tiny-note">Run the pipeline to inspect its columns.</span>';
}

function fieldHTML(field, params, columns) {
  const value = params[field.key] ?? field.default ?? '';
  const id = `field-${field.key}`;
  if (field.type === 'checkbox') return `<label class="check-label" for="${id}"><input id="${id}" type="checkbox" data-field="${esc(field.key)}" ${value === true || value === 'true' ? 'checked' : ''}>${esc(field.label)}</label>`;
  let input;
  const attributes = `id="${id}" data-field="${esc(field.key)}" ${field.required ? 'aria-required="true"' : ''} placeholder="${esc(field.placeholder || '')}" autocomplete="off" spellcheck="false"`;
  if (field.type === 'select') input = `<select ${attributes}>${(field.options || []).map(option => {
    const item = typeof option === 'string' || typeof option === 'number' ? { value: option, label: option } : option;
    return `<option value="${esc(item.value)}" ${String(value) === String(item.value) ? 'selected' : ''}>${esc(item.label)}</option>`;
  }).join('')}</select>`;
  else if (field.type === 'textarea') input = `<textarea ${attributes} class="expression-input" rows="${String(value).split('\n').length > 3 ? 4 : 2}">${esc(value)}</textarea>`;
  else input = `<input ${attributes} type="${field.type === 'number' ? 'number' : 'text'}" class="${field.type === 'number' ? '' : 'expression-input'}" value="${esc(Array.isArray(value) ? value.join(', ') : value)}" ${field.type === 'number' ? `min="${field.min ?? 0}" ${field.max != null ? `max="${field.max}"` : ''} step="${field.step || 1}"` : ''} ${field.type === 'column' ? `list="list-${id}"` : ''}>`;
  const suggestions = ['column','columns'].includes(field.type) ? `<div class="quick-column-list">${columns.slice(0, 6).map(col => `<button type="button" class="quick-column" data-action="field-column" data-target="${id}" data-column="${esc(col.name)}" data-multiple="${field.type === 'columns'}">${esc(col.name)}</button>`).join('')}</div>` : '';
  const datalist = field.type === 'column' ? `<datalist id="list-${id}">${columns.map(col => `<option value="${esc(col.name)}"></option>`).join('')}</datalist>` : '';
  return `<label class="field" for="${id}"><span class="field-label">${esc(field.label)}${field.type === 'textarea' ? '<em>R expression</em>' : ''}</span>${input}${datalist}${field.help ? `<small>${esc(field.help)}</small>` : ''}${suggestions}<span class="field-error" data-field-error="${esc(field.key)}" hidden></span></label>`;
}

function columnsForField(field, params, defaults = context().columns) {
  if (!['rightKeys','referenceKeys'].includes(field.key)) return defaults;
  const expression = String(params.table || '').trim();
  const table = availableTables({allExamples:true}).find(item => item.tableName === expression || rName(item.tableName) === expression);
  return table?.columns || defaults;
}

function renderConfig() {
  const step = state.steps.find(item => item.id === state.selectedId);
  $('#step-position').textContent = step ? `Step ${state.steps.indexOf(step) + 1} of ${state.steps.length}` : 'Start here';
  state.lastField = null;
  closeFieldHints();
  if (state.manual) {
    $('#step-config').innerHTML = `<div class="config-empty">${icon('code')}<h3>Edit R directly</h3><p>Return to Visual to parse your current code into steps. Custom expressions and scripts are preserved.</p><button class="btn btn-secondary btn-sm" data-action="visual-mode">Sync to Visual</button></div>`;
    return;
  }
  if (!step) {
    $('#step-config').innerHTML = `<div class="config-empty">${icon('sliders')}<h3>A new possibility with every step</h3><p>Filter rows, create a column, reshape your table, or explore ${OPERATIONS.length} guided transformations.</p><button class="btn btn-primary btn-sm" data-action="add">${icon('plus')}Add a step</button></div>`;
    return;
  }
  const op = opFor(step.op);
  if (!op) return;
  const columns = context().columns;
  $('#step-config').innerHTML = `<div class="config-title-row"><span class="operation-icon">${icon(categoryIcon(op.category))}</span><h3>${esc(op.label)}</h3>${step.enabled ? '' : '<span class="mini-badge warning">Disabled</span>'}</div><p class="config-description">${esc(op.description)}</p><div class="step-documentation">${operationDocumentation(op).map(doc => `<a href="${esc(doc.url)}" target="_blank" rel="noopener noreferrer" title="Read ${esc(doc.name)} documentation">${esc(doc.name)} ↗</a>`).join('')}</div><form id="step-form" onsubmit="return false">${op.fields.map(field => fieldHTML(field, step.params, columnsForField(field,step.params,columns))).join('')}</form>${op.fields.some(field => field.key === 'table') ? `<div class="config-tips">Insert a table: ${availableTables().map(table => `<button class="quick-column" data-action="field-table" data-target="field-table" data-table="${esc(table.tableName)}">${esc(table.tableName)}</button>`).join(' ')}</div>` : ''}${op.tips?.length ? `<div class="config-tips">${op.tips.map(tip => esc(tip)).join('<br>')}</div>` : ''}`;
  showFieldIssues();
}

function showFieldIssues() {
  const step = state.steps.find(item => item.id === state.selectedId);
  if (!step || state.manual) return;
  $$('#step-config [data-field-error]').forEach(element => { element.hidden = true; element.closest('.field').classList.remove('has-error'); });
  for (const issue of validateStep(step, context())) {
    if (!issue.field) continue;
    const element = $$('#step-config [data-field-error]').find(el => el.dataset.fieldError === issue.field);
    if (!element) continue;
    element.textContent = issue.message;
    element.hidden = false;
    element.closest('.field').classList.add('has-error');
  }
}

function initEditor() {
  if (!recoveredView) try { state.completions = localStorage.getItem('tablecraft.completions') !== 'off'; } catch {}
  $('#intellisense-toggle').checked = state.completions;
  if (!window.CodeMirror) {
    $('#r-editor').addEventListener('input', event => onEditorChange(event.target.value));
    toast('The enhanced editor did not load. Plain text editing still works.', true);
    return;
  }
  cm = window.CodeMirror.fromTextArea($('#r-editor'), {
    mode: 'r', lineNumbers: true, indentUnit: 2, tabSize: 2, lineWrapping: false,
    matchBrackets: true, autoCloseBrackets: true, viewportMargin: 15,
    gutters: ['CodeMirror-linenumbers', 'lint-gutter'],
    extraKeys: { 'Ctrl-Enter': () => requestRun(), 'Cmd-Enter': () => requestRun(),
      'Ctrl-Space': editor => { if (state.completions) editor.showHint({hint: completeR, completeSingle: false}); },
      F1: () => showFunctionHelp(),
      Tab: editor => editor.somethingSelected() ? editor.indentSelection('add') : editor.replaceSelection('  ', 'end'),
      'Shift-Tab': editor => editor.indentSelection('subtract') },
  });
  cm.on('change', editor => { if (!updatingEditor) onEditorChange(editor.getValue()); });
  cm.on('focus', () => { state.lastField = 'editor'; });
  cm.on('cursorActivity', () => { updateFunctionContext(); if (!updatingEditor) persistWorkspace(); });
  cm.on('inputRead', editor => {
    clearTimeout(hintTimer);
    if (!state.completions || updatingEditor) return;
    const cursor = editor.indexFromPos(editor.getCursor());
    const current = completionContext(editor.getValue(), cursor);
    if (!current.blocked && (current.prefix.length >= 1 || current.namespace || current.table)) hintTimer = setTimeout(() => {
      if (state.completions && editor.hasFocus()) editor.showHint({hint: completeR, completeSingle: false});
    }, 150);
  });
}
function completeR(editor) {
  const data = completionCandidates({code: editor.getValue(), offset: editor.indexFromPos(editor.getCursor()),
    columns: [...suggestedColumns(), ...context().columns], tables: availableTables({allExamples: true}), symbols: state.symbols});
  return {from: editor.posFromIndex(data.start), to: editor.posFromIndex(data.end), list: data.items.map(item => ({
    text: item.text, displayText: item.name, className: `completion-${item.kind}`,
    render(element) {
      const name = document.createElement('span'); name.textContent = item.name; element.append(name);
      const meta = document.createElement('small'); meta.textContent = item.package || item.kind; element.append(meta);
      element.title = item.signature || item.description || item.name;
      if (item.kind === 'function') {
        const help = document.createElement('a'); help.textContent = '?'; help.title = `Documentation for ${item.name}`;
        help.href = documentationFor(item.name, item.package); help.target = '_blank'; help.rel = 'noopener noreferrer';
        help.addEventListener('mousedown', event => event.stopPropagation());
        help.addEventListener('click', event => event.stopPropagation()); element.append(help);
      }
    },
  }))};
}

function updateFunctionContext() {
  const panel = $('#function-context');
  if (!state.completions || !cm) { panel.hidden = true; return; }
  const full = functionAt(cm.getValue(), cm.indexFromPos(cm.getCursor()));
  const name = full.split(/:::{0,1}/).at(-1);
  const info = R_FUNCTIONS.find(item => item.name === name) || state.symbols.find(item => item.name === name && item.kind === 'function');
  state.helpSymbol = full;
  panel.hidden = !info;
  if (info) panel.innerHTML = `<code>${esc(info.signature || name + '(...)')}</code><button class="link-button" data-action="function-help">Help <kbd>F1</kbd></button>`;
}

async function showFunctionHelp(symbol = null) {
  const generation=taskGeneration;
  const full = typeof symbol === 'string' ? symbol : cm ? functionAt(cm.getValue(), cm.indexFromPos(cm.getCursor())) : state.helpSymbol;
  if (!full) { toast('Place the cursor on a function name, then press F1.'); return; }
  const parts = full.split(/:::{0,1}/), name = parts.at(-1), packageName = parts.length > 1 ? parts[0] : undefined;
  const entry = R_FUNCTIONS.find(item => item.name === name && (!packageName || item.package === packageName));
  $('#function-help-title').textContent = full;
  $('#function-help-signature').textContent = entry?.signature || `${name}(...)`;
  $('#function-help-text').textContent = entry?.description || 'Opening the installed R help page…';
  const link = $('#function-help-link');
  link.href = documentationFor(name, packageName || entry?.package);
  openDialog('#function-help-dialog');
  if (state.ready && engine.helpFor) {
    try {
      const result = await engine.helpFor(name, packageName || entry?.package);
      if (generation !== taskGeneration || $('#function-help-title').textContent !== full) return;
      if (result?.text) $('#function-help-text').textContent = cleanHelpText(result.text);
      else if (!entry) $('#function-help-text').textContent = 'No installed help page was found. Use the documentation link below.';
      if (result?.package) link.href = documentationFor(name, result.package);
    } catch (error) { if (generation === taskGeneration && !error.cancelled && !entry) $('#function-help-text').textContent = 'No installed help page was found. Use the documentation link below.'; }
  }
}

async function refreshSymbols() {
  const generation=taskGeneration;
  if (!engine.completionSymbols || !state.ready) return;
  try {
    const symbols = await engine.completionSymbols();
    if (generation !== taskGeneration) return;
    state.symbols = Array.isArray(symbols) ? symbols : symbols?.symbols || [];
  } catch { /* Static completions remain available while R is busy or offline. */ }
}

async function refreshSourceSchema(version, token) {
  const generation=taskGeneration;
  if (!state.sync?.preservePreamble || !engine.previewTable || state.manual) return;
  const sourceName = state.source.tableName;
  try {
    // Inspect an existing binding from the successful run; never rerun setup
    // merely to offer suggestions while Live preview is paused.
    const data = await engine.previewTable(rName(sourceName), {limit:1});
    if (generation !== taskGeneration || state.version !== version || state.resultToken !== token || state.manual || state.source.tableName !== sourceName) return;
    state.source.columns = data.columns || []; state.source.totalRows = data.totalRows;
    renderSource(); renderColumns();
    if (!document.activeElement?.dataset.field) renderConfig();
  } catch { /* A complex source expression need not create a named binding. */ }
}

function closeFieldHints() {
  if (fieldHintState?.field) fieldHintState.field.setAttribute('aria-expanded', 'false');
  fieldHintState = null;
  const popup = $('#field-hints'); if (popup) popup.hidden = true;
}

function showFieldHints(field) {
  if (!state.completions || !field?.dataset.field || state.manual || !['INPUT', 'TEXTAREA'].includes(field.tagName) || ['number', 'checkbox'].includes(field.type)) return closeFieldHints();
  const step = state.steps.find(step => step.id === state.selectedId);
  const op = opFor(step?.op);
  const definition = op?.fields.find(item => item.key === field.dataset.field);
  if (!definition || ['name', 'new', 'idColumn'].includes(definition.key)) return closeFieldHints();
  const columns = columnsForField(definition,step.params), tableOnly = definition.key === 'table';
  let start = 0, end = field.selectionStart ?? field.value.length, prefix = field.value.slice(0, end), items;
  if (definition.type === 'column') { end=field.value.length; items = columns.map(col => ({name: col.name, text: col.name, kind: col.type})); }
  else if (definition.type === 'columns') {
    ({start,end,prefix}=literalListContext(field.value,end));
    items = columns.map(col => ({name: col.name, text: columnFieldValue(col.name), kind: col.type}));
  } else {
    const data = completionCandidates({code: field.value, offset: end, columns, tables: availableTables({allExamples: true}), symbols: state.symbols});
    start = data.start; end = data.end; prefix = data.prefix;
    items = data.items;
    if (tableOnly) {
      // A table field accepts either a table name or a complete R expression.
      const rawPrefix = field.value.slice(0, field.selectionStart ?? field.value.length).replace(/^`/, '');
      items = availableTables({allExamples: true}).filter(table => table.tableName.toLocaleLowerCase().startsWith(rawPrefix.toLocaleLowerCase()))
        .map(table => ({name: table.tableName, text: rName(table.tableName), kind: 'data.table'}));
      prefix = ''; start = 0; end = field.value.length;
    }
  }
  items = items.filter(item => item.name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())).slice(0, 30);
  if (!items.length) return closeFieldHints();
  const popup = $('#field-hints');
  fieldHintState = {field, items, start, end, selected: 0};
  popup.innerHTML = items.map((item, index) => `<button id="field-hint-${index}" type="button" role="option" aria-selected="${index === 0}" data-hint-index="${index}" class="${index === 0 ? 'active' : ''}"><code>${esc(item.name)}</code><small>${esc(item.kind || item.package || 'name')}</small></button>`).join('');
  field.setAttribute('aria-autocomplete', 'list'); field.setAttribute('aria-controls', 'field-hints'); field.setAttribute('aria-expanded', 'true'); field.setAttribute('aria-activedescendant', 'field-hint-0');
  const rect = field.getBoundingClientRect();
  popup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 260) - 8)) + 'px';
  popup.style.top = Math.min(rect.bottom + 3, window.innerHeight - 210) + 'px';
  popup.style.width = Math.min(Math.max(rect.width, 260), window.innerWidth - 16) + 'px';
  popup.hidden = false;
}

function pickFieldHint(index) {
  if (!fieldHintState) return;
  const {field, items, start, end} = fieldHintState, item = items[index];
  if (!item) return;
  field.focus(); field.setRangeText(item.text, start, end, 'end');
  closeFieldHints(); field.dispatchEvent(new Event('input', {bubbles: true})); closeFieldHints();
}

function setEditor(code) {
  updatingEditor = true;
  if (cm) {
    const scroll = cm.getScrollInfo();
    const cursor = cm.getCursor();
    cm.setValue(code);
    cm.setCursor(cursor);
    cm.scrollTo(scroll.left, scroll.top);
  } else $('#r-editor').value = code;
  updatingEditor = false;
  $('#line-count').textContent = code.split('\n').length;
}
function onEditorChange(code) {
  if (!state.manual) {
    remember(); state.manual = true; state.requestedThroughId = null;
    renderPipeline(); renderConfig(); refreshMode();
  }
  state.annotatedCode = state.includeComments ? code : reconcileRComments(state.annotatedCode || state.code, code);
  // A newly typed comment must stay editable; deleting its # on each keystroke
  // would incorrectly turn the following comment text into executable R.
  if (!state.includeComments && stripRComments(code) !== code) {
    state.includeComments = true;
    setEditor(state.annotatedCode);
    refreshMode();
  }
  state.code = state.includeComments ? state.annotatedCode : stripRComments(state.annotatedCode);
  state.manualDraft = state.code;
  state.draftAnnotatedCode = state.annotatedCode;
  $('#line-count').textContent = state.code.split('\n').length;
  changed();
}
function refreshMode() {
  $('#text-mode-banner').hidden = !state.manual;
  $('#code-mode-badge').textContent = state.manual ? 'Text mode' : 'Synced';
  $('#code-mode-badge').className = `mini-badge${state.manual ? ' warning' : ''}`;
  $('#restore-text-button').hidden = state.manual || !state.manualDraft;
  $('#visual-mode-button').classList.toggle('active', !state.manual);
  $('#visual-mode-button').setAttribute('aria-pressed', String(!state.manual));
  $('#text-mode-button').classList.toggle('active', state.manual);
  $('#text-mode-button').setAttribute('aria-pressed', String(state.manual));
  $('#comments-toggle').setAttribute('aria-pressed', String(state.includeComments));
  $('#comments-toggle').textContent = state.includeComments ? 'Comments: on' : 'Comments: off';
  $('#comments-toggle').title = state.includeComments ? 'Hide comments and omit them from copied, downloaded and executed R' : 'Restore comments in the editor and R output';
}
function toggleComments() {
  remember();
  state.includeComments = !state.includeComments;
  if (state.manual) {
    state.code = state.includeComments ? state.annotatedCode : stripRComments(state.annotatedCode);
    state.manualDraft = state.code; state.draftAnnotatedCode = state.annotatedCode;
    setEditor(state.code); changed();
  } else updateGeneratedCode();
  refreshMode();
}
function useVisual() {
  if (!state.manual) return;
  ensureManualExamples();
  let parsed;
  try {
    const code=state.annotatedCode || state.code, tables=context().tables;
    const scanned=parsePipeline(code,{previousSteps:[],columns:[],tables});
    if(scanned.mode === 'script') parsed=scanned;
    else {
      const previous=parsePipeline(compile(null,true).code,{previousSteps:[],columns:[],tables});
      const normalizeSetup=value=>formatRCode(stripRComments(value || '')).trim();
      const sameSource=scanned.sourceCode===previous.sourceCode;
      const sameSetup=normalizeSetup(scanned.preambleCode)===normalizeSetup(previous.preambleCode);
      // A changed setup can redefine or mutate even a familiar table name.
      // Use schema evidence only while that source and setup remain the same.
      const columns=sameSource && sameSetup ? state.source.columns : [];
      parsed=parsePipeline(code,{previousSteps:sameSource&&sameSetup?state.steps:[],columns:columns || [],tables});
    }
  }
  catch (error) { toast(`Could not synchronize this code: ${error.message}. Your text is preserved.`, true); return; }
  if (!parsed.ok) { toast(parsed.message || 'Complete the R expression before switching to Visual. Your text is preserved.', true); return; }
  remember();
  state.manualDraft = state.code; state.draftAnnotatedCode = state.annotatedCode; state.manual = false; state.requestedThroughId = null;
  state.steps = parsed.steps.map(step => ({...step, id: step.id || uid(), enabled: step.enabled !== false}));
  state.selectedId = state.steps[0]?.id || null;
  state.sync = parsed.mode === 'script' ? null : {
    preservePreamble: parsed.preservePreamble, preambleCode: parsed.preambleCode,
    epilogueCode: parsed.epilogueCode, pipelineSource: parsed.pipelineSource, resultName: parsed.resultName,
    assignmentOperator: parsed.assignmentOperator,
  };
  const parsedSource = availableTables({allExamples:true}).find(table => table.tableName === parsed.sourceName);
  if (parsedSource) state.source = {...clone(parsedSource), kind: parsedSource.kind || 'builtin'};
  else if (parsed.mode === 'pipeline') state.source = {
    id:uid(), kind:'text', tableName:parsed.sourceName || 'source_dt', label:parsed.sourceName || 'R expression',
    sourceCode:parsed.sourceCode, columns:[], rows:null,
    tablesCode:`${rName(parsed.sourceName || 'source_dt')} <- local({\n${formatRCode(parsed.preambleCode,{baseIndent:2})}\n  ${parsed.pipelineSource}\n})`,
  };
  renderSource(); renderPipeline(); renderConfig(); refreshMode(); updateGeneratedCode();
  toast(parsed.mode === 'script' ? 'Your full script is preserved in an editable R step.' : `Synchronized ${state.steps.length} step${state.steps.length === 1 ? '' : 's'} from your R code.${parsed.warnings?.length ? ' Custom expressions are kept as R steps.' : ''}`);
}
function useText() {
  if (state.manual) { cm?.focus(); return; }
  remember(); state.manual = true; state.manualDraft = state.code; state.draftAnnotatedCode = state.annotatedCode; state.requestedThroughId = null;
  renderPipeline(); renderConfig(); refreshMode(); cm?.focus();
  persistWorkspace();
}
function formatCode() {
  const code = formatRCode(state.code, {width: 88, indent: 2});
  if (code === state.code) { toast('Code is already formatted.'); return; }
  setEditor(code); onEditorChange(code); toast('R code wrapped and indented. Strings are kept intact.');
}
function restoreText() {
  if (!state.manualDraft) return;
  remember(); state.manual = true; state.requestedThroughId = null;
  state.annotatedCode = state.draftAnnotatedCode || state.manualDraft;
  state.code = state.includeComments ? state.annotatedCode : stripRComments(state.annotatedCode);
  setEditor(state.code); renderPipeline(); renderConfig(); refreshMode(); changed();
}
function updateGeneratedCode() {
  state.compiled = compile(null, true);
  state.annotatedCode = state.compiled.code;
  state.code = state.includeComments ? state.annotatedCode : stripRComments(state.annotatedCode);
  state.compiled = {...state.compiled, code:state.code};
  state.requestedThroughId = null;
  setEditor(state.code);
  showFieldIssues();
  changed();
}

function setSyntax(message, status = 'starting') {
  $('#syntax-status').className = `syntax-status${status === 'error' ? ' error' : ''}`;
  $('#syntax-status').innerHTML = `<span class="status-dot ${status}"></span><span>${esc(message)}</span>`;
}
function clearLint() {
  lintMarks.forEach(mark => mark.clear()); lintMarks = [];
  if (!cm) return;
  lintLines.forEach(line => cm.removeLineClass(line, 'background', 'lint-line')); lintLines = [];
  cm.clearGutter('lint-gutter');
}
function markDiagnostics(diagnostics) {
  clearLint();
  if (!cm) return;
  diagnostics.filter(item => item.severity === 'error' && item.line).forEach(item => {
    const line = Math.min(Math.max(0, item.line - 1), cm.lineCount()-1);
    const marker = document.createElement('span'); marker.className = 'lint-dot'; marker.title = item.message;
    cm.setGutterMarker(line, 'lint-gutter', marker);
    cm.addLineClass(line, 'background', 'lint-line'); lintLines.push(line);
    if (item.column) {
      const start = Math.max(0, Math.min(cm.getLine(line).length-1, item.column-1));
      lintMarks.push(cm.markText({line,ch:start}, {line,ch:start+1}, {className:'lint-underline', title:item.message}));
    }
  });
}
function changed() {
  state.version++;
  state.syntaxOK = null;
  state.errorStepId = null;
  state.runFailed = false;
  $$('.step-item.has-error').forEach(item=>item.classList.remove('has-error'));
  state.offset = 0;
  state.diagnostics = [];
  state.syntaxDiagnostics = [];
  renderDiagnostics(); clearLint();
  setSyntax(state.ready ? 'Checking syntax…' : 'R parser is starting…');
  setStale();
  const quick = preflight(state.code);
  if (quick.length) { state.diagnostics = quick; renderDiagnostics(); markDiagnostics(quick); }
  clearTimeout(checkTimer); clearTimeout(runTimer);
  pendingCheck = null; pendingRun = null;
  checkTimer = setTimeout(() => { pendingCheck = { code: state.code, version: state.version }; pump(); }, 420);
  if (state.autoRun) runTimer = setTimeout(() => queueRun(), 700);
  persistWorkspace();
}
function setStale() {
  const stale = state.result && !resultIsCurrent();
  $('#preview-stale').hidden = !stale;
  $('#export-csv-button').disabled = !state.result || !!stale || state.busy;
  $('#previous-page').disabled=state.busy || !resultIsCurrent() || state.offset<=0;
  $('#next-page').disabled=state.busy || !resultIsCurrent() || state.offset+state.pageSize>=(state.result?.totalRows||0);
  $('#page-size').disabled=state.busy || !resultIsCurrent();
  if (stale) {
    $('#result-state').textContent = state.runFailed ? 'Needs attention' : state.autoRun ? 'Updating…' : 'Preview paused';
    $('#result-state').className = `mini-badge ${state.runFailed?'error':'warning'}`;
    $('#preview-stale > span:last-child').textContent = state.runFailed ? 'Last successful result shown. Fix the error and run again to refresh it.' : 'Code or preview scope has changed. Run the pipeline to refresh this result.';
  }
}

function requestRun(throughId = null) {
  if (state.resetting || state.restoring) return;
  clearTimeout(runTimer);
  state.requestedThroughId = throughId;
  queueRun(throughId);
}
function queueRun(throughId = state.requestedThroughId) {
  if (state.resetting) return;
  if(state.manual) { throughId=null; ensureManualExamples(); }
  const compiled = state.manual ? {code: state.code, lineMap: [], issues: []} : compile(throughId);
  state.runFailed=false;
  pendingRun = { ...compiled, version: state.version, token:++state.requestToken, throughId, manual: state.manual, schemaKey:state.manual?null:schemaKey(stepsThrough(throughId)) };
  setStale();
  if (!state.ready) toast('R is still starting. Your latest run is queued.');
  pump();
}
async function pump() {
  if (!state.ready || state.importing || state.resetting || state.restoring || workerTask) return;
  if (pendingCheck) {
    const request = pendingCheck; pendingCheck = null;
    const generation = taskGeneration;
    workerTask = 'inspect';
    try {
      const result = await engine.inspect(request.code);
      if (generation !== taskGeneration || request.version !== state.version) return;
      state.syntaxOK = result.ok; state.syntaxVersion = request.version;
      setSyntax(result.ok ? 'Syntax looks good' : 'Check your R syntax', result.ok ? 'ready' : 'error');
      if (!result.ok) {
        state.diagnostics = result.diagnostics.map(item => ({ ...explainError(item.message, {columns: context().columns, line: item.line}), ...item }));
        state.syntaxDiagnostics=clone(state.diagnostics);
        renderDiagnostics(); markDiagnostics(state.diagnostics);
      } else {
        state.syntaxDiagnostics=[];
        if(!state.runFailed){
          state.diagnostics=resultIsCurrent()?(state.result.warnings||[]).map(message=>({severity:'warning',title:'R has a note',message:typeof message==='string'?message:message.message||String(message)})):[];
          renderDiagnostics();clearLint();
        }
      }
    } catch (error) { if (!error.cancelled) setSyntax('Parser temporarily unavailable', 'error'); }
    finally { if (generation === taskGeneration) { workerTask = null; pump(); } }
    return;
  }
  if (!pendingRun) return;
  const request = pendingRun; pendingRun = null;
  const generation = taskGeneration;
  workerTask = 'run'; state.busy = true; updateBusy();
  try {
    const issues = request.issues?.filter(issue => issue.severity === 'error') || [];
    if (issues.length) {
      const error = new Error(issues[0].message); error.diagnostics = issues; throw error;
    }
    const usedNames = new Set(referencedNames(request.code));
    const missing = state.uploads.filter(table => table.missing && usedNames.has(table.tableName)
      && (!isTableAssigned(request.code, table.tableName) || request.code.includes(rString(table.fileName))));
    if (missing.length) throw new Error(`Reselect ${missing.map(table => table.label || table.fileName).join(', ')} in Data source → Your tables before running this recipe.`);
    const result = await engine.run(request.code, { limit: state.pageSize, offset: 0, cacheImports: !request.manual });
    if (generation !== taskGeneration || request.version !== state.version || request.token !== state.requestToken) return;
    state.result = result; state.resultVersion = request.version; state.previewStepId = request.throughId;
    state.resultToken=request.token; state.runFailed=false;
    if(request.schemaKey){schemaCache.set(request.schemaKey,clone(result.columns));if(schemaCache.size>100)schemaCache.delete(schemaCache.keys().next().value);}
    state.offset = 0; state.errorStepId = null;
    const preserveSyntax=Boolean(request.throughId && state.syntaxOK===false && state.syntaxVersion===state.version);
    state.diagnostics = [...(preserveSyntax?state.syntaxDiagnostics:[]),...(result.warnings || []).map(message => ({severity:'warning', title:'R has a note', message: typeof message === 'string' ? message : message.message || String(message)}))];
    if(preserveSyntax)setSyntax('Check your R syntax','error');
    else if(request.throughId && state.syntaxOK!==true)setSyntax('Checking full script…','starting');
    else{state.syntaxOK=true;state.syntaxVersion=state.version;setSyntax('Syntax looks good','ready');}
    renderTable(); renderPipeline(); renderDiagnostics();
    persistWorkspace();
    refreshSymbols();
    refreshSourceSchema(request.version,request.token);
    if(preserveSyntax)markDiagnostics(state.syntaxDiagnostics);else clearLint();
    if (result.elapsedMs > 2500 && state.autoRun) toast('This step takes a little time. You can turn off Live preview and use Run.');
  } catch (error) {
    if (generation !== taskGeneration || request.version !== state.version || request.token !== state.requestToken || error.cancelled) return;
    state.runFailed=true;
    const incoming = error.diagnostics?.length ? error.diagnostics : [{ severity: 'error', message: error.message, line: error.line, column: error.column }];
    state.diagnostics = incoming.map(item => {
      const mapping = item.precise===false ? null : request.lineMap?.find(range => item.line >= range.startLine && item.line <= range.endLine);
      const stepId = item.stepId || mapping?.stepId;
      const stepLabel = opFor(state.steps.find(step => step.id === stepId)?.op)?.label;
      if (stepId) state.errorStepId = stepId;
      return { ...explainError(item.message, {columns: [...context().columns, ...suggestedColumns()],line:item.line,stepLabel}), ...item, stepId, code: request.code };
    });
    renderDiagnostics(); markDiagnostics(state.diagnostics); renderPipeline();
    $('#result-state').textContent = 'Needs attention'; $('#result-state').className = 'mini-badge error';
    if (!state.result) $('#table-container').innerHTML = `<div class="preview-empty"><div class="empty-table-icon">${icon('sliders')}</div><h3>A small adjustment is needed</h3><p>Use the message above to fix the pipeline, then run it again.</p></div>`;
  } finally {
    if (generation === taskGeneration) { workerTask = null; state.busy = false; updateBusy(); setStale(); pump(); }
  }
}

function updateBusy() {
  $('#run-button').disabled = state.importing || state.restoring || state.resetting;
  $('#run-button').innerHTML = state.busy ? `<span class="spinner"></span><span>Running…</span>` : `${icon('play')}<span>Run</span><kbd>Ctrl ↵</kbd>`;
  $('#stop-button').hidden = !state.busy;
  $('#export-csv-button').disabled = state.busy || !resultIsCurrent();
  $('#previous-page').disabled = state.busy || !resultIsCurrent() || state.offset <= 0;
  $('#next-page').disabled = state.busy || !resultIsCurrent() || state.offset + state.pageSize >= state.result.totalRows;
  $('#page-size').disabled = state.busy || !resultIsCurrent();
  if (state.busy) { $('#result-state').textContent = 'Running…'; $('#result-state').className = 'mini-badge warning'; }
}

function renderDiagnostics() {
  const panel = $('#diagnostics');
  panel.hidden = !state.diagnostics.length;
  panel.classList.toggle('warning', state.diagnostics.length > 0 && state.diagnostics.every(item => item.severity !== 'error'));
  panel.innerHTML = state.diagnostics.slice(0,5).map(item => `<div class="diagnostic-item">${icon(item.severity === 'error' ? 'alert' : 'info')}<div><strong>${esc(item.title || (item.severity === 'error' ? 'Let’s check this step' : 'A quick note'))}</strong><p>${esc(String(item.message || '').slice(0,1600))}</p>${item.tip ? `<p class="diagnostic-tip">${esc(item.tip)}</p>` : ''}${item.line ? `<button class="link-button" data-action="goto-line" data-line="${item.line}">${item.precise===false?'Statement starts near':'Go to'} line ${item.line}</button>` : ''}${item.stepId ? ` <button class="link-button" data-action="goto-step" data-id="${esc(item.stepId)}">Open step settings</button>` : ''}${item.severity === 'error' ? `<div class="error-consultation"><a href="${esc(errorConsultationURL(item.message, item.code || state.code))}" target="_blank" rel="noopener noreferrer">Ask Mistral about this error ↗</a><small>Opening this link sends the error and R code to Mistral.</small><button class="link-button" data-action="copy-error-prompt" data-error-index="${state.diagnostics.indexOf(item)}">Copy error + code</button></div>` : ''}</div></div>`).join('');
}

function renderTable() {
  const data = state.result;
  if (!data) return;
  const rows = data.rows || [], columns = data.columns || [];
  const numeric = col => /numeric|double|integer/.test(col.type) && !/Date|Time|date|time/.test(col.type);
  const head = columns.map(col => {
    const type = typeInfo(col.type);
    return `<th scope="col" class="${numeric(col) ? 'numeric' : ''}" title="${esc(col.name)} (${esc(col.type)})"><span class="col-header"><span class="type-icon ${type.cls}">${type.mark}</span>${esc(col.name)}</span></th>`;
  }).join('');
  const body = rows.map((row,index) => `<tr><td class="row-number">${formatNumber(state.offset+index+1)}</td>${columns.map(col => {
    const value = row[col.key || col.name];
    if (value === null || value === undefined) return '<td><span class="na" title="Missing value">NA</span></td>';
    const string = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const text = typeof value === 'number' && Number.isInteger(value) ? formatNumber(value) : string;
    return `<td class="${numeric(col) ? 'numeric' : ''}" title="${esc(string)}">${/factor/.test(col.type) || (columns.length < 7 && col.type === 'character' && rows.length <= 8) ? `<span class="cell-tag">${esc(text)}</span>` : esc(text)}</td>`;
  }).join('')}</tr>`).join('');
  $('#table-container').innerHTML = columns.length ? `<table class="data-table"><caption class="visually-hidden">Current R result. ${formatNumber(data.totalRows)} rows, ${data.totalColumns} columns.</caption><thead><tr><th class="row-number" scope="col">#</th>${head}</tr></thead><tbody>${body}</tbody></table>${rows.length ? '' : '<div class="preview-empty"><h3>No rows match this pipeline</h3><p>Try a wider filter or check your join keys.</p></div>'}` : '<div class="preview-empty"><h3>The result has no columns</h3><p>Select or create a column to show a table.</p></div>';
  $('#result-state').className = 'mini-badge success';
  $('#result-state').textContent = state.previewStepId ? `Through step ${state.steps.findIndex(step => step.id === state.previewStepId)+1}` : 'Up to date';
  const elapsed = data.elapsedMs >= 1000 ? `${(data.elapsedMs/1000).toFixed(2)} s` : `${Math.max(1,Math.round(data.elapsedMs || 0))} ms`;
  $('#result-metrics').innerHTML = `<span class="status-dot ready"></span><span><strong>${formatNumber(data.totalRows)}</strong> rows <span class="dot-separator">×</span> <strong>${data.totalColumns}</strong> columns</span><span class="dot-separator">·</span><span>${elapsed}</span>${data.totalColumns > columns.length ? `<span>· ${columns.length} columns shown</span>` : ''}`;
  $('#page-info').textContent = data.totalRows ? `${formatNumber(state.offset+1)}–${formatNumber(Math.min(state.offset+rows.length,data.totalRows))} of ${formatNumber(data.totalRows)}` : '0 of 0';
  $('#previous-page').disabled = state.offset <= 0;
  $('#next-page').disabled = state.offset+state.pageSize >= data.totalRows;
  $('#preview-stale').hidden = resultIsCurrent();
  $('#export-csv-button').disabled = !resultIsCurrent();
}

async function changePage(direction = 0) {
  if (!resultIsCurrent() || state.busy || workerTask) return;
  const generation=taskGeneration, token=state.resultToken, version=state.version;
  const next = Math.max(0,Math.min(Math.max(0,state.result.totalRows-1),state.offset+direction*state.pageSize));
  workerTask = 'preview'; state.busy = true; updateBusy();
  try {
    const result=await engine.preview({offset:next,limit:state.pageSize});
    if(generation!==taskGeneration || token!==state.resultToken || version!==state.version || !resultIsCurrent())return;
    state.result = result; state.offset = next;
    renderTable();
  } catch (error) { if (!error.cancelled) toast(error.message,true); }
  finally { if(generation===taskGeneration){workerTask = null; state.busy = false; updateBusy(); setStale(); pump();} }
}

function onRuntimeStatus(event) {
  const detail = event.detail || {};
  runtimeState = detail.state;
  const ready = ['ready','idle'].includes(detail.state);
  const failed = ['error','failed'].includes(detail.state);
  $('#engine-status').textContent = ready ? 'R engine ready' : detail.message || 'Working…';
  $('#engine-status').title = detail.message || '';
  $('#engine-dot').className = `status-dot ${ready ? 'ready' : failed ? 'error' : 'starting'}`;
  if (!state.ready || failed) {
    $('#runtime-notice').hidden = ready;
    $('#runtime-notice').classList.toggle('failed',failed);
    $('#loading-message').textContent = detail.message || 'Loading R packages…';
    if (failed) $('.runtime-notice strong').textContent = 'The R workspace could not start';
  }
}

async function startRuntime(reset = false) {
  const generation=taskGeneration;
  state.ready = false;
  $('#restart-button').disabled=true;
  $('#runtime-notice').hidden = false; $('#runtime-notice').classList.remove('failed');
  $('.runtime-notice strong').textContent = reset ? 'Restarting your R workspace' : 'Preparing your R workspace';
  try {
    const result = reset ? await engine.reset() : await engine.init();
    if(generation!==taskGeneration)return;
    await restoreUploadedFiles(generation);
    if(generation!==taskGeneration)return;
    state.ready = true;
    $('#runtime-notice').hidden = true;
    $('#engine-dot').className = 'status-dot ready'; $('#engine-status').textContent = 'R engine ready';
    const versions = result?.versions || engine.versions;
    if (versions) $('#runtime-versions').textContent = `Runtime: webR 0.6.0 · ${Object.entries(versions).map(([name,version]) => `${name} ${version}`).join(' · ')} · Bootstrap 6 alpha · CodeMirror 5.65.21`;
    pendingCheck = {code:state.code,version:state.version};
    refreshSymbols();
    if (state.autoRun) queueRun();
    pump();
  } catch (error) {
    if(generation!==taskGeneration || error.cancelled)return;
    state.ready = false;state.restoring=false;updateBusy();renderSaveStatus();
    $('#runtime-notice').hidden = false; $('#runtime-notice').classList.add('failed');
    $('.runtime-notice strong').textContent = 'Could not load R';
    $('#loading-message').textContent = `${error.message} Check your connection, then select Restart.`;
    setSyntax('R parser is unavailable', 'error');
    $('#result-state').textContent = 'R unavailable';
  } finally { if(generation===taskGeneration)$('#restart-button').disabled=false; }
}

async function restartRuntime(stopping = false) {
  taskGeneration++; workerTask = null; pendingRun = null; pendingCheck = null;
  clearTimeout(runTimer); clearTimeout(checkTimer);
  state.busy = false; state.result = null; state.resultVersion = -1; state.resultToken=-1; state.requestToken++; state.previewStepId=null; state.requestedThroughId=null;state.runFailed=false;
  state.importing=false;$('#import-button').disabled=false;$('#import-button').innerHTML=`${icon('upload')}Import table`;
  if (stopping) { state.autoRun = false; $('#auto-run').checked = false; }
  persistWorkspace();
  updateBusy();
  $('#table-container').innerHTML = `<div class="preview-empty"><div class="empty-table-icon">${icon('clock')}</div><h3>${stopping ? 'Calculation stopped' : 'Starting a fresh R session'}</h3><p>Your pipeline and imported files are kept in this tab. Run again when you are ready.</p></div>`;
  $('#result-metrics').textContent = 'R session restarting'; $('#page-info').textContent = '0 of 0';
  $('#preview-stale').hidden = true;
  await startRuntime(true);
  if (stopping) toast('Stopped. Live preview is paused so you can adjust the code.');
}

function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
  hydrateIcons(dialog);
}
function closeDialogs() { $$('dialog[open]').forEach(dialog => dialog.close()); }
function openOperations() {
  if (state.manual) { toast('Return to the visual pipeline to add a step.'); return; }
  if (state.steps.some(step => opFor(step.op)?.standalone)) { toast('This full R script is preserved in one editable step. Edit that step or choose a new source to start a pipeline.'); return; }
  operationCategory = 'All'; $('#operation-search').value = '';
  renderOperations(); openDialog('#operation-dialog');
  $('#operation-search').focus();
}
function renderOperations() {
  const query = $('#operation-search').value.trim().toLowerCase();
  const selectable = OPERATIONS.filter(operation => !operation.standalone);
  const categories = ['All', ...new Set(selectable.map(operation => operation.category))];
  $('#operation-categories').innerHTML = categories.map(category => `<button class="category-chip${category === operationCategory ? ' active' : ''}" data-action="operation-category" data-category="${esc(category)}">${esc(category)}</button>`).join('');
  const matches = selectable.filter(operation => (operationCategory === 'All' || operation.category === operationCategory) && (!query || [operation.label,operation.description,operation.category,...operation.functions].join(' ').toLowerCase().includes(query)));
  $('#operation-grid').innerHTML = matches.length ? matches.map(operation => `<button class="operation-card" data-action="choose-operation" data-operation="${esc(operation.id)}"><span class="operation-icon">${icon(categoryIcon(operation.category))}</span><span class="operation-card-text"><strong>${esc(operation.label)}</strong><small>${esc(operation.description)}</small><code>${esc(operation.functions.slice(0,4).join(' · '))}</code></span></button>`).join('') : '<div class="config-empty"><h3>No matching operations</h3><p>Try a function name such as melt, or use a Custom R step.</p></div>';
  $('#operation-count').textContent = `${matches.length} of ${selectable.length} transformations`;
}
function addStep(opId) {
  const operation = opFor(opId);
  if (!operation || state.manual || operation.standalone) return;
  remember();
  const columns = suggestedColumns();
  const params = defaultsFor(opId, columns);
  if (operation.fields.some(field => field.key === 'table') || opId === 'merge-many') {
    const secondary = chooseSecondaryTable(opId, columns);
    if (secondary) {
      if (Object.hasOwn(params, 'table')) params.table = rName(secondary.tableName);
      if (opId === 'merge-many') params.tables = `list(${rName(secondary.tableName)})`;
      const common = columns.filter(col => secondary.columns?.some(other => other.name === col.name));
      const key = common.find(col => /(^id$|_id$|^product$)/i.test(col.name)) || common.find(col => /character|factor/.test(col.type)) || common[0];
      if (key && Object.hasOwn(params, 'leftKeys')) { params.leftKeys = columnFieldValue(key.name); params.rightKeys = columnFieldValue(key.name); }
      if (key && opId === 'merge-many') params.columns = columnFieldValue(key.name);
    }
  }
  const step = {id:uid(),op:opId,params,enabled:true};
  state.steps.push(step); state.selectedId = step.id;
  closeDialogs(); renderSource(); renderPipeline(); renderConfig(); updateGeneratedCode();
  $('#step-config [data-field]')?.focus();
  $(`[data-step="${step.id}"]`)?.scrollIntoView({block:'nearest',inline:'nearest'});
}

function chooseSecondaryTable(opId, columns) {
  const combine = ['bind-rows', 'bind-columns', 'set-operation'].includes(opId);
  const candidates = (state.uploads.length ? state.uploads : availableTables())
    .filter(table => table.tableName !== state.source.tableName && !table.missing)
    .map(table => ({table, common: columns.filter(col => table.columns?.some(other => other.name === col.name))}));
  candidates.sort((a,b) => {
    const score = item => item.common.reduce((total,col) => total + (/(_id$|^product$|^id$)/.test(col.name) ? 20 : 1), 0);
    return score(b) - score(a);
  });
  if (state.uploads.length) return candidates[0]?.table || state.source;
  if (!combine && candidates[0]?.common.some(col => /(_id$|^product$|^id$)/.test(col.name))) return candidates[0].table;
  // Match the schema at this point in the pipeline, including newly computed
  // columns. A deterministic companion is an ordinary portable R definition.
  const current = compile().code;
  const key = columns.find(col => /character|factor/.test(col.type)) || columns[0];
  const stem = `${state.source.tableName}_${combine ? 'more' : 'lookup'}`;
  let name = stem, n = 2;
  while (availableTables().some(table => table.tableName === name) || state.removedExamples.includes(name)) name = `${stem}_${n++}`;
  const tail = combine ? 'copy(as.data.table(.tc_example_source))' : key
    ? `unique(as.data.table(.tc_example_source)[, ${rString(key.name)}, with = FALSE]) %>%\n  .[, example_label := paste("Example", seq_len(.N))]`
    : 'copy(as.data.table(.tc_example_source))';
  const sourceCode = `local({\n  .tc_example_source <- local({\n${formatRCode(current,{baseIndent:4})}\n  })\n  ${tail}\n})`;
  const table = {id:name, kind:'example', tableName:name, label:`${state.source.label} ${combine ? 'companion' : 'lookup'}`, sourceCode,
    tablesCode:`${rName(name)} <- ${sourceCode}`, columns: combine || !key ? clone(columns) : [clone(key),{name:'example_label',type:'character'}], description:'Generated companion example for this pipeline', rows: state.source.rows};
  state.examples.push(table);
  if (state.sync?.preservePreamble) state.sync.preambleCode += `\n\n${table.tablesCode}\n`;
  return table;
}
function selectStep(id) {
  state.selectedId = id; renderPipeline(); renderConfig();
  persistWorkspace();
}
function mutateStep(action,id) {
  if (state.manual) return;
  const index = state.steps.findIndex(step => step.id === id);
  if (index < 0) return;
  if (action === 'duplicate' && opFor(state.steps[index].op)?.standalone) return;
  remember();
  if (action === 'delete-step') {
    state.steps.splice(index,1); state.selectedId = state.steps[Math.min(index,state.steps.length-1)]?.id || null;
  } else if (action === 'duplicate') {
    const duplicate = {...clone(state.steps[index]),id:uid()}; state.steps.splice(index+1,0,duplicate); state.selectedId=duplicate.id;
  } else if (action === 'toggle-step') state.steps[index].enabled = !state.steps[index].enabled;
  else {
    const next = index+(action === 'move-up' ? -1 : 1);
    if (next >= 0 && next < state.steps.length) [state.steps[index],state.steps[next]] = [state.steps[next],state.steps[index]];
  }
  renderPipeline(); renderConfig(); updateGeneratedCode();
}
function insertColumn(name, target = state.lastField) {
  if (target === 'editor') {
    cm?.focus();
    if (cm) cm.replaceSelection(rName(name),'end');
    else { $('#r-editor').setRangeText(rName(name),$('#r-editor').selectionStart,$('#r-editor').selectionEnd,'end'); onEditorChange($('#r-editor').value); }
    return;
  }
  const field = target && document.getElementById(target);
  if (!field) { toast('Focus an expression, then choose a column to insert it.'); return; }
  const selected = state.steps.find(step => step.id === state.selectedId);
  const definition = opFor(selected?.op)?.fields.find(item => item.key === field.dataset.field);
  if (definition?.type === 'column') field.value = name;
  else if (definition?.type === 'columns') {
    const values = parseColumns(field.value);
    if (!values.includes(name)) values.push(name);
    field.value = values.map(columnFieldValue).join(', ');
  } else field.setRangeText(rName(name),field.selectionStart || 0,field.selectionEnd || 0,'end');
  field.dispatchEvent(new Event('input',{bubbles:true})); field.focus();
}

function showSource(tab = 'examples') {
  renderDatasets(); renderLoadedTables(); sourceTab(tab); openDialog('#source-dialog');
}
function sourceTab(tab) {
  ['examples','upload','loaded'].forEach(name => {
    $(`#${name}-view`).hidden = tab !== name;
    $(`#${name}-tab`).classList.toggle('active',tab === name);
    $(`#${name}-tab`).setAttribute('aria-selected',String(tab === name));
  });
}
function renderDatasets() {
  $('#dataset-grid').innerHTML = exampleTables().map(dataset => {
    const removed=state.removedExamples.includes(dataset.tableName);
    return `<button class="dataset-card${state.source.tableName === dataset.tableName ? ' selected' : ''}${removed ? ' removed-example' : ''}" data-action="${removed ? 'restore-example' : 'choose-example'}" data-dataset="${esc(dataset.id)}" data-table="${esc(dataset.tableName)}"><div>${icon('database')}<strong>${esc(dataset.label)}</strong>${removed ? '<span class="mini-badge warning">Add back</span>' : dataset.tags?.includes('recommended') ? '<span class="mini-badge success">Try this</span>' : ''}</div><small>${esc(dataset.description || 'Generated example table')}</small><div class="dataset-meta"><span>${formatNumber(dataset.rows || 0)} rows · ${dataset.columns.length} columns</span><span>${removed ? 'Removed from this workspace' : esc(dataset.tags?.filter(tag => tag !== 'recommended')[0] || 'example')}</span></div></button>`;
  }).join('');
}
function renderLoadedTables() {
  const query = ($('#loaded-table-search')?.value || '').trim().toLocaleLowerCase();
  const tables=availableTables().filter(removableTable);
  const matches = tables.filter(table => !query || [table.tableName, table.label, table.fileName, ...(table.columns || []).map(col => col.name)].join(' ').toLocaleLowerCase().includes(query));
  $('#loaded-tables').innerHTML = matches.length ? matches.map(table => {
    const uploaded=table.kind === 'upload';
    return `<div class="loaded-table" data-kind="${uploaded ? 'upload' : 'example'}">${icon('table')}<div><strong>${esc(table.label)} <span class="mini-badge">${uploaded ? 'Imported' : 'Example'}</span></strong><button class="link-button" data-action="insert-table" data-table="${esc(table.tableName)}"><code>${esc(rName(table.tableName))}</code></button><small>${table.missing ? 'File needed in this session' : `${formatNumber(table.totalRows ?? table.rows ?? 0)} rows · ${table.columns?.length || 0} columns`}${table.tableName === state.source.tableName ? ' · Primary table' : ''}</small></div><div class="loaded-table-actions"><button class="btn btn-icon btn-sm" data-action="preview-table" data-table="${esc(table.tableName)}" ${table.missing ? 'disabled' : ''} title="Preview table" aria-label="Preview ${esc(table.tableName)}">${icon('eye')}</button><button class="btn btn-secondary btn-sm" data-action="${table.missing ? 'reselect-file' : uploaded ? 'use-upload' : 'choose-example'}" data-table="${esc(table.tableName)}">${table.missing ? 'Reselect file' : 'Use table'}</button><button class="btn btn-icon btn-sm step-delete" data-action="delete-table" data-table="${esc(table.tableName)}" title="Remove table" aria-label="Remove ${esc(table.tableName)}">${icon('trash')}</button></div></div>`;
  }).join('') : `<div class="config-empty"><h3>${tables.length ? 'No tables match this search' : 'Your tables appear here'}</h3><p>${tables.length ? 'Try a filename, R object name, or column name.' : 'Import files or add an example table.'}</p></div>`;
  if(state.removedExamples.length)$('#loaded-tables').insertAdjacentHTML('beforeend','<p class="tiny-note removed-examples-note">Removed examples stay removed after refresh. Open <button class="link-button" data-action="source-examples">Example tables</button> to add one back.</p>');
}
function restoreExample(name) {
  const table=exampleTables().find(item=>item.tableName === name);
  if (!table) return;
  remember();state.removedExamples=state.removedExamples.filter(item=>item!==name);
  if(state.manual)ensureManualExamples();
  else if(state.sync?.preservePreamble && referencedNames(state.code).includes(name) && !isTableAssigned(state.annotatedCode || state.code,name)) {
    state.sync.preambleCode+=`\n\n${table.tablesCode || `${rName(name)} <- ${table.sourceCode}`}\n`;
  }
  renderSource();renderLoadedTables();renderDatasets();
  if(!state.manual)updateGeneratedCode();else persistWorkspace();
  toast(`Added ${name} back to the available examples.`);
}

function chooseSource(source, clear = $('#clear-on-source').checked) {
  state.removedExamples=state.removedExamples.filter(name=>name!==source.tableName);
  if (state.manual && !clear) useVisual();
  remember();
  if (state.manual) {state.manualDraft = state.code;state.draftAnnotatedCode=state.annotatedCode;}
  const standalone = state.steps.some(step => opFor(step.op)?.standalone);
  if (standalone) {state.manualDraft=state.code;state.draftAnnotatedCode=state.annotatedCode;clear=true;}
  state.manual = false; state.source = clone(source);
  if (clear) { state.steps=[]; state.selectedId=null; state.examples=[]; state.sync=null; }
  else if (state.sync?.preservePreamble) {
    state.sync.preambleCode += `\n\n${source.tablesCode || `${rName(source.tableName)} <- ${source.sourceCode}`}\n`;
    state.sync.pipelineSource = `copy(as.data.table(${rName(source.tableName)}))`;
  }
  state.resultVersion=-1;
  renderSource(); renderPipeline(); renderConfig(); refreshMode();
  closeDialogs(); updateGeneratedCode();
}

function insertTable(name, target = state.lastField) {
  if (!target || target !== 'editor' && !document.getElementById(target)) { state.lastField = 'editor'; target = 'editor'; }
  const field = target === 'editor' ? null : document.getElementById(target);
  if (field?.dataset.field === 'table') {
    field.value = rName(name); field.dispatchEvent(new Event('input', {bubbles:true})); field.focus();
  } else insertColumn(name, target);
  if ($('#source-dialog').open) $('#source-dialog').close();
}

function isTableAssigned(code, name) {
  const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[;\\n])\\s*(?:${escaped(rName(name))}|${escaped(name)})\\s*(?:<-|=(?!=))`).test(code);
}

function ensureManualExamples() {
  const names = new Set(referencedNames(state.code));
  const required = availableTables({allExamples:true}).filter(table => !['upload','text'].includes(table.kind) && names.has(table.tableName) && !isTableAssigned(state.code, table.tableName));
  if (!required.length) return;
  const definitions = required.map(table => table.tablesCode || `${rName(table.tableName)} <- ${table.sourceCode}`).join('\n\n');
  state.annotatedCode = formatRCode(`library(data.table)\nlibrary(magrittr)\n\n# Referenced example tables\n${definitions}\n\n${state.annotatedCode || state.code}`, {width:88});
  state.code = state.includeComments ? state.annotatedCode : stripRComments(state.annotatedCode);
  state.manualDraft = state.code; state.draftAnnotatedCode=state.annotatedCode;setEditor(state.code); changed(); renderTableNames();
}

function addImportsToText(imports) {
  const code = imports.map(table => table.tablesCode).join('\n\n');
  if (!code) return;
  if (state.manual) {
    state.annotatedCode = formatRCode(`library(data.table)\nlibrary(magrittr)\n\n# Imported tables\n${code}\n\n${state.annotatedCode || state.code}`, {width:88});
    state.code = state.includeComments ? state.annotatedCode : stripRComments(state.annotatedCode);
    state.manualDraft = state.code;state.draftAnnotatedCode=state.annotatedCode;setEditor(state.code); changed();
  } else if (state.sync?.preservePreamble) {
    state.sync.preambleCode += `\n\n# Imported tables\n${code}\n`;
  }
}

async function previewTable(name) {
  const generation=taskGeneration;
  const table = availableTables({allExamples:true}).find(item => item.tableName === name);
  if (!table || table.missing) { toast('Reselect this file to preview its table.', true); return; }
  if (!state.ready) { toast('R is still starting. Try the preview when it is ready.'); return; }
  const token = ++state.tablePreviewToken;
  $('#table-preview-title').textContent = name;
  $('#table-preview-meta').textContent = 'Reading a bounded preview…';
  $('#table-preview-content').innerHTML = '<div class="preview-empty"><span class="spinner"></span></div>';
  openDialog('#table-preview-dialog');
  try {
    const setupCode = `library(data.table)\nlibrary(magrittr)\n${table.tablesCode || `${rName(table.tableName)} <- ${table.sourceCode}`}`;
    const result = await engine.previewTable(rName(name), {setupCode, limit:100});
    if (generation !== taskGeneration || token !== state.tablePreviewToken) return;
    $('#table-preview-meta').textContent = `${formatNumber(result.totalRows)} rows · ${result.totalColumns} columns · ${table.label}`;
    const columns = result.columns || [];
    $('#table-preview-content').innerHTML = `<table class="data-table"><thead><tr><th>#</th>${columns.map(col => `<th><code>${esc(col.name)}</code><small class="preview-column-type">${esc(col.type)}</small></th>`).join('')}</tr></thead><tbody>${(result.rows || []).map((row,index) => `<tr><td class="row-number">${index+1}</td>${columns.map(col => { const value = row[col.key || col.name]; return `<td>${value == null ? '<span class="na">NA</span>' : esc(typeof value === 'object' ? JSON.stringify(value) : value)}</td>`; }).join('')}</tr>`).join('')}</tbody></table>${!result.totalRows ? '<p class="empty-table-note">This table has no rows.</p>' : ''}`;
  } catch (error) {
    if (generation !== taskGeneration || token !== state.tablePreviewToken || error.cancelled) return;
    $('#table-preview-meta').textContent = 'Preview could not run';
    const code = `${table.tablesCode || `${rName(name)} <- ${table.sourceCode}`}\n${rName(name)}`;
    $('#table-preview-content').innerHTML = `<div class="preview-empty"><p>${esc(error.message)}</p><a href="${esc(errorConsultationURL(error.message,code))}" target="_blank" rel="noopener noreferrer">Ask Mistral about this error ↗</a><small>Opens an external chat with the error and R code.</small></div>`;
  }
}

async function deleteTable(name) {
  const generation=taskGeneration;
  const table = availableTables().find(item => item.tableName === name);
  if (!table || !removableTable(table)) return;
  if (state.importing || state.restoring) { toast('Wait until the current import or recovery finishes.'); return; }
  const uploaded=table.kind === 'upload', used=referencedNames(state.code).includes(name);
  if (engine.removeTable && !table.missing && state.ready) await engine.removeTable(name,{includeSession:!uploaded});
  if (generation !== taskGeneration) return;
  if (uploaded && table.storageKey) await workspaceStore.removeFile(table.storageKey);
  if (generation !== taskGeneration) return;
  if (!uploaded) {remember();state.removedExamples=[...new Set([...state.removedExamples,name])];}
  else state.uploads = state.uploads.filter(item => item.tableName !== name);
  // Keep undo useful without resurrecting metadata whose bytes were deleted.
  if(uploaded)[...state.undo, ...state.redo].forEach(saved => {
    saved.uploads = saved.uploads.filter(item => item.tableName !== name);
    if (saved.source.tableName === name) saved.source = clone(state.uploads[0] || {...DATASETS[0], kind:'builtin'});
  });
  if (state.source.tableName === name) {
    const fallback=availableTables({allExamples:true}).find(item=>item.tableName!==name&&!item.missing);
    state.source=fallback?{...clone(fallback),kind:fallback.kind||'builtin'}:{id:'empty',kind:'text',tableName:'empty_dt',label:'No table selected',rows:0,columns:[],sourceCode:'data.table()',tablesCode:'empty_dt <- data.table()'};
  }
  if(used){state.autoRun=false;$('#auto-run').checked=false;}
  state.symbols=state.symbols.filter(symbol=>symbol.name!==name || symbol.package);
  refreshSymbols();
  schemaCache.clear();
  renderSource(); renderLoadedTables(); renderDatasets(); renderPipeline(); renderConfig();
  if (!state.manual && !state.sync?.preservePreamble) updateGeneratedCode();
  else { state.autoRun = false; $('#auto-run').checked = false; changed(); }
  toast(`Removed ${name}.${used || state.manual || state.sync ? ' Review any references to it in your R code.' : ''}${uploaded?'':' Add it back from Example tables when needed.'}`);
}

async function chooseFiles(files) {
  if (state.importing) { toast('Wait until the current import finishes.'); return; }
  const selected = [...files].filter(file => {
    if (file.size > MAX_FILE_BYTES) { toast(`${file.name} exceeds the 50 MiB per-file limit.`, true); return false; }
    return true;
  });
  if (!selected.length) return;
  const restore = state.pendingRestoreTable;
  state.pendingFiles = selected.map((file, index) => ({file, restore: index === 0 && restore ? restore : state.uploads.find(table => table.missing && [table.originalName, table.label, table.fileName].includes(file.name)), options: null, error: ''}));
  const firstRestored = state.pendingFiles[0]?.restore;
  if (firstRestored) $('#import-primary').checked = state.source.tableName === firstRestored.tableName;
  state.pendingFileIndex = -1;
  await selectPendingFile(0);
}

function importOptionsFromForm() {
  const sheetText = $('#import-sheet').value.trim();
  const sheetIsNamed = $$('#excel-sheets option').some(option => option.value === sheetText);
  return {
    format: $('#import-format').value, delimiter: $('#import-separator').value,
    encoding: $('#import-encoding').value, skip: Number($('#import-skip').value || 0),
    header: $('#import-header').checked, widths: $('#import-widths').value,
    names: $('#import-format').value === 'fwf' ? $('#import-names').value : '', naStrings: ['', ...parseColumns($('#import-na').value)],
    sheet: !sheetIsNamed && /^\d+$/.test(sheetText) ? Number(sheetText) : sheetText || 1, range: $('#import-range').value,
  };
}

function renderPendingFiles() {
  const list = $('#pending-files');
  list.hidden = !state.pendingFiles.length;
  list.innerHTML = `<p class="tiny-note">${state.pendingFiles.length} file${state.pendingFiles.length === 1 ? '' : 's'} selected. Choose a file to adjust its import settings.</p>` + state.pendingFiles.map((entry,index) => `<button class="pending-file${index === state.pendingFileIndex ? ' active' : ''}${entry.error ? ' has-error' : ''}" data-action="select-import" data-index="${index}" ${state.importing ? 'disabled' : ''}><span>${esc(entry.file.name)}</span><small>${entry.error ? esc(entry.error) : entry.options?.format || 'Auto-detect'}</small></button>`).join('');
  list.innerHTML += state.pendingFiles.filter(entry => entry.errorCode).map(entry => `<div class="error-consultation"><a href="${esc(errorConsultationURL(entry.error,entry.errorCode))}" target="_blank" rel="noopener noreferrer">Ask Mistral about ${esc(entry.file.name)} ↗</a><small>Opens an external chat with the import error and R code.</small></div>`).join('');
  if (!state.importing) $('#import-button').innerHTML = `${icon('upload')}Import ${state.pendingFiles.length > 1 ? `${state.pendingFiles.length} tables` : 'table'}`;
}

async function selectPendingFile(index) {
  if (state.importing) return;
  const previous = state.pendingFiles[state.pendingFileIndex];
  if (previous) previous.options = importOptionsFromForm();
  const entry = state.pendingFiles[index];
  if (!entry) return;
  const selectionToken = ++state.fileSelectionToken;
  state.pendingFileIndex = index; state.pendingRestoreTable = entry.restore || null;
  const loading = chooseFile(entry.file, entry.options, selectionToken);
  renderPendingFiles();
  await loading;
  if (selectionToken !== state.fileSelectionToken || state.pendingFiles[index] !== entry || state.importing) return;
  entry.options = importOptionsFromForm();
  renderPendingFiles();
}

async function chooseFile(file, savedOptions = null, selectionToken = state.fileSelectionToken) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) { toast('Choose a file smaller than 50 MiB. For larger data, use the generated code in desktop R.',true); return; }
  state.pendingFile = file;
  const generation=taskGeneration;
  $('#file-drop-title').textContent = file.name;
  $('#file-drop-detail').textContent = `${file.size < 1024*1024 ? `${Math.ceil(file.size/1024)} KiB` : `${(file.size/1024/1024).toFixed(1)} MiB`} · click to choose a different file`;
  $('#import-options').hidden = false;
  $('#import-feedback').textContent = ''; $('#import-feedback').className = '';
  const extension = file.name.split('.').at(-1).toLowerCase();
  const restored = state.pendingRestoreTable || state.uploads.find(table => table.missing && [table.originalName,table.label,table.fileName].includes(file.name));
  state.pendingRestoreTable = restored || null;
  const options = savedOptions || restored?.options || {};
  $('#import-format').value = options.format === 'fwf' || extension === 'fwf' ? 'fwf' : options.format === 'excel' || ['xls','xlsx'].includes(extension) ? 'excel' : 'csv';
  $('#import-header').checked = options.header == null ? $('#import-format').value !== 'fwf' : options.header !== false;
  $('#import-skip').value = options.skip || 0;
  $('#import-separator').value = options.delimiter === '\t' || ['tsv','tab'].includes(extension) ? 'tab' : options.delimiter || 'auto';
  $('#import-widths').value = Array.isArray(options.widths) ? options.widths.join(', ') : options.widths || '';
  $('#import-names').value = Array.isArray(options.names) ? options.names.join(', ') : options.names || '';
  $('#import-encoding').value = options.encoding || 'UTF-8';
  $('#import-sheet').value = options.sheet || '1'; $('#import-range').value = options.range || '';
  $('#import-na').value = (options.naStrings || ['NA']).filter(Boolean).join(', ');
  if (restored) { $('#clear-on-source').checked = false; $('#import-feedback').textContent = `Restoring ${restored.tableName}. Your pipeline will be kept.`; }
  showImportFields();
  if ($('#import-format').value === 'excel') {
    try {
      $('#import-feedback').textContent = 'Reading workbook sheet names…';
      const sheets = await engine.excelSheets(file);
      if (state.pendingFile !== file || generation!==taskGeneration || selectionToken !== state.fileSelectionToken || state.importing) return;
      $('#excel-sheets').innerHTML = sheets.map(name => `<option value="${esc(name)}"></option>`).join('');
      if (!restored && !savedOptions && sheets.length && $('#import-sheet').value === '1') $('#import-sheet').value = sheets[0];
      $('#import-feedback').textContent = `${sheets.length} sheet${sheets.length === 1 ? '' : 's'} found. Choose one above.`;
    } catch (error) { if(generation===taskGeneration && state.pendingFile===file && !error.cancelled){$('#import-feedback').textContent = error.message; $('#import-feedback').className='error';} }
  }
}
function showImportFields() {
  const format = $('#import-format').value;
  ['delimiter','encoding','na'].forEach(field => $(`#${field}-field`).hidden = format === 'excel' || field === 'delimiter' && format === 'fwf');
  ['widths','names'].forEach(field => $(`#${field}-field`).hidden = format !== 'fwf');
  ['sheet','range'].forEach(field => $(`#${field}-field`).hidden = format !== 'excel');
}
async function importFile() {
  if (!state.pendingFiles.length || state.importing) return;
  const generation = taskGeneration;
  const active = state.pendingFiles[state.pendingFileIndex];
  if (active) active.options = importOptionsFromForm();
  const usePrimary = $('#import-primary').checked, clear = $('#clear-on-source').checked;
  const wasManual = state.manual, imported = [], failed = [];
  state.importing = true; $('#import-button').disabled = true;
  $('#data-file').disabled = true;
  $('#import-feedback').className = ''; renderPendingFiles(); updateBusy();
  remember();
  try {
    for (const [index, entry] of state.pendingFiles.entries()) {
      if (generation !== taskGeneration) return;
      $('#import-button').innerHTML = `<span class="spinner"></span>${index+1} / ${state.pendingFiles.length}`;
      $('#import-feedback').textContent = `Reading ${entry.file.name} in R…`;
      const options = entry.options || entry.restore?.options || {format:'auto'};
      try {
        const settings = {...options, ...(entry.restore ? {tableName:entry.restore.tableName, fileName:entry.restore.fileName} : {})};
        const table = {...await engine.importFile(entry.file, settings), kind:'upload', missing:false, originalName:entry.file.name};
        if (generation !== taskGeneration) return;
        const storageKey=uid();
        try {
          if (await workspaceStore.putFile(storageKey,entry.file) !== false) table.storageKey=storageKey;
          else throw new Error('Browser file storage is unavailable.');
        } catch (error) {
          toast(`Imported ${entry.file.name}, but browser storage could not save its contents for refresh recovery. Save a recipe and keep the original file.`,true);
        }
        if (generation !== taskGeneration) return;
        const previous = state.uploads.findIndex(item => item.tableName === table.tableName);
        if (previous < 0) state.uploads.push(table); else state.uploads[previous] = table;
        if (state.source.tableName === table.tableName) state.source = clone(table);
        imported.push(table);
        persistWorkspace();
      } catch (error) {
        if (error.cancelled || generation !== taskGeneration) return;
        entry.error = error.message;
        try {entry.errorCode=buildImportCode(entry.file.name,options);} catch {entry.errorCode=`# Import ${rString(entry.file.name)}\n# ${error.message}`;}
        failed.push(entry);
      }
    }
    state.pendingFiles = failed; state.pendingFileIndex = -1;
    state.pendingFile = null; state.pendingRestoreTable = null;
    $('#data-file').value = '';
    if (imported.length) {
      schemaCache.clear();
      if (usePrimary && !wasManual) {
        const restored = active?.restore;
        state.source = clone(imported[0]);
        if (clear && !restored) { state.steps = []; state.selectedId = null; state.examples = []; state.sync = null; }
        else if (!restored && state.sync?.preservePreamble) state.sync.pipelineSource=`copy(as.data.table(${rName(imported[0].tableName)}))`;
      }
      if (wasManual || state.sync?.preservePreamble) addImportsToText(imported.filter(table => !isTableAssigned(state.code, table.tableName)));
      renderSource(); renderLoadedTables(); renderPipeline(); renderConfig(); refreshMode();
      if (!wasManual) updateGeneratedCode();
      toast(`Imported ${imported.length} table${imported.length === 1 ? '' : 's'}: ${imported.map(table => table.tableName).join(', ')}.${wasManual ? ' Import statements were added to your R code.' : ''}`);
      refreshSymbols();
    }
    $('#import-feedback').textContent = failed.length ? `${failed.length} file${failed.length === 1 ? '' : 's'} need attention. Select a file to adjust its options, then retry.` : `${imported.length} table${imported.length === 1 ? '' : 's'} imported.`;
    $('#import-feedback').className = failed.length ? 'error' : '';
    if (!failed.length) { $('#import-options').hidden = true; sourceTab('loaded'); }
    renderPendingFiles();
  } finally {
    if (generation === taskGeneration) {
      state.importing = false; $('#import-button').disabled = false; $('#data-file').disabled = false;
      renderPendingFiles(); updateBusy(); pump();
      if (failed.length) await selectPendingFile(0);
    }
  }
}

function openHelpers() { $('#helper-search').value = ''; renderHelpers(); openDialog('#helpers-dialog'); $('#helper-search').focus(); }
function renderHelpers() {
  const query = $('#helper-search').value.trim().toLowerCase();
  const matches = HELPERS.filter(helper => !query || [helper.name,helper.category,helper.signature,helper.description,helper.example].join(' ').toLowerCase().includes(query));
  $('#helper-list').innerHTML = matches.map(helper => `<div class="helper-card"><div class="helper-card-header"><strong>${esc(helper.name)}</strong><a href="${esc(documentationFor(helper.name))}" target="_blank" rel="noopener noreferrer" class="link-button">Help ↗</a><span class="mini-badge">${esc(helper.category)}</span></div><p>${esc(helper.description)}</p><div class="snippet"><code>${esc(helper.example || helper.signature)}</code><button class="btn btn-icon btn-sm" data-action="copy-helper" data-helper="${esc(helper.name)}" title="Copy example" aria-label="Copy ${esc(helper.name)} example">${icon('copy')}</button></div></div>`).join('') || '<div class="config-empty"><h3>No matching helpers</h3><p>Try a shorter function name or a topic such as missing values.</p></div>';
  $('#helper-count').textContent = `${matches.length} of ${HELPERS.length} reference entries`;
}

async function copyText(text, message = 'Copied to clipboard.') {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const temporary = document.createElement('textarea'); temporary.value=text;
      Object.assign(temporary.style,{position:'fixed',opacity:'0'}); document.body.append(temporary);
      temporary.select(); const copied = document.execCommand('copy'); temporary.remove();
      if (!copied) throw new Error('Clipboard access was blocked.');
    }
    toast(message);
  } catch { toast('Clipboard access was blocked. Select the code and press Ctrl+C, or download the R script.',true); }
}
function download(blob,filename) {
  const url = URL.createObjectURL(blob);
  const anchor=document.createElement('a'); anchor.href=url; anchor.download=filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function exportCSV() {
  if (!resultIsCurrent() || state.busy || workerTask) { toast('Run the pipeline and wait for the current calculation to finish.'); return; }
  const generation=taskGeneration;
  workerTask='export'; state.busy=true; updateBusy();
  try {
    const bytes=await engine.exportCSV();
    if(generation!==taskGeneration)return;
    download(new Blob([bytes],{type:'text/csv;charset=utf-8'}),'tablecraft-result.csv');
    toast('Exported the full result table.');
  } catch(error) { if (!error.cancelled) toast(error.message,true); }
  finally { if(generation===taskGeneration){workerTask=null; state.busy=false; updateBusy(); setStale(); pump();} }
}
function saveRecipe() {
  const portable=table=>{const {storageKey,...metadata}=clone(table);return metadata;};
  const recipe={format:'tablecraft-recipe',version:3,savedAt:new Date().toISOString(),source:portable(state.source),steps:clone(state.steps),manual:state.manual,manualDraft:state.manualDraft,code:state.code,
    annotatedCode:state.annotatedCode,draftAnnotatedCode:state.draftAnnotatedCode,includeComments:state.includeComments,
    sync:clone(state.sync),examples:clone(state.examples),removedExamples:clone(state.removedExamples),uploads:state.uploads.map(table=>({...portable(table),missing:true})),settings:{autoRun:state.autoRun,pageSize:state.pageSize,completions:state.completions}};
  download(new Blob([JSON.stringify(recipe,null,2)+'\n'],{type:'application/json'}),'tablecraft-recipe.json');
  toast('Recipe saved. Imported file contents are not included.');
}
async function loadRecipe(file) {
  if (!file) return;
  const generation=taskGeneration;
  try {
    if (file.size > 5*1024*1024) throw new Error('This recipe is too large. Choose a Tablecraft JSON recipe under 5 MiB.');
    const recipe=JSON.parse(await file.text());
    if (generation !== taskGeneration) return;
    if (recipe.format!=='tablecraft-recipe' || ![1,2,3].includes(recipe.version) || !Array.isArray(recipe.steps) || recipe.steps.length>300) throw new Error('Choose a supported Tablecraft recipe JSON file.');
    if (!recipe.source || !['builtin','upload','example','text'].includes(recipe.source.kind) || typeof recipe.source.sourceCode!=='string' || typeof recipe.code!=='string') throw new Error('This recipe is missing its source or R code.');
    const validColumns=columns=>Array.isArray(columns)&&columns.every(column=>column && typeof column.name==='string' && typeof column.type==='string');
    if(!validColumns(recipe.source.columns))throw new Error('This recipe has invalid source-column metadata.');
    recipe.steps.forEach(step=>{
      if (!opFor(step.op) || !step.params || typeof step.params!=='object' || Array.isArray(step.params)) throw new Error(`Unknown or invalid operation: ${step.op}.`);
      if (Object.values(step.params).some(value=>!['string','number','boolean'].includes(typeof value) && !Array.isArray(value))) throw new Error('This recipe contains invalid step settings.');
    });
    if (recipe.uploads && (!Array.isArray(recipe.uploads) || recipe.uploads.some(table=>typeof table.tableName!=='string' || !table.tableName || /[\u0000-\u001f]/.test(table.tableName) || typeof table.tablesCode!=='string' || typeof table.fileName!=='string' || !validColumns(table.columns)))) throw new Error('This recipe contains invalid table references.');
    if (recipe.examples && (!Array.isArray(recipe.examples) || recipe.examples.some(table=>typeof table.tableName!=='string' || typeof table.sourceCode!=='string' || !validColumns(table.columns)))) throw new Error('This recipe contains invalid example tables.');
    const imports=(recipe.uploads||[]).map(table=>{
      const existing=state.uploads.find(current=>!current.missing && current.tableName===table.tableName && current.fileName===table.fileName && current.tablesCode===table.tablesCode);
      const {storageKey,...metadata}=table;
      return existing || {...metadata,kind:'upload',missing:true};
    });
    const source=recipe.source.kind==='builtin' ? {...DATASETS.find(dataset=>dataset.id===recipe.source.id),kind:'builtin'} : recipe.source.kind==='example' ? {...recipe.source,...(recipe.examples||[]).find(table=>table.tableName===recipe.source.tableName)} : {...recipe.source,...imports.find(table=>table.tableName===recipe.source.tableName)};
    if (!source.sourceCode) throw new Error('The example table in this recipe is not available.');
    remember();
    state.uploads=imports;state.source=source;state.examples=clone(recipe.examples || []);state.sync=recipe.sync && recipe.sync.preservePreamble ? clone(recipe.sync) : null;
    state.removedExamples=Array.isArray(recipe.removedExamples)?recipe.removedExamples.filter(name=>typeof name==='string'&&name!==source.tableName):[];
    state.steps=recipe.steps.map(step=>({...step,id:uid(),enabled:step.enabled!==false}));
    state.selectedId=state.steps[0]?.id || null;
    state.manual=recipe.manual===true; state.manualDraft=String(recipe.manualDraft||''); state.code=recipe.code;
    state.includeComments=recipe.includeComments!==false;
    state.annotatedCode=typeof recipe.annotatedCode==='string'?recipe.annotatedCode:recipe.code;
    state.draftAnnotatedCode=typeof recipe.draftAnnotatedCode==='string'?recipe.draftAnnotatedCode:state.manualDraft;
    state.code=state.includeComments?state.annotatedCode:stripRComments(state.annotatedCode);
    state.autoRun=false; $('#auto-run').checked=false;
    state.pageSize=[50,100,200,500].includes(recipe.settings?.pageSize) ? recipe.settings.pageSize : 100;
    $('#page-size').value=String(state.pageSize);
    renderSource(); renderPipeline(); renderConfig(); refreshMode();
    if (state.manual) {setEditor(state.code);changed();} else updateGeneratedCode();
    toast(imports.some(table=>table.missing) ? 'Recipe opened. Reselect your files under Data source → Your tables, then Run.' : 'Recipe opened with Live preview paused. Review the code, then Run.');
  } catch(error) {if(generation===taskGeneration)toast(error.message,true);}
  finally {if(generation===taskGeneration)$('#recipe-file').value='';}
}

function toggleTheme() {
  const next=document.documentElement.dataset.bsTheme==='dark' ? 'light' : 'dark';
  document.documentElement.dataset.bsTheme=next;
  try {localStorage.setItem('tablecraft.theme',next);} catch {}
  refreshThemeButton();
}
function refreshThemeButton() {
  const dark=document.documentElement.dataset.bsTheme==='dark';
  $('#theme-button').innerHTML=icon(dark?'sun':'moon');
  $('#theme-button').setAttribute('aria-label',`Switch to ${dark?'light':'dark'} theme`);
  $('#theme-button').title=`Switch to ${dark?'light':'dark'} theme`;
}

const actions = {
  theme:toggleTheme, help:()=>openDialog('#help-dialog'), source:()=>showSource(), upload:()=>showSource('upload'),
  analysis:()=>{closeDialogs();analysis?.open(savedAnalysisConfig || {});savedAnalysisConfig=null;}, 'manage-tables':()=>showSource('loaded'),
  add:openOperations, helpers:openHelpers, run:()=>requestRun(), stop:()=>restartRuntime(true), restart:()=>restartRuntime(false),
  'restart-app':()=>openDialog('#restart-app-dialog'), 'confirm-restart-app':restartApp, 'toggle-comments':toggleComments,
  'copy-code':()=>copyText(state.code,'R code copied to clipboard.'), 'download-r':()=>download(new Blob([state.code+'\n'],{type:'text/plain;charset=utf-8'}),'tablecraft-pipeline.R'),
  'save-recipe':saveRecipe, 'open-recipe':()=>$('#recipe-file').click(), 'export-csv':exportCSV,
  'visual-mode':useVisual, 'text-mode':useText, 'restore-text':restoreText, 'format-code':formatCode, 'function-help':()=>showFunctionHelp(), undo:()=>undo(false), redo:()=>undo(true),
  'expand-code':()=>{$('.workbench').classList.toggle('expanded');cm?.refresh();},
  'prev-page':()=>changePage(-1),'next-page':()=>changePage(1),
  'source-examples':()=>sourceTab('examples'),'source-upload':()=>sourceTab('upload'),'source-loaded':()=>{renderLoadedTables();sourceTab('loaded');},
  'import-file':importFile,
  'select-import':element=>selectPendingFile(Number(element.dataset.index)),
  'preview-table':element=>previewTable(element.dataset.table), 'delete-table':element=>deleteTable(element.dataset.table),
  'operation-category':element=>{operationCategory=element.dataset.category;renderOperations();},
  'choose-operation':element=>addStep(element.dataset.operation),
  'add-custom':()=>addStep(OPERATIONS.find(operation=>operation.id==='custom')?.id || OPERATIONS.find(operation=>operation.label.toLowerCase().includes('custom'))?.id),
  'choose-dataset':element=>chooseSource({...DATASETS.find(dataset=>dataset.id===element.dataset.dataset),kind:'builtin'}),
  'choose-example':element=>{const table=exampleTables().find(item=>item.tableName===element.dataset.table);if(table)chooseSource({...table,kind:table.kind||'builtin'});},
  'restore-example':element=>restoreExample(element.dataset.table),
  'use-upload':element=>{const table=state.uploads.find(item=>item.tableName===element.dataset.table);if(table)chooseSource(table);},
  'reselect-file':element=>{state.pendingRestoreTable=state.uploads.find(item=>item.tableName===element.dataset.table);sourceTab('upload');$('#data-file').value='';$('#data-file').click();},
  'insert-column':element=>insertColumn(element.dataset.column),
  'insert-table':element=>insertTable(element.dataset.table),
  'field-table':element=>insertTable(element.dataset.table,element.dataset.target),
  'field-column':element=>insertColumn(element.dataset.column,element.dataset.target),
  'toggle-columns':element=>{state.columnsVisible=!state.columnsVisible;element.setAttribute('aria-expanded',String(state.columnsVisible));renderColumns();},
  'copy-helper':element=>{const helper=HELPERS.find(item=>item.name===element.dataset.helper);if(helper)copyText(helper.example||helper.signature);},
  'goto-line':element=>{const line=Number(element.dataset.line)-1;if(cm){cm.focus();cm.setCursor(line,0);cm.scrollIntoView({line,ch:0},50);}},
  'goto-step':element=>selectStep(element.dataset.id),
  'show-diagnostics':()=>{if(state.diagnostics.length)$('#diagnostics').scrollIntoView({block:'nearest'});else toast(state.syntaxOK?'R has parsed this code successfully.':'The R parser checks your code after each edit.');},
  'preview-step':element=>requestRun(element.dataset.id),
  'copy-error-prompt':element=>{const item=state.diagnostics[Number(element.dataset.errorIndex)];if(item)copyText(`Explain this R error and suggest a correction:\n\n${item.message}\n\nWhen running:\n\n${item.code || state.code}`);},
};
['move-up','move-down','duplicate','toggle-step','delete-step'].forEach(action=>actions[action]=element=>mutateStep(action,element.dataset.id));

function bindEvents() {
  $('#field-hints').addEventListener('mousedown', event => { const button=event.target.closest('[data-hint-index]'); if(button) {event.preventDefault();pickFieldHint(Number(button.dataset.hintIndex));} });
  document.addEventListener('click',event=>{
    if (!event.target.closest('#field-hints,[data-field]')) closeFieldHints();
    const closer=event.target.closest('[data-close]');
    if(closer){closer.closest('dialog').close();persistWorkspace();return;}
    const button=event.target.closest('[data-action]');
    if(button && !button.disabled){
      const handler=actions[button.dataset.action];
      if(handler){event.preventDefault();try {Promise.resolve(handler(button,event)).catch(error=>toast(error.message,true)).finally(persistWorkspace);} catch(error) {toast(error.message,true);}}
      return;
    }
    const step=event.target.closest('[data-step]');
    if(step){selectStep(step.dataset.step);return;}
    if(event.target.tagName==='DIALOG')event.target.close();
  });
  document.addEventListener('keydown',event=>{
    if (event.key === 'F1' && !event.target.closest('.CodeMirror')) {event.preventDefault();showFunctionHelp();return;}
    if (fieldHintState?.field === event.target && ['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Escape') {closeFieldHints();return;}
      if (['Enter','Tab'].includes(event.key)) {pickFieldHint(fieldHintState.selected);return;}
      const current = fieldHintState;
      current.selected = (current.selected + (event.key==='ArrowDown'?1:-1) + current.items.length) % current.items.length;
      $$('#field-hints [data-hint-index]').forEach((button,index)=>{button.classList.toggle('active',index===current.selected);button.setAttribute('aria-selected',String(index===current.selected));});
      current.field.setAttribute('aria-activedescendant',`field-hint-${current.selected}`);
      $(`#field-hint-${current.selected}`).scrollIntoView({block:'nearest'});return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === 'Space' && event.target.dataset.field) {event.preventDefault();showFieldHints(event.target);return;}
    const field=event.target.closest('input,textarea,select,.CodeMirror,[contenteditable="true"]');
    if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();requestRun();return;}
    if(event.target.matches('[data-step]')&&['Enter',' '].includes(event.key)){event.preventDefault();selectStep(event.target.dataset.step);return;}
    if(!field && !document.querySelector('dialog[open]')){
      if(event.key.toLowerCase()==='a'&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();openOperations();}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();undo(event.shiftKey);}
    }
  });
  $('#step-config').addEventListener('focusin',event=>{if(event.target.dataset.field){state.lastField=event.target.id;lastEditKey=null;showFieldHints(event.target);}});
  $('#step-config').addEventListener('input',event=>{
    const field=event.target;
    if(!field.dataset.field || state.manual)return;
    const step=state.steps.find(item=>item.id===state.selectedId);
    if(!step)return;
    const key=`${step.id}:${field.dataset.field}`;
    if(lastEditKey!==key){remember();lastEditKey=key;}
    step.params[field.dataset.field]=field.type==='checkbox'?field.checked:field.value;
    renderPipeline();updateGeneratedCode();showFieldHints(field);
  });
  $('#operation-search').addEventListener('input',renderOperations);
  $('#helper-search').addEventListener('input',renderHelpers);
  $('#table-search').addEventListener('input',()=>{renderTableNames();persistWorkspace();});
  $('#loaded-table-search').addEventListener('input',()=>{renderLoadedTables();persistWorkspace();});
  $('#intellisense-toggle').addEventListener('change', event => {
    state.completions = event.target.checked;
    try {localStorage.setItem('tablecraft.completions',state.completions?'on':'off');} catch {}
    if (!state.completions) {cm?.closeHint();closeFieldHints();clearTimeout(hintTimer);}
    updateFunctionContext();
    persistWorkspace();
  });
  $('#auto-run').addEventListener('change',event=>{
    state.autoRun=event.target.checked;clearTimeout(runTimer);
    if(state.autoRun)requestRun();else{pendingRun=null;setStale();toast('Live preview paused. R syntax checks stay on.');}
    persistWorkspace();
  });
  $('#page-size').addEventListener('change',event=>{if(workerTask){event.target.value=String(state.pageSize);toast('Wait for the current calculation to finish.');return;}state.pageSize=Number(event.target.value);state.offset=0;persistWorkspace();changePage(0);});
  $('#recipe-file').addEventListener('change',event=>loadRecipe(event.target.files[0]));
  $('#data-file').addEventListener('change',event=>chooseFiles(event.target.files));
  $('#import-format').addEventListener('change',()=>{showImportFields();$('#import-header').checked=$('#import-format').value!=='fwf';});
  const drop=$('#file-drop');
  drop.addEventListener('dragover',event=>{event.preventDefault();drop.classList.add('drag-over');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('drag-over'));
  drop.addEventListener('drop',event=>{event.preventDefault();drop.classList.remove('drag-over');chooseFiles(event.dataTransfer.files);});
  const list=$('#pipeline-list');
  list.addEventListener('dragstart',event=>{const step=event.target.closest('[data-step]');if(!step||state.manual)return;draggedId=step.dataset.step;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggedId);step.classList.add('dragging');});
  list.addEventListener('dragover',event=>{const step=event.target.closest('[data-step]');if(step&&draggedId){event.preventDefault();$$('.step-item.drag-over').forEach(item=>item.classList.remove('drag-over'));step.classList.add('drag-over');}});
  list.addEventListener('drop',event=>{
    event.preventDefault();const target=event.target.closest('[data-step]');
    if(target&&draggedId&&target.dataset.step!==draggedId){remember();const from=state.steps.findIndex(step=>step.id===draggedId),to=state.steps.findIndex(step=>step.id===target.dataset.step);const [step]=state.steps.splice(from,1);state.steps.splice(to,0,step);renderPipeline();renderConfig();updateGeneratedCode();}
    draggedId=null;$$('.drag-over,.dragging').forEach(item=>item.classList.remove('drag-over','dragging'));
  });
  list.addEventListener('dragend',()=>{draggedId=null;$$('.drag-over,.dragging').forEach(item=>item.classList.remove('drag-over','dragging'));});
  window.addEventListener('beforeunload',event=>{
    const saved=persistWorkspace();workspaceStore.flush().catch(()=>{});
    if (state.importing || !saved && (state.manual || state.undo.length || state.uploads.length) || state.uploads.some(table=>!table.missing && !table.storageKey)) {event.preventDefault();event.returnValue='';}
  });
  window.addEventListener('pagehide',()=>{persistWorkspace();workspaceStore.flush().catch(()=>{});});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){persistWorkspace();workspaceStore.flush().catch(()=>{});}});
  engine.addEventListener('status',onRuntimeStatus);
  window.addEventListener('resize',closeFieldHints);
}

async function boot() {
  hydrateIcons();
  const restored=await restoreWorkspace();
  refreshThemeButton();initEditor();bindEvents();initializeAnalysis();
  $('#auto-run').checked=state.autoRun;$('#page-size').value=String(state.pageSize);
  if(recoveredView){
    $('#table-search').value=recoveredView.tableSearch || '';$('#loaded-table-search').value=recoveredView.loadedSearch || '';
    $('.workbench').classList.toggle('expanded',recoveredView.expanded);
  }
  renderSource();renderPipeline();renderConfig();refreshMode();updateHistoryButtons();
  if (state.manual) {setEditor(state.code);changed();} else updateGeneratedCode();
  if(state.result){state.offset=Number(state.result.offset)||0;renderTable();setStale();}
  cm?.clearHistory();
  persistenceReady=true;persistWorkspace();
  // Show the actual pipe first; the reproducible source definition stays above it.
  requestAnimationFrame(()=>{
    if(cm){cm.refresh();if(recoveredView?.cursor){cm.setCursor(recoveredView.cursor);cm.scrollTo(recoveredView.scroll?.left || 0,recoveredView.scroll?.top || 0);}else{const line=Math.min(cm.lineCount()-1,Math.max(0,(state.compiled.lineMap?.[0]?.startLine||1)-4));cm.scrollIntoView({line,ch:0},15);}}
  });
  if(location.protocol==='file:'){
    $('#loading-message').textContent='Serve this folder over HTTP (for example: python -m http.server 8080), or publish it to GitHub Pages.';
  }
  startRuntime();
  if(restored)toast('Restored your saved workspace. Uploaded files are restored as R starts.');
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
