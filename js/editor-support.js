import {HELPERS, rName} from './catalog.js';
import {tokenizeR, splitTopLevel} from './r-syntax.js';

// Offline reference for ordinary R as well as data.table. The running R session
// supplies additional objects and exported package functions when available.
const groups = {
  base: {
    'sum': 'sum(..., na.rm = FALSE)', 'mean': 'mean(x, trim = 0, na.rm = FALSE)',
    'min': 'min(..., na.rm = FALSE)', 'max': 'max(..., na.rm = FALSE)',
    'range': 'range(..., na.rm = FALSE, finite = FALSE)', 'prod': 'prod(..., na.rm = FALSE)',
    'abs': 'abs(x)', 'round': 'round(x, digits = 0)', 'signif': 'signif(x, digits = 6)',
    'ceiling': 'ceiling(x)', 'floor': 'floor(x)', 'trunc': 'trunc(x)', 'sign': 'sign(x)',
    'sqrt': 'sqrt(x)', 'log': 'log(x, base = exp(1))', 'log10': 'log10(x)', 'log1p': 'log1p(x)',
    'exp': 'exp(x)', 'expm1': 'expm1(x)', 'pmin': 'pmin(..., na.rm = FALSE)', 'pmax': 'pmax(..., na.rm = FALSE)',
    'length': 'length(x)', 'lengths': 'lengths(x)', 'nrow': 'nrow(x)', 'ncol': 'ncol(x)', 'dim': 'dim(x)',
    'names': 'names(x)', 'colnames': 'colnames(x)', 'rownames': 'rownames(x)',
    'class': 'class(x)', 'typeof': 'typeof(x)', 'inherits': 'inherits(x, what)',
    'is.na': 'is.na(x)', 'anyNA': 'anyNA(x, recursive = FALSE)', 'is.nan': 'is.nan(x)',
    'is.finite': 'is.finite(x)', 'is.infinite': 'is.infinite(x)', 'is.null': 'is.null(x)',
    'is.numeric': 'is.numeric(x)', 'is.integer': 'is.integer(x)', 'is.character': 'is.character(x)',
    'is.logical': 'is.logical(x)', 'is.factor': 'is.factor(x)', 'is.list': 'is.list(x)',
    'is.matrix': 'is.matrix(x)', 'is.data.frame': 'is.data.frame(x)', 'isTRUE': 'isTRUE(x)',
    'as.numeric': 'as.numeric(x)', 'as.integer': 'as.integer(x)', 'as.character': 'as.character(x)',
    'as.logical': 'as.logical(x)', 'as.factor': 'as.factor(x)', 'as.list': 'as.list(x)',
    'as.matrix': 'as.matrix(x)', 'as.data.frame': 'as.data.frame(x)', 'as.Date': 'as.Date(x, format)',
    'as.POSIXct': 'as.POSIXct(x, tz = "UTC", format)', 'format': 'format(x, ...)',
    'c': 'c(...)', 'list': 'list(...)', 'vector': 'vector(mode = "logical", length = 0)',
    'numeric': 'numeric(length = 0)', 'integer': 'integer(length = 0)', 'character': 'character(length = 0)',
    'logical': 'logical(length = 0)', 'matrix': 'matrix(data, nrow = 1, ncol = 1, byrow = FALSE)',
    'data.frame': 'data.frame(..., check.names = TRUE)', 'factor': 'factor(x, levels, labels, ordered = FALSE)',
    'levels': 'levels(x)', 'droplevels': 'droplevels(x)', 'unlist': 'unlist(x, recursive = TRUE, use.names = TRUE)',
    'lapply': 'lapply(X, FUN, ...)', 'sapply': 'sapply(X, FUN, ...)', 'vapply': 'vapply(X, FUN, FUN.VALUE, ...)',
    'mapply': 'mapply(FUN, ..., MoreArgs = NULL)', 'Map': 'Map(f, ...)', 'Reduce': 'Reduce(f, x, init, accumulate = FALSE)',
    'Filter': 'Filter(f, x)', 'Find': 'Find(f, x)', 'Negate': 'Negate(f)', 'apply': 'apply(X, MARGIN, FUN, ...)',
    'tapply': 'tapply(X, INDEX, FUN, ...)', 'do.call': 'do.call(what, args)', 'split': 'split(x, f, drop = FALSE)',
    'unsplit': 'unsplit(value, f)', 'unname': 'unname(obj)', 'seq': 'seq(from, to, by)',
    'seq_len': 'seq_len(length.out)', 'seq_along': 'seq_along(along.with)', 'rep': 'rep(x, times)',
    'rep_len': 'rep_len(x, length.out)', 'rev': 'rev(x)', 'sort': 'sort(x, decreasing = FALSE, na.last = NA)',
    'order': 'order(..., na.last = TRUE, decreasing = FALSE)', 'rank': 'rank(x, ties.method = "average")',
    'match': 'match(x, table, nomatch = NA_integer_)', 'which': 'which(x)', 'which.max': 'which.max(x)',
    'which.min': 'which.min(x)', 'unique': 'unique(x)', 'duplicated': 'duplicated(x)', 'anyDuplicated': 'anyDuplicated(x)',
    'intersect': 'intersect(x, y)', 'union': 'union(x, y)', 'setdiff': 'setdiff(x, y)', 'setequal': 'setequal(x, y)',
    'all': 'all(..., na.rm = FALSE)', 'any': 'any(..., na.rm = FALSE)', 'all.equal': 'all.equal(target, current, ...)',
    'identical': 'identical(x, y)', 'stopifnot': 'stopifnot(...)', 'stop': 'stop(...)',
    'warning': 'warning(...)', 'message': 'message(...)', 'tryCatch': 'tryCatch(expr, error = function(e) NULL)',
    'try': 'try(expr, silent = FALSE)', 'withCallingHandlers': 'withCallingHandlers(expr, ...)',
    'paste': 'paste(..., sep = " ", collapse = NULL)', 'paste0': 'paste0(..., collapse = NULL)',
    'sprintf': 'sprintf(fmt, ...)', 'nchar': 'nchar(x)', 'substr': 'substr(x, start, stop)',
    'substring': 'substring(text, first, last)', 'trimws': 'trimws(x)', 'tolower': 'tolower(x)', 'toupper': 'toupper(x)',
    'strsplit': 'strsplit(x, split, fixed = FALSE)', 'sub': 'sub(pattern, replacement, x, ...)',
    'gsub': 'gsub(pattern, replacement, x, ...)', 'grep': 'grep(pattern, x, value = FALSE, ...)',
    'grepl': 'grepl(pattern, x, ...)', 'startsWith': 'startsWith(x, prefix)', 'endsWith': 'endsWith(x, suffix)',
    'chartr': 'chartr(old, new, x)', 'make.names': 'make.names(names, unique = FALSE)', 'make.unique': 'make.unique(names)',
    'cumsum': 'cumsum(x)', 'cumprod': 'cumprod(x)', 'cummin': 'cummin(x)', 'cummax': 'cummax(x)',
    'diff': 'diff(x, lag = 1, differences = 1)', 'cut': 'cut(x, breaks, labels = NULL)',
    'table': 'table(..., useNA = "no")', 'prop.table': 'prop.table(x, margin = NULL)',
    'rowSums': 'rowSums(x, na.rm = FALSE)', 'colSums': 'colSums(x, na.rm = FALSE)',
    'rowMeans': 'rowMeans(x, na.rm = FALSE)', 'colMeans': 'colMeans(x, na.rm = FALSE)',
    'sample': 'sample(x, size, replace = FALSE, prob = NULL)', 'set.seed': 'set.seed(seed)',
    'ifelse': 'ifelse(test, yes, no)', 'switch': 'switch(EXPR, ...)', 'function': 'function(...) {}',
    'library': 'library(package, character.only = FALSE)', 'require': 'require(package, character.only = FALSE)',
    'requireNamespace': 'requireNamespace(package, quietly = FALSE)', 'get': 'get(x, envir)', 'mget': 'mget(x, envir)',
    'assign': 'assign(x, value, envir)', 'exists': 'exists(x, envir)', 'ls': 'ls()', 'rm': 'rm(..., list = character())',
    'options': 'options(...)', 'getOption': 'getOption(x, default = NULL)', 'print': 'print(x, ...)',
    'cat': 'cat(..., sep = " ")', 'summary': 'summary(object, ...)', 'saveRDS': 'saveRDS(object, file)',
    'readRDS': 'readRDS(file)', 'file.path': 'file.path(..., fsep = "/")', 'file.exists': 'file.exists(...)',
    'list.files': 'list.files(path = ".", pattern = NULL)', 'getwd': 'getwd()', 'setwd': 'setwd(dir)',
    'Sys.Date': 'Sys.Date()', 'Sys.time': 'Sys.time()', 'difftime': 'difftime(time1, time2, units = "auto")',
    'local': 'local(expr)', 'with': 'with(data, expr)', 'within': 'within(data, expr)', 'invisible': 'invisible(x)',
    'return': 'return(value)', 'on.exit': 'on.exit(expr, add = FALSE)', 'eval': 'eval(expr, envir)', 'parse': 'parse(text)',
  },
  stats: {
    'median': 'median(x, na.rm = FALSE)', 'sd': 'sd(x, na.rm = FALSE)', 'var': 'var(x, y = NULL, na.rm = FALSE)',
    'quantile': 'quantile(x, probs = seq(0, 1, 0.25), na.rm = FALSE)', 'IQR': 'IQR(x, na.rm = FALSE)',
    'mad': 'mad(x, constant = 1.4826, na.rm = FALSE)', 'cor': 'cor(x, y = NULL, use = "everything", method = "pearson")',
    'cov': 'cov(x, y = NULL, use = "everything")', 'weighted.mean': 'weighted.mean(x, w, na.rm = FALSE)',
    'aggregate': 'aggregate(x, by, FUN, ...)', 'lm': 'lm(formula, data, ...)',
    'glm': 'glm(formula, family = gaussian, data, ...)', 'predict': 'predict(object, newdata, ...)',
    'residuals': 'residuals(object, ...)', 'coef': 'coef(object, ...)', 'confint': 'confint(object, level = 0.95)',
    't.test': 't.test(x, y = NULL, alternative = "two.sided", ...)', 'wilcox.test': 'wilcox.test(x, y = NULL, ...)',
    'chisq.test': 'chisq.test(x, y = NULL, correct = TRUE)', 'fisher.test': 'fisher.test(x, y = NULL, ...)',
    'cor.test': 'cor.test(x, y, method = "pearson")', 'ks.test': 'ks.test(x, y, ...)',
    'shapiro.test': 'shapiro.test(x)', 'aov': 'aov(formula, data)', 'anova': 'anova(object, ...)',
    'rnorm': 'rnorm(n, mean = 0, sd = 1)', 'runif': 'runif(n, min = 0, max = 1)',
    'rbinom': 'rbinom(n, size, prob)', 'rpois': 'rpois(n, lambda)', 'dnorm': 'dnorm(x, mean = 0, sd = 1)',
    'pnorm': 'pnorm(q, mean = 0, sd = 1)', 'qnorm': 'qnorm(p, mean = 0, sd = 1)',
    'na.omit': 'na.omit(object)', 'complete.cases': 'complete.cases(...)', 'na.exclude': 'na.exclude(object)',
    'density': 'density(x, na.rm = FALSE)', 'ecdf': 'ecdf(x)', 'kmeans': 'kmeans(x, centers, ...)',
    'dist': 'dist(x, method = "euclidean")', 'hclust': 'hclust(d, method = "complete")',
    'prcomp': 'prcomp(x, center = TRUE, scale. = FALSE)', 'reorder': 'reorder(x, X, FUN = mean)',
  },
  utils: {
    'head': 'head(x, n = 6L)', 'tail': 'tail(x, n = 6L)', 'str': 'str(object, ...)',
    'read.csv': 'read.csv(file, header = TRUE, ...)', 'write.csv': 'write.csv(x, file, row.names = FALSE)',
    'read.table': 'read.table(file, header = FALSE, sep = "", ...)', 'read.fwf': 'read.fwf(file, widths, ...)',
    'write.table': 'write.table(x, file, sep = " ", ...)', 'help': 'help(topic, package = NULL)',
    'help.search': 'help.search(pattern)', 'sessionInfo': 'sessionInfo()',
    'installed.packages': 'installed.packages()', 'install.packages': 'install.packages(pkgs)',
    'packageVersion': 'packageVersion(pkg)', 'capture.output': 'capture.output(..., type = "output")',
  },
  graphics: {
    'plot': 'plot(x, y, ...)', 'hist': 'hist(x, breaks = "Sturges", ...)',
    'boxplot': 'boxplot(x, ...)', 'barplot': 'barplot(height, names.arg, ...)',
    'pairs': 'pairs(x, ...)', 'lines': 'lines(x, y, ...)', 'points': 'points(x, y, ...)',
    'abline': 'abline(a = NULL, b = NULL, h = NULL, v = NULL, ...)', 'legend': 'legend(x, legend, ...)',
    'par': 'par(...)', 'image': 'image(x, y, z, ...)', 'mosaicplot': 'mosaicplot(x, ...)',
  },
};

