import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanHelpText, REngine } from '../js/runtime.js';

test('help cleanup preserves plain Unicode, spacing, code and blank lines', () => {
  const plain = 'Résumé: café, α, 数据, 🙂\n\n    x[, new_col := 1]\n\tvalue_name\n';
  assert.equal(cleanHelpText(plain), plain);
  assert.equal(cleanHelpText(null), '');
  assert.equal(cleanHelpText(undefined), '');
});

test('R underlined headings render as ordinary text', () => {
  const heading = Array.from('Fast row reordering').map(character => `_${'\b'}${character}`).join('');
  assert.equal(cleanHelpText(`${heading}\n\n     Details:\n`), 'Fast row reordering\n\n     Details:\n');
});

test('reverse underlines, bold overstrikes and Unicode retain visible characters', () => {
  assert.equal(cleanHelpText('F\bFa\bas\bst\bt'), 'Fast');
  assert.equal(cleanHelpText('F\b_a\b_s\b_t\b_'), 'Fast');
  assert.equal(cleanHelpText('_\bé _\b🙂 🙂\b_'), 'é 🙂 🙂');
  assert.equal(cleanHelpText('_\bF\bF'), 'F');
});

test('backspaces stay within each line and preserve terminal cursor behavior', () => {
  assert.equal(cleanHelpText('abc\b\bXY\n\b\bsecond\b'), 'aXY\nsecond');
  assert.equal(cleanHelpText('Heading\r\n\n    Body\rNext'), 'Heading\n\n    Body\nNext');
});

test('ANSI style and cursor controls are removed from help text', () => {
  assert.equal(cleanHelpText('\x1b[1;31mTitle\x1b[0m\n\x1b[2K    Body'), 'Title\n    Body');
  assert.equal(cleanHelpText('\u009b4mUsage\u009b0m'), 'Usage');
  assert.equal(cleanHelpText('a\x00b\x07c\x7fd'), 'abcd');
});

test('terminal hyperlink metadata and control strings leave only visible labels', () => {
  assert.equal(cleanHelpText('\x1b]8;;https://example.com/help\x07Docs\x1b]8;;\x07'), 'Docs');
  assert.equal(cleanHelpText('\x1b]8;;https://example.com/help\x1b\\Docs\x1b]8;;\x1b\\'), 'Docs');
  assert.equal(cleanHelpText('\x1bPterminal metadata\x1b\\Visible'), 'Visible');
});

test('literal R escape sequences remain intact and cleanup is idempotent', () => {
  const literal = String.raw`grepl("\bword\b", x); text <- "\033[1m"`;
  assert.equal(cleanHelpText(literal), literal);
  const cleaned = cleanHelpText('\x1b[1m_\bT_\be_\bx_\bt\x1b[0m\r\n  x_y');
  assert.equal(cleanHelpText(cleaned), cleaned);
});

test('helpFor applies cleanup while preserving metadata and missing-topic semantics', async () => {
  const fake = {
    _enqueue: callback => callback({}),
    _json: async () => ({ topic: 'fread', package: 'data.table', text: '_\bF_\ba_\bs_\bt' })
  };
  assert.deepEqual(await REngine.prototype.helpFor.call(fake, 'fread', 'data.table'), {
    topic: 'fread', package: 'data.table', text: 'Fast'
  });
  fake._json = async () => ({ topic: 'missing', package: 'data.table', text: null });
  assert.deepEqual(await REngine.prototype.helpFor.call(fake, 'missing', 'data.table'), {
    topic: 'missing', package: 'data.table', text: null
  });
});
