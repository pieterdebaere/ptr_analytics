import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The landing page re-uses the dashboard's shadcn/ui + Bklit components and the globe:
//   '@/…' -> dashboard/src (so the shared components resolve their own '@/' imports)
//   '~/…' -> landing/src
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '../dashboard/src'),
      '~': path.resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    license: { fileName: 'THIRD_PARTY_LICENSES.txt' },
  },
});
