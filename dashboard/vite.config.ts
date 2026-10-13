import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The production build must work under a strict CSP
// (`script-src 'self'; style-src 'self'`): no inline scripts or styles.
export default defineConfig({
  plugins: [react()],
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
  },
});
