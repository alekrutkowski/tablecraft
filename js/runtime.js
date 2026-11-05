import { rName } from "./catalog.js";
import { R_RUNTIME_EXTENSIONS } from "./runtime-r.js";

/**
 * A small, serial webR adapter. R executes in webR's worker, never on the UI thread.
 * PostMessage deliberately avoids the isolation headers unavailable on GitHub Pages.
 * Uploaded File objects and all their bytes stay in this browser session.
 */
export const WEBR_VERSION = "0.6.0";
export const WEBR_BASE_URL = `https://webr.r-wasm.org/v${WEBR_VERSION}/`;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const CORE_PACKAGES = ["data.table", "magrittr", "jsonlite", "bit64"];
const WORKING_DIRECTORY = "/home/web_user";
const RESERVED_TABLE_NAMES = new Set([
  "sales", "iris", "mtcars", "airquality", "plant_growth", "tooth_growth",
  "chickwts", "co2", "us_arrests", "sales_long", "products", "customers",
  "source_dt", "result"
]);
const reservedTableName = (name) => RESERVED_TABLE_NAMES.has(name) || /^\.tc/.test(name) || name === "..." || /^\.\.[0-9]+$/.test(name);

/** Preserve a filename's spelling while keeping imported objects distinct from app objects. */
export function tableNameFromFile(fileName, existingNames = []) {
  const base = String(fileName || "upload.csv").split(/[\\/]/).at(-1);
  let stem = base.replace(/\.[^.]+$/, "").replace(/[\u0000-\u001f\u007f]/g, "_") || "upload";
  // Internal prefixes need a different base, since a suffix alone remains reserved.
  if (/^\.tc/.test(stem)) stem = `table_${stem}`;
  const occupied = new Set(existingNames);
  let name = stem;
  let suffix = 2;
  while (reservedTableName(name) || occupied.has(name)) name = `${stem}_${suffix++}`;
  return name;
}

