/**
 * Actual R validation for the ad hoc analysis scripts. Requires webr@0.6.0.
 * Use TABLECRAFT_R_LIBRARY=/absolute/path/to/a/wasm/R/library to avoid downloads.
 * Run: node tests/analysis.webr.mjs
 */
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebR, ChannelType } from 'webr';
import { rString } from '../js/catalog.js';
import { ANALYSIS_RECIPES, ANALYSIS_CHARTS, buildAnalysisCode } from '../js/analysis.js';

const webR = new WebR({
  baseUrl: dirname(fileURLToPath(import.meta.resolve('webr'))) + '/',
  channelType: ChannelType.PostMessage,
});
const setup = `library(data.table)
\`2026 sales\` <- data.table(
  id = c(1L, 1L, 2L, 3L, NA_integer_, 4L),
  amount = c(1, 3, Inf, NA_real_, 5, 7),
  double = c(2, 6, 8, 10, 10, 14),
  category = c("a", "a", "b", NA_character_, "", "b")
)
\`other table\` <- data.table(id = c(2L, 3L, 5L, NA_integer_), amount = 11:14,
  category = c("a", "b", "c", "d"), other = TRUE)
\`list table\` <- data.table(id = c(1L, 1L, 2L), payload = list(1:2, 1:2, NULL))
empty <- data.table(id = integer(), amount = numeric(), double = numeric(), category = character())
text <- data.table(category = c("a", NA_character_, "b"), other = c("x", "y", "z"))
all_missing <- data.table(amount = c(NA_real_, NaN), double = c(NA_real_, NA_real_))
no_columns <- data.table()
large <- data.table(value = seq_len(10001L))`;
let scenarios = 0;
async function evaluate(config, assertion) {
  const code = buildAnalysisCode({ scope: 'table', tableNames: ['2026 sales'], setupCode: setup, ...config });
  await webR.evalRVoid(`invisible(parse(text = ${rString(code)}))`);
  await webR.evalRVoid(`analysis_result <- local({\n${code}\n})`);
  if (assertion) assert.equal(await webR.evalRBoolean(assertion), true, `${config.recipe || 'profile'} / ${config.tableNames || '2026 sales'}: ${assertion}`);
  scenarios += 1;
}
try {
  await webR.init();
  if (process.env.TABLECRAFT_R_LIBRARY) {
    await webR.FS.mkdir('/analysis-library');
    await webR.FS.mount('NODEFS', { root: process.env.TABLECRAFT_R_LIBRARY }, '/analysis-library');
    await webR.evalRVoid('.libPaths(c("/analysis-library", .libPaths()))');
  } else await webR.installPackages(['data.table']);
  await webR.evalRVoid('library(data.table); grDevices::pdf(file = "/tmp/analysis-checks.pdf")');
  await evaluate({ scope: 'column', columns: ['amount'] }, `nrow(analysis_result) == 1L && analysis_result$rows == 6L && analysis_result$missing == 1L && analysis_result$finite == 4L && analysis_result$non_finite == 1L && analysis_result$mean == 4 && analysis_result$median == 4 && analysis_result$p25 == 2.5 && analysis_result$p75 == 5.5 && abs(analysis_result$sd - sqrt(20 / 3)) < 1e-12`);
  await evaluate({ tableNames: ['large'] }, 'analysis_result$rows == 10001L && analysis_result$mean == 5001');
  await evaluate({ recipe: 'frequency', scope: 'column', columns: ['category'] }, 'sum(analysis_result$count) == 6L && abs(sum(analysis_result$percentage) - 100) < 1e-10 && analysis_result[is_missing == TRUE, count] == 1L');
  await evaluate({ recipe: 'missingness', scope: 'columns', columns: ['amount', 'category'] }, 'nrow(analysis_result) == 2L && all(analysis_result$complete_rows_selected == 5L) && all(analysis_result$missing == 1L)');
  await evaluate({ recipe: 'correlation', scope: 'columns', columns: ['amount', 'double'] }, 'nrow(analysis_result) == 1L && analysis_result$complete_pairs == 4L && analysis_result$excluded_pairs == 2L && abs(analysis_result$pearson - 1) < 1e-12 && abs(analysis_result$spearman - 1) < 1e-12');
  await evaluate({ recipe: 'overview', tableNames: ['list table'] }, 'analysis_result$rows == 3L && analysis_result$distinct_rows == 2L && analysis_result$duplicate_rows == 1L && analysis_result$missing_cells == 1L');
  await evaluate({ scope: 'compare', recipe: 'schema', tableNames: ['2026 sales', 'other table'] }, 'nrow(analysis_result) == 10L && sum(!analysis_result$present) == 2L && all(analysis_result[column == "id", matching_type])');
  await evaluate({ scope: 'compare', recipe: 'overlap', tableNames: ['2026 sales', 'other table'], columns: ['id'] }, 'analysis_result$shared_keys == 2L && analysis_result$left_only == 2L && analysis_result$right_only == 1L');
  await evaluate({ scope: 'compare', recipe: 'overlap', tableNames: ['2026 sales', 'other table'], columns: ['id'], includeMissingKeys: true }, 'analysis_result$shared_keys == 3L && analysis_result$left_only == 2L && analysis_result$right_only == 1L');
  for (const recipe of ANALYSIS_RECIPES.filter(item => !item.compare)) {
    await evaluate({ tableNames: ['empty'], recipe: recipe.id });
    await evaluate({ tableNames: ['no_columns'], recipe: recipe.id });
  }
  await evaluate({ tableNames: ['all_missing'] }, 'all(is.na(analysis_result$mean)) && all(analysis_result$observed == 0L)');
  await evaluate({ tableNames: ['text'], recipe: 'correlation' }, 'grepl("two numeric columns", analysis_result$message)');
  for (const chart of ANALYSIS_CHARTS.filter(item => item.id !== 'none')) {
    const compare = ['table-size', 'overlap'].includes(chart.id);
    const recipe = chart.id === 'table-size' ? 'overview' : chart.id === 'overlap' ? 'overlap' : chart.id === 'correlation' ? 'correlation' : chart.id === 'missingness' ? 'missingness' : 'profile';
    await evaluate({
      scope: compare ? 'compare' : 'table',
      tableNames: compare ? ['2026 sales', 'other table'] : ['2026 sales'],
      columns: chart.id === 'overlap' ? ['id'] : [], recipe, chart: chart.id,
    });
    if (!compare) {
      await evaluate({ tableNames: ['empty'], recipe, chart: chart.id });
      await evaluate({ tableNames: ['text'], recipe, chart: chart.id });
      await evaluate({ tableNames: ['all_missing'], recipe, chart: chart.id });
    }
  }
  // Exercise generated references with embedded quotes and backticks using real R parsing.
  await evaluate({ scope: 'column', tableNames: ['a`b'], columns: ['gross net'],
    setupCode: 'library(data.table)\n`a\\`b` <- data.table(`gross net` = 1:3)' }, 'analysis_result$column == "gross net" && analysis_result$mean == 2');
  await webR.evalRVoid('grDevices::dev.off()');
  console.log(`PASS: ${scenarios} actual R analysis scenarios, including all eight chart types, full-table counts, empty and nonnumeric inputs, list-column overview, schema/key comparisons and quoted names.`);
} finally { await webR.close(); }
