import {OPERATIONS, findOperation, rString, rName, parseColumns} from './catalog.js';
import {formatRCode, stripRComments, significantTokens} from './r-syntax.js';
import {parseRScript} from './pipeline-parser.js';

export {rString, rName, parseColumns, findOperation};
export {tokenizeR, referencedNames, formatRCode, splitTopLevel, decodeRLiteral, stripRComments, removeRComments, reconcileRComments} from './r-syntax.js';

/** Schema-aware initial values for an operation form. */
export function defaultsFor(opId, columns = []) {
  const op = findOperation(opId);
  if (!op) return {};
  const defaults = {
    ...Object.fromEntries(op.fields.map(field => [field.key, field.default ?? ''])),
    ...(op.defaults?.(columns) || {})
  };
  const names = columns.map(column => typeof column === 'string' ? column : column.name);
  for (const field of op.fields.filter(field => field.type === 'columns')) {
    const value = defaults[field.key];
    if (typeof value === 'string' && names.includes(value) && (/[,\n\r\t"'`\\]/.test(value) || value.trim() !== value)) defaults[field.key] = rString(value);
  }
  return defaults;
}

function paramsFor(step, ctx = {}) {
  const op = findOperation(step.op);
  const params = {...defaultsFor(step.op, ctx.columns || []), ...(step.params || {})};
  if (typeof params.table === 'string') {
    const value = params.table.trim();
    const tableNames = (ctx.tables || []).map(table => typeof table === 'string' ? table : table.tableName ?? table.name);
    if (tableNames.includes(value)) params.table = rName(value);
  }
  op?.fields.filter(field => field.type === 'number').forEach(field => {
    const value = params[field.key];
    if (String(value ?? '').trim() && Number.isFinite(Number(value))) params[field.key] = Number(value);
  });
  return params;
}

/**
 * Validate form structure only. The R parser/runtime supplies language and
 * evaluation diagnostics; raw R fields intentionally remain fully expressive.
 */
export function validateStep(step, ctx = {}) {
  if (step.enabled === false) return [];
  const op = findOperation(step.op);
  if (!op) return [{severity:'error', stepId:step.id, message:`Unknown operation: ${String(step.op)}. Remove this step or choose an available operation.`}];
  const params = paramsFor(step, ctx);
  const issues = [];
  const add = (field, message, severity = 'error') => issues.push({severity, stepId:step.id, field, message});
  op.fields.forEach(field => {
    const value = params[field.key];
    const empty = field.type === 'columns' ? !parseColumns(value).length : value == null || String(value).trim() === '';
    if (field.required && empty) {
      add(field.key, `Complete "${field.label}" in ${op.label.toLowerCase()}.`);
      return;
    }
    if (empty) return;
    if (typeof value === 'string' && value.includes('\0')) add(field.key, 'Remove the null character from this field. R strings cannot contain null characters.');
    if (field.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) add(field.key, `"${field.label}" must be a finite number.`);
      else if (field.integer && !Number.isInteger(n)) add(field.key, `"${field.label}" must be a whole number.`);
      else if (field.min != null && n < field.min) add(field.key, `"${field.label}" must be at least ${field.min}.`);
      else if (field.max != null && n > field.max) add(field.key, `"${field.label}" must be at most ${field.max}.`);
      else if (field.integer && n > 2147483647) add(field.key, `"${field.label}" must fit in an R integer (at most 2147483647).`);
    }
    if (field.type === 'select' && field.options) {
      const allowed = field.options.map(option => typeof option === 'object' ? option.value : option);
      if (!allowed.includes(value)) add(field.key, `Choose an available value for "${field.label}".`);
    }
    if (field.type === 'checkbox' && typeof value !== 'boolean') add(field.key, `"${field.label}" must be a true or false setting.`);
    if (field.type === 'columns') {
      const names = parseColumns(value);
      if (new Set(names).size !== names.length) add(field.key, `"${field.label}" repeats a column name. Check whether this is intentional.`, 'warning');
      if (hasUnclosedNameQuote(value)) add(field.key, `Close the quoted column name in "${field.label}".`);
    }
  });
  (op.validate?.(params, ctx) || []).forEach(issue => issues.push({...issue, stepId:step.id}));
  return issues;
}

// This checks only the mini-language used by literal column-name pickers.
function hasUnclosedNameQuote(value) {
  if (Array.isArray(value)) return false;
  let quote = '', start = true, escaped = false;
  for (const c of String(value ?? '')) {
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
    } else if (start && ['"', "'", '`'].includes(c)) {
      quote = c;
      start = false;
    } else if (c === ',' || c === '\n') start = true;
    else if (!/\s/.test(c)) start = false;
  }
  return Boolean(quote);
}

/** Build a single RHS. Incomplete forms are handled by compilePipeline(). */
export function buildStep(step, ctx = {}) {
  const op = findOperation(step.op);
  if (!op) throw new Error(`Unknown operation: ${String(step.op)}`);
  if (step.originalExpression != null && step.originalOp === step.op && step.originalParams === JSON.stringify(step.params)) {
    return step.originalExpression;
  }
  return op.build(paramsFor(step, ctx), ctx).replace(/\r\n?/g, '\n').trim();
}

export const parsePipeline = (code, options = {}) => parseRScript(code, {...options, defaultsFor, buildStep});

/**
 * Compile the wizard into an independently runnable R script. Line mappings
 * are 1-based, inclusive, and correspond to the executable text of each step.
 * A fresh copy prevents := and set* operations from mutating the source.
 * Comment filtering happens last, preserving all generated line locations.
 */
export function compilePipeline({sourceCode = 'as.data.table(iris)', steps = [], tablesCode = '', columns = [], tables = [],
  preambleCode = '', epilogueCode = '', preservePreamble = false, pipelineSource = '', resultName = 'result', assignmentOperator = '<-', lineWidth = 88, includeComments = true} = {}) {
  const ctx = {columns, tables};
  const issues = [];
  const lineMap = [];
  const activeSteps = steps.filter(step => step.enabled !== false);
  const standalone = activeSteps.find(step => step.op === 'script');
  if (standalone) {
    const source = String(standalone.params?.code ?? '');
    const code = includeComments ? source : stripRComments(source);
    if (activeSteps.length !== 1) issues.push({severity:'error', stepId:standalone.id, message:'A preserved full script must be edited on its own. Start a new visual pipeline before adding transformation steps.'});
    return {code, issues, lineMap:[{stepId:standalone.id, startLine:1, endLine:Math.max(1, code.split('\n').length)}]};
  }
  const lines = ['library(data.table)', 'library(magrittr)', ''];
  const setup = (Array.isArray(tablesCode) ? tablesCode.join('\n') : String(tablesCode || '')).replace(/\r\n?/g, '\n').trim();
  if (setup) lines.push('# Additional tables', ...setup.split('\n'), '');
  let source = String(sourceCode || '').replace(/\r\n?/g, '\n').trim();
  if (!source) {
    issues.push({severity:'error', message:'Choose a source table before running the pipeline.'});
    source = 'stop("Choose a source table before running the pipeline.")';
  }
  lines.push('# A fresh copy keeps the original data unchanged.', `source_dt <- ${source}`, '');
  // Parsed text owns its setup/imports and final expression. Do not re-insert
  // generated definitions, which could silently undo the user's text edits.
  const sourceLines = preservePreamble
    ? (preambleCode ? formatRCode(preambleCode.trimEnd(), {width:lineWidth}).split('\n') : [])
    : formatRCode(lines.join('\n'), {width:lineWidth}).split('\n');
  if (preservePreamble && sourceLines.length) sourceLines.push('');
  const startExpression = preservePreamble ? pipelineSource || source : 'copy(as.data.table(source_dt))';
  const assignment = resultName == null ? '' : `${rName(resultName)} ${assignmentOperator === '=' ? '=' : '<-'} `;
  sourceLines.push(...formatRCode(`${assignment}${startExpression}${activeSteps.length ? ' %>%' : ''}`, {width:lineWidth}).split('\n'));
  activeSteps.forEach((step, index) => {
    const op = findOperation(step.op);
    const stepIssues = validateStep(step, ctx);
    issues.push(...stepIssues);
    let stage;
    if (stepIssues.some(issue => issue.severity === 'error')) {
      stage = `{ stop(${rString(stepIssues.find(issue => issue.severity === 'error').message)}) }`;
    } else {
      try {
        stage = buildStep(step, ctx);
        if (!stage) throw new Error('The R expression is empty.');
      } catch (error) {
        const message = `Cannot build ${op?.label.toLowerCase() || 'this step'}: ${error.message}`;
        issues.push({severity:'error', stepId:step.id, message});
        stage = `{ stop(${rString(message)}) }`;
      }
    }
    sourceLines.push(`  # ${index + 1}. ${op?.label || 'Unknown operation'}`);
    const startLine = sourceLines.length + 1;
    if (index < activeSteps.length - 1) {
      // Insert after the final token, before trailing comments or whitespace.
      // Tokenizing the whole stage handles multiline raw strings and names.
      const last = significantTokens(stage).at(-1);
      const at = last?.end ?? stage.length;
      stage = `${stage.slice(0, at)} %>%${stage.slice(at)}`;
    }
    const stageLines = formatRCode(stage, {width:lineWidth, baseIndent:2}).split('\n');
    sourceLines.push(...stageLines);
    lineMap.push({stepId:step.id, startLine, endLine:sourceLines.length});
  });
  if (preservePreamble) {
    if (epilogueCode.trim()) sourceLines.push('', ...formatRCode(epilogueCode.trim(), {width:lineWidth}).split('\n'));
    sourceLines.push('');
  } else sourceLines.push('', 'result', '');
  const code = sourceLines.join('\n');
  return {code:includeComments ? code : stripRComments(code), lineMap, issues};
}

export const OPERATION_COUNT = OPERATIONS.length;