const nativeOrigin = name => Object.entries(groups).find(([,functions]) => Object.hasOwn(functions,name))?.[0]
  || (['merge','cbind','rbind'].includes(name) ? 'base' : '');

export const R_FUNCTIONS = [
  ...Object.entries(groups).flatMap(([packageName, functions]) => Object.entries(functions)
    .map(([name, signature]) => ({name, signature, package: packageName, kind: 'function', description: `${packageName} R function`}))),
  ...HELPERS.map(helper => ({name: helper.name, signature: helper.signature || helper.name,
    package: helper.name === '%>%' ? 'magrittr' : nativeOrigin(helper.name) || 'data.table', kind: 'function', description: helper.description})),
];

/** Return the lexical token at a caret, never interpreting comments or strings. */
export function completionContext(code, offset = code.length) {
  const text = String(code).slice(0, offset);
  let quote = '', quoteAt = -1, escaped = false, comment = false, rawEnd = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (comment) { if (ch === '\n') comment = false; continue; }
    if (rawEnd) { if (text.startsWith(rawEnd, i)) { i += rawEnd.length - 1; rawEnd = ''; } continue; }
    if (escaped) { escaped = false; continue; }
    if (quote) { if (ch === '\\') escaped = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '#') { comment = true; continue; }
    const raw = /[rR]/.test(ch) && (i === 0 || !/[\p{L}\p{N}._]/u.test(text[i - 1])) && text.slice(i).match(/^[rR]"(-*)([([{])/);
    if (raw) { rawEnd = ({'(': ')', '[': ']', '{': '}'}[raw[2]]) + raw[1] + '"'; i += raw[0].length - 1; continue; }
    if (['"', "'", '`'].includes(ch)) { quote = ch; quoteAt = i; }
  }
  if (comment || rawEnd) return {blocked: true, start: offset, end: offset, prefix: ''};
  const prefix = quote ? text.slice(quoteAt + 1).replace(/\\([\\`'"])/g, '$1') : text.match(/%[^%\s]*%?$|[\p{L}\p{N}._]*$/u)?.[0] || '';
  const start = quote ? quoteAt + 1 : offset - prefix.length;
  const before = text.slice(0, quote ? quoteAt : start);
  const namespace = before.match(/([\p{L}.][\p{L}\p{N}._]*):::{0,1}$/u)?.[1] || '';
  const tableToken = before.match(/(`(?:\\.|[^`])*`|[\p{L}.][\p{L}\p{N}._]*)\$$/u)?.[1];
  const table = tableToken?.startsWith('`') ? tableToken.slice(1, -1).replace(/\\([\\`])/g, '$1') : tableToken;
  const remaining = String(code).slice(offset);
  let suffix = 0;
  if (quote) {
    let escapedSuffix = false, closed = false;
    for (let i = 0; i < remaining.length; i++) {
      if (escapedSuffix) {escapedSuffix=false;continue;}
      if (remaining[i] === '\\') {escapedSuffix=true;continue;}
      if (remaining[i] === quote) {suffix=i;closed=true;break;}
    }
    if (!closed) suffix = (remaining.match(/^[\p{L}\p{N} .,_-]*/u)?.[0] || '').length;
  } else suffix = (remaining.match(prefix.startsWith('%') ? /^[\p{L}\p{N}._]*%?/u : /^[\p{L}\p{N}._]*/u)?.[0] || '').length;
  return {blocked: false, start, end: offset + suffix, prefix, quote, namespace, table, before};
}

/** Completion boundaries for the comma-separated literal column-name fields. */
export function literalListContext(value, offset = value.length) {
  const text = String(value);
  let quote = '', escaped = false, start = 0, end = text.length;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (escaped) {escaped=false;continue;}
    if (quote) {
      if (ch === '\\') escaped=true;
      else if (ch === quote) quote='';
      continue;
    }
    if (['"',"'",'`'].includes(ch) && !text.slice(start,index).trim()) {quote=ch;continue;}
    if (ch === ',' || ch === '\n') {
      if (index < offset) start=index+1;
      else {end=index;break;}
    }
  }
  while (start < offset && /\s/.test(text[start])) start++;
  let prefix=text.slice(start,offset);
  if (['"',"'",'`'].includes(prefix[0])) prefix=prefix.slice(1).replace(/[`"']$/, '').replace(/\\([\\`"'])/g,'$1');
  return {start,end,prefix};
}

export function completionCandidates({code, offset, columns = [], tables = [], symbols = []}) {
  const ctx = completionContext(code, offset);
  if (ctx.blocked) return {...ctx, items: []};
  const chosen = ctx.table ? tables.find(table => table.tableName === ctx.table)?.columns || [] : columns;
  let candidates = chosen.map(column => ({name: column.name, kind: 'column', description: column.type || 'column'}));
  if (!ctx.table) {
    candidates.push(...tables.map(table => ({name: table.tableName, kind: 'table', description: table.label || 'data.table'})));
    if (!ctx.quote || ctx.quote === '`') {
      candidates.push(...R_FUNCTIONS, ...symbols.map(symbol => typeof symbol === 'string' ? {name: symbol, kind: 'object'} : symbol));
      if (!ctx.namespace && !ctx.quote) {
        const call = enclosingCall(code, offset);
        const signature = [...R_FUNCTIONS, ...symbols].find(item => item.name === call?.split(/:::{0,1}/).at(-1))?.signature;
        if (signature?.includes('(')) {
          const args = splitTopLevel(signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')')));
          candidates.push(...args.map(arg => arg.trim().split(/\s*=/)[0]).filter(name => name && name !== '...' && /^[A-Za-z.][\w.]*$/.test(name))
            .map(name => ({name, kind:'argument', text:`${name} = `, description:`${call} argument`} )));
        }
      }
      candidates.push(...['TRUE', 'FALSE', 'NA', 'NA_real_', 'NA_integer_', 'NA_character_', 'NULL', 'Inf', 'NaN', '.N', '.SD', '.SDcols', '.I', '.GRP', '.BY', '.EACHI', 'result', 'source_dt'].map(name => ({name, kind: 'keyword'})));
      const assignment = /(?:^|[\n;])\s*(`(?:\\.|[^`])*`|[\p{L}.][\p{L}\p{N}._]*)\s*(?:<-|=(?!=))/gu;
      for (const match of code.matchAll(assignment)) candidates.push({name: match[1].replace(/^`|`$/g, '').replace(/\\([\\`])/g, '$1'), kind: 'object'});
    }
  }
  if (ctx.namespace) candidates = candidates.filter(item => item.package === ctx.namespace);
  const found = new Map();
  for (const item of candidates) {
    if (!item.name || !item.name.toLocaleLowerCase().startsWith(ctx.prefix.toLocaleLowerCase()) || found.has(item.name)) continue;
    const text = ctx.quote ? item.name.replaceAll('\\', '\\\\').replaceAll(ctx.quote, '\\' + ctx.quote)
      : item.text || (item.kind === 'keyword' || /^%.*%$/.test(item.name) ? item.name : rName(item.name));
    found.set(item.name, {...item, text});
  }
  const priority = {argument: -1, column: 0, table: 1, object: 2, function: 3, keyword: 4};
  return {...ctx, items: [...found.values()].sort((a, b) => (priority[a.kind] ?? 3) - (priority[b.kind] ?? 3) || a.name.localeCompare(b.name)).slice(0, 120)};
}

