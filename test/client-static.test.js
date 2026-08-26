const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

const root = path.resolve(__dirname, '..');

test('client declares connection state before use', async () => {
  const source = await fs.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(source, /sessionReady=false/);
  assert.doesNotMatch(source, /E\.historyList\.innerHTML/);
});

test('HTML permits zoom and exposes PWA and dialog metadata', async () => {
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /user-scalable=no/);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /aria-labelledby="confirmTitle"/);
  assert.match(html, /for="nameInput"/);
});

test('PWA manifest and mobile accessibility overrides are present', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'public', 'manifest.webmanifest'), 'utf8'));
  const styles = await fs.readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'portrait-primary');
  assert.equal(manifest.icons.some(icon => icon.sizes === 'any'), true);
  assert.match(styles, /\.icon-btn\{width:44px!important;height:44px!important/);
  assert.match(styles, /\.btn,\.difficulty,\.sound-setting\{min-height:44px!important/);
  assert.match(styles, /button:focus-visible/);
});

test('runtime-only room snapshots are ignored and not committed', async () => {
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.room-snapshots\.json$/m);
});
