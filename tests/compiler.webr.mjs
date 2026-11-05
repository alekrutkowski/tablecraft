/**
 * Optional real R parser checks. With webr@0.6.0 installed:
 *   node tests/compiler.webr.mjs
 * This uses bundled base R only and does not download any R packages.
 */
import assert from 'node:assert/strict';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebR, ChannelType} from 'webr';
import {OPERATIONS} from '../js/catalog.js';
import {buildStep, compilePipeline, defaultsFor, formatRCode, parsePipeline, rString, rName} from '../js/compiler.js';

const webR = new WebR({baseUrl:dirname(fileURLToPath(import.meta.resolve('webr'))) + '/',channelType:ChannelType.PostMessage});
const columns = [{name:'id',type:'integer'},{name:'units',type:'numeric'},{name:'region',type:'character'}];
const sameAST = (left,right) => webR.evalRBoolean(`identical(parse(text = ${rString(left)}, keep.source = FALSE), parse(text = ${rString(right)}, keep.source = FALSE))`);
try {
  await webR.init();
  for (const operation of OPERATIONS) {
    const step = {id:operation.id, op:operation.id, params:defaultsFor(operation.id,columns), enabled:true};
    const expression = buildStep(step);
    assert.equal(await sameAST(expression,formatRCode(expression,{width:60})),true,`${operation.id}: formatting changed the R parse tree`);
    const script = compilePipeline({sourceCode:'sales',steps:[step]}).code;
    const parsed = parsePipeline(script,{previousSteps:[step],columns});
    assert.equal(await sameAST(script,compilePipeline(parsed).code),true,`${operation.id}: visual/text round trip changed the R parse tree`);
  }
  const scripts = [
    'out = sales %>% .[units > 0]\nhead(out, 2L)',
    'out <- sales %>% { .[, flag := TRUE]; . }\nprint(nrow(out))\nout',
    'sales %>% head(n = 2L)',
    'value <- r"-(first line\n  exact literal line)-"\nresult <- sales %>% .[label == value]\nresult',
    'f <- function(x) { x %>% head(n = 2L) }\nf(sales)',
  ];
  for (const script of scripts) assert.equal(await sameAST(script,compilePipeline(parsePipeline(script)).code),true,script);
  for (const name of ['2026 sales', 'if', 'café', 'a`b', 'a\\b', 'a\tb', '中文', 'gross-net', 'a١', '.١']) {
    await webR.evalRVoid(`invisible(parse(text = ${rString(`${rName(name)} <- 1`)}))`);
  }
  console.log(`PASS: ${OPERATIONS.length} operations retain their R parse trees after hard wrapping and Visual/Text round trips; ${scripts.length} custom scripts and 10 quoted-name cases also pass.`);
} finally {
  await webR.close();
}
