/**
 * Ad hoc exploration of complete R tables. Generated scripts use ordinary R,
 * data.table and base graphics; no private Tablecraft objects are required.
 *
 * References:
 * https://stat.ethz.ch/R-manual/R-devel/library/stats/html/quantile.html
 * https://stat.ethz.ch/R-manual/R-devel/library/stats/html/cor.html
 * https://rdatatable.gitlab.io/data.table/reference/setops.html
 * https://docs.r-wasm.org/webr/latest/examples.html
 */
import { rName, rString } from './catalog.js';
import { formatRCode } from './r-syntax.js';

export const ANALYSIS_RECIPES = Object.freeze([
  { id: 'profile', label: 'Column profiles', description: 'Counts, distinct values, missingness, location, spread, quantiles and modes.', documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/stats/html/quantile.html' },
  { id: 'frequency', label: 'Value frequencies', description: 'Counts and percentages for every observed value, including missing values.', documentation: 'https://rdatatable.gitlab.io/data.table/reference/data.table.html' },
  { id: 'missingness', label: 'Missing values', description: 'Missing, nonmissing and complete-row counts for the selected columns.', documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/base/html/NA.html' },
  { id: 'correlation', label: 'Pairwise correlations', description: 'Pearson and Spearman correlations with the complete, finite pair count.', documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/stats/html/cor.html' },
  { id: 'overview', label: 'Table overview', description: 'Dimensions, missing cells, duplicate rows, complete rows and memory size.', documentation: 'https://rdatatable.gitlab.io/data.table/reference/duplicated.html' },
  { id: 'schema', label: 'Compare schemas', description: 'Column presence and R classes across the selected tables.', compare: true, documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/base/html/class.html' },
  { id: 'overlap', label: 'Compare key overlap', description: 'Distinct matching keys, left-only and right-only keys, duplicates and overlap ratios.', compare: true, documentation: 'https://rdatatable.gitlab.io/data.table/reference/setops.html' },
]);

export const ANALYSIS_CHARTS = Object.freeze([
  { id: 'none', label: 'No chart' },
  { id: 'histogram', label: 'Histograms', recipes: ['profile'], documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/hist.html' },
  { id: 'bar', label: 'Value frequency bars', recipes: ['profile', 'frequency'], documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/barplot.html' },
  { id: 'boxplot', label: 'Box plots', recipes: ['profile'], documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/boxplot.html' },
  { id: 'scatter', label: 'Scatter plots', recipes: ['profile', 'correlation'], documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/plot.default.html' },
  { id: 'correlation', label: 'Correlation heatmaps', recipes: ['correlation'], documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/image.html' },
  { id: 'missingness', label: 'Missing-value bars', recipes: ['profile', 'missingness', 'overview'], documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/barplot.html' },
  { id: 'table-size', label: 'Table-size comparison', recipes: ['overview', 'schema'], documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/barplot.html' },
  { id: 'overlap', label: 'Key-overlap comparison', recipes: ['overlap'], documentation: 'https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/barplot.html' },
]);

const SCOPES = [
  ['column', 'Single column'], ['columns', 'Selected columns'],
  ['table', 'Whole table'], ['compare', 'Compare tables'],
];
const uniqueNames = values => [...new Set((Array.isArray(values) ? values : [])
  .filter(value => value != null && String(value).length).map(String))];
const boundedInteger = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
const rVector = (values, indentation = '  ') => values.length
  ? `c(\n${values.map(value => `${indentation}  ${rString(value)}`).join(',\n')}\n${indentation})`
  : 'character(0)';
const indentR = (code, spaces = 2) => String(code).split('\n').map(line => line ? ' '.repeat(spaces) + line : '').join('\n');

export function normaliseAnalysisConfig(config = {}) {
  const scope = SCOPES.some(([id]) => id === config.scope) ? config.scope : 'table';
  return {
    scope,
    tableNames: uniqueNames(config.tableNames || (config.tableName != null ? [config.tableName] : [])),
    columns: uniqueNames(config.columns),
    recipe: ANALYSIS_RECIPES.some(item => item.id === config.recipe) ? config.recipe : 'profile',
    chart: ANALYSIS_CHARTS.some(item => item.id === config.chart) ? config.chart : 'none',
    topN: boundedInteger(config.topN, 20, 1, 100),
    scatterLimit: boundedInteger(config.scatterLimit, 5000, 100, 20000),
    maxPlots: boundedInteger(config.maxPlots, 8, 1, 16),
    includeMissingKeys: config.includeMissingKeys === true,
    setupCode: String(config.setupCode || '').trim(),
  };
}

export function validateAnalysisConfig(input = {}) {
  const config = normaliseAnalysisConfig(input), errors = [];
  if (!config.tableNames.length) errors.push('Choose at least one table.');
  if (config.scope === 'compare' && config.tableNames.length < 2) errors.push('Choose at least two tables to compare.');
  if (config.scope !== 'compare' && config.tableNames.length > 1) errors.push('Use Compare tables to analyse several tables together.');
  if (['column', 'columns'].includes(config.scope) && !config.columns.length) errors.push('Choose at least one column.');
  if (config.scope === 'column' && config.columns.length > 1) errors.push('Single column accepts exactly one column.');
  if (ANALYSIS_RECIPES.find(item => item.id === config.recipe)?.compare && config.tableNames.length < 2) errors.push('This analysis needs at least two tables.');
  if (config.recipe === 'overlap' && !config.columns.length) errors.push('Choose one or more shared key columns.');
  if (config.recipe === 'correlation' && config.columns.length === 1) errors.push('Correlations need at least two numeric columns.');
  if (config.chart === 'scatter' && config.columns.length === 1) errors.push('A scatter plot needs at least two numeric columns.');
  const chart = ANALYSIS_CHARTS.find(item => item.id === config.chart);
  if (chart?.recipes && !chart.recipes.includes(config.recipe)) errors.push('Choose a chart that matches the analysis.');
  if ([...config.tableNames, ...config.columns].some(name => name.includes('\u0000'))) errors.push('R names cannot contain a null character.');
  return [...new Set(errors)];
}

/** Complete source/import definitions suitable for running in a fresh R session. */
export function buildAnalysisSetup(tables = [], selectedNames = []) {
  const names = uniqueNames(selectedNames), blocks = ['library(data.table)'];
  names.forEach(name => {
    const table = tables.find(item => item.tableName === name || (!item.tableName && item.name === name));
    if (!table) return;
    const definition = String(table.tablesCode || table.importCode || '').trim();
    if (definition) blocks.push(definition);
    else {
      const source = String(table.readCode || table.sourceCode || '').trim();
      if (source && source !== name && source !== rName(name)) blocks.push(`${rName(name)} <- ${source}`);
    }
  });
  if (blocks.some(block => block.includes('%>%'))) blocks.splice(1, 0, 'library(magrittr)');
  return [...new Set(blocks)].join('\n\n');
}

const R_HELPERS = `# Character/factor/date values stay exact; integer64 is not rounded to double.
missing_value <- function(x) {
  if (is.list(x)) {
    vapply(x, function(value) {
      !length(value) || (length(value) == 1L && is.atomic(value) &&
        is.na(value))
    }, logical(1))
  } else {
    is.na(x)
  }
}
value_labels <- function(x) {
  if (is.list(x)) {
    vapply(x, function(value) {
      paste(capture.output(dput(value)), collapse = " ")
    }, character(1))
  } else {
    as.character(x)
  }
}
is_measure <- function(x) {
  is.numeric(x) && !is.complex(x) &&
    !inherits(x, c("Date", "POSIXt", "difftime", "integer64"))
}
column_names <- function(table, requested) {
  if (!length(requested)) return(names(table))
  absent <- setdiff(requested, names(table))
  if (length(absent)) {
    stop(paste("Columns not found:", paste(absent, collapse = ", ")),
      call. = FALSE)
  }
  requested
}
percent <- function(numerator, denominator) {
  if (denominator > 0L) 100 * numerator / denominator else NA_real_
}
bind_rows <- function(rows) {
  if (length(rows)) data.table::rbindlist(rows, use.names = TRUE, fill = TRUE)
  else data.table::data.table(message = "No columns are available.")
}
frequency <- function(x) {
  missing <- missing_value(x)
  data.table::data.table(
    value = value_labels(x), is_missing = missing
  )[, .(count = .N), by = .(value, is_missing)][
    order(-count, is_missing, value)
  ][, percentage := if (length(x)) 100 * count / length(x) else NA_real_][]
}
profile_column <- function(x, table_name, column_name) {
  missing <- missing_value(x)
  observed <- x[!missing]
  numeric_column <- is_measure(x)
  finite <- if (numeric_column) x[is.finite(x)] else numeric(0)
  frequencies <- frequency(x)[is_missing == FALSE]
  quantiles <- if (length(finite)) {
    as.numeric(stats::quantile(finite,
      probs = c(0, 0.05, 0.25, 0.5, 0.75, 0.95, 1), names = FALSE,
      type = 7))
  } else rep(NA_real_, 7L)
  endpoints <- if (length(observed) &&
    (inherits(x, c("Date", "POSIXt", "integer64")) || is.character(x))) {
    c(as.character(min(observed)), as.character(max(observed)))
  } else c(NA_character_, NA_character_)
  note <- if (inherits(x, "integer64")) {
    "Exact integer64 counts/range; floating-point statistics omitted."
  } else if (is.list(x)) {
    "List missingness means NULL/empty or one atomic NA; modes use dput labels."
  } else if (numeric_column) {
    "Numeric statistics use finite values; quantiles use type 7."
  } else ""
  data.table::data.table(
    table = table_name, column = column_name,
    type = paste(class(x), collapse = "/"), rows = length(x),
    observed = sum(!missing), missing = sum(missing),
    missing_percent = percent(sum(missing), length(x)),
    distinct = length(unique(observed)),
    empty_strings = if (is.character(x)) sum(x == "", na.rm = TRUE) else NA_integer_,
    finite = if (numeric_column) length(finite) else NA_integer_,
    non_finite = if (numeric_column) sum(!is.finite(x) & !is.na(x)) else NA_integer_,
    zeros = if (numeric_column) sum(finite == 0) else NA_integer_,
    negative = if (numeric_column) sum(finite < 0) else NA_integer_,
    mean = if (length(finite)) mean(finite) else NA_real_,
    sd = if (length(finite) > 1L) stats::sd(finite) else NA_real_,
    variance = if (length(finite) > 1L) stats::var(finite) else NA_real_,
    minimum = quantiles[1L], p05 = quantiles[2L], p25 = quantiles[3L],
    median = quantiles[4L], p75 = quantiles[5L], p95 = quantiles[6L],
    maximum = quantiles[7L],
    iqr = if (length(finite)) stats::IQR(finite, type = 7) else NA_real_,
    mad = if (length(finite)) stats::mad(finite) else NA_real_,
    sum = if (numeric_column) sum(finite) else NA_real_,
    mode = if (nrow(frequencies)) frequencies$value[1L] else NA_character_,
    mode_count = if (nrow(frequencies)) frequencies$count[1L] else 0L,
    mode_percent = if (nrow(frequencies)) {
      percent(frequencies$count[1L], length(observed))
    } else NA_real_,
    minimum_value = endpoints[1L], maximum_value = endpoints[2L],
    statistics_note = note
  )
}
column_jobs <- function(tables, requested) {
  unlist(lapply(names(tables), function(table_name) {
    table <- tables[[table_name]]
    lapply(column_names(table, requested), function(column_name) {
      list(table = table_name, column = column_name, value = table[[column_name]])
    })
  }), recursive = FALSE)
}
correlation_rows <- function(tables, requested) {
  bind_rows(lapply(names(tables), function(table_name) {
    table <- tables[[table_name]]
    selected <- column_names(table, requested)
    numeric_names <- selected[vapply(table[, selected, with = FALSE],
      is_measure, logical(1))]
    if (length(numeric_names) < 2L) {
      return(data.table::data.table(table = table_name,
        message = "At least two numeric columns are needed."))
    }
    pairs <- utils::combn(numeric_names, 2L, simplify = FALSE)
    bind_rows(lapply(pairs, function(pair) {
      x <- table[[pair[1L]]]
      y <- table[[pair[2L]]]
      complete <- is.finite(x) & is.finite(y)
      n <- sum(complete)
      usable <- n > 1L && stats::sd(x[complete]) > 0 &&
        stats::sd(y[complete]) > 0
      data.table::data.table(
        table = table_name, column_x = pair[1L], column_y = pair[2L],
        complete_pairs = n, excluded_pairs = length(x) - n,
        pearson = if (usable) stats::cor(x[complete], y[complete]) else NA_real_,
        spearman = if (usable) {
          stats::cor(x[complete], y[complete], method = "spearman")
        } else NA_real_,
        note = if (usable) "" else "Need two finite pairs and nonzero variation."
      )
    }))
  }))
}`;

const RECIPES_R = {
  profile: `output <- bind_rows(lapply(jobs, function(job) {
  profile_column(job$value, job$table, job$column)
}))`,
  frequency: `output <- bind_rows(lapply(jobs, function(job) {
  values <- frequency(job$value)
  values[, table := job$table][, column := job$column]
  data.table::setcolorder(values,
    c("table", "column", "value", "is_missing", "count", "percentage"))
  values
}))`,
  missingness: `output <- bind_rows(lapply(names(tables), function(table_name) {
  table <- tables[[table_name]]
  selected <- column_names(table, requested)
  complete <- Reduce(\`&\`, lapply(selected, function(column_name) {
    !missing_value(table[[column_name]])
  }), init = rep(TRUE, nrow(table)))
  bind_rows(lapply(selected, function(column_name) {
    x <- table[[column_name]]
    missing <- sum(missing_value(x))
    data.table::data.table(
      table = table_name, column = column_name, rows = nrow(table),
      missing = missing, observed = nrow(table) - missing,
      missing_percent = percent(missing, nrow(table)),
      complete_rows_selected = sum(complete)
    )
  }))
}))`,
  correlation: 'output <- correlation_rows(tables, requested)',
  overview: `output <- bind_rows(lapply(names(tables), function(table_name) {
  table <- tables[[table_name]]
  missing <- lapply(table, missing_value)
  complete <- Reduce(\`&\`, lapply(missing, \`!\`),
    init = rep(TRUE, nrow(table)))
  cells <- as.double(nrow(table)) * ncol(table)
  missing_cells <- sum(vapply(missing, sum, numeric(1)))
  distinct_rows <- if (any(vapply(table, is.list, logical(1)))) {
    sum(!duplicated(as.data.frame(table)))
  } else if (ncol(table)) nrow(unique(table)) else nrow(table)
  data.table::data.table(
    table = table_name, rows = nrow(table), columns = ncol(table),
    cells = cells, missing_cells = missing_cells,
    missing_percent = percent(missing_cells, cells),
    complete_rows = sum(complete), distinct_rows = distinct_rows,
    duplicate_rows = nrow(table) - distinct_rows,
    numeric_columns = sum(vapply(table, is_measure, logical(1))),
    memory_bytes = as.numeric(utils::object.size(table))
  )
}))`,
  schema: `all_columns <- if (length(requested)) requested else {
  unique(unlist(lapply(tables, names), use.names = FALSE))
}
output <- bind_rows(lapply(all_columns, function(column_name) {
  classes <- vapply(tables, function(table) {
    if (column_name %in% names(table)) {
      paste(class(table[[column_name]]), collapse = "/")
    } else NA_character_
  }, character(1))
  data.table::data.table(
    column = column_name, table = names(tables),
    present = !is.na(classes), type = unname(classes),
    in_every_table = all(!is.na(classes)),
    matching_type = all(!is.na(classes)) && length(unique(classes)) == 1L
  )
}))`,
  overlap: `keys <- lapply(tables, function(table) {
  selected <- column_names(table, requested)
  values <- data.table::copy(table[, selected, with = FALSE])
  if (any(vapply(values, is.list, logical(1)))) {
    stop("Key comparison does not support list columns.", call. = FALSE)
  }
  if (!include_missing_keys) {
    complete <- Reduce(\`&\`, lapply(values, function(x) !missing_value(x)),
      init = rep(TRUE, nrow(values)))
    values <- values[complete]
  }
  list(rows = nrow(values), unique = unique(values))
})
pairs <- utils::combn(names(tables), 2L, simplify = FALSE)
output <- bind_rows(lapply(pairs, function(pair) {
  left <- keys[[pair[1L]]]
  right <- keys[[pair[2L]]]
  shared <- tryCatch(
    nrow(data.table::fintersect(left$unique, right$unique)),
    error = function(error) {
      stop(paste("Key columns must have compatible types:",
        conditionMessage(error)), call. = FALSE)
    }
  )
  left_n <- nrow(left$unique)
  right_n <- nrow(right$unique)
  union_n <- left_n + right_n - shared
  data.table::data.table(
    table_left = pair[1L], table_right = pair[2L],
    rows_left = left$rows, rows_right = right$rows,
    distinct_left = left_n, distinct_right = right_n,
    duplicate_keys_left = left$rows - left_n,
    duplicate_keys_right = right$rows - right_n,
    shared_keys = shared, left_only = left_n - shared,
    right_only = right_n - shared,
    left_matched_percent = percent(shared, left_n),
    right_matched_percent = percent(shared, right_n),
    jaccard_percent = percent(shared, union_n),
    missing_keys_included = include_missing_keys
  )
}))`,
};

const R_PLOT_HELPERS = `# Aggregates always use full data. Only scatter points are sampled.
# Long labels are shortened only for plot rendering, never in output tables.
short_label <- function(x, width = 44L) {
  ifelse(nchar(x) > width, paste0(substr(x, 1L, width - 1L), "…"), x)
}
empty_plot <- function(title, message) {
  graphics::plot.new()
  graphics::title(main = title)
  graphics::text(0.5, 0.5, message, cex = 0.9, col = "#53616e")
}
plot_bar <- function(values, labels, title, axis_label) {
  if (!length(values) || !any(is.finite(values))) {
    empty_plot(title, "No values available to plot.")
  } else {
    previous <- graphics::par(mar = c(5, 10, 4, 2) + 0.1)
    on.exit(graphics::par(previous), add = TRUE)
    graphics::barplot(rev(values), names.arg = rev(short_label(labels)),
      horiz = TRUE, las = 1, col = "#137c6d", border = NA,
      main = title, xlab = axis_label, cex.names = 0.78)
  }
}
limited <- function(items, limit, what) {
  if (length(items) > limit) {
    warning(paste("Showing the first", limit, what,
      "in charts; statistics include all selected data."), call. = FALSE)
  }
  head(items, limit)
}`;

const CHARTS_R = {
  none: '',
  histogram: `numeric_jobs <- Filter(function(job) is_measure(job$value), jobs)
if (!length(numeric_jobs)) {
  empty_plot("Histograms", "No numeric columns selected.")
}
invisible(lapply(limited(numeric_jobs, max_plots, "numeric columns"),
  function(job) {
    values <- job$value[is.finite(job$value)]
    title <- paste(job$table, job$column, sep = " · ")
    if (!length(values)) return(empty_plot(title, "No finite numeric values."))
    graphics::hist(values, breaks = "FD", col = "#137c6d", border = "white",
      main = title, xlab = job$column)
  }
))`,
  bar: `invisible(lapply(limited(jobs, max_plots, "columns"), function(job) {
  values <- head(frequency(job$value), top_n)
  labels <- ifelse(values$is_missing, "(missing)", values$value)
  title <- paste(job$table, job$column, sep = " · ")
  plot_bar(values$count, labels, title,
    paste("Count; most frequent", top_n, "values; all rows counted"))
}))`,
  boxplot: `numeric_jobs <- Filter(function(job) is_measure(job$value), jobs)
numeric_jobs <- limited(numeric_jobs, min(30L, top_n), "numeric columns")
values <- lapply(numeric_jobs, function(job) job$value[is.finite(job$value)])
nonempty <- lengths(values) > 0L
if (!any(nonempty)) {
  empty_plot("Box plots", "No finite numeric values.")
} else {
  labels <- vapply(numeric_jobs, function(job) {
    paste(job$table, job$column, sep = " · ")
  }, character(1))
  previous <- graphics::par(mar = c(5, 10, 4, 2) + 0.1)
  graphics::boxplot(values[nonempty], names = short_label(labels[nonempty]),
    horizontal = TRUE, las = 1, col = "#b9ded1", border = "#137c6d",
    outline = FALSE, main = "Distribution comparison", cex.axis = 0.8,
    xlab = "All finite values; individual outlier points hidden")
  graphics::par(previous)
}`,
  scatter: `invisible(lapply(limited(names(tables), max_plots, "tables"),
  function(table_name) {
    table <- tables[[table_name]]
    selected <- column_names(table, requested)
    numeric_names <- selected[vapply(table[, selected, with = FALSE],
      is_measure, logical(1))]
    if (length(numeric_names) < 2L) {
      return(empty_plot(table_name, "Select at least two numeric columns."))
    }
    pair <- numeric_names[1:2]
    x <- table[[pair[1L]]]
    y <- table[[pair[2L]]]
    complete <- which(is.finite(x) & is.finite(y))
    if (!length(complete)) {
      return(empty_plot(table_name, "No finite complete pairs."))
    }
    positions <- unique(as.integer(round(seq(1L, length(complete),
      length.out = min(length(complete), scatter_limit)))))
    show <- complete[positions]
    graphics::plot(x[show], y[show], pch = 16,
      col = grDevices::adjustcolor("#137c6d", alpha.f = 0.45),
      xlab = pair[1L], ylab = pair[2L], main = table_name,
      sub = paste(length(show), "of", length(complete),
        "finite pairs shown; evenly spaced by row"))
  }
))`,
  correlation: `invisible(lapply(limited(names(tables), max_plots, "tables"),
  function(table_name) {
    table <- tables[[table_name]]
    selected <- column_names(table, requested)
    numeric_names <- selected[vapply(table[, selected, with = FALSE],
      is_measure, logical(1))]
    numeric_names <- limited(numeric_names, 30L, "heatmap columns")
    if (length(numeric_names) < 2L) {
      return(empty_plot(table_name, "Select at least two numeric columns."))
    }
    matrix <- as.matrix(table[, numeric_names, with = FALSE])
    matrix[!is.finite(matrix)] <- NA_real_
    values <- if (nrow(matrix) > 1L) {
      suppressWarnings(stats::cor(matrix, use = "pairwise.complete.obs"))
    } else matrix(NA_real_, ncol(matrix), ncol(matrix))
    n <- length(numeric_names)
    previous <- graphics::par(mar = c(9, 9, 4, 2) + 0.1)
    graphics::image(seq_len(n), seq_len(n), values[, n:1, drop = FALSE],
      zlim = c(-1, 1), axes = FALSE, xlab = "", ylab = "",
      col = grDevices::colorRampPalette(c("#477da8", "#ffffff", "#137c6d"))(50L),
      main = paste(table_name, "Pearson correlations"))
    graphics::axis(1, at = seq_len(n), labels = short_label(numeric_names, 22L),
      las = 2, cex.axis = 0.72)
    graphics::axis(2, at = seq_len(n),
      labels = rev(short_label(numeric_names, 22L)), las = 2, cex.axis = 0.72)
    graphics::mtext("Blue = -1; white = 0; green = +1; empty = undefined",
      side = 3, line = 0.3, cex = 0.7)
    graphics::par(previous)
  }
))`,
  missingness: `missing_rows <- bind_rows(lapply(jobs, function(job) {
  data.table::data.table(
    label = paste(job$table, job$column, sep = " · "),
    missing_percent = percent(sum(missing_value(job$value)), length(job$value))
  )
}))
if ("missing_percent" %in% names(missing_rows)) {
  missing_rows <- head(missing_rows[order(-missing_percent)], top_n)
  plot_bar(missing_rows$missing_percent, missing_rows$label,
    "Missing values by column", "Missing values (%) across all rows")
} else empty_plot("Missing values", "No columns available.")`,
  'table-size': `sizes <- vapply(tables, nrow, integer(1))
show <- head(order(sizes, decreasing = TRUE), top_n)
plot_bar(sizes[show], names(sizes)[show], "Table sizes", "Rows")`,
  overlap: `show <- head(seq_len(nrow(output)), top_n)
values <- rbind(output$shared_keys[show], output$left_only[show],
  output$right_only[show])
labels <- paste(output$table_left[show], output$table_right[show], sep = " / ")
previous <- graphics::par(mar = c(5, 10, 4, 2) + 0.1)
graphics::barplot(values, names.arg = short_label(labels),
  horiz = TRUE, las = 1, col = c("#137c6d", "#477da8", "#ae722d"),
  border = NA, main = "Distinct key comparison", xlab = "Distinct keys",
  legend.text = c("Shared", "Left only", "Right only"),
  args.legend = list(x = "topright", bty = "n", cex = 0.75), cex.names = 0.78)
graphics::par(previous)`,
};

/** Generate reproducible code without evaluating any source text in JavaScript. */
export function buildAnalysisCode(input = {}) {
  const config = normaliseAnalysisConfig(input), errors = validateAnalysisConfig(config);
  if (errors.length) throw new Error(errors.join(' '));
  const recipe = ANALYSIS_RECIPES.find(item => item.id === config.recipe);
  const tableList = config.tableNames.map(name => `  ${rString(name)} = ${rName(name)}`).join(',\n');
  const setup = config.setupCode || 'library(data.table)';
  const rSetup = /(?:library\s*\(\s*["']?data\.table|require\s*\(\s*["']?data\.table)/.test(setup)
    ? setup : `library(data.table)\n\n${setup}`;
  const selectedColumns = config.recipe === 'overview' || config.recipe === 'schema' ||
    (config.scope === 'table' && config.recipe !== 'overlap') ? [] : config.columns;
  const body = [
    `tables <- list(\n${tableList}\n)`,
    `tables <- lapply(tables, function(table) {\n  if (!is.data.frame(table)) stop("Select data.tables or data.frames.", call. = FALSE)\n  data.table::as.data.table(table)\n})`,
    `requested <- ${rVector(selectedColumns, '')}`,
    `top_n <- ${config.topN}L\nscatter_limit <- ${config.scatterLimit}L\nmax_plots <- ${config.maxPlots}L\ninclude_missing_keys <- ${config.includeMissingKeys ? 'TRUE' : 'FALSE'}`,
    R_HELPERS,
    config.recipe === 'schema' ? 'jobs <- list()' : 'jobs <- column_jobs(tables, requested)',
    RECIPES_R[config.recipe],
    config.chart === 'none' ? '' : R_PLOT_HELPERS,
    CHARTS_R[config.chart],
    'output[]',
  ].filter(Boolean).join('\n\n');
  const script = `# Tablecraft: ${recipe.label}\n# Statistics use complete selected tables, not preview rows.\n# Copy uploaded files beside this script, or adjust the import paths.\n# The app renders at most 500 result rows; the R result remains complete.\n\n${rSetup}\n\nlocal({\n${indentR(body)}\n})\n`;
  return formatRCode(script, { width: 88, indent: 2 }).trimEnd() + '\n';
}

function createNode(document, tag, attributes = {}, text) {
  const node = document.createElement(tag);
  Object.entries(attributes).forEach(([key, value]) => {
    if (value == null) return;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key === 'value') node.value = String(value);
    else node.setAttribute(key, String(value));
  });
  if (text != null) node.textContent = String(text);
  return node;
}

function tableRegistry(raw) {
  return (Array.isArray(raw) ? raw : []).filter(table => table && (table.tableName || table.name))
    .map(table => ({ ...table, tableName: String(table.tableName || table.name),
      label: String(table.label || table.tableName || table.name),
      columns: (table.columns || []).map(column => typeof column === 'string'
        ? { name: column, type: '' } : column).filter(column => column && column.name != null)
        .map(column => ({ ...column, name: String(column.name) })),
    })).filter((table, index, all) => all.findIndex(item => item.tableName === table.tableName) === index);
}

/**
 * Initialise once. The host owns the table registry and source definitions.
 * runAnalysis must preserve the main pipeline's result and preview state.
 */
export function initAnalysis({ engine, getTables = () => [], getSetupCode,
  getCode, toast = () => {}, document: suppliedDocument, window: suppliedWindow } = {}) {
  const document = suppliedDocument || globalThis.document;
  if (!document) throw new Error('An HTML document is required for the analysis workbench.');
  if (!engine) throw new Error('An R engine is required for the analysis workbench.');
  const window = suppliedWindow || document.defaultView || globalThis;
  let registry = [], config = normaliseAnalysisConfig(), lastResult = null;
  let running = false, requestId = 0, previousFocus = null, currentCode = '', destroyed = false;
  const objectURLs = new Set();
  const dialog = createNode(document, 'dialog', {
    class: 'app-dialog analysis-dialog', 'aria-labelledby': 'analysis-title',
    'aria-describedby': 'analysis-description', id: 'analysis-dialog',
  });
  dialog.innerHTML = `
    <div class="dialog-heading">
      <div><span class="analysis-eyebrow">DATA EXPLORER</span>
        <h2 id="analysis-title">Explore your tables</h2>
        <p id="analysis-description">Summary statistics, charts and comparisons, with R code you can keep.</p>
      </div>
      <button type="button" class="btn btn-icon analysis-close" data-analysis-action="close" aria-label="Close data explorer">✕</button>
    </div>
    <div class="analysis-workspace">
      <form class="analysis-controls" aria-label="Analysis options">
        <label for="analysis-scope">Explore</label>
        <select id="analysis-scope" name="scope" class="form-select"></select>
        <div class="analysis-table-heading"><label for="analysis-tables">Tables</label><span id="analysis-selected-count" class="analysis-muted"></span></div>
        <input id="analysis-table-search" type="search" class="form-control" placeholder="Find a table…" aria-label="Find a table">
        <div id="analysis-tables" class="analysis-table-options" role="group" aria-label="Tables to analyse"></div>
        <div id="analysis-column-control">
          <label for="analysis-column-search">Columns <span class="analysis-muted" id="analysis-column-hint"></span></label>
          <input id="analysis-column-search" type="search" class="form-control" placeholder="Find a column…" aria-label="Find a column">
          <div class="analysis-column-actions"><button type="button" class="link-button" data-analysis-action="all-columns">Select all</button><button type="button" class="link-button" data-analysis-action="clear-columns">Clear</button></div>
          <div id="analysis-columns" class="analysis-column-options" role="group" aria-label="Columns to analyse"></div>
        </div>
        <label for="analysis-recipe">Summary</label>
        <select id="analysis-recipe" name="recipe" class="form-select"></select>
        <p id="analysis-recipe-help" class="analysis-field-help"></p>
        <label for="analysis-chart">Chart</label>
        <select id="analysis-chart" name="chart" class="form-select"></select>
        <div class="analysis-limits">
          <label for="analysis-top">Chart categories</label><input id="analysis-top" type="number" name="topN" min="1" max="100" step="1" value="20" class="form-control">
        </div>
        <label class="analysis-check" id="analysis-missing-option"><input type="checkbox" name="includeMissingKeys"> Include missing key values</label>
        <button class="btn btn-primary analysis-run" type="submit" data-analysis-action="run">Run analysis</button>
        <p class="analysis-field-help">Statistics use all rows. Charts show up to 8 panels and 20 categories by default. Scatter plots show at most 5,000 points, evenly spaced by row.</p>
      </form>
      <section class="analysis-main" aria-label="Analysis results">
        <div class="analysis-main-toolbar">
          <div class="analysis-tabs" role="tablist" aria-label="Explorer view">
            <button type="button" id="analysis-results-tab" class="tab-button active" role="tab" aria-selected="true" aria-controls="analysis-results" data-analysis-action="results">Results</button>
            <button type="button" id="analysis-code-tab" class="tab-button" role="tab" aria-selected="false" aria-controls="analysis-code-panel" data-analysis-action="code">R code</button>
          </div>
          <a id="analysis-docs" href="https://stat.ethz.ch/R-manual/R-devel/library/stats/html/quantile.html" target="_blank" rel="noopener noreferrer" class="link-button">R documentation ↗</a>
        </div>
        <p id="analysis-status" class="analysis-status" role="status" aria-live="polite">Choose your data and run an analysis.</p>
        <div id="analysis-results" class="analysis-panel" role="tabpanel" aria-labelledby="analysis-results-tab">
          <div class="analysis-empty"><h3>Get to know your data</h3><p>Explore one column, profile an entire table, or compare schemas and keys across tables.</p><p>Every result includes reproducible R code.</p></div>
        </div>
        <div id="analysis-code-panel" class="analysis-panel" role="tabpanel" aria-labelledby="analysis-code-tab" hidden>
          <div class="analysis-code-toolbar"><span>Portable R script</span><button type="button" class="btn btn-secondary btn-sm" data-analysis-action="copy">Copy R</button><button type="button" class="btn btn-secondary btn-sm" data-analysis-action="download">Download .R</button></div>
          <p class="analysis-field-help analysis-code-note">The imports below use your current source definitions. When running locally, put uploaded files beside this script or update their paths.</p>
          <textarea id="analysis-code" readonly spellcheck="false" aria-label="Generated analysis R code"></textarea>
        </div>
      </section>
    </div>
    <div class="dialog-footer analysis-footer"><span>Analysis results are separate from your pipeline preview.</span><button type="button" class="btn btn-secondary" data-analysis-action="close">Done</button></div>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector);
  const form = $('.analysis-controls');
  SCOPES.forEach(([value, label]) => $('#analysis-scope').append(createNode(document, 'option', { value }, label)));
  ANALYSIS_RECIPES.forEach(item => $('#analysis-recipe').append(createNode(document, 'option', { value: item.id }, item.label)));

  function selectedTables() { return registry.filter(table => config.tableNames.includes(table.tableName)); }
  function availableColumns() {
    const tables = selectedTables();
    if (!tables.length) return [];
    const all = tables[0].columns;
    return config.scope === 'compare' && tables.length > 1
      ? all.filter(column => tables.every(table => table.columns.some(item => item.name === column.name)))
      : all;
  }
  function setStatus(message, error = false) {
    $('#analysis-status').textContent = message;
    $('#analysis-status').classList.toggle('analysis-status-error', error);
  }
  function setTab(which) {
    ['results', 'code'].forEach(id => {
      const active = id === which;
      $(`#analysis-${id}-tab`).classList.toggle('active', active);
      $(`#analysis-${id}-tab`).setAttribute('aria-selected', String(active));
      $(`#analysis-${id}-tab`).tabIndex = active ? 0 : -1;
      $(`#analysis-${id === 'code' ? 'code-panel' : 'results'}`).hidden = !active;
    });
  }
  function renderTables() {
    const query = $('#analysis-table-search').value.toLocaleLowerCase();
    const list = $('#analysis-tables'); list.replaceChildren();
    const filtered = registry.filter(table => `${table.tableName} ${table.label}`.toLocaleLowerCase().includes(query));
    filtered.forEach(table => {
      const row = createNode(document, 'label', { class: 'analysis-option' });
      const input = createNode(document, 'input', {
        type: config.scope === 'compare' ? 'checkbox' : 'radio',
        name: 'tableName', value: table.tableName,
        checked: config.tableNames.includes(table.tableName),
      });
      const label = createNode(document, 'span', { class: 'analysis-option-label' });
      label.append(createNode(document, 'code', {}, table.tableName));
      label.append(createNode(document, 'small', {}, `${table.columns.length} columns${Number.isFinite(table.rows) ? ` · ${Number(table.rows).toLocaleString()} rows` : ''}`));
      row.append(input, label); list.append(row);
    });
    if (!filtered.length) list.append(createNode(document, 'p', { class: 'analysis-field-help' }, 'No matching tables.'));
    $('#analysis-selected-count').textContent = `${config.tableNames.length} selected`;
  }
  function renderColumns() {
    const options = availableColumns();
    const query = $('#analysis-column-search').value.toLocaleLowerCase();
    const visible = options.filter(column => `${column.name} ${column.type || ''}`.toLocaleLowerCase().includes(query));
    const list = $('#analysis-columns'); list.replaceChildren();
    visible.forEach(column => {
      const row = createNode(document, 'label', { class: 'analysis-option' });
      const input = createNode(document, 'input', {
        type: config.scope === 'column' ? 'radio' : 'checkbox', name: 'columnName',
        value: column.name, checked: config.columns.includes(String(column.name)),
      });
      const label = createNode(document, 'span', { class: 'analysis-option-label' });
      label.append(createNode(document, 'code', {}, column.name), createNode(document, 'small', {}, column.type || 'column'));
      row.append(input, label); list.append(row);
    });
    if (!visible.length) list.append(createNode(document, 'p', { class: 'analysis-field-help' }, config.scope === 'compare'
      ? 'No shared columns. Table overview and schema comparison are still available.' : 'No matching columns.'));
    const hide = config.scope === 'table' || ['overview', 'schema'].includes(config.recipe);
    $('#analysis-column-control').hidden = hide;
    $('.analysis-column-actions').hidden = config.scope === 'column';
    $('#analysis-column-hint').textContent = config.scope === 'compare'
      ? '(shared; leave empty for all)' : `(${config.columns.length} selected)`;
  }
  function renderRecipes() {
    for (const option of $('#analysis-recipe').options) {
      const recipe = ANALYSIS_RECIPES.find(item => item.id === option.value);
      option.disabled = recipe.compare && config.scope !== 'compare';
    }
    if (ANALYSIS_RECIPES.find(item => item.id === config.recipe)?.compare && config.scope !== 'compare') config.recipe = 'profile';
    $('#analysis-recipe').value = config.recipe;
    const recipe = ANALYSIS_RECIPES.find(item => item.id === config.recipe);
    $('#analysis-recipe-help').textContent = recipe.description;
    $('#analysis-docs').href = recipe.documentation;
    const charts = ANALYSIS_CHARTS.filter(item => !item.recipes || item.recipes.includes(config.recipe));
    if (!charts.some(item => item.id === config.chart)) config.chart = 'none';
    $('#analysis-chart').replaceChildren(...charts.map(item => createNode(document, 'option', { value: item.id }, item.label)));
    $('#analysis-chart').value = config.chart;
    $('#analysis-missing-option').hidden = config.recipe !== 'overlap';
  }
  function makeCode() {
    const names = config.tableNames;
    let setup = getSetupCode?.(names, { ...config });
    if (setup == null) setup = buildAnalysisSetup(registry, names);
    if (setup && typeof setup.then === 'function') throw new Error('getSetupCode must return a script synchronously.');
    return buildAnalysisCode({ ...config, setupCode: setup });
  }
  function refreshCode({ dirty = true } = {}) {
    const errors = validateAnalysisConfig(config);
    $('.analysis-run').disabled = running || Boolean(errors.length);
    try {
      currentCode = errors.length ? '' : makeCode();
      $('#analysis-code').value = currentCode || `# ${errors.join('\n# ')}`;
    } catch (error) {
      currentCode = ''; $('#analysis-code').value = `# ${error.message}`;
      setStatus(error.message, true); $('.analysis-run').disabled = true;
    }
    ['copy', 'download'].forEach(action => $(`[data-analysis-action="${action}"]`).disabled = !currentCode);
    if (dirty && lastResult) setStatus('Options changed. Run again to update the results.');
    else if (errors.length && !running) setStatus(errors.join(' '));
  }
  function renderOptions() {
    $('#analysis-scope').value = config.scope;
    renderTables(); renderRecipes(); renderColumns(); refreshCode();
  }
  function releaseImages() {
    objectURLs.forEach(url => window.URL.revokeObjectURL(url)); objectURLs.clear();
  }
  function showError(error, code) {
    const target = $('#analysis-results'); target.replaceChildren();
    const box = createNode(document, 'div', { class: 'analysis-error-box' });
    box.append(createNode(document, 'h3', {}, 'R could not complete this analysis'));
    box.append(createNode(document, 'pre', {}, error.message || String(error)));
    const prompt = `Explain this R error:\n${error.message || error}\n\nWhen running this R code:\n${code}`;
    const link = createNode(document, 'a', {
      href: `https://chat.mistral.ai/chat?q=${encodeURIComponent(prompt)}`,
      target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-secondary btn-sm',
    }, 'Explain error with Mistral ↗');
    const copy = createNode(document, 'button', {
      type: 'button', class: 'btn btn-secondary btn-sm',
      'data-analysis-action': 'copy-error',
    }, 'Copy error + code');
    copy.addEventListener('click', () => void copyText(prompt, 'Error and R code copied.'));
    const actions = createNode(document, 'div', { class: 'analysis-error-actions' });
    actions.append(link, copy);
    box.append(actions, createNode(document, 'p', { class: 'analysis-field-help' },
      'Opening this link sends the error and displayed R code to Mistral. For a long script, copy the error and code and paste them into a chat.'));
    target.append(box); setTab('results');
  }
  async function appendPlot(container, entry, index) {
    let data = entry?.data ?? entry?.image ?? entry?.bitmap ?? entry;
    const figure = createNode(document, 'figure', { class: 'analysis-plot' });
    let element;
    if (typeof data === 'string' || typeof entry?.url === 'string') {
      const source = typeof entry?.url === 'string' ? entry.url : data;
      if (!/^(blob:|data:image\/|https?:\/\/)/i.test(source)) return;
      element = createNode(document, 'img', { src: source, alt: `Analysis chart ${index + 1}`, loading: 'lazy' });
    } else if (data && typeof data.width === 'number' && typeof data.height === 'number') {
      element = createNode(document, 'canvas', {
        width: data.width, height: data.height, role: 'img',
        'aria-label': `Analysis chart ${index + 1}; its numeric statistics appear in the results table`,
      });
      try {
        const context = element.getContext('2d');
        if (data.data && typeof window.ImageData === 'function' && data instanceof window.ImageData) context.putImageData(data, 0, 0);
        else context.drawImage(data, 0, 0);
      } catch { return; }
    } else if (data && typeof data.arrayBuffer === 'function') {
      const url = window.URL.createObjectURL(data); objectURLs.add(url);
      element = createNode(document, 'img', { src: url, alt: `Analysis chart ${index + 1}` });
    } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      const url = window.URL.createObjectURL(new window.Blob([data], { type: 'image/png' })); objectURLs.add(url);
      element = createNode(document, 'img', { src: url, alt: `Analysis chart ${index + 1}` });
    }
    if (!element) return;
    figure.append(element, createNode(document, 'figcaption', {}, `Chart ${index + 1}`)); container.append(figure);
  }
  async function renderResult(result) {
    releaseImages();
    const target = $('#analysis-results'); target.replaceChildren();
    const warnings = [...new Set(result.warnings || [])];
    if (warnings.length) {
      const details = createNode(document, 'details', { class: 'analysis-warnings', open: '' });
      details.append(createNode(document, 'summary', {}, 'Analysis notes'));
      warnings.forEach(warning => details.append(createNode(document, 'p', {}, warning.message || warning)));
      target.append(details);
    }
    const plots = createNode(document, 'div', { class: 'analysis-plots' });
    target.append(plots);
    const images = result.images || result.plots || [];
    for (let i = 0; i < images.length; i += 1) await appendPlot(plots, images[i], i);
    if (config.chart !== 'none' && !plots.childElementCount) {
      const note = createNode(document, 'p', { class: 'analysis-render-note' }, 'No chart image was returned. The R code includes the chart and can be run in R locally.');
      target.append(note);
    }
    const columns = result.columns || [], rows = result.rows || [];
    if (columns.length) {
      const wrapper = createNode(document, 'div', { class: 'table-container analysis-table-container', tabindex: '0', 'aria-label': 'Summary table, horizontally scrollable' });
      const table = createNode(document, 'table', { class: 'data-table' });
      const caption = createNode(document, 'caption', {}, 'Analysis statistics');
      const head = createNode(document, 'thead'), tr = createNode(document, 'tr');
      columns.forEach(column => tr.append(createNode(document, 'th', { scope: 'col' }, column.name || column.key)));
      head.append(tr);
      const body = createNode(document, 'tbody');
      rows.forEach(row => {
        const line = createNode(document, 'tr');
        columns.forEach((column, index) => {
          const value = Array.isArray(row) ? row[index] : row[column.key ?? column.name];
          const cell = createNode(document, 'td', {
            class: value == null ? 'na' : typeof value === 'number' ? 'numeric' : '',
          }, value == null ? 'NA' : typeof value === 'number'
            ? Number.isInteger(value) ? value.toLocaleString('en-US') : Number(value.toPrecision(7)).toString()
            : typeof value === 'object' ? JSON.stringify(value) : String(value));
          if (value != null) cell.title = String(value);
          line.append(cell);
        });
        body.append(line);
      });
      table.append(caption, head, body); wrapper.append(table); target.append(wrapper);
    }
    if (!rows.length) target.append(createNode(document, 'p', { class: 'analysis-render-note' }, 'The analysis returned no rows. Empty source tables have no value frequencies.'));
    const total = result.totalRows ?? rows.length;
    const count = `${rows.length.toLocaleString()} of ${Number(total).toLocaleString()} summary rows displayed`;
    target.append(createNode(document, 'p', { class: 'analysis-render-note' }, `${count}. All selected source rows were analysed. Copy or download the R script to reproduce the complete output.`));
    if (result.truncatedCells || result.truncatedColumns) target.append(createNode(document, 'p', { class: 'analysis-render-note' }, 'Long result cells or excess columns were shortened for display. The R result and script preserve their contents.'));
    if (result.stdout?.length) {
      const details = createNode(document, 'details', { class: 'analysis-warnings' });
      details.append(createNode(document, 'summary', {}, 'R output'), createNode(document, 'pre', {}, result.stdout.join('\n')));
      target.append(details);
    }
  }
  async function run(event) {
    event?.preventDefault();
    if (running || destroyed) return;
    refreshCode({ dirty: false });
    if (!currentCode || validateAnalysisConfig(config).length) return;
    const code = currentCode, activeRequest = ++requestId;
    running = true; $('.analysis-run').disabled = true; $('.analysis-run').textContent = 'Running in R…';
    form.setAttribute('aria-busy', 'true');
    [...form.elements].forEach(element => { element.disabled = true; });
    setStatus('Computing on complete tables in your browser…'); setTab('results');
    try {
      if (typeof engine.runAnalysis !== 'function') throw new Error('This R engine does not support independent analyses. Reload the updated application.');
      const result = await engine.runAnalysis(code, { limit: 500, columnLimit: 100, captureGraphics: config.chart !== 'none' });
      if (destroyed || activeRequest !== requestId) return;
      lastResult = result; await renderResult(result);
      setStatus(`Analysis complete${Number.isFinite(result.elapsedMs) ? ` in ${(result.elapsedMs / 1000).toFixed(2)} s` : ''}. Statistics use all selected rows.`);
    } catch (error) {
      if (destroyed || activeRequest !== requestId) return;
      setStatus(error.message || String(error), true); showError(error, code);
    } finally {
      if (!destroyed && activeRequest === requestId) {
        running = false; form.removeAttribute('aria-busy');
        [...form.elements].forEach(element => { element.disabled = false; });
        $('.analysis-run').textContent = 'Run analysis'; renderRecipes(); refreshCode({ dirty: false });
      }
    }
  }
  async function copyText(text, message) {
    try {
      if (window.navigator.clipboard?.writeText) await window.navigator.clipboard.writeText(text);
      else {
        const focus = document.activeElement;
        const textarea = createNode(document, 'textarea', {
          class: 'analysis-copy-buffer', 'aria-label': 'Text to copy',
        });
        textarea.value = text; dialog.append(textarea);
        try {
          textarea.focus(); textarea.select();
          if (!document.execCommand?.('copy')) throw new Error('Clipboard is unavailable. Select the displayed code and copy it with Ctrl+C.');
        } finally { textarea.remove(); focus?.focus?.(); }
      }
      toast(message);
    } catch (error) { toast(error.message || 'Could not copy the text.', true); }
  }
  async function copyCode() {
    if (currentCode) await copyText(currentCode, 'Analysis R code copied.');
  }
  function downloadCode() {
    if (!currentCode) return;
    const url = window.URL.createObjectURL(new window.Blob([currentCode], { type: 'text/plain;charset=utf-8' }));
    const link = createNode(document, 'a', { href: url, download: `tablecraft-${config.recipe}.R` });
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 2000);
  }
  function close() {
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    previousFocus?.focus?.();
  }
  function onClick(event) {
    const action = event.target.closest('[data-analysis-action]')?.dataset.analysisAction;
    if (!action) return;
    if (action === 'close') close();
    else if (action === 'code' || action === 'results') setTab(action);
    else if (action === 'copy') void copyCode();
    else if (action === 'download') downloadCode();
    else if (action === 'all-columns' && !running) {
      config.columns = availableColumns().map(column => String(column.name)); renderColumns(); refreshCode();
    } else if (action === 'clear-columns' && !running) {
      config.columns = []; renderColumns(); refreshCode();
    }
  }
  function onChange(event) {
    const input = event.target;
    if (running) return;
    if (input.name === 'scope') {
      config.scope = input.value;
      if (config.scope !== 'compare') config.tableNames = config.tableNames.slice(0, 1);
      else if (config.tableNames.length < 2) {
        config.tableNames = [...new Set([...config.tableNames, ...registry.map(table => table.tableName)])].slice(0, 2);
      }
      if (config.scope === 'column') config.columns = config.columns.slice(0, 1);
      if (!config.columns.length && ['column', 'columns'].includes(config.scope)) config.columns = availableColumns().slice(0, 1).map(column => String(column.name));
    } else if (input.name === 'tableName') {
      config.tableNames = config.scope === 'compare'
        ? input.checked ? [...new Set([...config.tableNames, input.value])] : config.tableNames.filter(name => name !== input.value)
        : [input.value];
      const names = availableColumns().map(column => String(column.name));
      config.columns = config.columns.filter(name => names.includes(name));
      if (!config.columns.length && config.scope === 'column') config.columns = names.slice(0, 1);
    } else if (input.name === 'columnName') {
      config.columns = config.scope === 'column' ? [input.value]
        : input.checked ? [...new Set([...config.columns, input.value])] : config.columns.filter(name => name !== input.value);
    } else if (input.name === 'recipe') {
      config.recipe = input.value;
      if (config.recipe === 'overlap' && !config.columns.length) config.columns = availableColumns().slice(0, 1).map(column => String(column.name));
      config.chart = ({ frequency: 'bar', missingness: 'missingness', correlation: 'correlation', overview: 'table-size', overlap: 'overlap' })[config.recipe] || 'none';
    } else if (input.name === 'chart') config.chart = input.value;
    else if (input.name === 'topN') config.topN = boundedInteger(input.value, 20, 1, 100);
    else if (input.name === 'includeMissingKeys') config.includeMissingKeys = input.checked;
    renderOptions();
  }
  function onKeydown(event) {
    if (event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tab = event.key === 'Home' ? 'results' : event.key === 'End' ? 'code'
      : event.target.id === 'analysis-results-tab' ? 'code' : 'results';
    setTab(tab); $(`#analysis-${tab}-tab`).focus();
  }
  dialog.addEventListener('click', onClick);
  dialog.addEventListener('keydown', onKeydown);
  form.addEventListener('submit', run);
  form.addEventListener('change', onChange);
  $('#analysis-table-search').addEventListener('input', renderTables);
  $('#analysis-column-search').addEventListener('input', renderColumns);
  dialog.addEventListener('close', () => previousFocus?.focus?.());

  return {
    open(options = {}) {
      if (destroyed) return;
      if (running) {
        if (!dialog.open) dialog.showModal?.(); return;
      }
      registry = tableRegistry(getTables());
      const available = registry.map(table => table.tableName);
      const requestedNames = uniqueNames(options.tableNames || (options.tableName != null ? [options.tableName] : config.tableNames)).filter(name => available.includes(name));
      const scope = options.scope || (options.columns?.length ? options.columns.length === 1 ? 'column' : 'columns' : config.scope);
      const names = requestedNames.length ? requestedNames : available.slice(0, scope === 'compare' ? 2 : 1);
      config = normaliseAnalysisConfig({ ...config, ...options, scope,
        tableNames: scope === 'compare' ? names : names.slice(0, 1),
      });
      if (config.scope === 'compare' && config.tableNames.length < 2) config.tableNames = available.slice(0, 2);
      const columns = availableColumns().map(column => String(column.name));
      config.columns = config.columns.filter(name => columns.includes(name));
      if (['column', 'columns'].includes(config.scope) && !config.columns.length) config.columns = columns.slice(0, 1);
      $('#analysis-top').value = config.topN;
      $('[name="includeMissingKeys"]').checked = config.includeMissingKeys;
      $('#analysis-table-search').value = ''; $('#analysis-column-search').value = '';
      previousFocus = document.activeElement;
      renderOptions();
      if (!dialog.open) {
        if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      }
      $('#analysis-scope').focus();
      if (!registry.length) setStatus('Add an example table or upload a file to start.');
    },
    close,
    run: () => run(),
    getCode: () => currentCode,
    getConfig: () => ({ ...config, tableNames: [...config.tableNames], columns: [...config.columns] }),
    getResult: () => lastResult,
    destroy() {
      destroyed = true; requestId += 1; releaseImages(); dialog.remove();
    },
    element: dialog,
  };
}
