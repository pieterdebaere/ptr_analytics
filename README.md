# PTR Analytics

**Self-hosted, privacy-friendly web analytics and speed insights for all your websites —
in one central dashboard.** An open-source alternative to Vercel Web Analytics and Vercel
Speed Insights that you run on your own server, e.g. `https://analytics.example.com`.

Connect any website with **one line** in its `<head>`:

```html
<script defer src="https://analytics.example.com/script.js" data-site="YOUR_SITE_ID"></script>
```

## Features

**Web Analytics**
- Visitors, page views and bounce rate with comparison to the previous period
- Time ranges: last 24 hours, 7 days, 30 days, 3 months, 12 months or a custom range (time-zone aware)
- Top pages and hostnames
- Referrers and UTM parameters (source, medium, campaign, term, content)
- Countries, devices, browsers and operating systems
- Custom events with properties (`pa.track('Signup', { plan: 'pro' })`) and declarative click events
- Click-to-filter on every dimension, linkable URLs, CSV export
- Live "visitors online" counter
- Single-page-app support (History API navigation is tracked automatically)

**Speed Insights**
- Core Web Vitals from real users: LCP, INP, CLS, FCP and TTFB (p75)
- Real Experience Score, per metric score and rating (good / needs improvement / poor)
- Trend over time and breakdown per page, country, browser, OS and device

**One server, many sites**
- Central overview of all connected websites with sparklines and trends
- Multiple users (admin / viewer)

**Privacy & security**
- No cookies, no local storage, no persistent identifiers — no cookie banner needed
- IP addresses are never stored; visitor ids are hashed with a salt that rotates daily
- Only the path is stored (no query strings except UTM parameters, no fragments)
- Tiny script (a few KB), respects opt-out, optionally Do Not Track / GPC
- Hardened: strict CSP, CSRF protection, scrypt password hashing, rate limiting,
  parameterised SQL, minimal dependencies. See [SECURITY.md](SECURITY.md).

## Quick start (Docker)

```bash
git clone https://github.com/pieterdebaere/ptr_analytics.git
cd ptr_analytics
cp .env.example .env        # set PUBLIC_URL, ADMIN_EMAIL and a strong ADMIN_PASSWORD
docker compose up -d --build
```

The server listens on `127.0.0.1:3000`. Put a reverse proxy with TLS in front of it
(see below), open `https://analytics.example.com` and log in with the admin account from
`.env`. Then **remove both `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env`** and run
`docker compose up -d` again, so the password no longer sits in the container environment.

Data (SQLite database and GeoIP database) lives in the `analytics-data` volume.

### Reverse proxy

**Caddy** (automatic HTTPS):

