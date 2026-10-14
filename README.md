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
- Optional hosted mode: public sign-up with email verification, per-member sites and
  per-site billing with Stripe (see [Hosted mode](#hosted-mode))

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
| `STATS_WORKERS` | `2` | Worker threads for dashboard queries and exports (0 = run in the main thread). |
| `STATS_QUERY_TIMEOUT_MS` | `30000` | Time budget per dashboard query; slower queries are aborted with 503. |
| `STATS_EXPORT_IDLE_TIMEOUT_MS` | `30000` | A CSV export whose client reads nothing for this long is cut off (frees the export slot). |
| `STATS_EXPORT_MAX_DURATION_MS` | `600000` | Maximum duration of a CSV export. |
| `STATS_CACHE_TTL_MS` | `15000` | How long identical dashboard queries are served from cache. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |

Hosted mode (all off by default, see [Hosted mode](#hosted-mode)):

| Variable | Default | Description |
|---|---|---|
| `SIGNUP_ENABLED` | `false` | Public self-service sign-up (`member` accounts, email verification). Requires `SMTP_URL`, `MAIL_FROM` and an `https://` `PUBLIC_URL`. |
| `ALLOW_INSECURE_PUBLIC_URL` | `false` | Local development only: allow `SIGNUP_ENABLED` with an `http://` `PUBLIC_URL`. |
| `SMTP_URL` | – | Outgoing mail server, e.g. `smtps://user:pass@smtp.example.com:465`. `smtp://` connections must upgrade with STARTTLS. |
| `SMTP_ALLOW_INSECURE` | `false` | Allow `smtp://` without STARTTLS (e.g. a relay on localhost); logs a warning at startup. |
| `MAIL_FROM` | – | Sender, e.g. `PTR Analytics <no-reply@example.com>`. |
| `SIGNUP_MAX_PER_HOUR` | `200` | Sign-up requests per hour over all clients; beyond it sign-up answers `503`. |
| `MAIL_MAX_PER_HOUR` | `500` | Outgoing mails per hour; beyond it sign-up and "forgot password" answer `503`. |
| `MAX_UNVERIFIED_ACCOUNTS` | `5000` | Sign-up answers `503` while this many accounts wait for verification. |
| `MEMBER_SITE_LIMIT` | `10` | Max sites per member when billing is disabled. |
| `TERMS_URL` / `PRIVACY_URL` | – | Shown on the sign-up page; when set, sign-up requires accepting them. |
| `BILLING_ENABLED` | `false` | Charge members per site with Stripe. Requires `SIGNUP_ENABLED` and the three Stripe variables. |
| `STRIPE_SECRET_KEY` | – | `sk_live_…` / `sk_test_…` or a restricted key (`rk_…`). |
| `STRIPE_WEBHOOK_SECRET` | – | `whsec_…` of the webhook endpoint `PUBLIC_URL/api/billing/webhook`. |
| `STRIPE_PRICE_ID` | – | Recurring per-unit price (`price_…`), e.g. €1 per site per month. |
| `STRIPE_AUTOMATIC_TAX` | `false` | Enable Stripe Tax in Checkout. |
| `FREE_SITES` | `1` | Sites included for free per member (billing enabled). |
| `PRICE_PER_SITE_CENTS` / `PRICE_CURRENCY` | `100` / `eur` | Display only; the Stripe price is authoritative. |

## Hosted mode

The same server can run as a hosted service where anyone can create an account. A
self-hosted install is unaffected unless you set `SIGNUP_ENABLED=true`.

* **Accounts.** Besides `admin` (operator: all sites, user management, never billed) and
  `viewer` (read-only access to all sites), there is a `member` role: a self-service account
  that only sees and manages the sites it created. Sign-up needs a verified email address:
  the mailed link (valid 24 h) asks for the password chosen at sign-up, so a link alone can
  neither activate an account someone else registered for your address nor log you into
  someone else's account. Logging in before verifying answers like a wrong password and
  re-sends the verification mail. "Forgot password" mails one-hour reset links. Tokens are
  in the link's `#fragment`, so they never reach server logs or `Referer` headers.
  Members can delete their account, which cancels their subscription and deletes all their
  sites and data. Admins can also create members (`role: "member"`) from the user
  management screen or the CLI. Sign-ups that are never verified are removed after 7 days.
* **Operator accounts.** New `viewer` accounts cannot be created in hosted mode (a viewer
  can read every member's sites). Passwords of operator accounts (`admin`, `viewer`) are
  never reset by mail; use `cli reset-password`.
* **Deleting sites and accounts.** A deleted site disappears immediately; its analytics data
  is removed in the background in small chunks, so deleting a large site never stalls the
  server. Accounts with a Stripe customer are deleted from the dashboard (this cancels every
  subscription and deletes the customer); the CLI refuses them. An admin cannot change the
  role of a member with a live subscription.
* **Limits.** Without billing every member may create `MEMBER_SITE_LIMIT` sites. With
  billing, `FREE_SITES` are free and each additional site is one unit of `STRIPE_PRICE_ID`.
  When a member pays for fewer sites than it has (e.g. after cancelling), its oldest sites
  stay active and newer ones are *suspended*: their tracking requests are accepted but
  dropped, nothing is deleted, and they become active again as soon as the allowance allows.
  Sites created by admins have no owner and are never limited. A member's site can have at
  most 5 domains, and wildcards directly over shared hosting domains (`*.github.io`,
  `*.vercel.app`, `*.netlify.app`, …) are refused.
* **Mail.** Any SMTP provider works. Mail is sent in the background; delivery failures are
  logged without addresses or links. Only plain addresses (`name@example.com`) are accepted.
  Sign-up and mail volume are capped globally (see the table above); when a cap or the mail
  queue is full, sign-up and "forgot password" answer `503` instead of dropping mail.
* **Reverse proxy.** Set `TRUST_PROXY` correctly: the sign-up, login and reset rate limits are
  per client IP (IPv6 per /64 and, for sign-up, per /48). With `TRUST_PROXY=false` behind a
  proxy every client shares one bucket; the server warns about this at startup.
* **Uptime monitors (SSRF).** Members can never reach private, loopback or cloud-metadata
  addresses (incl. Azure `168.63.129.16`); `UPTIME_TARGET_ALLOWLIST` does not apply to them. Add
  any other provider-internal or sensitive addresses to `UPTIME_TARGET_DENYLIST`. Member names are
  resolved through `UPTIME_DNS_SERVERS` (default `1.1.1.1,8.8.8.8`) so internal DNS stays hidden.
  The server's own addresses (including `PUBLIC_URL`'s IPs) are denied: behind a shared CDN or
  load balancer this also blocks unrelated sites on the same anycast IPs. Monitor traffic leaves
  from the server's IP, so never allowlist that IP elsewhere (use a dedicated egress if you can).

### Stripe setup

1. Create a product with a **recurring, per-unit** price (e.g. €1.00 / month) and copy its
   `price_…` id to `STRIPE_PRICE_ID`.
2. Create a secret key (or a restricted key with write access to Customers, Checkout
   Sessions, Subscriptions and Customer portal) → `STRIPE_SECRET_KEY`.
3. Add a webhook endpoint `https://analytics.example.com/api/billing/webhook` for the events
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated` and `customer.subscription.deleted`, and copy its signing
   secret to `STRIPE_WEBHOOK_SECRET`.
4. Configure the [customer portal](https://dashboard.stripe.com/settings/billing/portal)
   (invoices, payment methods, cancellation). Do not allow customers to switch to other
   prices there: only `STRIPE_PRICE_ID` counts.
5. Set `BILLING_ENABLED=true` and restart.

Webhooks are only a trigger: the server always re-reads the subscription from the Stripe API,
so replayed or out-of-order events are harmless. Increasing the number of paid sites is
invoiced immediately (prorated) and takes effect once paid; decreasing it credits the
difference on the next invoice; `0` cancels at the end of the billing period.

## Command line

```bash
# Docker
docker compose exec analytics node server/dist/cli.js create-user alice@example.com viewer   # admin | viewer | member
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
