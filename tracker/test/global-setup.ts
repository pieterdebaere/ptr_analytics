// Runs in Node (not jsdom): bundles the tracker exactly like build.mjs does and hands the
// code to the tests, which evaluate it inside fresh jsdom windows.
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    bundle: string;
  }
}

export default function setup(project: TestProject) {
  const out = buildSync({
    entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    target: 'es2017',
    minify: true,
    write: false,
  });
  project.provide('bundle', out.outputFiles[0]!.text);
}
