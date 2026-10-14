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
`503 {"error":"query timed out"}`). Concurrency is capped (32 in flight globally, 6 per user,
and the last 8 global slots only go to users with nothing in flight; exports 1 per user and 2
globally → `429` with `Retry-After`). Waiting queries are dispatched fairly between users
(least recently served first). An export whose client reads nothing for
`STATS_EXPORT_IDLE_TIMEOUT_MS` (30 s), or that runs longer than `STATS_EXPORT_MAX_DURATION_MS`
(10 min), is aborted: the connection is closed and the slot freed. Identical queries are cached
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
| `SIGNUP_ENABLED` | `false` | allow public self-service sign-up (`member` accounts). Requires `SMTP_URL` + `MAIL_FROM` (email verification is mandatory) and an `https://` `PUBLIC_URL`. Startup warns loudly when `TRUST_PROXY=false`. |
| `ALLOW_INSECURE_PUBLIC_URL` | `false` | development only: allow `SIGNUP_ENABLED` with an `http://` `PUBLIC_URL` (warns) |
| `SMTP_URL` | – | e.g. `smtps://user:pass@smtp.example.com:465` (nodemailer URL). `smtp://` uses `requireTLS` (STARTTLS mandatory). |
| `SMTP_ALLOW_INSECURE` | `false` | allow `smtp://` without STARTTLS (warns at startup) |
| `MAIL_FROM` | – | e.g. `PTR Analytics <no-reply@example.com>` |
| `SIGNUP_MAX_PER_HOUR` | `200` | sign-up requests per hour, all clients together (beyond: `503`) |
| `MAIL_MAX_PER_HOUR` | `500` | outgoing mails per hour (beyond: sign-up / forgot `503`) |
| `MAX_UNVERIFIED_ACCOUNTS` | `5000` | sign-up answers `503` while this many members are unverified |
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
**only the sites it owns**). With `SIGNUP_ENABLED`, no new viewers can be created
(`POST /api/users` / `PATCH` to `viewer` → `400`, CLI refuses; existing ones keep working).
`sites.owner_id` references the creating user.
Members: at most 5 domains per site, and no wildcard directly over a shared hosting suffix
(`*.github.io`, `*.vercel.app`, `*.netlify.app`, `*.pages.dev`, `*.herokuapp.com`, `*.web.app`,
`*.firebaseapp.com`, `*.onrender.com`, `*.fly.dev`, `*.azurewebsites.net`, `*.cloudfront.net`,
`*.appspot.com`) → `400` (admins unaffected).

**Deletion is soft** (schema v5: `sites.deleted_at`). Deleting a site (member or admin) sets
`deleted_at`: from then on the site is invisible everywhere (access checks `404`, lists,
overview, live map, ingest treats it as unknown, allowance). A background job purges its
events, vitals and sessions in small adaptive chunks (yielding between them, like the
retention cleanup), then deletes the row; it runs after every deletion and hourly. Deleting
a user first soft-deletes and detaches (`owner_id = NULL`) its sites in the same transaction,
so the `users → sites` cascade never deletes analytics rows synchronously.
Every site-scoped endpoint (stats, vitals, export, live, settings) checks access:
admin/viewer → any site; member → `owner_id = user.id`, otherwise `404`.
`User = {id, email, role, createdAt, emailVerified}`; `Site` gains `suspended: boolean` and,
for admins only, `ownerId: number|null` (`null` = operator site: never suspended, never
deleted together with a user).

### 6.3 Auth endpoints (cloud)

* `GET /api/public-config` (no auth) →
  `{signupEnabled, billingEnabled, freeSites, memberSiteLimit, pricePerSiteCents, currency, termsUrl, privacyUrl}`
