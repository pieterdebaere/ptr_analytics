# PTR Analytics tracker

The one-line tracking script of [PTR Analytics](https://github.com/pieterdebaere/ptr_analytics):
privacy-friendly page views, custom events and Speed Insights (Core Web Vitals) for any
website. It is a single dependency-free classic script, about 5.3 KB minified (≈ 2.8 KB gzip),
served by your PTR Analytics server at `/script.js`.

* No cookies, no `localStorage`/`sessionStorage` writes, no fingerprinting. The only storage it
  ever *reads* is the `pa_ignore` opt-out flag.
* Only `window.pa` is added to the page. It never throws into your page.
* Sends only the page's origin, path and `utm_*` parameters, and only the *origin* of an
  external referrer — see [What is sent](#what-is-sent).
* Sends with `fetch(…, {keepalive: true, credentials: 'omit'})` (`text/plain`, so no CORS
  preflight; never sends cookies), falling back to `navigator.sendBeacon` only in browsers
  without `fetch` keepalive support.

## Installation

Create a site in the dashboard, then add this line to the `<head>` of every page:

```html
<script defer src="https://analytics.example.com/script.js" data-site="SITE_ID"></script>
```

Replace `analytics.example.com` with your server and `SITE_ID` with the 12-character site id.
That's it: page views (including client-side navigations) and web vitals are now collected.

The script reads its settings from its own tag (`document.currentScript`). Where that is not
available, it uses the first `<script data-site>` whose `src` ends in `/script.js`, so keep
that file name when you proxy the script through your own domain.

## Script attributes

| attribute              | default                       | meaning |
|------------------------|-------------------------------|---------|
| `data-site`            | (required)                    | Site id. Without it nothing is sent. |
| `data-endpoint`        | `<script origin>/api/event`   | Override the ingest URL (e.g. when proxying through your own domain). |
| `data-auto`            | `true`                        | `false` disables automatic page views (initial load *and* SPA navigations); call `pa.pageview()` yourself. |
| `data-vitals`          | `true`                        | `false` disables Speed Insights (web vitals) collection. |
| `data-vitals-sample`   | `1`                           | Fraction of page loads (0..1) that report web vitals, e.g. `0.25`. |
| `data-respect-dnt`     | `false`                       | `true` = send nothing when the browser sends Do Not Track (`navigator.doNotTrack === "1"`) or Global Privacy Control. |
| `data-allow-localhost` | `false`                       | `true` = also track on `localhost`, `*.localhost`, `127.x.x.x`, `[::1]` and `file:` pages (skipped by default). |
| `data-exclude`         | none                          | Comma-separated path globs that are never tracked (page views, events and vitals). `*` = any characters within one path segment, `**` = anything. A trailing `/**` also matches the prefix itself: `/admin/**` excludes `/admin`, `/admin/` and `/admin/users/1`. Example: `data-exclude="/admin/**,/preview/*"`. At most 20 globs of up to 200 characters each are used (longer ones are ignored). |
| `data-debug`           | `false`                       | `true` = log why something was not sent (invalid input, disabled tracking, a throwing `beforeSend`) with `console.warn`. |

Nothing at all is sent when the page is driven by automation (`navigator.webdriver`), and a
prerendered page is only counted once the visitor actually sees it.

## JavaScript API

```js
pa.track('Signup', { plan: 'pro', seats: 3 }) // custom event with optional props
pa.pageview()                                 // manual page view of the current URL
pa.pageview('/virtual/path')                  // page view of another path on the same origin
pa.beforeSend = (event) => event              // optional hook, see below
```

* **Event names** are strings of 1–100 characters (trimmed).
* **Props** must be a plain object. The server accepts at most 30 keys; values must be strings
  (≤ 500 chars), finite numbers, booleans or `null` — anything else makes the server reject
  the event.
* **`pa.pageview(path)`** only accepts a path starting with a single `/` (e.g. `/checkout/step-2`,
  query strings allowed). Full URLs, protocol-relative `//host` paths and backslashes are rejected.
  Manual page views are always sent, even when the path didn't change.

### Calling `pa` before the script has loaded

Because the script is loaded with `defer`, add this snippet *before* it if you call `pa` early
(inline in the `<head>`, or at the top of your app bundle):

```html
<script>window.pa=window.pa||function(){(window.pa.q=window.pa.q||[]).push(arguments)}</script>
```

Queued calls are replayed in order once the tracker has loaded (after the initial page view):

```js
pa('track', 'Signup', { plan: 'pro' })
pa('pageview')
pa('pageview', '/virtual/path')
```

After loading, `window.pa` keeps working as such a function *and* has `pa.track`,
`pa.pageview` and `pa.beforeSend`. A `pa.beforeSend` set on the stub is kept.

### `pa.beforeSend`

Called with the complete payload just before it is sent — page views, custom events and web
vitals alike. It sees the full `location.href` and `document.referrer`; the reduction described
in [What is sent](#what-is-sent) is applied to whatever it returns:

```js
{ site, type: 'pageview' | 'event' | 'vitals', url, width, referrer?, name?, props?, metrics? }
```

Return the (possibly modified) object to send it, or `null`/`false` to drop it. If the hook
throws, or returns a `url` that is not an absolute URL, the event is dropped (fail closed: the
hook might exist to redact data).

```js
pa.beforeSend = (event) => {
  if (event.url.includes('/internal/')) return null       // drop
  const url = new URL(event.url)
  url.pathname = url.pathname.replace(/\/users\/\d+/, '/users/:id') // redact ids
  return { ...event, url: url.href }
}
```

### What is sent

* `url`: only the origin, the pathname and the `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_term` and `utm_content` query parameters of the page URL (or of the `url` returned by
  `beforeSend`). Every other query parameter and the fragment never leave the browser, so
  tokens such as `?token=…` or `#access_token=…` are not sent. Example:
  `https://example.com/reset?token=SECRET&utm_source=mail#x` is sent as
  `https://example.com/reset?utm_source=mail`. The server stores only the pathname and the
  UTM values.
* `referrer`: only with the first page view of a page load, and only the origin of
  `document.referrer` (`https://www.google.com/search?q=…` → `https://www.google.com/`). It is
  left out when the referrer is the page's own origin or not an `http(s)` URL. The server
  stores only its hostname.
* `width`: `window.innerWidth`, used as a device-type fallback.

## Declarative events

Any click on an element with `data-pa-event` (or on one of its descendants) sends a custom
event. Attributes `data-pa-event-<key>="value"` become props (keys lower-cased, values strings):

```html
<button data-pa-event="Signup" data-pa-event-plan="pro" data-pa-event-location="hero">
  Start free trial
</button>
```

sends `pa.track('Signup', { plan: 'pro', location: 'hero' })`.

## Opting yourself out

To exclude your own visits on a site, open the browser console on that site and run:

```js
localStorage.setItem('pa_ignore', 'true')
```

Nothing is sent from that browser for that site until you run
`localStorage.removeItem('pa_ignore')`. (The tracker only ever reads this key.)

## Page views in single-page apps

With `data-auto` (the default), the tracker patches `history.pushState` / `history.replaceState`
and listens to `popstate`, so client-side navigations are counted automatically — this covers
Next.js, React Router, Vue Router, SvelteKit, Nuxt, Astro view transitions, etc. A page view
is only sent when the **pathname** changes; changes to only the query string or hash
are ignored.

## Speed Insights (web vitals)

LCP, FCP, CLS, INP and TTFB are measured with `PerformanceObserver` (feature-detected; browsers
without support simply report fewer metrics), following the semantics of Google's `web-vitals`
library. They are sent once per page load, in a single `vitals` payload, when the page is first
hidden (tab switch, navigation away, close), and attributed to the URL the page was loaded
with — client-side navigations do not split them. Only metrics that have a value are included.

## Framework notes

### Plain HTML

Add the snippet to the `<head>` of every page (or your shared layout/template):

```html
<head>
  <script defer src="https://analytics.example.com/script.js" data-site="SITE_ID"></script>
</head>
```

### Next.js (App Router)

Use `next/script` in the root layout; navigations are picked up automatically:

```tsx
// app/layout.tsx
import Script from 'next/script'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script
          src="https://analytics.example.com/script.js"
          data-site="SITE_ID"
          strategy="afterInteractive"
        />
      </body>
    </html>
  )
}
```

For the Pages Router, put the same `<Script>` in `pages/_app.tsx`. Typing for custom events:

```ts
// global.d.ts
declare global {
  interface Window {
    pa?: ((...args: unknown[]) => void) & {
      track: (name: string, props?: Record<string, string | number | boolean | null>) => void
      pageview: (path?: string) => void
      beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null | false
    }
  }
}
export {}

// anywhere in a client component
window.pa?.track('Signup', { plan: 'pro' })
```

### React / Vue / other SPAs (Vite, CRA, …)

Add the script tag to `index.html`. Routers that use the History API are tracked
automatically. If your app calls `pa` during startup, also add the queue snippet above the
tracker. To control page views yourself (e.g. to send route templates instead of real paths),
set `data-auto="false"` and call `pa.pageview()` from your router:

```js
// Vue Router
router.afterEach((to) => window.pa?.pageview(to.matched.at(-1)?.path ?? to.path))

// React Router
const location = useLocation()
useEffect(() => { window.pa?.pageview() }, [location.pathname])
```

Hash-based routers (`/#/route`) only change the fragment, which is not tracked; use
`data-auto="false"` and `pa.pageview('/route')` with them.

## Development

```sh
npm run build -w tracker      # -> tracker/dist/script.js, prints minified + gzip size
npm run typecheck -w tracker
npm test -w tracker           # vitest + jsdom
```

MIT licensed.
