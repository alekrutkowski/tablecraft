/** Optional actual R parser checks: node tests/comments.webr.mjs */
import assert from 'node:assert/strict';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebR, ChannelType} from 'webr';
import {compilePipeline, rString, stripRComments, reconcileRComments, formatRCode} from '../js/compiler.js';
import {commentCases} from './comment-cases.mjs';

const webR = new WebR({baseUrl:dirname(fileURLToPath(import.meta.resolve('webr'))) + '/', channelType:ChannelType.PostMessage});
const sameAST = async (left, right) => {
  if (left.includes('\r') || right.includes('\r')) {
    // R's documented CRLF/CR support applies to file/connection input.
    // CodeMirror supplies LF to parse(text); exported files retain their EOLs.
    await webR.FS.writeFile('/tmp/comments-before.R', new TextEncoder().encode(left));
    await webR.FS.writeFile('/tmp/comments-after.R', new TextEncoder().encode(right));
    return webR.evalRBoolean('identical(parse(file = "/tmp/comments-before.R", keep.source = FALSE), parse(file = "/tmp/comments-after.R", keep.source = FALSE))');
  }
  return webR.evalRBoolean(`identical(parse(text = ${rString(left)}, keep.source = FALSE), parse(text = ${rString(right)}, keep.source = FALSE))`);
};
let count = 0;
try {
  await webR.init();
  for (const {name, source} of commentCases) {
    assert.equal(await sameAST(source, stripRComments(source)), true, name);
    count += 1;
  }
  for (const expression of ['r"-(\n"# literal\n)-" # comment', '1 %#% 2 # comment', '`a#b` # comment']) {
    const options = {steps:[{id:'custom', op:'custom', params:{expression}}, {id:'head', op:'head-tail', params:{n:2}}]};
    const shown = compilePipeline(options), hidden = compilePipeline({...options, includeComments:false});
    assert.equal(await sameAST(shown.code, hidden.code), true, expression);
    count += 1;
  }
  const old = '# data\nout <- list(alpha = 1, beta = 2, gamma = 3, delta = 4) # values\nout # result\n';
  const changed = formatRCode(stripRComments(old).replace('alpha = 1', 'alpha = 2'), {width:30});
  const restored = reconcileRComments(old, changed);
  assert.equal(await sameAST(changed, restored), true, 'edited and wrapped code with restored comments');
  count += 1;
  console.log(`PASS: ${count} actual R parse-tree checks for comment filtering, safe pipe insertion and edited comment restoration.`);
} finally {
  await webR.close();
}
