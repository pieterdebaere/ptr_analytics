# PTR Analytics — Technical specification

PTR Analytics is a self-hosted, privacy-friendly alternative to Vercel Web Analytics
and Vercel Speed Insights. One server (e.g. `https://analytics.example.com`) hosts a
central dashboard for **all** websites you connect. A website is connected by adding
one line to its `<head>`:

```html
<script defer src="https://analytics.example.com/script.js" data-site="SITE_ID"></script>
```

This document is the contract between the three packages. Anything not specified here
is an implementation detail of the package that owns it.

## 1. Repository layout

```
/package.json            npm workspaces root ("tracker", "dashboard", "server")
/tsconfig.base.json      shared strict TS options
/tracker                 the tracking script (TypeScript -> one minified IIFE file)
  dist/script.js         build output, served by the server at GET /script.js
/dashboard               React + Vite + TypeScript single page app
  dist/                  build output, served by the server as static files
/server                  Fastify + better-sqlite3 (TypeScript, ESM, compiled with tsc)
  dist/index.js          server entry point
  dist/cli.js            admin CLI (create users, reset passwords)
/docs                    documentation (this file)
```

* Node.js >= 22, ESM everywhere (`"type": "module"`).
* Keep runtime dependencies to an absolute minimum (this is a public, security-sensitive
  project — every dependency is supply-chain risk). Prefer `node:` built-ins.
* Tests: `vitest` in each package (`npm test` runs `vitest run`).
* Each package has `build`, `test` and `typecheck` scripts.

## 2. Privacy model (must hold everywhere)

* **No cookies, no localStorage identifiers, no fingerprint stored.** The tracker never
  writes to storage. It may only *read* `localStorage.pa_ignore` (opt-out flag).
* **IP addresses are never stored or logged.** (Disable Fastify request logging of IPs
  or make sure IPs are not part of log lines for `/api/event`.)
* Visitor identifier = first 16 bytes (hex) of
  `sha256(daily_salt || site_id || client_ip || user_agent)` where every part is
  length-prefixed (unambiguous concatenation).
  `daily_salt` is 32 random bytes generated per UTC day, stored in the `salts` table, and
  **deleted when the day is over** (only the current day's salt is kept; SQLite
  `secure_delete` + WAL truncation make sure the bytes are really gone), so visitor ids
  cannot be linked across days nor reversed.
* Only the URL **pathname** is stored (no query string, no fragment). UTM parameters are
  extracted from the query string; everything else in the query string is discarded.
* For referrers only the **hostname** is stored (leading `www.` stripped). Referrers equal
  to the page's own hostname are treated as internal (stored as NULL).

## 3. Tracking script (`/tracker`)

### 3.1 Usage

```html
<script defer src="https://analytics.example.com/script.js" data-site="SITE_ID"></script>
```

Supported attributes on the script tag:

| attribute              | default            | meaning |
|------------------------|--------------------|---------|
| `data-site`            | (required)         | site id |
| `data-endpoint`        | `<script origin>/api/event` | override ingest URL |
| `data-auto`            | `true`             | `false` disables automatic pageviews (call `pa.pageview()` yourself) |
| `data-vitals`          | `true`             | `false` disables Speed Insights (web vitals) collection |
| `data-vitals-sample`   | `1`                | sample rate 0..1 for vitals |
| `data-respect-dnt`     | `false`            | `true` = do nothing when `navigator.doNotTrack === "1"` or `globalPrivacyControl` |
| `data-allow-localhost` | `false`            | track on `localhost`, `127.0.0.1`, `[::1]`, `file:` (otherwise skipped) |
| `data-exclude`         | none               | comma separated path globs (`*` = any chars within segment, `**` = anything), e.g. `/admin/**,/preview/*`; at most 20 globs of ≤ 200 chars, matched without backtracking (O(path length × glob length)) |

Global API (`window.pa`):

```js
pa.track('Signup', { plan: 'pro', seats: 3 })   // custom event
pa.pageview()                                   // manual pageview of current URL
pa.pageview('/virtual/path')                    // manual pageview of another path (same origin)
pa.beforeSend = (event) => event | null         // optional hook: modify (e.g. redact url) or drop
```

Calls made before the script loads must not be lost. Document this queue snippet:

