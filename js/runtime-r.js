/** R helpers kept separate so parser-based package discovery and isolated evaluation can be tested. */
export const R_RUNTIME_EXTENSIONS = String.raw`
.tc$environment <- new.env(parent = .GlobalEnv)
.tc$context <- function(include_pipeline = FALSE) {
  target <- new.env(parent = .GlobalEnv)
  copy_bindings <- function(source) {
    invisible(lapply(ls(source, all.names = TRUE), function(name) {
      if (name == ".tc" || bindingIsActive(name, source)) return(NULL)
      value <- get(name, envir = source, inherits = FALSE)
      if (data.table::is.data.table(value) || is.data.frame(value) || is.list(value) || is.atomic(value)) value <- data.table::copy(value)
      assign(name, value, envir = target)
    }))
  }
  copy_bindings(.tc$imports)
  if (include_pipeline) copy_bindings(.tc$environment)
  if (include_pipeline && !is.null(.tc$result)) assign("result", data.table::copy(.tc$result), envir = target)
  target
}
.tc$packages_for <- function(code) {
  expressions <- tryCatch(parse(text = code, keep.source = FALSE), error = function(error) NULL)
  packages <- character()
  add <- function(value) {
    if (is.symbol(value) || (is.character(value) && length(value) == 1L)) {
      name <- as.character(value)
      if (length(name) == 1L && grepl("^[A-Za-z][A-Za-z0-9.]*$", name)) packages <<- c(packages, name)
    }
  }
  walk <- function(value) {
    if (is.expression(value)) { invisible(lapply(value, walk)); return(invisible(NULL)) }
    if (!is.call(value)) return(invisible(NULL))
    head <- value[[1L]]
    fun <- if (is.symbol(head)) as.character(head) else ""
    if (fun %in% c("quote", "substitute", "expression", "bquote")) return(invisible(NULL))
    if (fun %in% c("::", ":::")) { if (length(value) >= 3L) add(value[[2L]]); return(invisible(NULL)) }
    if (is.call(head) && length(head) == 3L && is.symbol(head[[1L]]) && as.character(head[[1L]]) %in% c("::", ":::")) {
      add(head[[2L]])
      fun <- as.character(head[[3L]])
    }
    parts <- as.list(value)
    if (fun %in% c("library", "require", "requireNamespace") && length(parts) >= 2L) {
      argument_names <- names(parts)
      index <- if (!is.null(argument_names) && "package" %in% argument_names) match("package", argument_names) else 2L
      character_only <- if (!is.null(argument_names) && "character.only" %in% argument_names) identical(parts[[match("character.only", argument_names)]], TRUE) else FALSE
      package <- tryCatch(parts[[index]], error = function(error) NULL)
      if (is.character(package) || (is.symbol(package) && !character_only && fun != "requireNamespace")) add(package)
    }
    if (length(parts) >= 2L) invisible(lapply(seq.int(2L, length(parts)), function(index) {
      tryCatch(walk(parts[[index]]), error = function(error) invisible(NULL))
    }))
    invisible(NULL)
  }
  walk(expressions)
  .tc$json(as.list(unique(packages)))
}
.tc$separate <- function(code, setup = "", offset = 0L, limit = 200L, column_limit = 100L, cell_limit = 512L, strict_table = FALSE) {
  started <- proc.time()[["elapsed"]]
  setwd(.tc$workdir)
  on.exit(setwd(.tc$workdir), add = TRUE)
  environment <- .tc$context(TRUE)
  warnings <- character()
  stdout <- character()
  current_line <- NULL
  answer <- tryCatch({
    value <- NULL
    stdout <- utils::capture.output(withCallingHandlers({
      if (nzchar(setup)) eval(parse(text = setup), envir = environment)
      expressions <- parse(text = code, keep.source = TRUE)
      source_refs <- attr(expressions, "srcref")
      for (index in seq_along(expressions)) {
        if (length(source_refs) >= index) current_line <- as.integer(source_refs[[index]][1L])
        value <- eval(expressions[[index]], envir = environment)
      }
      if (inherits(value, c("gg", "ggplot", "trellis"))) print(value)
    }, warning = function(warning) { warnings <<- c(warnings, conditionMessage(warning)); invokeRestart("muffleWarning") },
       message = function(message) { warnings <<- c(warnings, conditionMessage(message)); invokeRestart("muffleMessage") }), type = "output")
    table <- if (strict_table) .tc$table(value) else tryCatch(.tc$table(value), error = function(error) data.table::data.table())
    preview <- jsonlite::fromJSON(.tc$preview(offset, limit, column_limit, cell_limit, table = table), simplifyVector = FALSE)
    preview$ok <- TRUE
    preview$elapsedMs <- (proc.time()[["elapsed"]] - started) * 1000
    preview$warnings <- as.list(unique(c(unlist(preview$warnings, use.names = FALSE), warnings,
      if (length(stdout) > 200L) "Console output is limited to its first 200 lines." else character())))
    preview$stdout <- as.list(utils::head(stdout, 200L))
    preview
  }, error = function(error) list(ok = FALSE, error = conditionMessage(error),
       diagnostics = list(.tc$diagnostic(error, current_line)), warnings = as.list(unique(warnings)), stdout = as.list(utils::head(stdout, 200L))))
  .tc$json(answer)
}
.tc$remove_import <- function(name) {
  if (exists(name, envir = .tc$imports, inherits = FALSE)) rm(list = name, envir = .tc$imports)
  .tc$import_keys <- .tc$import_keys[names(.tc$import_keys) != name]
  if (exists(name, envir = .tc$environment, inherits = FALSE)) rm(list = name, envir = .tc$environment)
  invisible(NULL)
}
.tc$symbols <- function() {
  entries <- list()
  add <- function(name, value = NULL, package = "") {
    entries[[length(entries) + 1L]] <<- list(name = name,
      kind = if (is.function(value)) "function" else if (is.data.frame(value)) "table" else "object", package = package)
  }
  invisible(lapply(list(.tc$environment, .tc$imports), function(environment) {
    invisible(lapply(ls(environment, all.names = FALSE), function(name) {
      if (!bindingIsActive(name, environment)) tryCatch(add(name, get(name, envir = environment, inherits = FALSE)), error = function(error) NULL)
    }))
  }))
  if (!is.null(.tc$result)) add("result", .tc$result)
  invisible(lapply(loadedNamespaces(), function(package) {
    exports <- tryCatch(getNamespaceExports(package), error = function(error) character())
    invisible(lapply(exports, function(name) {
      tryCatch(add(name, getExportedValue(package, name), package), error = function(error) NULL)
    }))
  }))
  .tc$json(entries)
}
.tc$help <- function(topic, package = NULL) {
  refs <- suppressWarnings(do.call(utils::help, list(topic = topic, package = package, try.all.packages = is.null(package))))
  if (!length(refs)) return(.tc$json(list(topic = topic, package = package, text = NULL)))
  text <- paste(utils::capture.output(tools::Rd2txt(
    utils:::.getHelpFile(refs[1L]), options = list(underline_titles = FALSE)
  )), collapse = "\n")
  .tc$json(list(topic = topic, package = package, text = substr(text, 1L, 120000L)))
}
options(webr.show_menu = FALSE)
if (base::requireNamespace("webr", quietly = TRUE)) {
  tryCatch({
    webr::shim_install()
    # webR 0.6's library/require shims always substitute pkg, even with
    # character.only=TRUE. Preserve ordinary R argument semantics here.
    ensure_package <- function(package) {
      if (length(find.package(package, quiet = TRUE)) == 0L) {
        tryCatch(webr::install(package), error = function(error) {
          stop(sprintf("Could not install R package '%s' for webR: %s", package, conditionMessage(error)), call. = FALSE)
        })
      }
      if (length(find.package(package, quiet = TRUE)) == 0L) {
        stop(sprintf("R package '%s' is not available in the compatible webR binary repository.", package), call. = FALSE)
      }
      invisible(NULL)
    }
    shims <- as.environment("webr_shims")
    shims$library <- local({
      ensure <- ensure_package
      function(package, ..., character.only = FALSE, show_menu = FALSE) {
        if (missing(package)) return(base::library(...))
        name <- if (character.only) package else as.character(substitute(package))
        ensure(name)
        do.call(base::library, c(list(package = name, character.only = TRUE), list(...)))
      }
    })
    shims$require <- local({
      ensure <- ensure_package
      function(package, ..., character.only = FALSE, show_menu = FALSE) {
        name <- if (character.only) package else as.character(substitute(package))
        ensure(name)
        do.call(base::require, c(list(package = name, character.only = TRUE), list(...)))
      }
    })
    rm(ensure_package, shims)
  }, error = function(error) invisible(NULL))
}
`;