export function enclosingCall(code, offset = code.length) {
  const tokens = tokenizeR(String(code).slice(0, offset)).filter(token => !['space','comment'].includes(token.type));
  const stack = [];
  tokens.forEach((token,index) => {
    if (token.type === 'open') {
      const previous = tokens[index-1]?.value || '';
      const name = token.value === '(' && /^[\p{L}.][\p{L}\p{N}._]*$/u.test(previous) ? previous : '';
      stack.push({name: name && /^:::{0,1}$/.test(tokens[index-2]?.value || '') ? `${tokens[index-3]?.value}${tokens[index-2].value}${name}` : name});
    } else if (token.type === 'close') stack.pop();
  });
  return stack.findLast(frame => frame.name)?.name || '';
}

export function functionAt(code, offset = code.length) {
  const left = String(code).slice(0, offset), right = String(code).slice(offset);
  const word = (left.match(/[\p{L}\p{N}._:]+$/u)?.[0] || '') + (right.match(/^[\p{L}\p{N}._]+/u)?.[0] || '');
  if (word && (R_FUNCTIONS.some(item => item.name === word.split('::').at(-1)) || /^\s*\(/.test(right.replace(/^[\p{L}\p{N}._]+/u, '')))) return word;
  return enclosingCall(code, offset) || word;
}

/** Explicit user action only: building the URL does not send the code. */
export function errorConsultationURL(error, code) {
  const url = new URL('https://chat.mistral.ai/chat');
  url.searchParams.set('q', `Explain this R error and suggest a correction:\n\n${String(error)}\n\nWhen running this R code:\n\n${String(code)}`);
  return url.href;
}
