import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter(entry => !['.git', 'node_modules', '.openai'].includes(entry.name))
    .map(entry => entry.isDirectory()
      ? filesIn(path.join(directory, entry.name))
      : [path.join(directory, entry.name)]));
  return nested.flat();
}

const files = await filesIn(root);
const relative = file => path.relative(root, file).replaceAll(path.sep, '/');

test('all local HTML assets exist and work beneath a project path', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const assets = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
    .map(match => match[1])
    .filter(url => !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url));
  assert.ok(assets.length, 'The page should link its static assets');
  for (const asset of assets) {
    assert.ok(!asset.startsWith('/'), `Use a relative asset URL for GitHub project Pages: ${asset}`);
    const filename = decodeURIComponent(asset.split(/[?#]/, 1)[0]);
    const target = path.resolve(root, filename);
    const project = path.resolve(root);
    assert.ok(target === project || target.startsWith(project + path.sep), `Asset must be inside the project: ${asset}`);
    const targetStat = await stat(target);
    if (targetStat.isDirectory()) {
      assert.ok((await stat(path.join(target, 'index.html'))).isFile(), `Directory link needs an index.html: ${asset}`);
    } else assert.ok(targetStat.isFile(), `Missing local asset: ${asset}`);
  }
});

test('local JavaScript module imports resolve', async () => {
  const modules = files.filter(file => /\.(?:m?js)$/.test(file) && !relative(file).startsWith('vendor/'));
  for (const module of modules) {
    const source = await readFile(module, 'utf8');
    const imports = [...source.matchAll(/\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)]
      .map(match => match[1]).filter(specifier => specifier.startsWith('.'));
    for (const specifier of imports) {
      assert.ok((await stat(path.resolve(path.dirname(module), specifier))).isFile(),
        `${relative(module)} imports missing module ${specifier}`);
    }
  }
});

test('GitHub Pages workflow deploys the static project with scoped permissions', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(workflow, /pages:\s*write/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.doesNotMatch(workflow, /permissions:\s*write-all/);
  assert.ok((await stat(path.join(root, '.nojekyll'))).isFile());
});

test('original text files have clean URLs and consistent punctuation', async () => {
  const textFiles = files.filter(file =>
    !relative(file).startsWith('vendor/') &&
    /\.(?:html|css|js|mjs|md|json|ya?ml|R)$/.test(file));
  const tracking = /(?:\?|&)(?:utm_[a-z\d_]+|fbclid|gclid|msclkid)=/i;
  const prohibitedDash = String.fromCharCode(0x2014);
  for (const file of textFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, tracking, `Tracking parameter in ${relative(file)}`);
    assert.ok(!source.includes(prohibitedDash), `Inconsistent dash in ${relative(file)}`);
  }
});
