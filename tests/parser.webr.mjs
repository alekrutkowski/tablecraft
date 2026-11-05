/**
 * Optional real-R verification of recovered forms, including their rebuilt R.
 *   TABLECRAFT_R_LIBRARY=/path/to/wasm/library node tests/parser.webr.mjs
 * Uses webr@0.6.0 plus data.table and magrittr in the supplied Wasm library.
 */
import assert from 'node:assert/strict';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebR, ChannelType} from 'webr';
import {buildStep, compilePipeline, parsePipeline, rString} from '../js/compiler.js';
import {recognitionCases, conservativeCases, knownColumns} from './parser-cases.mjs';

const webR = new WebR({baseUrl:dirname(fileURLToPath(import.meta.resolve('webr'))) + '/',channelType:ChannelType.PostMessage});
const sameAST = (a,b) => webR.evalRBoolean(`identical(parse(text = ${rString(a)}, keep.source = FALSE), parse(text = ${rString(b)}, keep.source = FALSE))`);
try {
  await webR.init();
  if (process.env.TABLECRAFT_R_LIBRARY) {
    await webR.FS.mkdir('/parser-library');
    await webR.FS.mount('NODEFS', {root:resolve(process.env.TABLECRAFT_R_LIBRARY)}, '/parser-library');
    await webR.evalRVoid('.libPaths(c("/parser-library", .libPaths()))');
  }
  await webR.evalRVoid(`
    library(data.table)
    library(magrittr)
    sales <- data.table(
      id = 1:4, region = c("A", "B", "A", "B"),
      revenue = c(10, NA_real_, 10, 4), units = c(2L, 3L, 2L, NA_integer_),
      backup = c(8, 9, 10, 11), "gross, net" = c(9, 8, 7, 6),
      date_text = c("2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"),
      date = as.IDate("2024-01-01") + 0:3
    )
    other <- copy(sales[2:3])
    lookup <- data.table(id = 1:4, label = letters[1:4])
  `);
  for (const [expression,op] of recognitionCases) {
    const source = `result <- sales %>% ${expression}\nresult`;
    const parsed = parsePipeline(source,{columns:knownColumns});
    assert.equal(parsed.steps[0].op,op,expression);
    assert.equal(await sameAST(source,compilePipeline(parsed).code),true,`${expression}: unchanged source changed its R AST`);
    const canonical = buildStep({op,params:parsed.steps[0].params});
    const check = `local({
      original <- copy(sales) %>% ${expression}
      rebuilt <- copy(sales) %>% ${canonical}
      same_values <- isTRUE(all.equal(as.data.frame(original), as.data.frame(rebuilt), check.attributes = TRUE))
      same_key <- identical(key(original), key(rebuilt))
      same_indexes <- identical(indices(original), indices(rebuilt))
      isTRUE(same_values && same_key && same_indexes)
    })`;
    let same;
    try { same = await webR.evalRBoolean(check); }
    catch (error) { throw new Error(`${expression}\nCanonical: ${canonical}\n${error.message}`); }
    assert.equal(same,true,`${expression}\nCanonical: ${canonical}`);
  }
  for (const expression of conservativeCases) {
    const source = `result <- sales %>% ${expression}\nresult`;
    assert.equal(await sameAST(source,compilePipeline(parsePipeline(source)).code),true,expression);
  }
  for (const [name,expression] of [
    ['setorderv','data.table::setorderv(cols = "revenue", order = -1L, na.last = TRUE)'],
    ['melt','data.table::melt(id.vars = "region", measure.vars = "revenue", variable.factor = FALSE)'],
    ['shift','.[, lagged := data.table::shift(revenue, n = 2L)]'],
  ]) {
    const parsed = parsePipeline(`result <- sales %>% ${expression}`, {columns:knownColumns});
    const item = parsed.steps[0], canonical = buildStep({op:item.op,params:item.params});
    assert.equal(await webR.evalRBoolean(`local({
      ${name} <- function(...) stop("masked function")
      a <- copy(sales) %>% ${expression}
      b <- copy(sales) %>% ${canonical}
      isTRUE(all.equal(a,b))
    })`),true,`Qualified ${name} must survive the rebuild`);
  }
  console.log(`PASS: ${recognitionCases.length} variants keep their R AST and evaluate identically after rebuilding their visual fields; ${conservativeCases.length} unsupported variants retain their R AST.`);
} finally {
  await webR.close();
}
