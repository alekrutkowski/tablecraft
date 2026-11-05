/** Primary R/data.table documentation, shared by forms and editor hints. */
const dataTablePages = {
  '[':'data.table', '[.data.table':'data.table', '.':'data.table', 'data.table':'data.table',
  'as.data.table':'as.data.table', 'is.data.table':'as.data.table', ':=':'assign', let:'assign',
  '.N':'special-symbols', '.I':'special-symbols', '.SD':'special-symbols', '.SDcols':'special-symbols',
  '.BY':'special-symbols', '.GRP':'special-symbols', '.NGRP':'special-symbols', '.EACHI':'special-symbols',
  fread:'fread', fwrite:'fwrite', copy:'copy', set:'assign', setDT:'setDT', setDF:'setDF',
  setnames:'setnames', setcolorder:'setcolorder', setorder:'setorder', setorderv:'setorder',
  setkey:'setkey', setkeyv:'setkey', key:'setkey', haskey:'setkey',
  setindex:'setkey', setindexv:'setkey', indices:'setkey',
  unique:'duplicated', uniqueN:'duplicated', duplicated:'duplicated', anyDuplicated:'duplicated',
  nafill:'nafill', setnafill:'nafill', 'na.omit':'na.omit.data.table',
  shift:'shift', rleid:'rleid', rleidv:'rleid', rowid:'rowid', rowidv:'rowid',
  frank:'frank', frankv:'frank', fifelse:'fifelse', fcase:'fcase', fcoalesce:'coalesce',
  frollmean:'froll', frollsum:'froll', frollmin:'froll', frollmax:'froll', frollprod:'froll',
  frollmedian:'froll', frollvar:'froll', frollsd:'froll', frollapply:'frollapply',
  first:'last', last:'last', between:'between', '%between%':'between', inrange:'between', '%inrange%':'between',
  like:'like', '%like%':'like', '%ilike%':'like', '%flike%':'like', '%plike%':'like',
  '%chin%':'chmatch', chmatch:'chmatch', chmatchdup:'chmatch',
  melt:'melt.data.table', dcast:'dcast.data.table', patterns:'patterns', measure:'measure', measurev:'measure',
  transpose:'transpose', tstrsplit:'tstrsplit', CJ:'J', J:'J', SJ:'J',
  merge:'merge', mergelist:'mergelist', setmergelist:'mergelist', foverlaps:'foverlaps', rbindlist:'rbindlist',
  fintersect:'setops', funion:'setops', fsetdiff:'setops', fsetequal:'setops',
  'as.IDate':'IDateTime', 'as.ITime':'IDateTime', IDate:'IDateTime', ITime:'IDateTime',
  year:'IDateTime', quarter:'IDateTime', month:'IDateTime', week:'IDateTime', isoweek:'IDateTime',
  isoyear:'IDateTime', yday:'IDateTime', mday:'IDateTime', wday:'IDateTime', hour:'IDateTime',
  minute:'IDateTime', second:'IDateTime', yearmon:'IDateTime', yearqtr:'IDateTime',
};
const basePages = {
  stopifnot:'stopifnot', stop:'stop', warning:'warning', message:'message', library:'library', require:'library',
  requireNamespace:'ns-load', loadNamespace:'ns-load', getNamespaceExports:'ns-reflect',
  c:'c', list:'list', 'data.frame':'data.frame', matrix:'matrix', array:'array',
  'as.numeric':'numeric', 'as.double':'double', 'as.integer':'integer', 'as.character':'character',
  'as.logical':'logical', 'as.factor':'factor', factor:'factor', 'as.Date':'as.Date',
  'as.POSIXct':'as.POSIXlt', 'as.POSIXlt':'as.POSIXlt', 'as.data.frame':'as.data.frame',
  'is.numeric':'numeric', 'is.integer':'integer', 'is.character':'character', 'is.logical':'logical',
  'is.factor':'factor', 'is.list':'list', 'is.na':'NA', anyNA:'NA', 'is.finite':'is.finite',
  'is.infinite':'is.finite', 'is.nan':'is.finite', 'is.null':'NULL', 'isTRUE':'Logic',
  mean:'mean', sum:'sum', prod:'prod', min:'Extremes', max:'Extremes', pmin:'Extremes', pmax:'Extremes',
  range:'range', length:'length', lengths:'lengths', nrow:'nrow', ncol:'nrow', dim:'dim',
  names:'names', colnames:'colnames', rownames:'colnames', class:'class', typeof:'typeof', inherits:'class',
  unique:'unique', duplicated:'duplicated', anyDuplicated:'duplicated', match:'match', '%in%':'match',
  all:'all', any:'any', 'all.equal':'all.equal', identical:'identical', which:'which',
  'which.min':'which.min', 'which.max':'which.min', ifelse:'ifelse',
  seq:'seq', seq_len:'seq', seq_along:'seq', rep:'rep', sample:'sample', 'sample.int':'sample',
  'set.seed':'Random', sort:'sort', order:'order', rank:'rank', 'is.unsorted':'is.unsorted',
  lapply:'lapply', sapply:'lapply', vapply:'lapply', mapply:'mapply', Map:'funprog', Reduce:'funprog',
  Filter:'funprog', Find:'funprog', Negate:'funprog', Position:'funprog', apply:'apply', tapply:'tapply',
  'do.call':'do.call', get:'get', mget:'get', assign:'assign', exists:'exists', rm:'remove', ls:'ls',
  paste:'paste', paste0:'paste', sprintf:'sprintf', format:'format', print:'print', cat:'cat',
  grepl:'grep', grep:'grep', gsub:'grep', sub:'grep', strsplit:'strsplit', nchar:'nchar',
  nzchar:'nchar', substr:'substr', substring:'substr', trimws:'trimws', toupper:'chartr', tolower:'chartr',
  round:'Round', signif:'Round', floor:'Round', ceiling:'Round', trunc:'Round', abs:'MathFun',
  sqrt:'MathFun', exp:'Log', log:'Log', log10:'Log', log2:'Log',
  cumsum:'cumsum', cumprod:'cumsum', cummin:'cumsum', cummax:'cumsum',
  rowSums:'colSums', rowMeans:'colSums', colSums:'colSums', colMeans:'colSums',
  table:'table', 'prop.table':'prop.table', cut:'cut', split:'split', interaction:'interaction',
  union:'sets', intersect:'sets', setdiff:'sets', setequal:'sets',
  'try':'try', tryCatch:'conditions', withCallingHandlers:'conditions', 'on.exit':'on.exit',
  function:'function', if:'Control', else:'Control', for:'Control', while:'Control', repeat:'Control',
  return:'function', local:'eval', eval:'eval', parse:'parse', deparse:'deparse', quote:'substitute',
  substitute:'substitute', expression:'expression', options:'options', getOption:'options',
};
const statsPages = {
  sd:'sd', var:'cor', cov:'cor', cor:'cor', median:'median', quantile:'quantile', IQR:'IQR', mad:'mad',
  lm:'lm', glm:'glm', predict:'predict', aggregate:'aggregate', 'complete.cases':'complete.cases',
  'na.omit':'na.fail', 't.test':'t.test', 'wilcox.test':'wilcox.test', 'chisq.test':'chisq.test',
  'cor.test':'cor.test', 'fisher.test':'fisher.test', rnorm:'Normal', dnorm:'Normal', pnorm:'Normal', qnorm:'Normal',
  runif:'Uniform', dunif:'Uniform', punif:'Uniform', qunif:'Uniform',
};
const utilsPages = {head:'head', tail:'head', str:'str', help:'help', '?':'help', apropos:'apropos', 'help.search':'help.search',
  'read.csv':'read.table', 'read.delim':'read.table', 'read.table':'read.table', 'read.fwf':'read.fwf',
  'write.csv':'write.table', 'write.table':'write.table', 'install.packages':'install.packages',
  packageVersion:'packageDescription', sessionInfo:'sessionInfo'};
