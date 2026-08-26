import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))).replaceAll('\\', '/');

await build({
  absWorkingDir: root,
  entryPoints: ['src/firebase-entry.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  outfile: 'public/js/vendor/firebase.js'
});
