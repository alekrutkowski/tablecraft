/**
 * Real R checks for plain-text function help. Requires webr@0.6.0.
 * TABLECRAFT_R_LIBRARY can point to a compatible Wasm R library.
 * Run: node tests/help.webr.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanHelpText, REngine } from '../js/runtime.js';

const module = process.env.TABLECRAFT_WEBR_MODULE
  ? pathToFileURL(resolve(process.env.TABLECRAFT_WEBR_MODULE)).href
  : import.meta.resolve('webr');
const baseUrl = dirname(fileURLToPath(module)) + '/';
let moduleUrl = module, bridgeDirectory;
if (process.env.TABLECRAFT_R_LIBRARY) {
  const parent = process.env.TABLECRAFT_TEST_TMP || tmpdir();
  await mkdir(parent, { recursive: true });
  bridgeDirectory = await mkdtemp(join(parent, 'tablecraft-help-'));
  const bridge = join(bridgeDirectory, 'bridge.mjs');
  await writeFile(bridge, `
import { WebR as OriginalWebR, ChannelType } from ${JSON.stringify(module)};
export { ChannelType };
export class WebR extends OriginalWebR {
  async init() {
    const result = await super.init();
    await this.FS.mkdir('/help-library');
    await this.FS.mount('NODEFS', { root: ${JSON.stringify(resolve(process.env.TABLECRAFT_R_LIBRARY))} }, '/help-library');
    await this.evalRVoid('.libPaths(c("/help-library", .libPaths()))');
    return result;
  }
  async installPackages(packages) {
    for (const name of Array.isArray(packages) ? packages : [packages]) {
      if (!await this.evalRBoolean('base::requireNamespace(' + JSON.stringify(name) + ', quietly = TRUE)')) {
        throw new Error('Local compatible Wasm package missing: ' + name);
      }
    }
  }
}
`);
  moduleUrl = pathToFileURL(bridge).href;
}
const engine = new REngine({ moduleUrl, baseUrl });
const pages = [];
const terminalControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
try {
  await engine.init();
  const webR = engine._webR;
  const result = await engine.run('data.table(id = 1:2)');
  await webR.evalRVoid('tools::Rd2txt_options(underline_titles = TRUE); .help_options_before <- tools::Rd2txt_options()');
  for (const topic of ['setorderv', 'fread']) {
    const quoted = JSON.stringify(topic);
    const legacy = await webR.evalRString(`paste(utils::capture.output(tools::Rd2txt(
      utils:::.getHelpFile(utils::help(${quoted}, package = "data.table")[1L])
    )), collapse = "\\n")`);
    assert.match(legacy, /\u0008/, `${topic}: legacy output should reproduce the reported overstrike issue`);

    const raw = JSON.parse(await webR.evalRString(`.tc$help(${quoted}, "data.table")`));
    const help = await engine.helpFor(topic, 'data.table');
    assert.equal(help.topic, topic);
    assert.equal(help.package, 'data.table');
    assert.ok(help.text.length > 1000, `${topic}: expected the full documentation page`);
    assert.doesNotMatch(raw.text, terminalControls, `${topic}: R rendering should be clean before JavaScript cleanup`);
    assert.doesNotMatch(help.text, terminalControls, `${topic}: helpFor should return plain text`);
    for (const heading of ['Description:', 'Usage:', 'Arguments:', 'Examples:']) assert.ok(help.text.includes(heading), `${topic}: missing ${heading}`);
    assert.equal(help.text, raw.text, `${topic}: plain R output should pass through unchanged`);
    assert.equal(cleanHelpText(legacy), help.text, `${topic}: cached legacy help should recover the same text`);
    pages.push({ topic, package: help.package, characters: help.text.length, rawTextClean: true, legacyTextRecovered: true });
    console.log(`PASS: ${topic} help, plain R output, browser cleanup, and cached legacy text (${help.text.length} characters).`);
  }
  assert.equal(await webR.evalRBoolean('identical(tools::Rd2txt_options(), .help_options_before)'), true);
  assert.deepEqual((await engine.preview()).rows, result.rows);
  assert.equal((await engine.helpFor('tablecraft_no_such_help_topic', 'data.table')).text, null);
  console.log('PASS: help leaves R formatting options and the pipeline result unchanged; missing topics remain null.');
  if (process.env.TABLECRAFT_HELP_REPORT) await writeFile(process.env.TABLECRAFT_HELP_REPORT, JSON.stringify({
    verifiedAt: new Date().toISOString(), runtime: 'Production REngine in Node webR',
    packageDelivery: process.env.TABLECRAFT_R_LIBRARY ? 'Compatible Wasm packages mounted locally' : 'webR package installer',
    versions: engine.versions, pages, formattingOptionsUnchanged: true, pipelineResultUnchanged: true, missingTopicIsNull: true
  }, null, 2) + '\n');
} finally {
  await engine.close();
  if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true });
}
