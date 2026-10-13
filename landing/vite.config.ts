import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { CONFIG_DEFAULTS } from './src/config.defaults.ts';

/**
 * Content-Security-Policy the landing page is built for. Also sent by `vite preview` so a
 * local preview catches CSP violations; copy it to your host (see README / public/_headers).
 */
export const LANDING_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': LANDING_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Injects the tags that need an absolute URL (canonical, og:url, og:image) from VITE_SITE_URL. */
function seoTags(siteUrl: string): Plugin {
  return {
    name: 'landing-seo-tags',
    transformIndexHtml(html) {
      const base = siteUrl.trim().replace(/\/+$/, '');
      let tags = '';
      if (/^https?:\/\//.test(base)) {
        const u = escapeAttr(base);
        tags = [
          `<link rel="canonical" href="${u}/" />`,
          `<meta property="og:url" content="${u}/" />`,
          `<meta property="og:image" content="${u}/og.png" />`,
          `<meta property="og:image:width" content="1200" />`,
          `<meta property="og:image:height" content="630" />`,
          `<meta property="og:image:alt" content="PTR Analytics — privacy-friendly web analytics for all your websites" />`,
          `<meta name="twitter:card" content="summary_large_image" />`,
          `<meta name="twitter:image" content="${u}/og.png" />`,
        ].join('\n    ');
      } else {
        tags = '<meta name="twitter:card" content="summary" />';
      }
      return html.replace(/<!-- %ABSOLUTE_URL_TAGS%[^>]*-->/, tags);
    },
  };
}

// The landing page re-uses the dashboard's shadcn/ui + Bklit components and the globe:
//   '@/…' -> dashboard/src (so the shared components resolve their own '@/' imports)
//   '~/…' -> landing/src
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_');
  return {
    plugins: [react(), tailwindcss(), seoTags(env.VITE_SITE_URL ?? CONFIG_DEFAULTS.siteUrl)],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '../dashboard/src'),
        '~': path.resolve(import.meta.dirname, 'src'),
      },
    },
    preview: { headers: SECURITY_HEADERS },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      // The modulepreload polyfill is an inline script -> disabled for the strict CSP.
      modulePreload: { polyfill: false },
      // Never inline assets as data: URIs; everything is served from 'self'.
      assetsInlineLimit: 0,
      license: { fileName: 'THIRD_PARTY_LICENSES.txt' },
    },
  };
});
