// Builds the tracker into a single minified classic-script IIFE: dist/script.js
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const outfile = `${root}dist/script.js`;

await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2017',
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  banner: {
    js: `/*! PTR Analytics v${version} | MIT License | https://github.com/pieterdebaere/ptr_analytics */`,
  },
  logLevel: 'warning',
});

const code = readFileSync(outfile);
const kb = (n) => `${n} B (${(n / 1024).toFixed(2)} KB)`;
console.log(`dist/script.js  minified: ${kb(code.length)}  gzip: ${kb(gzipSync(code, { level: 9 }).length)}`);
