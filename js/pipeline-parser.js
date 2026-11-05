import {OPERATIONS} from './catalog.js';
import {tokenizeR, significantTokens, normalizedR, splitTopLevel, rStatements} from './r-syntax.js';
import {topLevelOperator, literalName, underlyingSource, recognizeStage, shadowedLogicalAliases} from './r-recognition.js';

function stripGeneratedLabel(expression) {
  const labels = new Set(OPERATIONS.map(operation => operation.label));
  return expression.replace(/^\s*#\s*\d+\.\s*([^\n]+)\n/, (match, label) => labels.has(label.trim()) ? '' : match).trim();
}

function scriptFallback(code, warning = '') {
  return {
    ok:true, mode:'script', standalone:true, rawCode:code,
    preservePreamble:true, preambleCode:'', epilogueCode:'', pipelineSource:'', resultName:null,
    sourceCode:'', steps:[{id:'script-preserved', op:'script', enabled:true, params:{code}}],
    warnings:warning ? [warning] : ['This script is preserved in a full-script step because it has no top-level pipeline.'],
  };
}

/**
 * Recover editable forms where possible. Preserve all other R as custom stages
 * or a whole-script card. Setup and trailing expressions stay authoritative.
 */
export function parseRScript(code, {previousSteps = [], columns = [], tables = [], defaultsFor, buildStep} = {}) {
  const originalSource = String(code ?? '');
  const source = originalSource.replace(/\r\n?/g, '\n');
  const lexical = tokenizeR(source);
  const stack = [];
  const pairs = {')':'(', ']':'[', '}':'{'};
  let invalid = false;
  for (const token of lexical) {
    if (token.closed === false) invalid = true;
    if (token.type === 'open') stack.push(token.value);
    if (token.type === 'close' && stack.pop() !== pairs[token.value]) invalid = true;
  }
  if (invalid || stack.length) return scriptFallback(originalSource, 'The R has an incomplete delimiter or string. It is preserved exactly in a full-script step.');
  const statements = rStatements(source);
  const candidates = statements.map(statement => {
    const expression = source.slice(statement.expressionStart, statement.end).trim().replace(/;\s*$/, '');
    if (topLevelOperator(expression, ['->','->>','<<-'])) return null;
    const assignment = topLevelOperator(expression, ['<-', '=']);
    const resultName = assignment ? literalName(expression.slice(0, assignment.start)) : null;
    if (assignment && !resultName) return null;
    const rhs = assignment ? expression.slice(assignment.end).trim() : expression;
    const pieces = splitTopLevel(rhs, '%>%');
    if (pieces.length < 2 && resultName !== 'result') return null;
    return {statement, expression, assignment, resultName, pieces};
  }).filter(Boolean);
  const candidate = candidates.at(-1);
  if (!candidate) return scriptFallback(originalSource);
  const {statement, resultName, pieces} = candidate;
  const pipelineSource = pieces[0].trim();
  if (!pipelineSource || pieces.slice(1).some(piece => !significantTokens(piece).length)) return scriptFallback(originalSource, 'A pipeline stage is incomplete. The entire R script is preserved for editing.');
  const usedIds = new Set();
  const shadowedAliases = shadowedLogicalAliases(source, columns);
  const stages = pieces.slice(1).map((piece, index) => {
    const expression = stripGeneratedLabel(piece);
    const normalized = normalizedR(expression);
    const previous = previousSteps.find(step => step.enabled !== false && !usedIds.has(step.id) && (() => {
      try { return normalizedR(buildStep(step, {columns, tables})) === normalized; } catch { return false; }
    })());
    // An unsupported stage can become representable after another text edit.
    // Keeping a previous generic card must not permanently prevent recovery.
    const genericPrevious = previous && ['custom','custom-bracket','script'].includes(previous.op);
    const aliasIsShadowed = significantTokens(expression).some(token => token.type === 'name' && shadowedAliases.has(token.name));
    const previousForm = previous && !genericPrevious && !aliasIsShadowed
      ? {op:previous.op, params:{...previous.params}} : null;
    const recognized = previousForm || recognizeStage(expression, {shadowedAliases, columns}) ||
      (genericPrevious ? {op:previous.op, params:{...previous.params}} : {op:'custom', params:{expression}});
    const params = {...(defaultsFor?.(recognized.op, columns) || {}), ...recognized.params};
    let id = previous?.id || `parsed-${index + 1}`;
    let suffix = 2;
    while (usedIds.has(id)) id = `parsed-${index + 1}-${suffix++}`;
    usedIds.add(id);
    return {
      id, op:recognized.op, params, enabled:true,
      originalExpression:expression, originalParams:JSON.stringify(params), originalOp:recognized.op,
    };
  });
  const preambleCode = source.slice(0, statement.expressionStart);
  const epilogueCode = source.slice(statement.end);
  let sourceCode = underlyingSource(pipelineSource);
  if (literalName(sourceCode) === 'source_dt') {
    for (const before of statements.filter(item => item.end <= statement.expressionStart)) {
      const text = source.slice(before.expressionStart, before.expressionEnd);
      const op = topLevelOperator(text, ['<-','=']);
      if (op && literalName(text.slice(0, op.start)) === 'source_dt') sourceCode = underlyingSource(text.slice(op.end));
    }
  }
  const sourceName = literalName(sourceCode);
  return {
    ok:true, mode:'pipeline', standalone:false, rawCode:originalSource,
    preservePreamble:true, preambleCode, epilogueCode, pipelineSource, resultName,
    assignmentOperator:candidate.assignment?.value || '<-',
    sourceCode, sourceName,
    steps:stages,
    warnings:stages.some(step => step.op === 'custom' || step.op === 'custom-bracket')
      ? ['Unrecognized stages are kept as editable custom R steps. Setup code and final expressions are preserved.'] : [],
  };
}
