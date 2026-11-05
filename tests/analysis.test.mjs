import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_RECIPES, ANALYSIS_CHARTS, normaliseAnalysisConfig,
  validateAnalysisConfig, buildAnalysisSetup, buildAnalysisCode,
} from '../js/analysis.js';

const base = { scope: 'table', tableNames: ['sales'], recipe: 'profile' };

test('analysis preserves exact table and column names while removing duplicates', () => {
  const config = normaliseAnalysisConfig({
    tableNames: [' sales ', ' sales ', '2026 sales', '', null],
    columns: ['gross net', 'gross net', 'if', 'a`b'],
  });
  assert.deepEqual(config.tableNames, [' sales ', '2026 sales']);
  assert.deepEqual(config.columns, ['gross net', 'if', 'a`b']);
});

test('analysis limits rendering controls without restricting full-data statistics', () => {
  const config = normaliseAnalysisConfig({ topN: 500, scatterLimit: 1, maxPlots: 40 });
  assert.equal(config.topN, 100);
  assert.equal(config.scatterLimit, 100);
  assert.equal(config.maxPlots, 16);
  assert.equal(normaliseAnalysisConfig().scatterLimit, 5000);
  const code = buildAnalysisCode(base);
  assert.match(code, /Statistics use complete selected tables/);
  assert.match(code, /profile_column\(job\$value/);
  assert.doesNotMatch(code, /head\(tables|head\(table,/);
});

test('analysis validates empty selections, comparison scope, key columns and null bytes', () => {
  assert.match(validateAnalysisConfig({}).join(' '), /Choose at least one table/);
  assert.match(validateAnalysisConfig({ ...base, scope: 'compare' }).join(' '), /at least two/);
  assert.match(validateAnalysisConfig({ ...base, tableNames: ['a', 'b'] }).join(' '), /Compare tables/);
  assert.match(validateAnalysisConfig({ ...base, scope: 'column' }).join(' '), /one column/);
  assert.match(validateAnalysisConfig({ ...base, scope: 'column', columns: ['x', 'y'] }).join(' '), /exactly one/);
  assert.match(validateAnalysisConfig({ scope: 'compare', tableNames: ['a', 'b'], recipe: 'overlap' }).join(' '), /key columns/);
  assert.match(validateAnalysisConfig({ ...base, tableNames: ['a\u0000b'] }).join(' '), /null character/);
  assert.throws(() => buildAnalysisCode({}), /Choose at least one/);
});

test('analysis rejects incompatible chart choices and single-column correlations', () => {
  assert.match(validateAnalysisConfig({ ...base, chart: 'table-size' }).join(' '), /matches the analysis/);
  assert.match(validateAnalysisConfig({ ...base, recipe: 'correlation', columns: ['x'] }).join(' '), /two numeric columns/);
  assert.match(validateAnalysisConfig({ ...base, chart: 'scatter', columns: ['x'] }).join(' '), /two numeric columns/);
  assert.deepEqual(validateAnalysisConfig({ ...base, chart: 'histogram' }), []);
});

test('analysis source preparation includes only selected definitions with quoted names', () => {
  const metadata = [
    { tableName: '2026 sales', sourceCode: 'fread("2026 sales.csv")' },
    { tableName: 'untouched', tablesCode: 'stop("unrelated pipeline error")' },
    { tableName: 'other', importCode: 'other <- fread("other.tsv")' },
  ];
  const setup = buildAnalysisSetup(metadata, ['2026 sales', 'other']);
  assert.match(setup, /`2026 sales` <- fread\("2026 sales\.csv"\)/);
  assert.match(setup, /other <- fread\("other\.tsv"\)/);
  assert.doesNotMatch(setup, /unrelated pipeline error/);
  assert.equal((setup.match(/library\(data\.table\)/g) || []).length, 1);
});

test('analysis source preparation retains result definitions and pipe dependencies', () => {
  const definition = 'result <- local({\n  sales <- data.table(x = 1:3)\n  sales %>% .[x > 1]\n})';
  const setup = buildAnalysisSetup([{ tableName: 'result', tablesCode: definition }], ['result']);
  assert.match(setup, /library\(magrittr\)/);
  assert.ok(setup.includes(definition));
});

test('generated analysis quotes non-syntactic object names and R string names', () => {
  const code = buildAnalysisCode({
    scope: 'compare', tableNames: ['2026 sales', 'if', 'a`b'],
    columns: ['gross net', 'line\nbreak'], recipe: 'profile',
  });
  assert.match(code, /"2026 sales" = `2026 sales`/);
  assert.match(code, /"if" = `if`/);
  assert.ok(code.includes('`a\\`b`'));
  assert.ok(code.includes('"line\\nbreak"'));
  assert.match(code, /local\(\{/);
  assert.match(code, /output\[\]/);
});

test('all recipes and compatible charts generate standalone R using public APIs', () => {
  assert.equal(ANALYSIS_RECIPES.length, 7);
  assert.equal(ANALYSIS_CHARTS.filter(chart => chart.id !== 'none').length, 8);
  for (const recipe of ANALYSIS_RECIPES) {
    for (const chart of ANALYSIS_CHARTS.filter(chart => chart.id === 'none' || chart.recipes.includes(recipe.id))) {
      const code = buildAnalysisCode({
        scope: 'compare', tableNames: ['left', 'right'], recipe: recipe.id,
        columns: recipe.id === 'overlap' ? ['id'] : [], chart: chart.id,
        setupCode: 'left <- data.table(id = 1:3)\nright <- data.table(id = 2:4)',
      });
      assert.match(code, /library\(data\.table\)/, recipe.id);
      assert.match(code, /left <- data\.table/);
      assert.doesNotMatch(code, /\.tc_|__tablecraft/);
      if (chart.id !== 'none') assert.match(code, /graphics::/);
    }
  }
});

test('finite statistics and list overview have explicit handling in generated R', () => {
  const profile = buildAnalysisCode(base);
  assert.match(profile, /Numeric statistics use finite values/);
  assert.match(profile, /quantiles use type 7/);
  assert.match(profile, /integer64/);
  const overview = buildAnalysisCode({ ...base, recipe: 'overview' });
  assert.match(overview, /duplicated\(as\.data\.frame\(table\)\)/);
});

test('chart code discloses its sampling and display bounds', () => {
  const scatter = buildAnalysisCode({ ...base, chart: 'scatter' });
  assert.match(scatter, /scatter_limit <- 5000L/);
  assert.match(scatter, /evenly spaced|evenly-spaced/i);
  const correlation = buildAnalysisCode({ ...base, recipe: 'correlation', chart: 'correlation' });
  assert.match(correlation, /30/);
});
