import test from 'node:test';
import assert from 'node:assert/strict';
import {stripRComments, removeRComments, reconcileRComments, tokenizeR, significantTokens, formatRCode} from '../js/r-syntax.js';
import {compilePipeline, parsePipeline} from '../js/compiler.js';
import {commentCases} from './comment-cases.mjs';

const assertProjection = (annotated, edited) => {
  const restored = reconcileRComments(annotated, edited);
  assert.equal(stripRComments(restored), stripRComments(edited));
  return restored;
};

test('comment filtering preserves exact R literals, operators and line boundaries', () => {
  for (const {name, source, expected} of commentCases) {
    const stripped = stripRComments(source);
    assert.equal(stripped, expected, name);
    assert.deepEqual(significantTokens(stripped).map(token => token.value), significantTokens(source).map(token => token.value), name);
    assert.deepEqual(stripped.match(/\r\n|\r|\n/g), source.match(/\r\n|\r|\n/g), name);
    assert.equal(stripRComments(stripped), stripped, name);
  }
  assert.equal(removeRComments, stripRComments);
  assert.equal(stripRComments(null), '');
  assert.equal(stripRComments(''), '');
});

test('unfinished strings and names keep their hash characters while editing', () => {
  for (const unfinished of ['"text # data', "'text # data", '`name # data', 'r"-(text # data', 'r\'{text # data']) {
    assert.equal(stripRComments('# remove\nvalue <- ' + unfinished), '\nvalue <- ' + unfinished);
  }
  assert.equal(stripRComments('x %unfinished # note\ny <- 2'), 'x %unfinished \ny <- 2');
});

test('unmodified comment visibility round trips restore byte-for-byte source', () => {
  for (const {name, source} of commentCases) {
    let annotated = source;
    for (let iteration = 0; iteration < 5; iteration += 1) annotated = assertProjection(annotated, stripRComments(annotated));
    assert.equal(annotated, source, name);
  }
});

test('one-character edits preserve adjacent and header comments without old code', () => {
  const annotated = '# input\nx <- 1 # amount\nresult <- x # output\n';
  const edited = stripRComments(annotated).replace('x <- 1', 'x <- 2');
  const restored = assertProjection(annotated, edited);
  assert.equal(restored, annotated.replace('x <- 1', 'x <- 2'));
  assert.equal(restored.includes('x <- 1'), false);
  assert.equal(assertProjection('x # name\n', 'y \n'), 'y # name\n');
});

test('line insertion and deletion preserve comments tied to surviving code', () => {
  const annotated = '# input\nx <- 1 # first\ny <- 2 # second\nx + y # output\n';
  const inserted = stripRComments(annotated).replace('y <- 2', 'z <- 3\ny <- 2');
  assert.equal(assertProjection(annotated, inserted), annotated.replace('y <- 2', 'z <- 3\ny <- 2'));
  const deleted = stripRComments(annotated).replace('y <- 2 \n', '');
  const restored = assertProjection(annotated, deleted);
  assert.equal(restored, annotated.replace('y <- 2 # second\n', ''));
  assert.equal(restored.includes('# second'), false);
  assert.equal(restored.includes('y <- 2'), false);
});