* `POST /api/auth/signup` `{email, password, acceptTerms: true}` → always `202 {ok:true}`
  (no account enumeration). New address: create unverified member + send a verification link
  `PUBLIC_URL/verify#token=…` (24 h). Existing member: send a "you already have an account"
  mail with a reset link instead (operator accounts: the same mail without a link). Rate
  limited per IP (IPv6 /64 and /48) and per email (`429`). Global caps (`SIGNUP_MAX_PER_HOUR`,
  `MAIL_MAX_PER_HOUR`, mail queue full, `MAX_UNVERIFIED_ACCOUNTS`) → `503 {"error":"please try
  again later"}`, checked before the address is looked at.
* `POST /api/auth/verify` `{token, password}` → `200 {user}` + session cookie (marks the email
  verified). The password must be the account's (scrypt, constant time; counts against the
  login rate limits per IP / email+IP / email and the token-submission limit per IP). Any
  failure (unknown/expired/used token, wrong password) → `400 {"error":"this link is invalid
  or has expired"}`; a wrong password does **not** consume the token. Missing password → `400`.
* `POST /api/auth/forgot` `{email}` → always `202 {ok:true}`; sends `PUBLIC_URL/reset#token=…`
  (1 h) to members only (admins/viewers: nothing is sent; reset them with the CLI). `503` when
  mail cannot be accepted (checked before the lookup).
* `POST /api/auth/reset` `{token, password}` → `204`; signs out all sessions of that user and
  invalidates all its tokens. Tokens of non-member accounts are refused (`400`).
* Login of an unverified member → `401 {"error":"invalid email or password"}`, identical to a
  wrong password. With the correct password the verification mail is re-sent in the
  background (per account at most 1 per 10 min, 3 per day).
* `DELETE /api/account` `{password}` (members) → `204`; cancels the Stripe subscriptions and
  deletes the customer, deletes the user and soft-deletes all its sites (data purged in the
  background).
