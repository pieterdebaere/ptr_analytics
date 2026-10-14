# PTR Analytics

**Self-hosted, privacy-friendly web analytics, speed insights and uptime monitoring for all
your websites — in one central dashboard.** An open-source alternative to Vercel Web Analytics,
Vercel Speed Insights and Uptime Kuma that you run on your own server, e.g.
`https://analytics.example.com`.

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

**Uptime monitoring** (see [Uptime monitoring](#uptime-monitoring))
- 22 monitor types: HTTP(S), HTTP(S) keyword, HTTP(S) JSON query, TCP port, TLS certificate,
  DNS record, push (heartbeat), group, manual, ping (ICMP), WebSocket, SMTP, NTP, Redis, SSH
  banner, gRPC health, PostgreSQL, MySQL / MariaDB, MongoDB, MQTT, Docker container
  (self-hosted only) and domain expiry (RDAP)
- Retries, upside-down mode, accepted status codes, HTTP auth (Basic, Bearer, OAuth 2.0 client
  credentials, mTLS); TLS certificate and domain expiry tracking with notices 21/14/7/3/1 days ahead
- 20 notification providers: e-mail, webhook, Slack, Discord, Microsoft Teams, Telegram,
  Google Chat, Mattermost, Rocket.Chat, Zulip, Matrix, Signal (signal-cli REST API), ntfy,
  Gotify, Pushover, Pushbullet, Home Assistant, PagerDuty, Opsgenie and Twilio SMS
- Public status pages with incidents, custom domains (DNS TXT verification), SVG badges and an
  RSS feed
- Maintenance windows: manual, single, weekly, monthly, every N days or cron, in any IANA time zone
- Push monitors (dead-man's switch for cron jobs and backups)
- Live updates in the dashboard (Server-Sent Events)
- Two-factor authentication (TOTP) with recovery codes; scoped API keys and a Prometheus
  `/metrics` endpoint

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

All state lives in the SQLite database in the data volume, plus the uptime secrets key
`/data/secrets.key` (unless you set `SECRETS_KEY`, see [Secrets key](#secrets-key)). Make a
consistent copy of the database while the server runs with:

```bash
docker compose exec analytics node -e "new (require('better-sqlite3'))('/data/analytics.db').backup('/data/backup.db')"
```

Back up `secrets.key` together with the database: without it the stored monitor credentials,
notification tokens and two-factor secrets cannot be decrypted. Treat backups as secrets: they
contain password hashes and the current day's salt.

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

## Uptime monitoring

### Adding a monitor

Monitors belong to a site. Open the site, go to its **Uptime** tab and click **New monitor**
(or use **Uptime → New monitor** and pick the site). Choose the type, the target, the check
interval (at least `UPTIME_MIN_INTERVAL_S`), retries and the notification channels. Channels
are set up once under **Notifications**; a channel marked as default is linked to every new
monitor. The monitor page shows response times, uptime over 24 hours to 90 days, outages,
status changes and the TLS certificate; it updates live.

### Push monitors

A push monitor is DOWN when nothing arrived within its interval: let cron jobs, backups or
other scripts report in. The push URL is shown once when the monitor is created (or when you
regenerate it). Send the token in the URL:

```bash
curl -fsS -m 10 --retry 3 "https://analytics.example.com/api/push/<token>?status=up&msg=OK&ping="
```

or in the `X-Push-Token` header, which keeps it out of reverse-proxy access logs:

```bash
curl -fsS -m 10 --retry 3 -H "X-Push-Token: <token>" "https://analytics.example.com/api/push?status=up&msg=OK&ping="
```

`status` is `up` (default) or `down`, `msg` an optional message and `ping` an optional response
time in milliseconds. `GET` and `POST` work (a request body is ignored); `HEAD` only checks the
token. Each token may push once per second (bursts of 10); faster pushes are coalesced.

### Status pages and custom domains

Under **Status pages** create a page for a site, choose its monitors and publish it. Public
pages live at `/status/<slug>`, with an RSS feed at `/status/<slug>/feed.xml` and a badge at
`/api/public/status/<slug>/badge.svg`; per-monitor badges (status, uptime, response time,
certificate) can be enabled on the monitor page.

* **Separate origin.** Set `STATUS_PAGE_ORIGIN` (e.g. `https://status.example.com`, not the
  dashboard host or a subdomain of it) and route that host to this server too: public pages are
  then served only there, and `/status/<slug>` on the dashboard origin redirects to it. That
  host serves only the status page surface; login, dashboard and API answer `404`. Recommended
  in hosted mode, where members control the pages' text and logos (the server warns without it).
* **Custom domain.** Add the domain (e.g. `status.example.org`) on the page's **Custom domains**
  tab. The dashboard shows a verification token: publish it as a DNS TXT record

  ```
  _ptr-status.status.example.org.  TXT  "<verifyToken>"
  ```

  and click **Verify** (DNS errors count as "not verified"; try again once the record has
  propagated). Unverified domains expire after 7 days; if
  several pages claim the same domain, the first one to prove DNS control gets it. Then point
  the domain (CNAME or A/AAAA) at your reverse proxy and route it to this server. A custom
  domain serves only its own page (`/` redirects to it). For automatic certificates, Caddy's
  on-demand TLS can ask `https://analytics.example.com/api/public/status-domain?domain=…`,
  which answers `200` only for verified domains of published pages.

### Prometheus

Create an API key with the `metrics` scope under **Security** in the user menu (the key is shown
once, `pa_…`). Admins can choose `metrics:all` to export every account's monitors; otherwise
a key exports the monitors its owner can see. Then scrape `/metrics` with the key as a bearer
token:

```yaml
scrape_configs:
  - job_name: ptr-uptime
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/ptr-analytics.key   # contains pa_…
    static_configs:
      - targets: ["analytics.example.com"]
```

It exports `monitor_status`, `monitor_paused`, `monitor_response_time_ms`,
`monitor_uptime_ratio` and `monitor_cert_days_remaining`. Keys with the `read` scope can call
the read-only dashboard API (`Authorization: Bearer pa_…`). Changing your password, resetting it
and enabling or disabling two-factor authentication revoke all API keys of the account.

### Secrets key

Monitor credentials, notification tokens and two-factor secrets are encrypted at rest
(AES-256-GCM). The key comes from, in this order:

1. `SECRETS_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`);
2. `SECRETS_KEY_FILE`: path to a file with 32 bytes (base64, hex or raw); the file must exist;
3. otherwise `<DATA_DIR>/secrets.key` (`/data/secrets.key` in Docker), generated on first start
   with mode `0600`.

**Back up the key together with the database** (see [Backups](#backups)). If the key is lost
or changed, the stored notification credentials and monitor secrets cannot be decrypted any
more (re-enter them), and authenticator codes stop working: those users sign in with a
recovery code, or you run `cli mfa-reset`.

The key file must not be writable by group or others, and not readable by them either, except a
root-owned file with mode `0400` or `0440` (Docker / Kubernetes secrets). It must also be
readable by the container user (`node`, uid 1000): mount it owned by uid 1000 with mode `0600`/
`0400`, or root-owned with mode `0440` and group gid 1000. A root-owned `0400` file passes the
permission check but cannot be read by the server.

### Security notes

* **SSRF policy.** All monitor and notification traffic resolves the target, checks every
  address and connects to exactly that address; redirects are checked again.
  `UPTIME_PRIVATE_TARGETS` defaults to `allow` on a self-hosted install (you can monitor your
  LAN, localhost and services behind the same reverse proxy) and is forced to `deny` in hosted
  mode (`allow` is refused at startup). Link-local and cloud-metadata addresses
  (`169.254.0.0/16` incl. `169.254.169.254`, `fe80::/10`, `fd00:ec2::254`, `100.100.100.200`,
  `168.63.129.16`, `192.0.0.192` and the metadata host names) are always denied, unless
  `UPTIME_ALLOW_METADATA=true` on a self-hosted install. `UPTIME_TARGET_DENYLIST` applies to
  everyone, `UPTIME_TARGET_ALLOWLIST` only to operator accounts (see [Hosted mode](#hosted-mode)).
* **Redirects.** HTTP monitors fail on an https → http redirect unless *Follow https → http
  redirects* is enabled (self-hosted only), and never follow a redirect that would re-send the
  request body to another origin.
* **No proxy, no `/etc/hosts`.** Monitor and notification traffic ignores `HTTP_PROXY`,
  `HTTPS_PROXY`, `NO_PROXY` and `NODE_USE_ENV_PROXY`, and names are resolved over DNS
  (`UPTIME_DNS_SERVERS` or the system resolvers), so `/etc/hosts` entries are not used.
* **Secrets are write-only** in the API and the dashboard: they are never sent back, only
  whether they are set.
* Set `REQUIRE_MFA_FOR_ADMINS=true` to make admins and viewers enrol two-factor
  authentication before they can use the dashboard or the API.

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

Uptime monitoring (all optional):

| Variable | Default | Description |
|---|---|---|
| `UPTIME_ENABLED` | `true` | Turn uptime monitoring off completely. |
| `UPTIME_MIN_INTERVAL_S` | `20` | Shortest check interval in seconds (5–86400). |
| `UPTIME_CHECK_CONCURRENCY` | `64` | Checks in flight at the same time. |
| `UPTIME_PRIVATE_TARGETS` | `allow` (hosted: `deny`) | `allow` or `deny` monitoring private, loopback and ULA addresses. `allow` is refused in hosted mode. |
| `UPTIME_ALLOW_METADATA` | `false` | Allow link-local / cloud-metadata addresses. Refused in hosted mode. |
| `UPTIME_TARGET_ALLOWLIST` | – | Comma-separated IPs, CIDRs or host names (`*.example.com`) always allowed. Never applies to hosted members. |
| `UPTIME_TARGET_DENYLIST` | – | Comma-separated IPs, CIDRs or host names always denied (wins over the allow list; applies to everyone). |
| `UPTIME_DNS_SERVERS` | system resolvers (hosted members: `1.1.1.1,8.8.8.8`) | Comma-separated resolver IPs (at most 8) for monitor and notification traffic, or `system` for the system resolvers for everyone. |
| `UPTIME_MAX_BODY_BYTES` | `1048576` | Response bytes read by HTTP-like checks (1 KiB–16 MiB). |
| `UPTIME_RAW_RETENTION_HOURS` | `48` | Keep individual heartbeats this long (25–720); hourly statistics are kept 90 days. |
| `UPTIME_RETENTION_DAYS` | `400` | Keep daily statistics, status changes and outages this long (0 = forever). |
| `UPTIME_PING_BINARY` | `/bin/ping` | Absolute path of `ping`; empty disables the ping type. |
| `UPTIME_DOCKER_ENABLED` | `false` | Enable the Docker container type (self-hosted only). |
| `UPTIME_DOCKER_HOST` | `/var/run/docker.sock` | Docker socket path, or `http(s)://` URL of a Docker socket proxy. |
| `UPTIME_DEST_MAX_PER_MIN` | `60` | Checks of hosted members per destination per minute, over all accounts (0 = unlimited). Over budget, checks are delayed, never dropped. |
| `SECRETS_KEY` | – | Key for secrets at rest: 32 random bytes, base64. See [Secrets key](#secrets-key). |
| `SECRETS_KEY_FILE` | `$DATA_DIR/secrets.key` (generated) | File holding the secrets key (must exist when set). |
| `REQUIRE_MFA_FOR_ADMINS` | `false` | Admins **and viewers** must enrol two-factor authentication before using the dashboard, the API or `/metrics`. |
| `MEMBER_MONITORS_PER_SITE` | `10` | Hosted mode: monitors per member site. |
| `MEMBER_MIN_INTERVAL_S` | `60` | Hosted mode: shortest interval for members (never below `UPTIME_MIN_INTERVAL_S`). |
| `MEMBER_MAX_BODY_BYTES` | `262144` | Hosted mode: response bytes read for members (never above `UPTIME_MAX_BODY_BYTES`). |
| `MEMBER_STATUS_PAGES_PER_SITE` | `1` | Hosted mode: status pages per member site. |
| `MEMBER_NOTIFY_CHANNELS` | `10` | Hosted mode: notification channels per member. |
| `MEMBER_NOTIFY_PER_HOUR` | `120` | Hosted mode: notifications sent per member per hour. |

`STATUS_PAGE_ORIGIN` is listed with the hosted-mode variables below; it works in self-hosted
mode too.

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
| `STATUS_PAGE_ORIGIN` | – | Separate origin for public status pages, e.g. `https://status.example.com` (must not be `PUBLIC_URL`'s host or a subdomain of it). Optional, **recommended in hosted mode** (the server warns at startup without it); see *Status pages* below. |

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

* **Status pages.** Status pages show tenant-controlled text and logos. Set
  `STATUS_PAGE_ORIGIN` (e.g. `https://status.example.com`) and route that host to this server
  as well: public pages are then served only there (`/status/<slug>` on the dashboard origin
  redirects to it), and that host — like every verified custom domain — serves *only* the
  status page surface (`/status/<slug>`, its RSS feed, the page assets, `/api/public/*`,
  `/script.js` + `/api/event` for the page's own analytics, `/favicon.svg`); login, the
  dashboard and the authenticated API answer `404` there. Without `STATUS_PAGE_ORIGIN` pages
  stay on the dashboard origin, and verified custom domains are still restricted to their own
  page. Custom domains are verified with a DNS TXT record; several accounts may *claim* the
  same domain, but only the first one to prove DNS control gets it (the other claims are
  dropped), and unverified claims expire after 7 days.
* **Account security.** Enabling two-factor authentication needs the account password,
  creating an API key needs the password (and a current code when 2FA is on), and the owner
  is e-mailed about 2FA changes, new API keys and repeated wrong 2FA codes (progressive
  lockout, at most 30 wrong codes per day). Changing or resetting a password and enabling,
  disabling or resetting 2FA revoke all API keys of the account; a role change signs the
  user out everywhere.

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
docker compose exec analytics node server/dist/cli.js mfa-reset you@example.com          # remove two-factor authentication
docker compose exec analytics node server/dist/cli.js monitors list [siteId]           # uid, site, type, status, name
docker compose exec analytics node server/dist/cli.js monitors pause <uid>
docker compose exec analytics node server/dist/cli.js monitors resume <uid>
```

`create-user` and `reset-password` print a generated password once. `reset-password` and
`mfa-reset <email>` (remove two-factor authentication) sign the user out and revoke the
account's API keys. Login rate limits are kept in memory, so restarting the server also
clears a temporary lockout (the per-account two-factor lockout is stored and survives a
restart; `mfa-reset` clears it). `monitors pause|resume` changes the database directly; a
running server picks the change up within a minute.

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
