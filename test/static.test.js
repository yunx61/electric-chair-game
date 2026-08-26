import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('v4 is a static Firebase app with zoomable mobile UI', async () => {
  const [html, pkg] = await Promise.all([read('public/index.html'), read('package.json')]);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /user-scalable\s*=\s*no/i);
  assert.match(html, /maxlength="22"/);
  assert.equal(JSON.parse(pkg).version, '4.0.0');
  assert.doesNotMatch(pkg, /"ws"/);
});

test('Firebase rules default-deny and protect immutable events', async () => {
  const rules = await read('database.rules.json');
  assert.match(rules, /"\.read": false/);
  assert.match(rules, /"\.write": false/);
  assert.match(rules, /!data\.exists\(\) && newData\.exists\(\)/);
  assert.match(rules, /reveal_timeout/);
  assert.match(rules, /90000 <= now/);
});

test('PWA and Firebase Hosting security headers are configured', async () => {
  const [manifest, sw, firebase] = await Promise.all([
    read('public/manifest.webmanifest'),
    read('public/service-worker.js'),
    read('firebase.json')
  ]);
  assert.equal(JSON.parse(manifest).display, 'standalone');
  assert.match(sw, /CACHE_NAME/);
  assert.match(firebase, /Content-Security-Policy/);
  assert.match(firebase, /Referrer-Policy/);
});

test('CI uses current action runtimes and Java 21 for Firebase emulators', async () => {
  const workflow = await read('.github/workflows/ci.yml');
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /pnpm\/action-setup@v6/);
  assert.match(workflow, /actions\/setup-java@v5/);
  assert.match(workflow, /java-version: 21/);
});