Tokens: 32 random bytes in the URL **fragment** (never sent to the server, so never in access
logs or `Referer`), only `sha256(token)` stored, single use; up to 3 valid tokens per user and
purpose (older ones are dropped). The SPA pages `/verify` and `/reset` are served with
`Referrer-Policy: no-referrer`; the SPA reads the token from `location.hash` and POSTs it.
Email addresses must be plain `local@domain` (no display names, comments, quotes, lists,
`<>()",;:[]\`, whitespace or control characters); mail is addressed as `{address}` objects;
identical recipient + template mails still in the queue are replaced (not duplicated).

### 6.4 Billing (Stripe)

Allowance for a member = `FREE_SITES + paidSites` (billing enabled) or `MEMBER_SITE_LIMIT`.
`POST /api/sites` beyond the allowance → `402 {error, code: "upgrade_required"}`.
* `GET /api/billing` →
  `{enabled, freeSites, pricePerSiteCents, currency, sitesUsed, sitesAllowed, paidSites, status: "none"|"active"|"trialing"|"past_due"|"canceled"|"unpaid"|"incomplete", hasCustomer, cancelAtPeriodEnd}`
  (`sitesAllowed` is authoritative). Billing endpoints are members-only (`403` otherwise);
  checkout/quantity/portal/webhook are `404` when billing is disabled; `409` for state
  conflicts (already subscribed, no subscription, …); `502` when Stripe fails.
* `POST /api/billing/checkout` `{paidSites: 1..1000}` → `{url}` — Stripe Checkout (subscription,
  `STRIPE_PRICE_ID` × paidSites). Only when the member has no active subscription.
* `POST /api/billing/quantity` `{paidSites: 0..1000}` → `{billing}` — updates the existing
  subscription quantity (prorated); `0` cancels at period end.
* `POST /api/billing/portal` → `{url}` — Stripe customer portal (invoices, payment method, cancel).
* `POST /api/billing/webhook` — Stripe webhook (no auth, no CSRF header; signature verified
  with `STRIPE_WEBHOOK_SECRET`, 5 min tolerance, raw body ≤ 256 KB; with billing disabled it
  answers `404` in `onRequest`, before reading the body). Handles
  `checkout.session.completed`, `customer.subscription.created|updated|deleted`; the state is
  always re-read from the Stripe API (webhook payloads are only a trigger).
Paid-site count / status changes recompute `sites.suspended` for the member: the oldest
`allowance` sites stay active, newer ones are suspended (ingest silently drops their events,
the dashboard shows a banner). Nothing is deleted.
Deleting **any** user that has a `stripe_customer_id` (whatever its current role) first cancels
all its subscriptions and deletes the Stripe customer (`502`, nothing deleted, if Stripe fails);
`cli delete-user` refuses such accounts. Changing the role of a member whose subscription is
`active`/`trialing`/`past_due` → `409`.
The Stripe API is called with `fetch` (no SDK).

## 7. Landing page (`/landing`)

Static marketing site (Vite + React + Tailwind + shadcn/Bklit, sharing components with the
dashboard), deployed on its own domain. Build-time config: `VITE_APP_URL` (the hosted
analytics server, e.g. `https://analytics.pieterdebaere.be`) and `VITE_REPO_URL`.

## 8. Uptime monitoring

Re-implementation of the functionality of [Uptime Kuma](https://github.com/louislam/uptime-kuma),
integrated with the analytics. The full requirements analysis (feature inventory, protocols,
notification request formats, threat model) is in [`docs/uptime/ANALYSIS.md`](uptime/ANALYSIS.md);
this section is the binding contract. Shared server types: `server/src/uptime/types.ts`.
Schema: migration v6 (`server/src/uptime/schema/*.ts`).

### 8.1 Scope and decisions

* Monitor types: `http`, `keyword`, `json`, `tcp`, `tls`, `dns`, `push`, `group`, `manual`, `ping`,
  `websocket`, `smtp`, `ntp`, `redis`, `ssh`, `grpc_health`, `postgres`, `mysql`, `mongodb`,
  `mqtt`, `docker` (self-hosted opt-in) and `domain` (RDAP domain expiry). No real-browser, full
  database drivers, Kafka, GameDig or command-running types (see ANALYSIS §8.1 WON'T).
* Statuses: `-1` unknown, `0` down, `1` up, `2` pending, `3` maintenance; retries, retry interval,
  resend every N failed checks, upside-down mode, accepted status codes, certificate expiry
  notices (21/14/7/3/1 days), domain expiry notices.
* Monitors belong to a **site** (`site_id`); access, limits, suspension and soft delete follow the
  site (spec §6.2). Tags, notification channels and maintenance windows belong to a user
  (`owner_id`, `NULL` = operator object visible to admins/viewers). Links between objects are only
  accepted within the same owner.
* Hosted mode (members): `MEMBER_MONITORS_PER_SITE` (10), min interval `MEMBER_MIN_INTERVAL_S` (60),
  timeout ≤ 30 s, retries ≤ 5, `MEMBER_STATUS_PAGES_PER_SITE` (1), `MEMBER_NOTIFY_CHANNELS` (10),
  `MEMBER_NOTIFY_PER_HOUR` (120); private targets always denied; webhook URLs https only; e-mail
  channels need double opt-in; types with `hosted: 'disabled'` refused. Suspended sites: monitors
  are paused, status pages show "monitoring paused".
* Public status pages are served on the same origin under `/status/:slug` (SPA route, no login).
  No custom CSS and no third-party scripts; Markdown subset only (rendered as React elements).
* Secrets (monitor credentials, notification tokens, TOTP secrets) are encrypted at rest with
  AES-256-GCM (`SECRETS_KEY` or a generated `<DATA_DIR>/secrets.key`, mode 0600) and **write-only**
  in the API: responses contain `secretsSet: string[]` instead of values; sending `""`/omitting a
  secret field keeps the stored value, `null` clears it.
* All outgoing connections go through the SSRF-safe `SafeNet` (resolve → check every address →
  connect to that exact address; redirects re-checked; `dns.Resolver` with timeouts, never
  `dns.lookup`). Policy: `UPTIME_PRIVATE_TARGETS` (`allow` self-hosted default, forced `deny` in
  hosted mode), link-local/metadata always denied unless `UPTIME_ALLOW_METADATA`, allow/deny lists,
  in hosted mode the server's own addresses (`PUBLIC_URL` host, local interfaces) are always denied
  (self-hosted installs may monitor sites behind the same reverse proxy). Monitor and notification
  traffic never uses `HTTP(S)_PROXY` / `NODE_USE_ENV_PROXY`; `/etc/hosts` is not consulted (names are
  resolved with c-ares).
* Realtime: Server-Sent Events (`GET /api/uptime/stream`), the dashboard falls back to polling.
* Two-factor authentication (TOTP + recovery codes) for all accounts; API keys (bearer, scoped)
  for `/metrics` (Prometheus) and read-only API automation.

Configuration (all optional): `UPTIME_ENABLED` (true), `UPTIME_MIN_INTERVAL_S` (20),
`UPTIME_CHECK_CONCURRENCY` (64), `UPTIME_PRIVATE_TARGETS`, `UPTIME_ALLOW_METADATA` (false;
metadata = link-local `169.254.0.0/16`/`fe80::/10` incl. 169.254.169.254, Alibaba
`100.100.100.200`, Azure WireServer `168.63.129.16`, Oracle `192.0.0.192`, `fd00:ec2::254` and the
metadata hostnames), `UPTIME_TARGET_ALLOWLIST` / `UPTIME_TARGET_DENYLIST` (CIDRs/hostnames; the
allow list is an operator exception and never applies to hosted members, the deny list applies to
everyone — use it for further provider-internal addresses), `UPTIME_DNS_SERVERS` (comma-separated IP
literals or `system`; default: system resolvers, except hosted members whose names are resolved by
`1.1.1.1,8.8.8.8` so they cannot enumerate internal DNS names — members get the same "target not
allowed" for denied and non-existent names), `UPTIME_MAX_BODY_BYTES` (1 MiB),
`MEMBER_MAX_BODY_BYTES` (256 KiB, response body cap for members; member request bodies ≤ 16 KiB),
`UPTIME_RAW_RETENTION_HOURS` (48), `UPTIME_RETENTION_DAYS` (400), `UPTIME_PING_BINARY`
(`/bin/ping`, empty disables), `UPTIME_DOCKER_ENABLED` (false) + `UPTIME_DOCKER_HOST`,
`SECRETS_KEY` / `SECRETS_KEY_FILE` (must not be group/other-readable unless root-owned 0400/0440),
`MEMBER_*` limits above, `REQUIRE_MFA_FOR_ADMINS` (false). HTTP-family monitors refuse https → http
redirects unless `allowDowngrade` (self-hosted only) and never follow a redirect that would re-send
the request body to another origin. Parsed in `server/src/uptime/config.ts`.

### 8.2 Engine

Scheduler with a min-heap on the monotonic clock, stable per-monitor phase jitter, anchored
intervals (missed slots skipped, never bursts), global/per-owner/per-destination concurrency
limits, `AbortSignal` deadlines + watchdog. Results are written in batches (heartbeat, state,
hourly/daily time-weighted aggregates, events, outages, outbox rows in one transaction). Status
transitions are a pure, unit-tested function (`(state, result, settings, inMaintenance) → …`)
reproducing Uptime Kuma's important/notify rules. Group monitors derive their status from their
children. Push monitors are DOWN when no push arrived within `interval` (grace period after
start). Maintenance windows (strategies `manual`, `single`, `weekly`, `monthly`, `interval`,
`cron`; IANA time zones) put monitors (and group descendants) in status 3 and suppress
notifications. Retention: raw heartbeats `UPTIME_RAW_RETENTION_HOURS`, hourly stats 90 days,
daily stats/events/outages `UPTIME_RETENTION_DAYS`; purge in small chunks.
Uptime = `up_ms / (up_ms + down_ms + pending_ms)` (time-weighted; maintenance and gaps excluded).

### 8.3 API (authenticated, same conventions as §4.7: cookie session or API key, `X-PA-Request: 1` on mutations)

`Monitor` JSON:
```jsonc
{ "uid": "k3j9x0abcd12", "siteId": "…", "parentUid": null, "type": "http", "name": "Homepage",
  "description": null, "active": true, "intervalS": 60, "retryIntervalS": 60, "maxRetries": 1,
  "resendEvery": 0, "timeoutMs": 10000, "upsideDown": false, "certNotify": true, "domainNotify": false,
  "config": { /* type specific, see GET /api/uptime/types */ }, "secretsSet": ["password"],
  "target": "https://example.com/", "tags": [{"uid","name","color","value"}], "channelUids": ["…"],
  "publicId": null /* badges enabled when set */, "pushUrl": null /* push monitors only, shown once on create/regenerate */,
  "state": { "status": 1, "since": 1791000000000, "lastCheckAt": …, "latencyMs": 123, "msg": "200 OK" },
  "uptime24h": 0.9998, "uptime30d": 0.9991, "tls": { "notAfter": …, "daysLeft": 61, "issuer": "…", "valid": true } | null,
  "createdAt": …, "updatedAt": … }
```
* `GET /api/uptime/types` → `{types: [{type, label, description, category, fields: FieldDef[], defaults, available: boolean, hostedAllowed: boolean}]}`
  plus `{limits: {minIntervalS, maxTimeoutMs, maxRetries, monitorsPerSite|null}}` for the current user.
* `GET /api/uptime/overview` → `{sites: [{siteId, total, up, down, pending, maintenance, paused, uptime30d}], monitors: Monitor[]}` (accessible sites only)
* `GET /api/sites/:siteId/monitors` → `{monitors: Monitor[]}` ; `POST` (same fields as Monitor, writable ones) → `201 {monitor}` (402/409-style limits as `{error, code: "limit_reached"}`)
* `GET|PATCH|DELETE /api/monitors/:uid` ; `POST /api/monitors/:uid/pause|resume|clone|check` (check = run now, rate limited) ;
  `POST /api/monitors/:uid/push-token` → `{pushUrl}` (regenerates) ; `POST /api/monitors/:uid/badges` `{enabled}` → `{publicId}`
* `GET /api/monitors/:uid/heartbeats?period=24h|7d|30d|90d|custom&from&to&tz` →
  `{interval: 'raw'|'hour'|'day', points: [{t, status, latencyMs, latencyMin, latencyMax, upRatio}]}` (≤ 500 points, down-sampled)
* `GET /api/monitors/:uid/stats?period&tz` → `{uptime, previousUptime, avgLatencyMs, minLatencyMs, maxLatencyMs, checks, outages: number, downtimeMs, mttrMs, bars: [{t, upRatio|null, maintenance: boolean}] /* 90 local days */}`
* `GET /api/monitors/:uid/events?before=<id>&limit` → `{events: [{id, ts, from, to, msg}]}` ; `GET /api/monitors/:uid/outages?limit` → `{outages: [{id, startedAt, confirmedAt, endedAt, cause}]}`
* `GET /api/uptime/stream` → `text/event-stream`; events `beat` `{uid, ts, status, latencyMs, msg}` and `state` `{uid, status, since}` for accessible monitors (heartbeat every 25 s).
* Tags: `GET|POST /api/tags`, `PATCH|DELETE /api/tags/:uid` (`{uid, name, color}`).
* Maintenance: `GET|POST /api/maintenances`, `GET|PATCH|DELETE /api/maintenances/:uid`, `POST /api/maintenances/:uid/pause|resume`;
  `{uid, title, description, active, strategy, tz, startsAt, endsAt, timeStart, timeEnd, weekdays: number[] /* 0=Sun */, daysOfMonth: (number|"L")[], intervalDays, cron, durationS, monitorUids, statusPageUids, status: "scheduled"|"under-maintenance"|"inactive"|"ended", nextWindow: {start, end}|null}`.
* Notification channels: `GET /api/notification-providers` → `{providers: [{id, label, category, fields: FieldDef[], hostedAllowed}]}`;
  `GET|POST /api/notification-channels`, `GET|PATCH|DELETE /api/notification-channels/:uid`
  (`{uid, type, name, config, secretsSet, isDefault, active, verified: boolean, consecutiveFailures, monitorCount}`; `applyToExisting: true` on create/update links it to all of the owner's monitors);
  `POST /api/notification-channels/:uid/test` (rate limited) → `{ok, error?}`; `POST /api/notification-channels/test` with an unsaved channel body;
  `GET /api/notification-channels/:uid/log?limit` → `{entries: [{ts, event, ok, httpStatus, error, monitorUid}]}`;
  e-mail double opt-in (hosted mode): `GET /api/notification-channels/verify?token=` (public; confirms the recipient) and one-click unsubscribe links.
* Status pages (per site): `GET /api/status-pages`, `POST /api/sites/:siteId/status-pages`, `GET|PATCH|DELETE /api/status-pages/:uid`
  (`{uid, siteId, slug, title, description, footer, theme, accent, published, noindex, showTags, showCertExpiry, showPoweredBy, refreshS, analyticsSiteId, logoUrl, sections: [{name, monitors: [{uid, displayName, showUrl}]}], domains: [{domain, verified, verifyToken}]}`);
  `POST /api/status-pages/:uid/logo` (raw PNG/JPEG/WebP ≤ 512 KB, content sniffed) ; `DELETE …/logo`;
  incidents: `GET|POST /api/status-pages/:uid/incidents`, `PATCH|DELETE /api/incidents/:uid` (`{uid, title, body, style, pinned, createdAt, updatedAt, resolvedAt}`).
* Security: `GET /api/auth/mfa` → `{enabled, recoveryCodesLeft}`; `POST /api/auth/mfa/setup` → `{secret, otpauthUrl}` (pending until confirmed);
  `POST /api/auth/mfa/enable {code}` → `{recoveryCodes: string[]}` (shown once); `POST /api/auth/mfa/disable {password, code}`;
  `POST /api/auth/mfa/recovery-codes {password, code}` → new codes. Login with MFA: `POST /api/auth/login` answers
  `200 {mfaRequired: true, mfaToken}` (no session yet); `POST /api/auth/login/mfa {mfaToken, code | recoveryCode}` → `{user}` + session.
  API keys: `GET|POST /api/api-keys` (`{name, scopes: ["read", "metrics"], expiresInDays?}` → key shown once `pa_<prefix>_<secret>`), `DELETE /api/api-keys/:uid`.

### 8.4 Public endpoints (no auth)

* `GET|POST|HEAD /api/push/:token?status=up|down&msg=&ping=` → `{ok: true}` (CORS `*`, rate limited per token/IP; unknown token → 404 after constant work).
* `GET /api/public/status/:slug` → status page JSON for published pages only (no internal ids, no targets unless `showUrl`):
  `{title, description, footer, theme, accent, logoUrl, showPoweredBy, refreshS, analytics: {siteId, scriptUrl}|null, overall: "up"|"degraded"|"down"|"maintenance"|"unknown",
   sections: [{name, monitors: [{id /* opaque per page */, name, status, uptime90d, bars: [{t, upRatio|null, maintenance}], url?, certDaysLeft?, tags?}]}],
   incidents: [...pinned/unresolved + last 10 resolved], maintenance: [{title, description, start, end, status}], updatedAt}`;
  `GET /status/:slug/feed.xml` (RSS of incidents and outages).
* Badges (SVG, `Cache-Control: max-age=60`): `GET /api/public/badge/:publicId/status.svg`, `uptime.svg?period=24h|7d|30d|90d`,
  `response.svg`, `cert.svg`; `GET /api/public/status/:slug/badge.svg`. Query parameters `label`, `style=flat|flat-square|for-the-badge`
  (strictly validated, text escaped).
* `GET /metrics` — Prometheus text format, requires `Authorization: Bearer <api key with "metrics" scope>`;
  only the key owner's monitors.
* `GET /uptime-bot` — plain page explaining the checks (linked from the User-Agent).