test('formatting and wrapping retain comments without changing the formatted code', () => {
  const annotated = '# values\nout <- list(alpha = 1, beta = 2, gamma = 3, delta = 4) # arguments\nout # return\n';
  const formatted = formatRCode(stripRComments(annotated), {width:30});
  const restored = assertProjection(annotated, formatted);
  assert.match(restored, /# values/);
  assert.match(restored, /# arguments/);
  assert.match(restored, /# return/);
  assert.equal(stripRComments(restored), formatted);
});

test('new comments take precedence and restored text never enters a literal', () => {
  assert.equal(assertProjection('x <- 1 # old\ny <- 2 # keep\n', 'x <- 3 # new\ny <- 2 \n'), 'x <- 3 # new\ny <- 2 # keep\n');
  const source = 'value <- 1 # first\nnext <- 2 # second\n';
  for (const edited of ['value <- "first\nnext <- 2\nlast"\n', 'value <- r"-(first\nnext <- 2\nlast)-"\n', 'value <- "unfinished']) {
    const restored = assertProjection(source, edited);
    assert.equal(restored, edited);
  }
});

test('replacing the whole script cannot resurrect old statements or annotations', () => {
  const old = '# original input\nold <- 1 # obsolete\nold\n';
  const replacement = '# new input\nfresh <- list(value = TRUE)\nfresh\n';
  assert.equal(assertProjection(old, replacement), replacement);
  assert.equal(assertProjection(old, ''), '');
  assert.equal(assertProjection(old, '42'), '42');
  assert.equal(assertProjection('', replacement), replacement);
});

test('Windows and Unicode edits preserve line endings and comment spelling', () => {
  const old = '# 注释\r\ncafé <- 1 # valeur 🦉\r\n`结果` <- café # 结果\r\n';
  const edited = stripRComments(old).replace('café <- 1', 'café <- 2');
  assert.equal(assertProjection(old, edited), old.replace('café <- 1', 'café <- 2'));
});

test('large replaced blocks preserve the projection without quadratic diff storage', () => {
  const old = Array.from({length:600}, (_, i) => `old_${i} <- ${i} # previous ${i}`).join('\n');
  const edited = Array.from({length:600}, (_, i) => `fresh_${i} <- ${i + 10000}`).join('\n');
  const restored = assertProjection(old, edited);
  assert.equal(restored.includes('old_'), false);
});

test('compiler comment option filters setup, steps and epilogue without moving line mappings', () => {
  const options = {
    sourceCode:'lookup',
    tablesCode:'lookup <- data.table(code = "# literal") # imported',
    steps:[
      {id:'custom', op:'custom', params:{expression:'.[code == "# literal"] # filter\n# next'}},
      {id:'head', op:'head-tail', params:{n:2}}
    ]
  };
  const shown = compilePipeline(options), hidden = compilePipeline({...options, includeComments:false});
  assert.equal(hidden.code, stripRComments(shown.code));
  assert.deepEqual(hidden.lineMap, shown.lineMap);
  assert.deepEqual(hidden.issues, shown.issues);
  assert.equal(tokenizeR(hidden.code).some(token => token.type === 'comment'), false);
  assert.ok(hidden.code.includes('"# literal"'));
  const lines = hidden.code.split('\n');
  assert.match(lines[hidden.lineMap[0].startLine - 1], /\.\[code == "# literal"\] %>%/);
  assert.match(lines[hidden.lineMap[1].startLine - 1], /head\(/);

  const parsed = parsePipeline('library(data.table) # setup\nresult <- sales %>% head(n = 2L) # final stage\nresult # final expression');
  const parsedShown = compilePipeline(parsed), parsedHidden = compilePipeline({...parsed, includeComments:false});
  assert.equal(parsedHidden.code, stripRComments(parsedShown.code));
  assert.deepEqual(parsedHidden.lineMap, parsedShown.lineMap);
});

test('standalone scripts keep their exact source and line locations when comments are omitted', () => {
  const code = '# heading\r\nx <- "# literal" # assignment\r\nx\r\n';
  const options = {steps:[{id:'script', op:'script', params:{code}}]};
  const shown = compilePipeline(options), hidden = compilePipeline({...options, includeComments:false});
  assert.equal(shown.code, code);
  assert.equal(hidden.code, stripRComments(code));
  assert.deepEqual(hidden.lineMap, shown.lineMap);
  assert.deepEqual(hidden.lineMap, [{stepId:'script', startLine:1, endLine:4}]);
});

test('pipe insertion recognizes hashes in raw strings and special infix operators', () => {
  for (const expression of ['r"-(\n"# literal\n)-" # comment', '1 %#% 2 # comment', '`a#b` # comment']) {
    const {code} = compilePipeline({steps:[
      {id:'custom', op:'custom', params:{expression}},
      {id:'head', op:'head-tail', params:{n:2}}
    ]});
    const tokens = significantTokens(code);
    const pipes = tokens.filter(token => token.value === '%>%');
    assert.equal(pipes.length, 2, expression);
    assert.ok(code.includes('# comment'), expression);
    assert.equal(tokenizeR(stripRComments(code)).some(token => token.type === 'comment'), false, expression);
  }
});
