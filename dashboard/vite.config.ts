import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The production build must work under a strict CSP
// (`script-src 'self'; style-src 'self'`): no inline scripts or styles.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/script.js': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: false,
    // The modulepreload polyfill is injected as an inline script -> disable.
    modulePreload: { polyfill: false },
    // Never inline assets as data: URIs; everything is served from 'self'.
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    // The minifier drops the `@license` banners of bundled dependencies
    // (React, React Router, ...), so ship their licence texts next to the
    // bundle instead (MIT requires the notice to accompany the code).
    license: { fileName: 'THIRD_PARTY_LICENSES.txt' },
    rolldownOptions: {
      output: {
        // Kept by the minifier (legal comment); points to the notices above.
        postBanner: (chunk) =>
          chunk.isEntry
            ? '/*! Bundles third-party open source code (React, React Router, ...); licenses: /THIRD_PARTY_LICENSES.txt */'
            : '',
      },
    },
  },
});