/** Plain text for browser help, including older cached terminal-formatted pages. */
export function cleanHelpText(value) {
  const text = String(value ?? "")
    // OSC links and terminal control strings contain metadata, not visible text.
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, "")
    .replace(/(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[ -/]*[0-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  return text.split("\n").map((line) => {
    const cells = [];
    let cursor = 0;
    // Iterate Unicode code points so a backspace cannot split a surrogate pair.
    for (const character of line) {
      if (character === "\b") {
        cursor = Math.max(0, cursor - 1);
        continue;
      }
      // Underlining can be either "_\bX" or "X\b_"; bold uses "X\bX".
      if (character !== "_" || cells[cursor] == null || cells[cursor] === " ") {
        cells[cursor] = character;
      }
      cursor += 1;
    }
    return cells.join("");
  }).join("\n");
}


const rString = (value) => JSON.stringify(String(value)).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
const rBoolean = (value) => value ? "TRUE" : "FALSE";
const rStrings = (values) => values.length ? `c(${values.map(rString).join(", ")})` : "character(0)";
const integer = (value, fallback, minimum = 0, maximum = 1e9) => {
  const parsed = value === "" || value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Use a whole number between ${minimum} and ${maximum}.`);
  }
  return parsed;
};

export class RExecutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RExecutionError";
    Object.assign(this, details);
    this.diagnostics ??= [{ severity: "error", message }];
    this.line ??= this.diagnostics[0]?.line ?? undefined;
    this.column ??= this.diagnostics[0]?.column ?? undefined;
  }
}

function cancelledError() {
  return new RExecutionError("The R session was restarted. Run the pipeline again when R is ready.", { code: "SESSION_RESET", cancelled: true });
}

function listOption(value, fallback = []) {
  if (value == null) return [...fallback];
  return Array.isArray(value) ? value.map(String) : String(value).split(",").map((item) => item.trim());
}

/** Normalize GUI controls without evaluating any user-supplied R expression. */
export function normaliseImportOptions(fileName, options = {}) {
  const extension = String(fileName).split(".").at(-1).toLowerCase();
  let format = String(options.format || "auto").toLowerCase();
  if (format === "auto") format = ["xls", "xlsx"].includes(extension) ? "excel" : extension === "tsv" || extension === "tab" ? "tsv" : extension === "fwf" ? "fwf" : "csv";
  if (["xls", "xlsx"].includes(format)) format = "excel";
  if (["fixed", "fixed-width", "fixedwidth"].includes(format)) format = "fwf";
  if (format === "delimited") format = "csv";
  if (!["csv", "tsv", "fwf", "excel"].includes(format)) throw new Error("Choose a CSV, TSV, fixed-width, or Excel format.");

  let header = options.header;
  if (header === "true" || header === "yes") header = true;
  if (header === "false" || header === "no") header = false;
  if (header == null || header === "auto") header = format === "fwf" ? false : format === "excel" ? true : "auto";
  if (![true, false, "auto"].includes(header)) throw new Error("Header must be automatic, on, or off.");

  let delimiter = options.delimiter ?? options.sep ?? (format === "tsv" ? "\t" : "auto");
  if (delimiter === "tab" || delimiter === "\\t") delimiter = "\t";
  if (delimiter !== "auto" && String(delimiter).length !== 1) throw new Error("The delimiter should be one character, such as a comma, tab, or semicolon.");
  const decimal = options.decimal ?? options.dec ?? "auto";
  if (!["auto", ".", ","].includes(decimal)) throw new Error("Use a decimal point, decimal comma, or automatic decimal detection.");
  const encoding = options.encoding || "unknown";
  if (!["unknown", "UTF-8", "Latin-1"].includes(encoding)) throw new Error("Choose UTF-8, Latin-1, or automatic encoding.");
  const names = listOption(options.names ?? options.colNames ?? options.columnNames).filter((name) => name !== "");
  const naStrings = listOption(options.naStrings ?? options.na, format === "excel" ? [""] : ["NA"]);
  const skip = integer(options.skip, 0);
  let widths = [];
  if (format === "fwf") {
    const raw = options.widths;
    widths = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,;]+/).filter(Boolean)).map(Number);
    if (!widths.length || widths.length > 1000 || widths.some((width) => !Number.isInteger(width) || Math.abs(width) > 1e6) || !widths.some((width) => width > 0)) {
      throw new Error("Enter fixed widths as whole numbers, for example 6, 12, 3, 8. Negative widths skip a field.");
    }
    if (names.length && names.length !== widths.filter((width) => width >= 0).length) throw new Error("Provide one column name for each non-negative width.");
  }
  let sheet = options.sheet ?? 1;
  if (typeof sheet === "number") sheet = integer(sheet, 1, 1);
  else sheet = String(sheet).trim() || 1;
  return { format, header, delimiter, decimal, encoding, names, naStrings, skip, widths, sheet, range: String(options.range || "").trim() };
}

/** Portable R source for the exact import chosen in the visual wizard. */
export function buildImportCode(fileName, options = {}) {
  const p = normaliseImportOptions(fileName, options);
  const path = rString(fileName);
  if (p.format === "excel") {
    const args = [`path = ${path}`, `sheet = ${typeof p.sheet === "number" ? p.sheet : rString(p.sheet)}`, `col_names = ${p.names.length ? rStrings(p.names) : rBoolean(p.header !== false)}`];
    if (p.range) args.push(`range = ${rString(p.range)}`);
    if (p.skip) args.push(`skip = ${p.skip}L`);
    args.push(`na = ${rStrings(p.naStrings)}`, "progress = FALSE", '.name_repair = "unique"');
    return `as.data.table(readxl::read_excel(${args.join(", ")}))`;
  }
  if (p.format === "fwf") {
    const widthCode = `c(${p.widths.map((width) => `${width}L`).join(", ")})`;
    const encoding = p.encoding === "unknown" ? "" : p.encoding === "Latin-1" ? "latin1" : "UTF-8";
    const common = [`file = ${path}`, `widths = ${widthCode}`, "header = FALSE", "strip.white = TRUE", 'comment.char = ""', "stringsAsFactors = FALSE", "check.names = FALSE", `fileEncoding = ${rString(encoding)}`];
    if (p.header === true && !p.names.length) {
      return `local({\n  .header <- utils::read.fwf(${common.join(", ")}, skip = ${p.skip}L, n = 1L, colClasses = "character", na.strings = NULL)\n  .names <- vapply(.header, function(x) as.character(x[1L]), character(1L))\n  .empty <- is.na(.names) | !nzchar(.names)\n  .names[.empty] <- paste0("V", which(.empty))\n  as.data.table(utils::read.fwf(${common.join(", ")}, skip = ${p.skip + 1}L, col.names = make.unique(.names), na.strings = ${rStrings(p.naStrings)}))\n})`;
    }
    const args = [...common, `skip = ${p.skip + (p.header === true ? 1 : 0)}L`, `na.strings = ${rStrings(p.naStrings)}`];
    if (p.names.length) args.push(`col.names = ${rStrings(p.names)}`);
    return `as.data.table(utils::read.fwf(${args.join(", ")}))`;
  }
  const args = [`file = ${path}`, `sep = ${rString(p.delimiter)}`, `header = ${p.header === "auto" ? '"auto"' : rBoolean(p.header)}`, `dec = ${rString(p.decimal)}`, `na.strings = ${rStrings(p.naStrings)}`, `encoding = ${rString(p.encoding)}`, "showProgress = FALSE"];
  if (p.skip) args.push(`skip = ${p.skip}L`);
  if (p.names.length) args.push(`col.names = ${rStrings(p.names)}`);
  return `fread(${args.join(", ")})`;
}

// This code uses only installed R packages. No R object proxies escape to the UI.
const R_BOOTSTRAP = String.raw`
suppressPackageStartupMessages(library(data.table))
suppressPackageStartupMessages(library(magrittr))
invisible(requireNamespace("jsonlite", quietly = TRUE))
invisible(requireNamespace("bit64", quietly = TRUE))
data.table::setDTthreads(1L)
options(width = 100L, max.print = 200L, datatable.showProgress = FALSE)
Sys.setenv(TZ = "UTC")
.tc <- new.env(parent = emptyenv())
.tc$imports <- new.env(parent = emptyenv())
.tc$import_keys <- character()
.tc$result <- NULL
.tc$workdir <- getwd()
.tc$json <- function(x) as.character(jsonlite::toJSON(x, auto_unbox = TRUE, null = "null", na = "null", digits = NA, force = TRUE))
.tc$diagnostic <- function(error, line = NULL, column = NULL, precise = FALSE) {
  message <- conditionMessage(error)
  location <- regmatches(message, regexec(":([0-9]+):([0-9]+):", message, perl = TRUE))[[1L]]
  if (length(location) >= 3L) {
    line <- as.integer(location[2L])
    column <- as.integer(location[3L])
    precise <- TRUE
  }
  list(severity = "error", message = message, line = line, column = column,
       precise = precise, call = if (is.null(conditionCall(error))) NULL else paste(deparse(conditionCall(error)), collapse = " "))
}
.tc$inspect <- function(code) {
  answer <- tryCatch({
    parse(text = code, keep.source = TRUE)
    list(ok = TRUE, diagnostics = list())
  }, error = function(error) list(ok = FALSE, diagnostics = list(.tc$diagnostic(error))))
  .tc$json(answer)
}
.tc$columns <- function(table) {
  original <- names(table)
  keys <- original
  empty <- is.na(keys) | !nzchar(keys)
  keys[empty] <- paste0("V", which(empty))
  keys <- make.unique(keys, sep = "__")
  unname(lapply(seq_along(original), function(index) {
    value <- table[[index]]
    list(name = original[index], key = keys[index], type = paste(class(value), collapse = "/"),
         levels = if (is.factor(value)) as.list(utils::head(levels(value), 30L)) else NULL)
  }))
}
.tc$table <- function(value) {
  if (data.table::is.data.table(value)) return(value)
  if (is.data.frame(value) || is.matrix(value)) return(data.table::as.data.table(value))
  if (is.atomic(value) && !is.null(value)) return(data.table::data.table(value = value))
  if (is.list(value) && length(value)) {
    return(tryCatch(data.table::as.data.table(value), error = function(error) stop("The final value could not be displayed as a table. Return a data.table, data.frame, matrix, or vector.", call. = FALSE)))
  }
  stop("The final expression must return a table or vector. End the script with result, or with the pipeline itself.", call. = FALSE)
}
.tc$register_import <- function(name, code) {
  setwd(.tc$workdir)
  warnings <- character()
  value <- withCallingHandlers(
    eval(parse(text = code), envir = new.env(parent = .GlobalEnv)),
    warning = function(warning) { warnings <<- c(warnings, conditionMessage(warning)); invokeRestart("muffleWarning") },
    message = function(message) invokeRestart("muffleMessage")
  )
  value <- data.table::copy(.tc$table(value))
  assign(name, value, envir = .tc$imports)
  assignment <- call("<-", as.name(name), parse(text = code, keep.source = FALSE)[[1L]])
  .tc$import_keys[name] <- paste(deparse(assignment, width.cutoff = 500L), collapse = "\n")
  .tc$json(list(totalRows = nrow(value), totalColumns = ncol(value), columns = .tc$columns(value), warnings = as.list(unique(warnings))))
}
.tc$run <- function(code, cache_imports = TRUE) {
  started <- proc.time()[["elapsed"]]
  setwd(.tc$workdir)
  on.exit(setwd(.tc$workdir), add = TRUE)
  warnings <- character()
  stdout <- character()
  current_line <- NULL
  current_column <- NULL
  answer <- tryCatch({
    expressions <- parse(text = code, keep.source = TRUE)
    source_refs <- attr(expressions, "srcref")
    environment <- .tc$context()
    last_value <- NULL
    stdout <- utils::capture.output(withCallingHandlers({
      for (index in seq_along(expressions)) {
        if (length(source_refs) >= index) {
          current_line <- as.integer(source_refs[[index]][1L])
          current_column <- as.integer(source_refs[[index]][5L])
        }
        expression <- expressions[[index]]
        key <- if (cache_imports) paste(deparse(expression, width.cutoff = 500L), collapse = "\n") else ""
        cached <- if (cache_imports) names(.tc$import_keys)[.tc$import_keys == key] else character()
        if (length(cached) == 1L && exists(cached, envir = .tc$imports, inherits = FALSE)) {
          last_value <- data.table::copy(get(cached, envir = .tc$imports, inherits = FALSE))
          assign(cached, last_value, envir = environment)
        } else {
          last_value <- eval(expression, envir = environment)
        }
      }
    },
    warning = function(warning) { warnings <<- c(warnings, conditionMessage(warning)); invokeRestart("muffleWarning") },
    message = function(message) { warnings <<- c(warnings, conditionMessage(message)); invokeRestart("muffleMessage") }
    ), type = "output")
    .tc$result <- .tc$table(last_value)
    .tc$environment <- environment
    if (length(stdout) > 200L) warnings <- c(warnings, "Console output is limited to its first 200 lines.")
    list(ok = TRUE, elapsedMs = (proc.time()[["elapsed"]] - started) * 1000,
         warnings = as.list(unique(warnings)), stdout = as.list(utils::head(stdout, 200L)))
  }, error = function(error) list(ok = FALSE, error = conditionMessage(error),
       diagnostics = list(.tc$diagnostic(error, current_line, current_column)),
       warnings = as.list(unique(warnings)), stdout = as.list(utils::head(stdout, 200L))))
  .tc$json(answer)
}
.tc$preview <- function(offset = 0L, limit = 200L, column_limit = 100L, cell_limit = 512L, table = .tc$result) {
  if (is.null(table)) stop("Run a pipeline to create a result first.", call. = FALSE)
  total_rows <- nrow(table)
  total_columns <- ncol(table)
  offset <- min(max(0L, offset), total_rows)
  count <- min(limit, max(0L, total_rows - offset))
  row_indices <- if (count) seq.int(offset + 1L, offset + count) else integer()
  column_indices <- seq_len(min(column_limit, total_columns))
  metadata <- .tc$columns(table)[column_indices]
  keys <- vapply(metadata, function(column) column$key, character(1L))
  truncated <- 0L
  shorten <- function(value) {
    if (is.character(value) && length(value) == 1L && !is.na(value) && nchar(value, type = "chars") > cell_limit) {
      truncated <<- truncated + 1L
      return(paste0(substr(value, 1L, cell_limit), "\u2026"))
    }
    value
  }
  display_columns <- lapply(column_indices, function(index) {
    value <- table[[index]][row_indices]
    if (inherits(value, "integer64") || inherits(value, "Date") || inherits(value, "ITime") || is.factor(value)) value <- as.character(value)
    else if (inherits(value, "POSIXt")) value <- format(value, "%Y-%m-%d %H:%M:%S", tz = "UTC", usetz = TRUE)
    else if (inherits(value, "difftime") || is.complex(value) || is.raw(value)) value <- as.character(value)
    if (is.list(value)) return(lapply(value, function(cell) {
      encoded <- tryCatch(.tc$json(cell), error = function(error) paste(utils::head(capture.output(str(cell)), 3L), collapse = " "))
      shorten(encoded)
    }))
    lapply(value, function(cell) {
      if (is.numeric(cell) && length(cell) == 1L && is.nan(cell)) return("NaN")
      if (is.numeric(cell) && length(cell) == 1L && is.infinite(cell)) return(as.character(cell))
      shorten(cell)
    })
  })
  rows <- lapply(seq_len(count), function(index) {
    stats::setNames(lapply(display_columns, function(column) column[[index]]), keys)
  })
  warnings <- character()
  if (total_columns > length(column_indices)) warnings <- c(warnings, sprintf("Preview shows the first %s of %s columns. The complete table is retained for export.", length(column_indices), total_columns))
  if (truncated) warnings <- c(warnings, sprintf("%s long cells are shortened in this preview. CSV export keeps their full values.", truncated))
  if (anyDuplicated(names(table))) warnings <- c(warnings, "Some columns have duplicate names. All are shown separately; consider renaming them before further transformations.")
  .tc$json(list(rows = rows, columns = metadata, totalRows = total_rows, totalColumns = total_columns,
       offset = offset, limit = limit, truncatedColumns = total_columns - length(column_indices),
       truncatedCells = truncated, warnings = as.list(warnings)))
}
.tc$versions <- function() {
  packages <- utils::installed.packages()[, c("Package", "Version"), drop = FALSE]
  .tc$json(list(R = as.character(getRversion()), packages = as.list(stats::setNames(packages[, "Version"], packages[, "Package"]))))
}
invisible(NULL)
`;

export class REngine extends EventTarget {
  constructor(options = {}) {
    super();
    this.options = { maxFileBytes: MAX_FILE_BYTES, previewLimit: 200, columnLimit: 100, cellLimit: 512, ...options };
    this.state = "idle";
    this.versions = null;
    this.packages = {};
    this._webR = null;
    this._ready = false;
    this._initialising = null;
    this._generation = 0;
    this._queue = Promise.resolve();
    this._files = new Map();
    this._fileObjects = new WeakMap();
    this._imports = new Map();
    this._nextImport = 1;
    this._extraPackages = new Set();
    this._lastRun = { elapsedMs: 0, warnings: [], stdout: [] };
    this._newCancellation();
  }

  get ready() { return this._ready; }
  get imports() { return [...this._imports.values()].map((record) => record.metadata); }

  _newCancellation() {
    this._cancellation = new Promise((resolve, reject) => { this._cancel = reject; });
    // A close before any operation still must not create an unhandled rejection.
    this._cancellation.catch(() => {});
  }

  _status(state, message, extra = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent("status", { detail: { state, message, ...extra } }));
  }

  _log(type, message) {
    this.dispatchEvent(new CustomEvent("log", { detail: { type, message } }));
  }

  _assertGeneration(generation) {
    if (generation !== this._generation) throw cancelledError();
  }

  async _json(webR, code) {
    const value = await webR.evalRString(code);
    return JSON.parse(value);
  }

  async _refreshVersions(webR) {
    const versionInfo = await this._json(webR, ".tc$versions()");
    this.packages = versionInfo.packages;
    this.versions = { webR: webR.version || WEBR_VERSION, R: versionInfo.R, ...Object.fromEntries([...CORE_PACKAGES, "readxl"].filter((name) => versionInfo.packages[name]).map((name) => [name, versionInfo.packages[name]])) };
    return this.versions;
  }

  async init() {
    if (this.ready) return this.versions;
    if (this._initialising) return this._initialising;
    const generation = this._generation;
    const cancellation = this._cancellation;
    this._status("loading", "Starting R in your browser…", { progress: 0.1 });
    const start = (async () => {
      const { WebR, ChannelType } = await import(this.options.moduleUrl || `${WEBR_BASE_URL}webr.mjs`);
      this._assertGeneration(generation);
      const webR = new WebR({ baseUrl: this.options.baseUrl || WEBR_BASE_URL, channelType: ChannelType.PostMessage, interactive: false, homedir: WORKING_DIRECTORY });
      this._webR = webR;
      await webR.init();
      this._assertGeneration(generation);
      // Drain startup/package messages so they never accumulate on the worker channel.
      void (async () => {
        try {
          for await (const output of webR.stream()) {
            if (generation !== this._generation) break;
            if (output.type === "stdout" || output.type === "stderr") this._log(output.type, String(output.data));
          }
        } catch (error) {
          if (generation === this._generation && this._ready) this._log("error", error.message);
        }
      })();
      this._status("loading", "Loading data.table, magrittr, and preview support…", { progress: 0.45 });
      await webR.installPackages(CORE_PACKAGES);
      this._assertGeneration(generation);
      await webR.evalRVoid(`local({ required <- ${rStrings(CORE_PACKAGES)}; missing <- required[!vapply(required, requireNamespace, logical(1L), quietly = TRUE)]; if (length(missing)) stop(paste("R packages did not finish downloading:", paste(missing, collapse = ", "), ". Check your connection and restart R."), call. = FALSE) })`);
      await webR.evalRVoid(R_BOOTSTRAP);
      await webR.evalRVoid(R_RUNTIME_EXTENSIONS);
      this._assertGeneration(generation);
      if (this._files.size) {
        this._status("loading", "Restoring your imported tables…", { progress: 0.85 });
        for (const record of this._files.values()) {
          await webR.FS.writeFile(record.path, new Uint8Array(await record.file.arrayBuffer()));
          this._assertGeneration(generation);
        }
        if ([...this._imports.values()].some((record) => record.options.format === "excel")) {
          await webR.installPackages(["readxl"]);
          this._extraPackages.add("readxl");
          this._assertGeneration(generation);
        }
        for (const record of this._imports.values()) {
          await this._json(webR, `.tc$register_import(${rString(record.metadata.tableName)}, ${rString(record.metadata.readCode)})`);
          this._assertGeneration(generation);
        }
      }
      await this._refreshVersions(webR);
      this._assertGeneration(generation);
      this._ready = true;
      this._status("ready", `R ${this.versions.R} is ready`, { progress: 1, versions: this.versions });
      return this.versions;
    })();
    const pending = Promise.race([start, cancellation]).catch((error) => {
      if (generation === this._generation) {
        this._ready = false;
        this._initialising = null;
        try { this._webR?.close(); } catch {}
        this._webR = null;
        this._status("error", "R could not start. Check your connection, then retry.");
      }
      throw error;
    });
    this._initialising = pending;
    return pending;
  }

  async _enqueue(operation) {
    const generation = this._generation;
    await this.init();
    this._assertGeneration(generation);
    const webR = this._webR;
    const cancellation = this._cancellation;
    const result = this._queue.then(() => {
      this._assertGeneration(generation);
      return Promise.race([operation(webR, generation), cancellation]);
    });
    this._queue = result.catch(() => {});
    return result;
  }

  async inspect(code) {
    return this._enqueue((webR) => this._json(webR, `.tc$inspect(${rString(code)})`));
  }

  _previewArguments(options = {}) {
    const offset = integer(options.offset, 0);
    const limit = integer(options.limit, this.options.previewLimit, 1, 1000);
    const columnLimit = integer(options.columnLimit, this.options.columnLimit, 1, 500);
    const cellLimit = integer(options.cellLimit, this.options.cellLimit, 32, 10000);
    return `${offset}L, ${limit}L, ${columnLimit}L, ${cellLimit}L`;
  }

  async _preview(webR, options) {
    const result = await this._json(webR, `.tc$preview(${this._previewArguments(options)})`);
    return { ...result, elapsedMs: this._lastRun.elapsedMs, warnings: [...new Set([...this._lastRun.warnings, ...result.warnings])], stdout: this._lastRun.stdout };
  }

  async run(code, options = {}) {
    return this._enqueue(async (webR, generation) => {
      this._status("running", "Running your pipeline…");
      try {
        const started = performance.now();
        await this._ensurePackages(webR, code, generation);
        const result = await this._json(webR, `.tc$run(${rString(code)}, cache_imports = ${rBoolean(options.cacheImports !== false)})`);
        this._assertGeneration(generation);
        if (!result.ok) throw new RExecutionError(result.error, result);
        this._lastRun = { elapsedMs: result.elapsedMs || performance.now() - started, warnings: result.warnings || [], stdout: result.stdout || [] };
        return await this._preview(webR, options);
      } finally {
        if (generation === this._generation && this.ready) this._status("ready", "R is ready");
      }
    });
  }

  async preview(options = {}) {
    return this._enqueue((webR) => this._preview(webR, options));
  }


  /** Discover package calls from R's syntax tree, excluding strings, comments and quoted code. */
  async packageDependencies(code) {
    return this._enqueue((webR) => this._json(webR, `.tc$packages_for(${rString(code)})`));
  }

  async _ensurePackages(webR, code, generation) {
    const packages = await this._json(webR, `.tc$packages_for(${rString(code)})`);
    const missing = packages.filter((name) => !this.packages[name]);
    if (!missing.length) return;
    this._status("running", `Installing R packages: ${missing.join(", ")}…`);
    try {
      await webR.installPackages(missing);
      this._assertGeneration(generation);
      await this._refreshVersions(webR);
      const failed = missing.filter((name) => !this.packages[name]);
      if (failed.length) throw new Error(`No compatible package was installed for ${failed.join(", ")}.`);
      missing.forEach((name) => this._extraPackages.add(name));
    } catch (error) {
      if (error.cancelled) throw error;
      throw new RExecutionError(`Could not install ${missing.join(", ")} for webR. Check that the package is available in the webR package repository and that the network connection is working. ${error.message}`, { code: "PACKAGE_INSTALL_FAILED", packages: missing });
    }
  }

  async _evaluateSeparate(code, options = {}, strictTable = false) {
    return this._enqueue(async (webR, generation) => {
      this._status("running", strictTable ? "Preparing table preview…" : "Running exploratory analysis…");
      let shelter;
      let images = [];
      try {
        await this._ensurePackages(webR, `${options.setupCode || ""}\n${code}`, generation);
        const expression = `.tc$separate(${rString(code)}, ${rString(options.setupCode || "")}, ${this._previewArguments(options)}, strict_table = ${rBoolean(strictTable)})`;
        let result;
        if (options.captureGraphics) {
          shelter = await new webR.Shelter();
          const captured = await shelter.captureR(expression, { captureGraphics: { width: 960, height: 600 } });
          const value = await captured.result.toJs();
          result = JSON.parse(value.values[0]);
          images = captured.images || [];
        } else result = await this._json(webR, expression);
        this._assertGeneration(generation);
        if (!result.ok) {
          images.forEach((image) => image.close?.());
          throw new RExecutionError(result.error, result);
        }
        return { ...result, images };
      } finally {
        if (shelter) await shelter.purge();
        if (generation === this._generation && this.ready) this._status("ready", "R is ready");
      }
    });
  }

  /** A copied context keeps :=, set(), previews and summaries away from the pipeline result. */
  async previewTable(sourceCode, options = {}) {
    return this._evaluateSeparate(sourceCode, { ...options, captureGraphics: false }, true);
  }

  async runAnalysis(code, options = {}) {
    return this._evaluateSeparate(code, options, false);
  }

  async completionSymbols() {
    return this._enqueue(async (webR) => {
      const symbols = await this._json(webR, ".tc$symbols()");
      return [...new Map(symbols.map((symbol) => [`${symbol.package}:${symbol.name}`, symbol])).values()];
    });
  }

  async helpFor(topic, packageName) {
    return this._enqueue(async (webR) => {
      const help = await this._json(webR, `.tc$help(${rString(topic)}, ${packageName ? rString(packageName) : "NULL"})`);
      return { ...help, text: help.text == null ? help.text : cleanHelpText(help.text) };
    });
  }

  async removeTable(tableName, { includeSession = false } = {}) {
    return this._enqueue(async (webR) => {
      const record = this._imports.get(tableName);
      if (!record && !includeSession) return false;
      await webR.evalRVoid(`.tc$remove_import(${rString(tableName)})`);
      if (!record) return true;
      this._imports.delete(tableName);
      const fileName = record.metadata.fileName;
      if (![...this._imports.values()].some((item) => item.metadata.fileName === fileName)) {
        const staged = this._files.get(fileName);
        if (staged) {
          try { await webR.FS.unlink(staged.path); } catch {}
          this._files.delete(fileName);
          this._fileObjects.delete(staged.file);
        }
      }
      return true;
    });
  }

  _validateFile(file) {
    if (!file || typeof file.arrayBuffer !== "function") throw new Error("Choose a file from your computer first.");
    if (!file.size) throw new Error("This file is empty. Choose a file with at least one row.");
    if (file.size > this.options.maxFileBytes) throw new Error(`This file is larger than the ${Math.round(this.options.maxFileBytes / 1024 / 1024)} MiB import limit. Use a smaller file or increase maxFileBytes in the app configuration.`);
  }

  async _stageFile(webR, file, preferredName = null, tableName = null, generation = this._generation) {
    const existing = this._fileObjects.get(file);
    if (existing && this._files.get(existing.fileName) === existing && (!preferredName || existing.fileName === preferredName)) return existing;
    // Preserve ordinary spaces and Unicode so exported R refers to the user's
    // original filename. Only path/control characters are unsuitable for the VFS.
    const baseName = String(file.name || "upload.csv").split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "").slice(0, 180) || "upload.csv";
    const dot = baseName.lastIndexOf(".");
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    const extension = dot > 0 ? baseName.slice(dot) : "";
    let fileName = preferredName || baseName;
    let suffix = 2;
    const taken = new Set([...this._files.keys()].map((name) => name.toLowerCase()));
    if (!preferredName) while (taken.has(fileName.toLowerCase())) fileName = `${stem}_${suffix++}${extension}`;
    const previous = this._files.get(fileName);
    if (preferredName) {
      const owners = [...this._imports.values()].filter((record) => record.metadata.fileName === preferredName);
      const conflict = owners.some((record) => record.metadata.tableName !== tableName && record.file !== file);
      const ownedByTarget = owners.some((record) => record.metadata.tableName === tableName);
      if (conflict || (previous && previous.file !== file && !ownedByTarget)) {
        throw new Error(`This recipe needs filename ${preferredName}, already used by another imported table. Open the recipe in a fresh tab and reselect its files.`);
      }
      if (previous?.file === file) return previous;
    }
    const record = { file, fileName, path: `${WORKING_DIRECTORY}/${fileName}`, previous, written: true };
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      this._assertGeneration(generation);
      await webR.FS.writeFile(record.path, bytes);
      this._assertGeneration(generation);
    } catch (error) {
      await this._rollbackStagedFile(webR, record, generation);
      throw error;
    }
    return record;
  }

  _commitStagedFile(record) {
    const previous = this._files.get(record.fileName);
    if (previous && previous.file !== record.file && this._fileObjects.get(previous.file) === previous) this._fileObjects.delete(previous.file);
    const committed = { file: record.file, fileName: record.fileName, path: record.path };
    this._files.set(record.fileName, committed);
    this._fileObjects.set(record.file, committed);
  }

  async _rollbackStagedFile(webR, record, generation) {
    if (!record?.written || generation !== this._generation) return;
    try {
      if (record.previous) await webR.FS.writeFile(record.path, new Uint8Array(await record.previous.file.arrayBuffer()));
      else await webR.FS.unlink(record.path);
    } catch { /* Preserve the original import error if filesystem cleanup fails. */ }
  }

  async _ensureReadxl(webR, generation) {
    if (this._extraPackages.has("readxl")) return;
    this._status("loading", "Loading Excel support for this session…");
    await webR.installPackages(["readxl"]);
    this._assertGeneration(generation);
    if (!await webR.evalRBoolean('requireNamespace("readxl", quietly = TRUE)')) throw new Error("Excel support did not finish downloading. Check your connection and try importing again.");
    this._extraPackages.add("readxl");
    await this._refreshVersions(webR);
  }

  async excelSheets(file) {
    this._validateFile(file);
    return this._enqueue(async (webR, generation) => {
      let staged;
      try {
        staged = await this._stageFile(webR, file, null, null, generation);
        await this._ensureReadxl(webR, generation);
        const sheets = await this._json(webR, `.tc$json(as.list(readxl::excel_sheets(${rString(staged.path)})))`);
        this._assertGeneration(generation);
        this._commitStagedFile(staged);
        return sheets;
      } catch (error) {
        await this._rollbackStagedFile(webR, staged, generation);
        throw error;
      } finally {
        if (generation === this._generation && this.ready) this._status("ready", "R is ready");
      }
    });
  }

  async importFile(file, options = {}) {
    this._validateFile(file);
    const normalized = normaliseImportOptions(file.name || "upload.csv", options);
    const requestedName = options.tableName == null ? null : String(options.tableName);
    if (requestedName !== null && (!requestedName.length || requestedName.length > 240 || /[\u0000-\u001f\u007f]/.test(requestedName) || reservedTableName(requestedName))) throw new Error("Choose a nonempty table name of at most 240 characters that does not conflict with an example or app object.");
    const requestedFileName = options.fileName ?? null;
    if (requestedFileName !== null && (typeof requestedFileName !== "string" || !requestedFileName.length || requestedFileName.length > 240 || requestedFileName === "." || requestedFileName === ".." || /[\\/\u0000-\u001f\u007f]/.test(requestedFileName))) {
      throw new Error("A restored filename must be a nonempty basename of at most 240 characters, without slashes or control characters.");
    }
    return this._enqueue(async (webR, generation) => {
      this._status("running", `Reading ${file.name || "your file"}…`);
      let staged;
      try {
        staged = await this._stageFile(webR, file, requestedFileName, requestedName, generation);
        if (normalized.format === "excel") await this._ensureReadxl(webR, generation);
        this._assertGeneration(generation);
        const tableName = requestedName || tableNameFromFile(file.name || staged.fileName, this._imports.keys());
        const readCode = buildImportCode(staged.fileName, normalized);
        const details = await this._json(webR, `.tc$register_import(${rString(tableName)}, ${rString(readCode)})`);
        this._assertGeneration(generation);
        const metadata = { id: tableName, tableName, label: file.name || staged.fileName, fileName: staged.fileName, originalFileName: file.name || staged.fileName, originalName: file.name || staged.fileName, format: normalized.format, sourceCode: rName(tableName), tablesCode: `${rName(tableName)} <- ${readCode}`, readCode, portableReadCode: buildImportCode(file.name || staged.fileName, normalized), options: normalized, ...details };
        this._commitStagedFile(staged);
        this._imports.set(tableName, { file, options: normalized, metadata });
        return metadata;
      } catch (error) {
        await this._rollbackStagedFile(webR, staged, generation);
        throw error;
      } finally {
        if (generation === this._generation && this.ready) this._status("ready", "R is ready");
      }
    });
  }

  async exportCSV() {
    return this._enqueue(async (webR) => {
      const path = "/tmp/tablecraft-result.csv";
      try {
        await webR.evalRVoid(`if (is.null(.tc$result)) stop("Run a pipeline before exporting.", call. = FALSE); data.table::fwrite(.tc$result, file = ${rString(path)}, na = "NA", quote = "auto", dateTimeAs = "ISO", sep2 = c("", "|", ""))`);
        return await webR.FS.readFile(path);
      } finally {
        try { await webR.FS.unlink(path); } catch {}
      }
    });
  }

  /** Closing the worker is the reliable way to stop R on a PostMessage channel. */
  close({ preserveFiles = true } = {}) {
    this._generation += 1;
    this._cancel(cancelledError());
    try { this._webR?.close(); } catch {}
    this._webR = null;
    this._ready = false;
    this._initialising = null;
    this._queue = Promise.resolve();
    this._extraPackages.clear();
    this._lastRun = { elapsedMs: 0, warnings: [], stdout: [] };
    this.versions = null;
    this.packages = {};
    if (!preserveFiles) {
      this._files.clear();
      this._fileObjects = new WeakMap();
      this._imports.clear();
      this._nextImport = 1;
    }
    this._newCancellation();
    this._status("idle", "R session stopped");
  }

  async reset(options = {}) {
    this.close(options);
    return this.init();
  }
}