```html
<script>window.pa=window.pa||function(){(window.pa.q=window.pa.q||[]).push(arguments)}</script>
```
…so `pa('track', 'Signup', {plan:'pro'})` / `pa('pageview')` also work and queued calls
are replayed on load. After load `window.pa` is a function that dispatches the same way
*and* has `.track`, `.pageview` methods and the optional `.beforeSend` property.

Declarative events: any click on an element (or ancestor) with
`data-pa-event="Name"` sends a custom event; attributes `data-pa-event-<key>="value"`
become props (`<key>` lower-case).

Opt-out: if `localStorage.getItem('pa_ignore') === 'true'` nothing is sent (wrap in
try/catch — storage may throw).

### 3.2 Behaviour

* Pageview sent on load (unless `data-auto="false"`) and on SPA navigations
  (`history.pushState` / `replaceState` patched + `popstate`); do not send a pageview
  if the pathname is unchanged from the last sent pageview (query/hash changes alone
  don't count).
* Skips: excluded paths, localhost (unless allowed), DNT (if respected), opt-out,
  prerendering (`document.visibilityState === 'prerender'` → wait until visible),
  automation (`navigator.webdriver === true`).
* Settings come from `document.currentScript`; when that is null, from the first
  `script[data-site]` whose `src` ends with `/script.js` (never an arbitrary `[data-site]` tag).
* Data minimisation (after `beforeSend`, which still receives the full `location.href` /
  `document.referrer` and may rewrite them): the sent `url` is `origin + pathname` plus only
  the `utm_source|medium|campaign|term|content` query parameters; the fragment is always
  dropped. The sent `referrer` is reduced to its origin (`https://host/`) and omitted when it
  is same-origin or not `http(s)`. A `url` that is not an absolute URL drops the event.
* Transport: `fetch(endpoint, {method:'POST', body: json, keepalive: true,
  headers:{'Content-Type':'text/plain'}, credentials: 'omit'})` — `text/plain` without custom
  headers is a CORS-simple request (no preflight; the server answers
  `Access-Control-Allow-Origin: *`) and keepalive survives page unload. Only when `fetch`
  keepalive is unavailable (no `fetch`/`Request`, `'keepalive' in Request.prototype` false, or
  `fetch` throws synchronously) fall back to
  `navigator.sendBeacon(endpoint, new Blob([json], {type: 'text/plain'}))`, which cannot omit
  credentials. A rejected fetch is not retried.
* Web vitals (Speed Insights): collect **LCP, FCP, CLS, INP, TTFB** with
  `PerformanceObserver` (implement it yourself, no dependency; follow the web-vitals
  library semantics: LCP finalised on first input / hidden, CLS = max session window,
  INP = ~p98 of interaction durations (event timing, `durationThreshold: 40`),
  TTFB = navigation `responseStart - activationStart` clamped ≥ 0, FCP = `first-contentful-paint`
  entry). Metrics are attributed to the path of the initial page load. Send them in one
  `vitals` payload when the page becomes hidden (`visibilitychange` → hidden, or `pagehide`),
  at most once per page load (send again only metrics that changed, e.g. CLS/INP after bfcache restore is out of scope — just once).
* The built file must be small (target < 4 KB minified, no external dependencies),
  must not throw on old browsers (feature-detect everything), must not leak globals other
  than `window.pa`, and must be valid as a classic script.

### 3.3 Ingest payload — `POST /api/event`

Body is JSON (sent as `text/plain` or `application/json`), max **8 KB**:

```jsonc
{
  "site": "k3j9x0abcd12",           // required
  "type": "pageview",               // "pageview" | "event" | "vitals"
  "url": "https://example.com/blog/post?utm_source=x", // required, absolute http(s) URL of the page (tracker sends origin + path + utm_* only)
  "referrer": "https://google.com/", // optional, origin of document.referrer (omitted when none, same-origin or not http(s))
  "width": 1280,                    // optional, window.innerWidth (device fallback)
  "name": "Signup",                 // required for type "event"
  "props": { "plan": "pro" },       // optional for type "event"
  "metrics": [ { "name": "LCP", "value": 1234.5 } ] // required for type "vitals"
}
```

## 4. Server (`/server`)

### 4.1 Configuration (environment variables)

| var | default | meaning |
|-----|---------|---------|
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | the Docker image sets `0.0.0.0` |
| `DATA_DIR` | `./data` | directory for `analytics.db` (created if missing) |
| `PUBLIC_URL` | (none) | public origin of the dashboard, e.g. `https://analytics.example.com`. Used for CSRF origin checks and the install snippet. Strongly recommended; warn on startup if missing. |
| `TRUST_PROXY` | `false` | `false`, `true`, a hop count (`1`), or comma separated IPs/CIDRs. Passed to Fastify `trustProxy`. Client IP comes from `request.ip`. **Never** read `X-Forwarded-For` manually. |
| `COOKIE_SECURE` | `true` if `PUBLIC_URL` starts with `https://`, else `false` | |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | (none) | if the `users` table is empty on startup and both are set, create this admin. Password min 12 chars. |
| `RETENTION_DAYS` | `0` | delete analytics data older than N days (0 = keep forever) |
| `GEOIP_DB_PATH` | `<DATA_DIR>/geoip-country.mmdb` | MaxMind-format country database (DB-IP Lite or GeoLite2 Country). Optional; if missing, countries are unknown. |
| `GEOIP_AUTO_DOWNLOAD` | `false` | `true` = download DB-IP "IP to Country Lite" (CC BY 4.0) on startup when missing or older than 35 days, and refresh monthly. |
| `GEOIP_HEADER` | (none) | name of a trusted header containing an ISO country code set by your proxy/CDN (e.g. `cf-ipcountry`). Only read when configured. Takes precedence over the DB. |
| `INGEST_RATE_LIMIT` | `600` | max ingest requests per client IP per minute |
| `LOG_LEVEL` | `info` | |

### 4.2 Database (SQLite via better-sqlite3, WAL mode, `foreign_keys=ON`)

Owned by the server. Migrations run on startup (versioned with `PRAGMA user_version`).
Minimum schema:

```sql
users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','viewer')),
      created_at INTEGER NOT NULL)
auth_sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)
sites(id TEXT PRIMARY KEY, name TEXT NOT NULL, domains TEXT NOT NULL /* JSON array */,
      created_at INTEGER NOT NULL)
salts(day TEXT PRIMARY KEY /* YYYY-MM-DD UTC */, salt BLOB NOT NULL)
sessions(id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      visitor_id TEXT NOT NULL, started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      pageviews INTEGER NOT NULL DEFAULT 0)
events(id INTEGER PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL /* ms epoch */, type TEXT NOT NULL CHECK(type IN ('pageview','event')),
      name TEXT, visitor_id TEXT NOT NULL, session_id TEXT NOT NULL,
      hostname TEXT NOT NULL, path TEXT NOT NULL, referrer TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
      country TEXT, device TEXT, browser TEXT, os TEXT, props TEXT /* JSON object */)
vitals(id INTEGER PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL, metric TEXT NOT NULL CHECK(metric IN ('LCP','FCP','CLS','INP','TTFB')),
      value REAL NOT NULL, hostname TEXT NOT NULL, path TEXT NOT NULL,
      country TEXT, device TEXT, browser TEXT, os TEXT)
```

Indexes at least on `events(site_id, ts)`, `events(site_id, type, ts)`,
`sessions(site_id, visitor_id, last_seen_at)`, `vitals(site_id, metric, ts)`.

Sessions: an event joins the visitor's most recent session if its `last_seen_at` is within
30 minutes, otherwise a new session (random id) is created. Pageviews increment
`sessions.pageviews`. **Bounce rate** = sessions with `pageviews <= 1` / sessions.

Site ids: 12 chars, random, alphabet `[a-z0-9]`, generated with `crypto.randomInt`.

### 4.3 Ingest — `POST /api/event`

* CORS: `Access-Control-Allow-Origin: *`, methods `POST, OPTIONS`, header `Content-Type`,
  `Access-Control-Max-Age: 86400`. No credentials. Handle `OPTIONS` preflight (204).
* Accept `text/plain` and `application/json`, body limit 8 KB. Parse JSON safely.
* Validation (reject with `400 {"error":"invalid payload"}` — keep error generic):
  * `site`: `/^[a-z0-9]{12}$/` and must exist.
  * `url`: ≤ 2048 chars, absolute `http:`/`https:` URL. Its hostname must match one of
    the site's domains (see 4.4). If the `Origin` request header is present (and not `null`)
    its hostname must also match.
  * `type` one of the three values.
  * `referrer`: optional string ≤ 2048, parsed as http(s) URL, else ignored.
  * `width`: optional integer 0..100000.
  * `name` (event): trimmed string 1..100 chars, no control chars.
  * `props`: optional plain object, ≤ 30 keys, key 1..100 chars, values string (≤ 500 chars,
    truncated), finite number, boolean or null. Anything else → reject.
  * `metrics` (vitals): array 1..5 of `{name, value}`, `name` ∈ LCP|FCP|CLS|INP|TTFB,
    unique names, `value` finite, `0 ≤ value ≤ 600000` (CLS `0 ≤ value ≤ 100`).
  * Stored strings are truncated: path ≤ 1024, utm_* ≤ 256, hostname ≤ 253.
* Bots (UA regex: bot, crawl, spider, slurp, headless, lighthouse, preview, facebookexternalhit,
  curl, wget, python-requests, … and empty UA) are dropped silently → still `202`.
* Success → `202` with empty body. Rate limit exceeded → `429`.
* Device: from UA (mobile/tablet/desktop); fall back to `width` (< 768 mobile, < 1024 tablet).
* Browser / OS from a small built-in UA parser (no dependency).
* Country: `GEOIP_HEADER` (if configured, 2 uppercase letters, ignore `XX`, `T1`) else GeoIP DB.

### 4.4 Domain matching

A site has 1..20 domain entries. An entry is a lowercase hostname (labels of
`[a-z0-9-]`, IDN in punycode), `localhost`, or a wildcard `*.example.com`.
* `example.com` matches `example.com` and `www.example.com`.
* `*.example.com` matches `example.com` and any subdomain at any depth.
Hostnames are compared lowercase; a trailing dot is removed; ports are ignored.

### 4.5 Static routes

* `GET /script.js` — the tracker. `Content-Type: application/javascript; charset=utf-8`,
  `Cache-Control: public, max-age=3600`, `Access-Control-Allow-Origin: *`,
  `Cross-Origin-Resource-Policy: cross-origin`.
* `GET /healthz` → `200 {"ok":true}` (no auth, no DB details).
* Everything else that is not `/api/*`: the dashboard SPA from `dashboard/dist`
  (`index.html` fallback for client-side routes, hashed assets cached immutable).

### 4.6 Security requirements (non-negotiable)

* Every SQL statement uses bound parameters. Column names used for breakdowns/filters
  come from a fixed allow-list map, never from user input directly.
* Dashboard responses get security headers: strict CSP
  (`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin` (except `/script.js` and `/api/event`),
  `Permissions-Policy` minimal, `Strict-Transport-Security` when `COOKIE_SECURE`.
* Passwords: `crypto.scrypt` (N=2^15, r=8, p=1, 16-byte salt, 64-byte key), stored as
  `scrypt$N$r$p$saltB64$hashB64`, compared with `timingSafeEqual`. Unknown-user logins
  still perform a dummy hash (no user enumeration via timing). Password length 12..256.
* Login sessions: 32 random bytes (base64url) in cookie `pa_session`
  (`HttpOnly; SameSite=Strict; Path=/; Secure` when `COOKIE_SECURE`; Max-Age 30 days).
  The DB stores only `sha256(token)`. Logout deletes the row. Password change deletes all
  other sessions of that user.
* CSRF: every non-GET/HEAD request to `/api/*` except `/api/event` must carry header
  `X-PA-Request: 1`; if an `Origin` header is present it must equal the `PUBLIC_URL`
  origin (or, when `PUBLIC_URL` is unset, the request's own `Host`). Otherwise `403`.
* Rate limits (in-memory, bounded memory): login 10 failed attempts / 15 min per IP and per
  email → `429`; ingest per `INGEST_RATE_LIMIT`.
* Authorization: `viewer` can read all sites & stats; only `admin` can create/update/delete
  sites and manage users. A user cannot delete themselves; the last admin cannot be
  demoted or deleted.
* Errors never leak stack traces or SQL. Unknown routes under `/api` → `404 {"error":"not found"}`.
* All query params validated (lengths, enums, numbers); `tz` must be a valid IANA zone
  (check with `Intl.DateTimeFormat`), ≤ 64 chars.

### 4.7 Dashboard API

All responses are JSON. Errors: `{"error": "message"}` with a proper status code.
All endpoints except login require a valid session (`401 {"error":"unauthorized"}`).

#### Auth
* `POST /api/auth/login` `{email, password}` → `200 {user}` + cookie, `401` on bad credentials.
* `POST /api/auth/logout` → `204`.
* `GET /api/auth/me` → `{user}` where `user = {id, email, role, createdAt}`.
* `POST /api/auth/password` `{currentPassword, newPassword}` → `204`.

#### Config
* `GET /api/config` → `{publicUrl: string|null, version: string, geoip: boolean}`.

#### Users (admin only)
* `GET /api/users` → `{users: User[]}`
* `POST /api/users` `{email, password, role}` → `201 {user}` (409 if exists)
* `PATCH /api/users/:id` `{role?, password?}` → `{user}`
* `DELETE /api/users/:id` → `204`

#### Sites
`Site = {id, name, domains: string[], createdAt}`
* `GET /api/sites` → `{sites: Site[]}`
* `POST /api/sites` (admin) `{name (1..100), domains: string[] (1..20)}` → `201 {site}`
* `GET /api/sites/:id` → `{site}`
* `PATCH /api/sites/:id` (admin) `{name?, domains?}` → `{site}`
* `DELETE /api/sites/:id` (admin) → `204` (cascades all data)

#### Common stats query parameters
* `period`: `24h | 7d | 30d | 90d | 12m | custom` (default `7d`)
* `from`, `to`: `YYYY-MM-DD` (inclusive, interpreted in `tz`), required when `period=custom`,
  span ≤ 3 years.
* `tz`: IANA time zone (default `UTC`).
* Filters (exact match, value ≤ 1024 chars; empty string means `IS NULL`, e.g. `referrer=`
  = direct traffic): `path, hostname, referrer, country, device, browser, os,
  utm_source, utm_medium, utm_campaign, utm_term, utm_content, event`.
  `event=<name>` restricts pageview-based queries to visitors that triggered that custom
  event within the range.

Period resolution (all in `tz`):
* `24h`: last 24 full+current hours, hourly buckets (24 points).
* `7d`, `30d`, `90d`: last N days including today, daily buckets.
* `12m`: last 12 months including current, monthly buckets.
* `custom`: hourly if span ≤ 2 days, daily if ≤ 92 days, else monthly.
* The *previous period* is the range of equal length directly before.

Bucket starts are computed in `tz` (DST-correct) and returned as ms epoch (`t`).

#### Load protection
Stats, vitals, overview and export queries run in a pool of worker threads with read-only
SQLite connections (`STATS_WORKERS`), each with a time budget (`STATS_QUERY_TIMEOUT_MS` →
`503 {"error":"query timed out"}`). Concurrency is capped (32 in flight globally, 6 per user;
exports 1 per user and 2 globally → `429` with `Retry-After`). Identical queries are cached
for `STATS_CACHE_TTL_MS`. Authenticated GETs carrying a `Sec-Fetch-Site` header other than
`same-origin`/`none` are rejected with `403`. `HEAD` on export returns headers only.
Vitals endpoints reject the `referrer`, `utm_*` and `event` filters with `400`.

#### Stats endpoints
* `GET /api/overview?period&tz` →
  `{sites: [{id, name, domains, visitors, pageviews, previousVisitors, series: number[] /* visitors per bucket */}]}`
* `GET /api/sites/:id/stats/summary` →
  `{visitors, pageviews, bounceRate /* 0..1 or null */, events, previous: {visitors, pageviews, bounceRate, events}}`
* `GET /api/sites/:id/stats/timeseries` →
  `{interval: 'hour'|'day'|'month', points: [{t, visitors, pageviews}]}` (every bucket, zero-filled)
* `GET /api/sites/:id/stats/breakdown?dimension=<d>&limit=<1..1000, default 10>` where `d` ∈
  `path, hostname, referrer, country, device, browser, os, utm_source, utm_medium,
  utm_campaign, utm_term, utm_content, event` →
  `{dimension, rows: [{value: string|null, visitors, count}]}` sorted by visitors desc.
  `count` = pageviews (or number of events for `dimension=event`). Page dimensions are
  computed over pageviews only; `event` over custom events only.
* `GET /api/sites/:id/stats/event-props?event=<name>&limit` →
  `{rows: [{key, value: string|null, visitors, count}]}`
* `GET /api/sites/:id/stats/realtime` → `{visitors}` (distinct visitors in the last 5 minutes)
* `GET /api/sites/:id/export` → `text/csv` attachment of raw events in range (respecting filters):
  columns `timestamp,type,name,hostname,path,referrer,utm_source,utm_medium,utm_campaign,utm_term,utm_content,country,device,browser,os,props`.
  Streamed. Cells starting with `= + - @ \t \r` are prefixed with `'` (CSV injection) and
  properly quoted.

#### Speed Insights endpoints
Common params as above plus optional `device=desktop|mobile|tablet` and `path=`.
Ratings use web.dev thresholds (good ≤ / poor >):
LCP 2500/4000 ms, FCP 1800/3000 ms, INP 200/500 ms, CLS 0.1/0.25, TTFB 800/1800 ms.
Per-metric score (0..100) = Lighthouse log-normal curve with p10 = good threshold and
median = poor threshold, evaluated on p75.
**Real Experience Score** = weighted average of metric scores: FCP 15%, LCP 30%, INP 30%,
CLS 25% (re-normalised over metrics that have data; `null` if none).
* `GET /api/sites/:id/vitals/summary` →
  `{score: number|null, metrics: {LCP|FCP|INP|CLS|TTFB: {p75: number|null, count, score: number|null, rating: 'good'|'needs-improvement'|'poor'|null}}}`
* `GET /api/sites/:id/vitals/timeseries?metric=<LCP|FCP|INP|CLS|TTFB|RES>` →
  `{interval, points: [{t, value: number|null /* p75, or score for RES */, count}]}`
* `GET /api/sites/:id/vitals/breakdown?metric=<m>&dimension=<path|hostname|country|device|browser|os>&limit` →
  `{rows: [{value, p75, count, rating}]}` sorted by count desc.

#### Live map (globe)
* `GET /api/sites/:id/stats/live` →
  `{visitors, countries: [{country: string|null, visitors}], recent: [{ts, country: string|null, path}]}`
  over the last 5 minutes (`recent` = newest pageviews first, max 50). Never cached.
* `GET /api/live` → `{visitors, countries: [{country, visitors}], sites: [{id, name, visitors}]}`
  aggregated over all sites the user can access (last 5 minutes).

## 5. Dashboard (`/dashboard`)

React + Vite + TypeScript, `react-router-dom` for routing, Tailwind CSS v4 with
[shadcn/ui](https://ui.shadcn.com) components (Base UI flavour, `src/components/ui`) and
[Bklit UI](https://bklit.com) charts (`src/components/charts`, MIT). The 3D globe
(`src/components/globe`) is drawn with d3-geo (orthographic projection) on a canvas.
Light & dark theme following `prefers-color-scheme` with a manual toggle. No inline `<script>` and no
`style="…"` attributes in `index.html` (strict CSP). Never use `dangerouslySetInnerHTML`.
All analytics values (paths, referrers, event names, props, countries…) are untrusted.

See the dashboard README for screens. All mutating requests send `X-PA-Request: 1`.
Period + filters live in the URL query string so views are linkable.

## 6. Hosted ("cloud") mode

The same server can run as a hosted service where anyone can sign up. Everything below is
**off by default**; a self-hosted install behaves exactly as described above.

### 6.1 Configuration

| var | default | meaning |
|-----|---------|---------|
| `SIGNUP_ENABLED` | `false` | allow public self-service sign-up (`member` accounts). Requires `SMTP_URL` + `MAIL_FROM` (email verification is mandatory). |
| `SMTP_URL` | – | e.g. `smtps://user:pass@smtp.example.com:465` (nodemailer URL) |
| `MAIL_FROM` | – | e.g. `PTR Analytics <no-reply@example.com>` |
| `MEMBER_SITE_LIMIT` | `10` | max sites per member when billing is disabled |
| `BILLING_ENABLED` | `false` | charge members per site via Stripe. Requires `SIGNUP_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`. |
| `STRIPE_SECRET_KEY` | – | `sk_live_…` / `sk_test_…` (or a restricted key) |
| `STRIPE_WEBHOOK_SECRET` | – | `whsec_…` of the webhook endpoint `PUBLIC_URL/api/billing/webhook` |
| `STRIPE_PRICE_ID` | – | recurring per-unit price, e.g. €1.00 / month (`price_…`) |
| `STRIPE_AUTOMATIC_TAX` | `false` | enable Stripe Tax on checkout |
| `FREE_SITES` | `1` | sites included for free per member |
| `PRICE_PER_SITE_CENTS` / `PRICE_CURRENCY` | `100` / `eur` | display only (Stripe's price is authoritative) |
| `TERMS_URL` / `PRIVACY_URL` | – | links shown on the sign-up page (required to be accepted) |

### 6.2 Accounts & tenancy

Roles: `admin` (operator: all sites, user management, never billed), `viewer` (read-only
access to all sites — self-hosted teams) and `member` (self-service account: sees and manages
**only the sites it owns**). `sites.owner_id` references the creating user (`ON DELETE CASCADE`).
Every site-scoped endpoint (stats, vitals, export, live, settings) checks access:
admin/viewer → any site; member → `owner_id = user.id`, otherwise `404`.
`User = {id, email, role, createdAt, emailVerified}`; `Site` gains `suspended: boolean`.

### 6.3 Auth endpoints (cloud)

* `GET /api/public-config` (no auth) →
  `{signupEnabled, billingEnabled, freeSites, pricePerSiteCents, currency, termsUrl, privacyUrl}`
* `POST /api/auth/signup` `{email, password, acceptTerms: true}` → always `202 {ok:true}`
  (no account enumeration). New address: create unverified member + send a verification link
  `PUBLIC_URL/verify?token=…` (24 h). Existing address: send a "you already have an account"
  mail with a reset link instead. Rate limited per IP and per email.
* `POST /api/auth/verify` `{token}` → `200 {user}` + session cookie (marks the email verified).
* `POST /api/auth/forgot` `{email}` → always `202 {ok:true}`; sends `PUBLIC_URL/reset?token=…` (1 h).
* `POST /api/auth/reset` `{token, password}` → `204`; signs out all sessions of that user.
* Login of an unverified member → `403 {error: "email not verified"}`.
* `DELETE /api/account` `{password}` (members) → `204`; cancels the Stripe subscription,
  deletes the user and all its sites and data.
Tokens: 32 random bytes, only `sha256(token)` stored, single use.

### 6.4 Billing (Stripe)

Allowance for a member = `FREE_SITES + paidSites` (billing enabled) or `MEMBER_SITE_LIMIT`.
`POST /api/sites` beyond the allowance → `402 {error, code: "upgrade_required"}`.
* `GET /api/billing` →
  `{enabled, freeSites, pricePerSiteCents, currency, sitesUsed, sitesAllowed, paidSites, status: "none"|"active"|"trialing"|"past_due"|"canceled"|"unpaid"|"incomplete", hasCustomer}`
* `POST /api/billing/checkout` `{paidSites: 1..1000}` → `{url}` — Stripe Checkout (subscription,
  `STRIPE_PRICE_ID` × paidSites). Only when the member has no active subscription.
* `POST /api/billing/quantity` `{paidSites: 0..1000}` → `{billing}` — updates the existing
  subscription quantity (prorated); `0` cancels at period end.
* `POST /api/billing/portal` → `{url}` — Stripe customer portal (invoices, payment method, cancel).
* `POST /api/billing/webhook` — Stripe webhook (no auth, no CSRF header; signature verified
  with `STRIPE_WEBHOOK_SECRET`, 5 min tolerance, raw body ≤ 1 MB). Handles
  `checkout.session.completed`, `customer.subscription.created|updated|deleted`; the state is
  always re-read from the Stripe API (webhook payloads are only a trigger).
Paid-site count / status changes recompute `sites.suspended` for the member: the oldest
`allowance` sites stay active, newer ones are suspended (ingest silently drops their events,
the dashboard shows a banner). Nothing is deleted.
The Stripe API is called with `fetch` (no SDK).

## 7. Landing page (`/landing`)

Static marketing site (Vite + React + Tailwind + shadcn/Bklit, sharing components with the
dashboard), deployed on its own domain. Build-time config: `VITE_APP_URL` (the hosted
analytics server, e.g. `https://analytics.pieterdebaere.be`) and `VITE_REPO_URL`.
