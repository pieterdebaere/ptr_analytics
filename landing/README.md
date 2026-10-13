# PTR Analytics — landing page

The marketing site for PTR Analytics: a static Vite + React + Tailwind page that re-uses the
dashboard's [shadcn/ui](https://ui.shadcn.com) components, [Bklit UI](https://bklit.com) charts and
the 3D globe (`@/…` resolves to `dashboard/src`, `~/…` to `landing/src`). It is deployed on its
own domain, separate from the analytics server.

```bash
# from the repository root
npm install
npm run dev -w landing        # http://localhost:5173 (hot reload)
npm run build -w landing      # typecheck + static build into landing/dist
npm test -w landing           # vitest (price calculator logic)
npx vite preview --port 4173  # in landing/: serve dist/ with the production CSP headers
```

## Configuration (build time)

All settings are Vite environment variables, read once in [`src/config.ts`](src/config.ts)
(defaults in [`src/config.defaults.ts`](src/config.defaults.ts)). Set them in the shell, in
`landing/.env.production` or in your host's build settings. They are baked into the static
files at build time — rebuild after changing them.

| Variable | Default | Used for |
|---|---|---|
| `VITE_APP_URL` | `https://analytics.pieterdebaere.be` | The hosted analytics server: "Start for free" → `${VITE_APP_URL}/signup`, "Log in" → `${VITE_APP_URL}/login`, and the `<script>` snippet. |
| `VITE_REPO_URL` | `https://github.com/pieterdebaere/ptr_analytics` | GitHub links and the `git clone` command in the self-host guide. |
| `VITE_SITE_URL` | – (empty) | Public URL of the landing page itself, e.g. `https://ptr-analytics.example.com`. Enables `<link rel="canonical">`, `og:url` and the absolute `og:image` / Twitter card. Leave empty to omit those tags. |
| `VITE_CONTACT_EMAIL` | – (empty) | Optional contact address shown in the footer and FAQ. When empty, the page points to GitHub issues instead. |

Pricing shown on the page (first website free, €1 per additional website per month) lives in
`PRICING` in `src/config.ts`; keep it in sync with the server's `FREE_SITES` /
`PRICE_PER_SITE_CENTS` (Stripe stays authoritative).

> **TODO:** the hosted service has no public legal pages yet. `LINKS.privacy`, `LINKS.terms` and
> `LINKS.imprint` in `src/config.ts` are `#` placeholders — replace them before going live.

Example:

```bash
VITE_APP_URL=https://analytics.example.com \
VITE_SITE_URL=https://www.example.com \
VITE_CONTACT_EMAIL=hello@example.com \
npm run build -w landing
```

## Deploying `dist/`

`npm run build -w landing` produces a fully static site in `landing/dist/` (HTML, hashed JS/CSS,
the Geist font files, `favicon.svg`, `og.png`, `robots.txt` and `_headers`). Any static host
works. The build needs the whole repository (it imports components from `dashboard/src`) and the
root `node_modules`, so install from the repository root.

### Vercel

Import the repository, set **Root Directory** to `landing` and keep "Include files outside the
root directory" enabled. [`vercel.json`](vercel.json) sets the install command (`cd .. && npm ci`),
build command, output directory and the security headers. Add the `VITE_*` variables under
*Settings → Environment Variables*.

### Netlify

```toml
# netlify.toml (repository root)
[build]
  base = "landing"
  command = "cd .. && npm ci && npm run build -w landing"
  publish = "dist"
```

The security headers come from [`public/_headers`](public/_headers), which is copied into `dist/`.

### Cloudflare Pages

Build command `npm ci && npm run build -w landing`, build output directory `landing/dist`, root
directory `/` (the repository root). `_headers` is picked up automatically. Set the `VITE_*`
variables as build environment variables.

### Any other static host (nginx, Caddy, S3 + CDN, GitHub Pages…)

Upload the contents of `dist/` and configure the headers below. Files under `/assets/` have
content hashes in their names and can be cached forever.

```caddyfile
www.example.com {
    root * /srv/ptr-landing
    file_server
    header {
        Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests"
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
        X-Frame-Options DENY
        Cross-Origin-Opener-Policy same-origin
        Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
        Strict-Transport-Security "max-age=63072000; includeSubDomains"
    }
    @assets path /assets/*
    header @assets Cache-Control "public, max-age=31536000, immutable"
}
```

## Security headers / CSP

The page is built to run under a strict Content Security Policy:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'; upgrade-insecure-requests
```

* No inline `<script>` or `<style>` (the modulepreload polyfill is disabled, assets are never
  inlined) and no third-party origins: the Geist font is bundled, there are no CDNs or trackers.
* React `style` props are applied through the CSSOM, which `style-src 'self'` allows.
* Do **not** pass `centerValue` to the Bklit `Gauge`/`RingCenter`/`PieCenter`: those use
  NumberFlow, which injects a `<style>` element into its shadow root and is blocked by this CSP.
  The demos render their own labels instead.
* `vite preview` sends the same headers (see `vite.config.ts`), so CSP violations show up as
  console errors during a local check.

The same policy is shipped as [`public/_headers`](public/_headers) (Netlify, Cloudflare Pages) and
[`vercel.json`](vercel.json) (Vercel). If you add the PTR Analytics script to the landing page
itself, extend `script-src` and `connect-src` with your `VITE_APP_URL` origin.

## Structure

```
index.html              meta tags (SEO, Open Graph); canonical/og:url injected from VITE_SITE_URL
public/                 favicon.svg, apple-touch-icon.png, og.png (1200×630), robots.txt, _headers
src/config.ts           build-time configuration and links
src/lib/pricing.ts      price calculator logic (+ pricing.test.ts)
src/sections/*          page sections (hero, features, privacy, pricing, self-host, FAQ, …)
src/demos/*             lazy-loaded Bklit chart demos and the hero globe (fake data)
src/components/*        landing-only building blocks (header, code block, theme toggle, …)
```

Heavy parts are code-split: the chart demos load when they scroll near the viewport, the globe
loads right after the first paint. The theme is dark by default; the visitor's choice is stored
in `localStorage` (a first-party UI preference — the page sets no cookies).