```caddyfile
analytics.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name analytics.example.com;
    # ssl_certificate ... ;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        # Replace (don't append to) X-Forwarded-For with the real client address.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

With one proxy in front (Caddy or the nginx config above) keep `TRUST_PROXY=1`. The proxy
must *replace* `X-Forwarded-For` with the real client address, as Caddy (2.5+) does by
default and as the nginx config above does. Only use a non-`false` `TRUST_PROXY` when the
server port is reachable exclusively through the proxy (the compose file binds it to
`127.0.0.1`); otherwise clients can forge their IP address.

**Behind Cloudflare:** let nginx restore the visitor address first and keep `TRUST_PROXY=1`:

```nginx
# in the server block; list all ranges from https://www.cloudflare.com/ips/
set_real_ip_from 173.245.48.0/20;
# ... remaining IPv4/IPv6 ranges ...
real_ip_header CF-Connecting-IP;
```

Also firewall the origin so that only Cloudflare can reach ports 80/443; otherwise
`CF-Connecting-IP` (and `GEOIP_HEADER=cf-ipcountry`) can be forged.

### Backups

All state lives in the SQLite database in the data volume. Make a consistent copy while the
server runs with:

```bash
docker compose exec analytics node -e "new (require('better-sqlite3'))('/data/analytics.db').backup('/data/backup.db')"
```

Treat backups as secrets: they contain password hashes and the current day's salt.

## Connecting a website

1. In the dashboard click **Add site**, give it a name and the domain(s) it runs on
   (`example.com` also accepts `www.example.com`; `*.example.com` accepts all subdomains).
2. Copy the snippet from the site's **Settings** tab into the `<head>` of every page:

   ```html
   <script defer src="https://analytics.example.com/script.js" data-site="YOUR_SITE_ID"></script>
   ```

   **Next.js (App Router)** — in `app/layout.tsx`:

   ```tsx
   import Script from 'next/script';
   // inside <head> or <body>:
   <Script src="https://analytics.example.com/script.js" data-site="YOUR_SITE_ID" strategy="afterInteractive" />
   ```

Page views (including client-side navigations) and web vitals are collected automatically.

### Custom events

```js
pa.track('Signup', { plan: 'pro' });
```

Or without JavaScript:

```html
<button data-pa-event="Signup" data-pa-event-plan="pro">Sign up</button>
```

To call `pa` before the script has loaded, add this queue snippet once:

```html
<script>window.pa=window.pa||function(){(window.pa.q=window.pa.q||[]).push(arguments)}</script>
```

All script options (exclude paths, disable vitals, Do Not Track, `beforeSend` hook for
redacting URLs, …) are documented in [tracker/README.md](tracker/README.md).

### Excluding your own visits

Open the browser console on your website and run
`localStorage.setItem('pa_ignore', 'true')`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | – | Public URL of the dashboard, e.g. `https://analytics.example.com`. Required in production. |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address (the Docker image sets `HOST=0.0.0.0`). |
| `DATA_DIR` | `./data` | Directory for the SQLite database. |
| `TRUST_PROXY` | `false` | `false`, number of proxy hops, or comma-separated trusted proxy IPs/CIDRs. See *Reverse proxy*. |
| `COOKIE_SECURE` | `true` when `PUBLIC_URL` is https | Sets the `Secure` flag on the session cookie. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | – | Creates the first admin when there are no users yet (password ≥ 12 chars). |
| `RETENTION_DAYS` | `0` | Delete analytics data older than N days (0 = forever). |
| `GEOIP_DB_PATH` | `$DATA_DIR/geoip-country.mmdb` | MaxMind-format country database (DB-IP Lite or GeoLite2 Country). Set `GEOIP_AUTO_DOWNLOAD=false` when you provide your own. |
| `GEOIP_AUTO_DOWNLOAD` | `false` | Download & monthly refresh the free DB-IP *IP to Country Lite* database. |
| `GEOIP_HEADER` | – | Header with the visitor's country code set by your CDN, e.g. `cf-ipcountry`. Only honoured when `TRUST_PROXY` is set; the origin must be reachable only through that CDN. |
| `INGEST_RATE_LIMIT` | `600` | Max tracking requests per IP per minute. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |

## Command line

```bash
# Docker
docker compose exec analytics node server/dist/cli.js create-user alice@example.com viewer
docker compose exec analytics node server/dist/cli.js reset-password you@example.com
docker compose exec analytics node server/dist/cli.js list-users
docker compose exec analytics node server/dist/cli.js delete-user alice@example.com
```

`create-user` and `reset-password` print a generated password once. Login rate limits are
kept in memory, so restarting the server also clears a temporary lockout.

If the server needs an outbound HTTP proxy to download the GeoIP database, set
`HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1`.

## Development

Requires Node.js 22+.

```bash
npm install
npm run build           # tracker, dashboard and server
npm test                # all test suites
DATA_DIR=./data ADMIN_EMAIL=dev@example.com ADMIN_PASSWORD=dev-password-123 npm run dev   # API on 127.0.0.1:3000
npm run dev:dashboard   # dashboard with hot reload on :5173 (proxies /api to :3000)
```

Project layout:

| Path | |
|---|---|
| `tracker/` | The tracking script (TypeScript → one minified file served at `/script.js`) |
| `dashboard/` | React single-page dashboard |
| `server/` | Fastify API, ingest endpoint and SQLite storage |
| `docs/SPEC.md` | Technical specification / API reference |

## Privacy

PTR Analytics is designed so that you don't need a cookie banner: it uses no cookies or
other client-side storage, and it does not store IP addresses or any identifier that can
be linked to a person or across days. Always check your local legal requirements.

IP geolocation by [DB-IP](https://db-ip.com) (when `GEOIP_AUTO_DOWNLOAD` is enabled,
licensed under CC BY 4.0).

## License

[MIT](LICENSE)