const graphicsPages = {plot:'plot', hist:'hist', boxplot:'boxplot', barplot:'barplot', pairs:'pairs', lines:'lines', points:'points', abline:'abline', legend:'legend', title:'title', par:'par'};
const baseURL = 'https://stat.ethz.ch/R-manual/R-devel/library/';

export function documentationFor(functionName, packageName = '') {
  let name = String(functionName || '').replace(/^`|`$/g, '');
  const qualified = /^([A-Za-z][A-Za-z0-9.]*):::{0,1}(.+)$/.exec(name);
  if (qualified) { packageName = qualified[1]; name = qualified[2].replace(/^`|`$/g, ''); }
  if (packageName === 'magrittr' || ['%>%','%<>%','%$%','%T>%'].includes(name)) {
    const page = ({'%>%':'pipe','%<>%':'compound','%$%':'exposition','%T>%':'tee'})[name] || 'pipe';
    return `https://magrittr.tidyverse.org/reference/${page}.html`;
  }
  if ((!packageName || packageName === 'data.table') && dataTablePages[name]) return `https://rdatatable.gitlab.io/data.table/reference/${dataTablePages[name]}.html`;
  for (const [pkg, pages] of [['base',basePages],['stats',statsPages],['utils',utilsPages],['graphics',graphicsPages]]) {
    if ((!packageName || packageName === pkg) && pages[name]) return `${baseURL}${pkg}/html/${pages[name]}.html`;
  }
  if (packageName && !['base','stats','utils','graphics','grDevices','methods','datasets'].includes(packageName)) {
    return `https://cran.r-project.org/web/packages/${encodeURIComponent(packageName)}/${encodeURIComponent(packageName)}.pdf`;
  }
  return `https://search.r-project.org/?P=${encodeURIComponent(name)}`;
}

export const GENERAL_R_FUNCTIONS = [...new Set([...Object.keys(basePages), ...Object.keys(statsPages), ...Object.keys(utilsPages), ...Object.keys(graphicsPages)])];
