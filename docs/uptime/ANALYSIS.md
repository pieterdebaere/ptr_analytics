# Uptime monitoring for PTR Analytics — Uptime Kuma requirements & feature analysis

Status: research document, input for the uptime-monitoring specification (`docs/uptime/SPEC.md`, to be written).

**Source analysed.** Uptime Kuma tag `2.5.6` (latest 2.x release, `git clone --depth 1 --branch 2.5.6`), cross-checked
against `master` (`3.0.0-beta.0`, commit `b092505`, 2026-10-14). File references below are paths inside the Uptime
Kuma repository at tag 2.5.6 unless stated otherwise. The repository was treated as untrusted data: it was read, never
installed or executed. Public security advisories were taken from
`https://github.com/louislam/uptime-kuma/security/advisories` (both pages).

**What changes in 3.0 (master).** Apart from one extra notification provider (`indigo.js`) the monitor engine,
notification layer, status pages and maintenance code are identical to 2.5.6. 3.0 replaces the home-grown
single-user auth (`server/auth.js`, JWT + `notp` TOTP) by `better-auth` (`server/better-auth.ts`, migrations
`2025-10-29-0000-better-auth.js`, `2026-05-26-*`, `2026-06-08-0000-better-auth-2fa.js`,
`2026-06-29-0000-better-auth-api-key.js`): username plugin, `admin` plugin (roles, ban, impersonation), 2FA plugin,
API-key plugin and a Have-I-Been-Pwned password check. Monitors still carry a single `user_id`; 3.0 is "several
admins of one installation", not tenant isolation.

**How to read this document.** Sections 1–7 describe what Uptime Kuma does (with our recommendation inline where a
decision is needed). Section 8 is the requirements baseline for PTR Analytics: prioritised feature list, data model,
scheduler, analytics integration, hosted-mode tenancy and the threat model.

Conventions: *Kuma* = Uptime Kuma; *we/PTR* = PTR Analytics; *member* = hosted-mode self-service account
(`docs/SPEC.md` §6); "native" = implemented with `node:` built-ins only.

---

## Table of contents

1. [Architecture of Uptime Kuma](#1-architecture-of-uptime-kuma)
2. [Monitor types](#2-monitor-types)
3. [Monitor settings common to all types](#3-monitor-settings-common-to-all-types)
4. [Notification providers](#4-notification-providers)
5. [Status pages and badges](#5-status-pages-and-badges)
6. [Maintenance windows](#6-maintenance-windows)
7. [Other features](#7-other-features)
8. [Requirements for PTR Analytics](#8-requirements-for-ptr-analytics)

---

## 1. Architecture of Uptime Kuma

### 1.1 Process model and stack

* One Node.js process (`server/server.js`, 2 000 lines) running Express 4 for HTTP, **socket.io 4** for the whole
  authenticated dashboard API (there is no REST API for monitors — every CRUD operation is a socket event, see the
  list in §7.10) and a Vue 3 SPA.
* Persistence through `knex` + `redbean-node` (an ORM with "beans"), SQLite by default, MariaDB (embedded or external)
  optional (`server/database.js`, `server/setup-database.js`). Schema in `db/knex_init_db.js` + 57 migrations in
  `db/knex_migrations/`.
* Monitor checks run **in the main event loop**. Each running monitor is an in-memory `Monitor` bean held in
  `UptimeKumaServer.monitorList` (`server/uptime-kuma-server.js`) with its own timer.
* Background jobs via `croner` (`server/jobs.js`): `clear-old-data` daily at 03:14 server time and
  `incremental-vacuum` every 5 minutes.
* Heavy runtime dependencies (from `package.json`): axios, socket.io, express, knex, redbean-node, liquidjs,
  nodemailer, jsonata, badge-maker, croner, playwright-core, @grpc/grpc-js, protobufjs, kafkajs, mqtt, net-snmp,
  gamedig, pg, mysql2, mssql, mongodb, oracledb, redis, ssh2-sftp-client, openid-client, `@louislam/ping`
  (wraps the system `ping` binary), tcp-ping, ws, web-push, nostr-tools, tldts, globalping, node-radius-utils,
  jsonwebtoken, notp, bcryptjs … — roughly 60 direct runtime dependencies. This is the opposite of our
  "minimal dependencies" rule and the main reason we re-implement rather than embed.

### 1.2 Heartbeat model and statuses

Every check produces one **heartbeat** row (`heartbeat` table, `server/model/heartbeat.js`):

| column | meaning |
|---|---|
| `monitor_id` | owner monitor |
| `status` | `0 = DOWN`, `1 = UP`, `2 = PENDING`, `3 = MAINTENANCE` (`src/util.ts` l. 32–35) |
| `msg` | human readable result (`"200 - OK"`, error message, DNS records, …) |
| `time` | UTC datetime with ms (`R.isoDateTimeMillis`) |
| `end_time` | returned by the uptime calculator (same instant in practice) |
| `ping` | response time in ms (nullable) |
| `duration` | seconds since previous beat (push monitors) |
| `important` | 1 when the status changed (see 1.4) |
| `down_count` | consecutive non-important DOWN beats since last notification (resend logic) |
| `retries` | retry counter at the time of the beat |
| `response` | optional brotli-compressed, base64 response body (HTTP types, `save_response` / `save_error_response`) |

Status semantics:

* **UP** — check succeeded (after applying upside-down mode).
* **DOWN** — check failed and no retries left.
* **PENDING** — check failed but `retries < maxretries`; also used by `group` (empty group / pending children),
  `docker` (container restarting or health "starting"), `manual` (no status set).
* **MAINTENANCE** — the monitor (or any ancestor group) is attached to an active maintenance window; the check
  itself is **not executed** (`monitor.js` l. 476–478).

`flipStatus()` (`src/util.ts`) only swaps UP↔DOWN; PENDING/MAINTENANCE stay.

### 1.3 The check loop (`Monitor.start()`, `server/model/monitor.js` l. 420–1120)

```
start(io):
  previousBeat = null; retries = 0
  beat():
    if !previousBeat or type == push: previousBeat = last heartbeat from DB; retries = previousBeat.retries
    bean = new heartbeat {status: DOWN (flipped if upside-down), downCount: previousBeat.downCount}
    if timeout <= 0: timeout = interval * 0.8            # runtime patch
    try:
      if isUnderMaintenance(monitor or ancestors): status = MAINTENANCE
      elif type in (http, keyword, json-query): axios request ... (see §2)
      elif ping / push / docker / radius / kafka-producer: inline implementations
      elif type in monitorTypeList: await monitorType.check(monitor, bean, server)
           (a type must set UP or throw, unless allowCustomStatus)
      if upsideDown: status = flip(status); if now DOWN: throw "Flip UP to DOWN"
      retries = 0
    catch error:
      bean.msg = error.message (AbortSignal → "timeout by AbortSignal (Xs)")
      if upsideDown and status == UP: retries = 0
      elif maxretries > 0 and retries < maxretries: retries++; status = PENDING
      else: retries++ (keeps counting while DOWN)
    bean.retries = retries
    important = isImportantBeat(isFirst, previous.status, bean.status)
    if important: notify if isImportantForNotification(...); bean.downCount = 0; clear status page cache
    else if status == DOWN and resendInterval > 0:
         downCount++; if downCount >= resendInterval: notify again; downCount = 0
    domain-expiry check (RDAP) if enabled
    if status == PENDING and retryInterval > 0: next interval = retryInterval
    uptimeCalculator.update(status, ping)               # stat tables, see 1.6
    io.to(user).emit("heartbeat"); sendStats(); R.store(bean); prometheus.update()
    setTimeout(safeBeat, max(1, interval*1000 - (now - bean.time)))
  safeBeat(): try beat() catch → log, retry after interval
  push monitors: first beat delayed by one interval; others start immediately
```

Notable properties:

* **Drift-compensated** scheduling: next run = `interval − elapsed since the beat started`, so a 3 s check with a 60 s
  interval still runs every 60 s. Long timers use the `unlimited-timeout` package (setTimeout > 24.8 days).
* **No global concurrency limit, no jitter**: on start-up every monitor fires immediately (thundering herd); a slow
  check never blocks others because everything is async, but CPU-heavy types (real browser, gRPC parsing) do.
* **Retry state lives in memory** and is re-read from the last heartbeat on the first beat after (re)start, so a
  restart does not reset a PENDING streak.
* The retry interval only applies while PENDING; DOWN monitors are checked at the normal interval.
* `retry_only_on_status_code_failure` (json-query only): a failed JSON assertion goes straight to DOWN, only
  transport/status failures are retried (l. 935–951).

### 1.4 "Important" beats and notifications

`Monitor.isImportantBeat()` (l. 1391) marks a beat important (= state transition, shown in the event list and kept
long-term) on:

| previous → current | important | notification (`isImportantForNotification`, l. 1426) |
|---|---|---|
| first beat (any) | yes | yes, but `sendNotification` only sends when first beat is DOWN (l. 1459) |
| UP → DOWN, PENDING → DOWN | yes | yes |
| DOWN → UP | yes | yes |
| UP → MAINTENANCE, DOWN → MAINTENANCE | yes | **no** |
| MAINTENANCE → UP | yes | **no** |
| MAINTENANCE → DOWN | yes | yes |
| UP → PENDING, PENDING → UP, PENDING → PENDING, X → X | no | no |

Consequences worth copying: a flap that recovers during retries (UP→PENDING→UP) never notifies; entering/leaving
maintenance is silent unless the monitor comes out DOWN.
Note that DOWN → PENDING never happens: once DOWN, further failures stay DOWN (the retry counter keeps counting),
so a recovery is always DOWN → UP and a new outage always starts from UP.

**Resend** (`resendInterval`, "Resend notification if down X times consecutively", 0 = off): counted in beats, not
time; `down_count` is persisted on each heartbeat so it survives restarts.

The notification text is `[<monitor name>] [✅ Up|🔴 Down] <heartbeat msg>` (l. 1469). Each provider gets
`(notificationConfig, msg, monitorJSON, heartbeatJSON)`; `heartbeatJSON` is enriched with `timezone`,
`timezoneOffset`, `localDateTime` (server time zone) and, on UP, `lastDownTime` (time of the last important DOWN beat,
used by Discord for "downtime duration"). `monitorJSON` is `monitor.toJSON(preload, includeSensitiveData=false)`.
`heartbeatJSON.response` contains the decoded response body when response saving is on — i.e. response bodies of
monitored services are forwarded to third-party notification services.

Providers are called **sequentially and synchronously inside the check loop** (`for … await Notification.send`), so
a slow webhook delays the next check of that monitor. Failures are only logged; there is no retry, queue or
delivery log.

### 1.5 Upside-down mode

`upside_down = 1` inverts the result: a failing check counts as UP (with the error as message), a successful check
throws `"Flip UP to DOWN"` and enters the normal retry logic. Push monitors flip the `status` query parameter.
Use cases: "port must be closed", "page must not be reachable from outside".

### 1.6 Uptime calculation (`server/uptime-calculator.js`)

Introduced in 2.0 to replace per-request `SELECT … FROM heartbeat` aggregation. One `UptimeCalculator` instance per
monitor, cached in memory (`UptimeCalculator.list`), backed by three aggregate tables:

| table | key | retention | in-memory window |
|---|---|---|---|
| `stat_minutely` | `(monitor_id, timestamp)` unique, timestamp = unix seconds floored to the minute | 24 h (deleted on every `update()`) | `LimitQueue(1440)` |
| `stat_hourly` | floored to the hour | 30 days (deleted on every `update()`) | `LimitQueue(720)` |
| `stat_daily` | UTC day start | `keepDataPeriodDays` (daily job) | `LimitQueue(365)` |

Columns: `up`, `down` (counts), `ping` (running **average** of UP beats), `ping_min`, `ping_max`, `extras` (JSON,
currently `{maintenance: n}`). Migrations: `2023-08-16-0000-create-uptime.js`, `2023-12-21-0000-stat-ping-min-max.js`,
`2023-12-22-0000-hourly-uptime.js`, `2024-01-22-0000-stats-extras.js`, `2026-07-22-0000-fix-stat-daily-overflow.js`.

`update(status, ping)`:
* `flatStatus`: UP and MAINTENANCE → UP, DOWN and PENDING → DOWN — but MAINTENANCE is caught first and only
  increments `extras.maintenance`, so **maintenance is excluded** from the ratio; **PENDING counts as down**.
* Only UP beats update ping avg/min/max (incremental mean `avg = (avg·(n−1)+ping)/n`).
* Every beat issues up to 3 upserts + 2 range deletes → ~5 write statements per check.

Reads: `getData(num, type)` sums `up`/`down` over the last `num` buckets (including the current partial bucket);
`uptime = up / (up + down)`; `avgPing = Σ(avg·up)/Σup`. Shortcuts: `get24Hour()` = 1440 minutes, `get7Day()` =
168 hours, `get30Day()` = 30 days, `get1Year()` = 365 days. `getDataByDuration("24h"|"7d"|"2w"|"3M"|"1y"|"30m")`
is used by badges. If the window is empty the last non-empty bucket is returned (questionable).

Properties to note:
* **Count-based, not time-weighted.** A monitor that is DOWN for 10 min with a 20 s retry interval and UP for 50 min
  with a 60 s interval gets 30 DOWN + 50 UP counts → 62.5 % instead of 83 %. Different intervals over time distort
  the ratio. Gaps (server stopped) are simply ignored.
* Daily buckets are UTC days; charts in the browser re-bucket in local time.
* Dashboard shows 24 h, 30 d and 1 y uptime plus 24 h average response (`Monitor.sendStats`, l. 1321).

### 1.7 Retention (`server/jobs/clear-old-data.js`, `server/database.js` l. 983)

* `keepDataPeriodDays` (setting, default **365**, `< 1` disables): deletes `heartbeat` rows older than N days and
  `stat_daily` older than N days.
* `Database.clearHeartbeatData()` (run by the same job): deletes **non-important** heartbeats older than 24 h,
  keeping the newest 100 rows per monitor. So long-term only status changes survive in `heartbeat`; history comes
  from the stat tables.
* SQLite: `PRAGMA optimize` daily and `PRAGMA incremental_vacuum` every 5 minutes.
* Settings → Monitor History: show DB size, "shrink database" (VACUUM), clear all statistics, per monitor "clear
  events" (important beats) and "clear heartbeats".

### 1.8 Realtime (socket.io)

After login the server joins the socket to room `userID` and pushes: `monitorList`, `heartbeatList` (last 100 beats
per monitor), `importantHeartbeatList` (last 500 important beats), `notificationList`, `proxyList`,
`dockerHostList`, `remoteBrowserList`, `apiKeyList`, `maintenanceList`, `statusPageList`, `info`. Per beat:
`heartbeat`, `avgPing`, `uptime` (24, 720, "1y"), `certInfo`, `domainInfo` (only when clients are connected —
`getTotalClientInRoom`). Status pages poll HTTP instead (`/api/status-page/heartbeat/:slug`, cached 1 min).

**For us:** no socket.io. Use Server-Sent Events (`text/event-stream`, built-in, works with our strict CSP
`connect-src 'self'`) for the dashboard live view and plain JSON polling for public status pages.

### 1.9 Extension points that matter for a re-implementation

* `MonitorType` base class (`server/monitor-types/monitor-type.js`): `name`, `supportsConditions`,
  `conditionVariables`, `allowCustomStatus`, `check(monitor, heartbeat, server)`; success = set `status = UP`
  (and optionally `ping`, `msg`), failure = throw. A clean contract we should keep.
* `NotificationProvider` base class (`server/notification-providers/notification-provider.js`):
  `send(config, msg, monitorJSON, heartbeatJSON)`, `renderTemplate()` (LiquidJS), `extractAddress()`,
  `throwGeneralAxiosError()`, `getAxiosConfigWithProxy()` (env `NOTIFICATION_PROXY`).
* **Monitor conditions** (`server/monitor-conditions/`): a small expression tree (`and`/`or` groups, max depth in UI)
  over typed variables with operators `equals, not_equals, contains, not_contains, starts_with, not_starts_with,
  ends_with, not_ends_with, num_equals, num_not_equals, lt, gt, lte, gte`. Used by DNS (`record`), MQTT (`topic`,
  `message`, `json_value`), MySQL/MSSQL/Oracle (`result`). A good, safe alternative to JSONata (see §2.1).

---

## 2. Monitor types

Kuma 2.5.6 offers **35 monitor types**. Eight are implemented inline in `server/model/monitor.js`
(`http`, `keyword`, `json-query`, `ping`, `push`, `docker`, `radius`, `kafka-producer`), the rest are `MonitorType`
subclasses registered in `server/uptime-kuma-server.js` l. 113–138. Per type below: purpose, configuration fields
(column name in `monitor` table → UI default), how the check works, result/message semantics, our recommendation and
the security implications.

**Recommendation legend**

| code | meaning |
|---|---|
| **N** | implement natively with `node:` built-ins (`http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `crypto`, `child_process`) |
| **P** | implement a *small protocol handshake* ourselves on `net`/`tls`/`dgram` without a client driver (a few hundred lines, fully testable with fake servers) |
| **H** | only possible with a heavy third-party dependency (driver/SDK) — not in core; at most an optional plugin later |
| **S** | skip (won't implement) |

Priority (MUST/SHOULD/COULD/WON'T) is given in §8.1; this section only states the technical recommendation.

Universal security baseline for **every** network type (details in §8.7): target resolution goes through our
SSRF guard (resolve → check every address against the block list → connect to the *checked IP literal*, never let the
OS resolve again), per-check hard deadline, response byte cap, and in hosted mode private/loopback/link-local/metadata
targets are refused.

### 2.1 HTTP family — `http`, `keyword`, `json-query`

**Purpose.** Availability of a URL; `keyword` additionally searches the body for a string; `json-query` evaluates an
expression against a JSON body and compares it with an expected value.

**Fields** (`server/server.js` `editMonitor` l. 818–980, defaults from `src/pages/EditMonitor.vue` l. 3346–3420):

| field | column | default / validation |
|---|---|---|
| URL | `url` (TEXT) | `https://`; no server-side scheme validation for `http` (axios only supports http/https) |
| Method | `method` | `GET`; UI: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS |
| Body encoding | `http_body_encoding` | `json` (body parsed with `JSON.parse`, error "Your JSON body is invalid"), `form` (`application/x-www-form-urlencoded`, sent raw), `xml` (`text/xml; charset=utf-8`) |
| Body | `body` (TEXT) | empty |
| Headers | `headers` (TEXT, JSON object) | validated as JSON in `Monitor.validate()` |
| Authentication | `auth_method` | `null`, `basic` (`basic_auth_user`, `basic_auth_pass`), `bearer` (`bearer_token`), `oauth2-cc` (`oauth_token_url`, `oauth_client_id`, `oauth_client_secret`, `oauth_scopes`, `oauth_audience`, `oauth_auth_method` = `client_secret_basic`\|`client_secret_post`), `ntlm` (`basic_auth_user/pass`, `auth_domain`, `auth_workstation`), `mtls` (`tls_cert`, `tls_key`, `tls_ca`, PEM text) |
| Accepted status codes | `accepted_statuscodes_json` | `["200-299"]`; options `100-199 … 500-599` and single codes `100`–`999`; must all be strings |
| Max redirects | `maxredirects` | 10 (0 = do not follow) |
| Ignore TLS/SSL errors | `ignore_tls` | false |
| IP family | `ip_family` | auto / `ipv4` / `ipv6` (`autoSelectFamily` happy-eyeballs otherwise) |
| Cache buster | `cache_bust` | false; adds `?uptime_kuma_cachebuster=<random>` |
| Proxy | `proxy_id` | default proxy preselected |
| Timeout | `timeout` (seconds, double) | 48 s for new monitors, clamped to `0.8 × interval`; `0` → `0.8 × interval` at runtime |
| Save response / save error response | `save_response`, `save_error_response`, `response_max_length` | false / **true** / 1024 bytes (0 … 1 MiB) |
| Certificate expiry notification | `expiry_notification` | false |
| Domain expiry notification | `domain_expiry_notification` | true |
| keyword | `keyword` (VARCHAR 255), `invert_keyword` | case-sensitive substring |
| json-query | `json_path` (JSONata expression, default `$`), `json_path_operator` (`==`, `!=`, `<`, `<=`, `>`, `>=`, `contains`; default `==`), `expected_value` (VARCHAR 255), `retry_only_on_status_code_failure` | |

**How it works** (`monitor.js` l. 479–733):
* axios with custom agents: `rejectUnauthorized = !ignoreTls`, `SSL_OP_LEGACY_SERVER_CONNECT`, `maxCachedSessions: 0`;
  the HTTPS agent carries a fresh `tough-cookie` jar per check (cookies survive redirects within one check).
* Default `Accept: text/html,application/xhtml+xml,…`; user headers override auth headers; `User-Agent` is axios'
  default unless set (Kuma sets `Uptime-Kuma/<version>` globally elsewhere).
* `validateStatus` = accepted status codes; axios follows redirects up to `maxredirects` (redirect targets are not
  re-validated in any way).
* TLS details captured from the `keylog`/`secureConnect` event or the response socket: full chain via
  `getPeerCertificate(true)` → `parseCertificateInfo` (subject, issuer, `validTo`, `daysRemaining`, SANs,
  `fingerprint256`, `certType` server/intermediate CA/root CA/self-signed), `valid = socket.authorized`,
  `hostnameMatchMonitorUrl` (`X509Certificate.checkHost`). Stored in `monitor_tls_info.info_json`.
* Response time = wall clock from before building the request to response (includes OAuth token fetch, DNS, TLS).
* OAuth2 client-credentials via `openid-client` (`util-server.js` l. 74): token cached on the monitor object until
  `expires_at`; on a 401 one forced refresh + retry.
* NTLM via a vendored `axios-ntlm` (`server/modules/axios-ntlm`).
* "maxContentLength size of -1 exceeded" → retried once with `Accept-Encoding: gzip, deflate`.
* No response size limit (axios default `maxContentLength: -1`): a multi-GB body is buffered in memory.

**Result semantics.**
* `http`: UP with msg `"<status> - <statusText>"`; otherwise the axios error message (`"Request failed with status
  code 503"`, `"timeout of 48000ms exceeded"`, `"getaddrinfo ENOTFOUND …"`, `"certificate has expired"`).
* `keyword`: body (objects `JSON.stringify`-ed) `includes(keyword)` XOR invert → UP with `", keyword is found"`;
  else DOWN with `"…, but keyword is not in [<first 47 chars of tag-stripped body>...]"`.
* `json-query` (`evaluateJsonQuery`, `src/util.ts` l. 669): body parsed as JSON, JSONata expression evaluated, result
  must be a primitive (arrays/objects rejected with a hint), then compared as **strings** via a second JSONata
  expression (`$number()` for `<,<=,>,>=`). msg `"JSON query passes (comparing <value> == <expected>)"`.

**Recommendation.** **N** for `http` + `keyword` on `node:http`/`node:https` with our SSRF-safe connector (custom
`lookup` that returns the pre-validated IP, manual redirect following with re-validation of every hop, byte cap,
total deadline, decompression via `node:zlib` with a decompressed-size cap). Keyword search on the first *N* bytes
(cap 1 MiB, configurable lower in hosted mode), optional case-insensitive flag.
`json-query`: **N but not JSONata** — JSONata is a full expression language (functions, regex, recursion → CPU DoS,
and a dependency). Implement a restricted path syntax (`$.a.b[0].c`, `length()` on arrays) plus the operators of
§1.9 conditions. Basic/Bearer/custom headers: N. OAuth2 client credentials: N (form POST to token URL with
`client_secret_basic` or `client_secret_post`, `scope`, `audience`; cache until `expires_in − 30 s`; token URL also
passes the SSRF guard). mTLS: N (`cert`/`key`/`ca` options). NTLM: **S** (legacy, needs MD4/DES which OpenSSL 3
disables by default). Cookie jar: keep cookies only across the redirect chain of one check (N, minimal parser).

**Security.** Classic SSRF primitive (see §8.7.1), including blind SSRF via redirects and DNS rebinding; response
bodies may contain secrets of internal services and are (a) stored when "save response" is on, (b) shown in error
messages (keyword excerpt), (c) forwarded in notifications — in hosted mode never store/forward bodies of non-public
targets. Credentials (basic pass, bearer token, OAuth secret, mTLS key) must be encrypted at rest and write-only in
the API. Header injection: reject CR/LF in header names/values (Node does this, but validate early for good errors).
`ignore TLS` must not disable certificate *capture* (we still want expiry data). `Host` header override + IP literal
URL is a known way to reach virtual hosts on shared IPs — fine, as the IP is what we validate.

### 2.2 `port` — TCP port (+ TLS certificate, STARTTLS, expected TLS alert)

**Fields.** `hostname`, `port` (1–65535), `smtp_security` reused as "TLS mode" (`nostarttls` = none, `secure` = TLS,
`starttls`), `expiry_notification`, `ignore_tls`, `expected_tls_alert` (`none` or an RFC 8446 alert name:
`certificate_required`, `bad_certificate`, `certificate_unknown`, `unknown_ca`, `access_denied`,
`handshake_failure`, `certificate_expired`, `certificate_revoked`, …), optional `tls_cert`/`tls_key`/`tls_ca`
(present a client cert while expecting an alert).

**How it works** (`server/monitor-types/tcp.js`): `tcp-ping` opens a TCP connection (1 attempt) and measures connect
time → UP, msg `"<ms> ms"`, failure → `"Connection failed"`. If TLS mode is `secure`/`starttls` **and** expiry
notification is on, a second connection performs TLS (for STARTTLS a mini state machine speaks SMTP `EHLO`/
`STARTTLS`, IMAP `a001 STARTTLS` or XMPP `<starttls/>` after a 1.5 s banner timeout) and stores certificate info;
an invalid certificate → DOWN `"TLS Connection failed: Certificate is invalid"`. Expected-TLS-alert mode connects
with `tls.connect`, parses `alert number N` from the OpenSSL error and is UP only if the expected alert arrives
(used to assert that an mTLS endpoint rejects clients without certificate).

**Recommendation.** **N** (`net.connect` with timeout; `tls.connect` with `servername`; STARTTLS state machine for
SMTP/IMAP/POP3/XMPP is ~100 lines). Add a dedicated **`tls` type** ("TLS certificate"): connect, SNI, read chain,
DOWN when invalid / hostname mismatch / expires in < X days — a frequent need that Kuma only covers indirectly.

**Security.** Port scanning of internal networks (the error message distinguishes refused vs timeout → network
mapping oracle). In hosted mode: SSRF guard + a port deny-list is not needed if private ranges are blocked, but rate
limit monitor creation/test-runs per member. Do not echo raw server banners into messages without length cap and
control-character stripping.

### 2.3 `ping` — ICMP echo

**Fields.** `hostname`; `ping_count` (1–100, default 1, new monitors 3), `packet_size` (1–65500, default 56),
`timeout` used as ping *deadline* (1–300 s, default 10), `ping_per_request_timeout` (1–60 s, default 2),
`ping_numeric` (default true). Validation in `Monitor.validate()` l. 1715–1754; the UI raises the interval to at least
`ceil(min(deadline, count × perRequestTimeout) × 1.1)` (`EditMonitor.vue` `calculatePingInterval`).

**How it works.** `@louislam/ping` spawns the OS `ping` binary (`util-server.js` l. 115–205) with `-c count -s size
-w deadline -W timeout [-n]`; output parsed for avg time; when the first attempt fails with an empty message it
retries with `ping6`/`-6`. UP with `ping = avg rtt`, msg empty; DOWN with the raw `ping` output (Windows output
converted from the console code page with `iconv`/`chardet`).

**Recommendation.** Node has no raw/ICMP datagram sockets, so either **exec** the system `ping` (needs
`iputils-ping` in the image and either the setuid bit, `CAP_NET_RAW` or `net.ipv4.ping_group_range` covering the
container GID) or skip. Recommend **N via `execFile`** (never a shell) with a fixed argument vector, the *already
resolved and validated IP literal* as the only positional argument (never the user's hostname — prevents both
argument injection like `-f`/`--` tricks and re-resolution/DNS rebinding), output parsed by a strict regex for
iputils and BusyBox formats, `LC_ALL=C`. Provide a "TCP ping" (connect time to port 443/80) fallback when the binary
is unavailable.

**Security.** Command execution surface (mitigated by execFile + IP literal + numeric-only options);
`CAP_NET_RAW` in the container (also allows packet spoofing — prefer `ping_group_range`); traffic amplification
(100 × 65 500 bytes every 20 s at a victim) → in hosted mode clamp count ≤ 5, size ≤ 1 472 (no fragmentation),
interval ≥ 60 s. ICMP to private ranges = network mapping → SSRF guard.

### 2.4 `dns` — DNS record check

**Fields.** `hostname` (name to query, or IP for PTR), `dns_resolve_server` (comma separated IPs **or hostnames**,
UI default `1.1.1.1`), `port` (default 53), `dns_resolve_type` (`A`, `AAAA`, `CAA`, `CNAME`, `MX`, `NS`, `PTR`, `SOA`,
`SRV`, `TXT`; default `A`), `conditions` (variable `record`, string operators), `dns_last_result` (TEXT, written by the
check).

**How it works** (`server/monitor-types/dns.js`): resolver hostnames are themselves resolved (A+AAAA) so a docker
service name can be used; `node:dns/promises` `Resolver.setServers(["[ip]:port", …])`, `resolve(name, type)` or
`reverse()`. Message formats: `Records: a | b`, MX `Hostname: x - Priority: n`, SOA `NS-Name: … | Serial: …`, SRV
`Name: … | Port: …`. Conditions: UP if **any** record satisfies the condition group; otherwise DOWN with the record
list. The last result is written to `monitor.dns_last_result` when it changes (record-change detection is shown in
the UI but does not notify).

**Recommendation.** **N** (exactly Kuma's approach). Add: "notify when records change" (SHOULD — cheap and valuable
for hijack detection), DNSSEC AD bit is out of scope (c-ares does not expose it).

**Security.** The resolver address is a network target (UDP/TCP 53) → SSRF guard; hostnames for resolvers must not
be accepted in hosted mode (rebinding). Queried names are not a target and need no guard. Limit TXT result length in
messages.

### 2.5 `docker` — container state

**Fields.** `docker_container` (name or id), `docker_host` → `docker_host(id, user_id, name, docker_type =
socket|tcp, docker_daemon = socket path or `tcp://host:2375`)`. TLS client certs are read from
`data/docker-tls/<host>/{ca,cert,key}.pem` when the URL is https (`server/docker.js` l. 85–115).

**How it works** (`monitor.js` l. 784–847): `GET /containers/<name>/json` against the Docker Engine API; not running →
DOWN `"Container State is <status>"`, paused → DOWN, restarting → PENDING, health `healthy` → UP, `unhealthy` →
DOWN, `starting` → PENDING, no health check → UP with a long hint message. "Test docker host" lists
`/containers/json?all=true`.

**Recommendation.** **N** (HTTP over `socketPath`), **self-hosted only**, behind an explicit operator opt-in
(`UPTIME_DOCKER_HOSTS_ENABLED=true`) and documentation recommending a read-only docker-socket-proxy
(only `GET /containers/*/json`). Container name validated `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$` (prevents path
traversal into other Engine API endpoints such as `../../exec`).

**Security.** Mounting `/var/run/docker.sock` = root on the host for anyone who can make the server issue arbitrary
Engine API calls. Disabled in hosted mode; `tcp://` daemons are SSRF targets too.

### 2.6 `system-service` — systemd / Windows service

**Fields.** `system_service_name` (regex `^[a-zA-Z0-9._\-@]+$`). **How.** `execFile("systemctl", ["is-active", name])`
or PowerShell `Get-Service` (`server/monitor-types/system-service.js`). **Recommendation.** **S** for the first
release (our server normally runs in a container where systemd is not visible); COULD later for bare-metal installs,
self-hosted only. **Security.** Command execution; reveals host service inventory.

### 2.7 `pm2` — PM2 process

**How.** `execFile("pm2", ["jlist"])` and looks up the process by name/id (`server/util/pm2.js`). **Recommendation:
S.** Host-specific, command execution.

### 2.8 `real-browser` — headless Chromium

**Fields.** `url`, `remote_browser` (→ `remote_browser(id, name, url)` Playwright `ws://` endpoint), `screenshot_delay`
(ms, `< 0.5 × interval`), accepted status codes. Settings: `chromeExecutable` (allow-list of paths unless
`UPTIME_KUMA_ALLOW_ALL_CHROME_EXEC=1`; in the official container it `apt install`s Chromium on first use!).

**How.** `playwright-core` `chromium.launch()` or `connect(remoteURL)`; `page.goto(url, {waitUntil: "networkidle",
timeout: 0.8 × interval})`; screenshot saved as `data/screenshots/<jwt(monitorId)>.png`; 200–399 → UP, ping = response
timing. Only `http:`/`https:` allowed since GHSA-2qgm-m29m-cj2h (local file inclusion via `file://`).

**Recommendation. S** (WON'T in core): hundreds of MB, a browser is an SSRF cannon (every sub-resource, redirects,
JavaScript `fetch` to internal IPs — cannot be guarded at our socket layer), high CPU/RAM per check. Our Speed
Insights already measure real-user experience; a synthetic browser is out of scope. Possible future: "remote browser"
only (self-hosted, operator supplies a sandboxed browser endpoint).

### 2.9 `websocket-upgrade`

**Fields.** `url` (`wss://` default), `ws_subprotocol` (comma list), `ws_ignore_sec_websocket_accept_header`,
`headers`, auth (`basic`, `bearer`, `oauth2-cc`, `mtls`), `ignore_tls`, `timeout` (handshake), accepted *close* codes
(`accepted_statuscodes_json`, default `["1000"]`, options 1000–4999).

**How** (`server/monitor-types/websocket-upgrade.js`): `ws` library connects; on `open` it closes with 1000; result is
the close code checked against accepted codes; error close codes mapped to names (1002 "Protocol error", 1006
"Abnormal Closure", 1008 "Policy Violation", 1011 "Internal Error", 3000 "Unauthorized", …); optionally an invalid
`Sec-WebSocket-Accept` is tolerated.

**Recommendation.** **P**: perform the RFC 6455 opening handshake over our SSRF-safe HTTP/1.1 connector
(`Upgrade: websocket`, `Connection: Upgrade`, random 16-byte `Sec-WebSocket-Key`, `Sec-WebSocket-Version: 13`,
optional `Sec-WebSocket-Protocol`), require `101` and `Sec-WebSocket-Accept = base64(sha1(key + 258EAFA5-E914-47DA-95CA-C5AB0DC85B11))`,
then send a masked close frame (1000) and read the server's close frame (2-byte code). ~150 lines. Node 22's global
`WebSocket` cannot take custom headers, agents or a pinned IP, so it is unsuitable.

**Security.** Same as HTTP (SSRF, credentials).

### 2.10 `sftp`

**Fields.** `hostname`, `port` (22), `ssh_username`, `ssh_auth_method` (`password`|`privateKey`), `ssh_password`,
`ssh_private_key`, `ssh_passphrase`, `sftp_path` (must exist), `timeout`. **How.** `ssh2-sftp-client` connect +
`exists(path)` (`server/monitor-types/sftp.js`). **Recommendation. H** for login/path checks (ssh2 is large, native
crypto bindings). Offer instead **P "SSH banner"**: TCP connect and require a line matching `^SSH-2\.0-` within the
timeout (proves sshd is answering) — covers most uptime use cases with zero dependencies. **Security.** Stored SSH
private keys are high-value secrets; avoid storing them at all.

### 2.11 `group`

**Fields.** Only common fields; children reference it through `monitor.parent`. **How**
(`server/monitor-types/group.js`): on its own schedule, looks at the **last heartbeat** of every *active* child:
no children → PENDING `"Group empty"`; any DOWN → throws `"Child monitors down: a, b; pending: c"` (→ retries →
DOWN); else any PENDING or child without beats → PENDING; else UP `"All children up and running"`. Paused children
are ignored. Groups nest (cycles prevented in `editMonitor` via `getAllChildrenIDs`). Pausing a group force-pauses
descendants (`isParentActive`), maintenance on a group applies to descendants (`isUnderMaintenance` recursion),
deleting a group either deletes the children recursively or unlinks them (user's choice); changing a group's
type to non-group unlinks them.

**Recommendation. N**, plus improvement: re-evaluate the group immediately when a child's status changes (event
driven instead of polling with up to one interval lag) and optional "degraded" semantics (UP if ≥ k of n children
UP). **Security:** none beyond tenancy (children must belong to the same tenant/site).

### 2.12 `push` — passive heartbeat (dead-man's switch)

**Fields.** `push_token` (32 chars `[A-Za-z0-9]`, generated **client-side** with `genSecret(32)`, column widened by
`2023-10-11-1915-push-token-to-32.js`, regenerate button), `interval` (= expected period), retries, upside-down.

**How.** Endpoint `ALL /api/push/:pushToken?status=up|down&msg=OK&ping=<ms>` (`server/routers/api-router.js`
l. 46–150), any HTTP method, no auth besides the token, monitor must be active. `status` ≠ `up` means DOWN; `ping`
validated 0 … 1e11; `msg` stored as given (no length limit). Status computed by `determineStatus()` (retries via the
previous beat), maintenance overrides, `duration` = seconds since previous beat. The monitor loop does not check
anything; it only enforces the deadline: if the last beat is not UP or older than `interval + 1 s` it creates a DOWN
beat `"No heartbeat in the time window"` (through retries → PENDING first); otherwise it sleeps until the deadline.
Response `{"ok":true}` or `404 {"ok":false,"msg":…}`. Push code samples for 10 languages in `extra/push-examples/`.

**Recommendation. N** — essential for cron jobs/backups. Changes: token generated server-side (`crypto.randomBytes(24)`
base64url = 192 bit), stored as `sha256(token)` (lookup by hash, show once / allow reveal only by re-generation),
accept `GET`/`POST`/`HEAD`, body ignored, `msg` ≤ 255 chars stripped of control characters, per-token and per-IP rate
limit (e.g. 1 request/s burst 10 per token; 404s per IP limited to stop token guessing), CORS `*` allowed (no
credentials). Optional "start" signal (`/api/push/<token>/start`) to measure job duration (Healthchecks.io style) —
COULD.

**Security.** Unauthenticated write endpoint: token guessing (192 bit is enough, but rate-limit misses), log
injection via `msg`, storage flooding (one beat per request → cap to 1 stored beat per second per monitor and
collapse duplicates), tokens leaking in proxy logs (allow the token in a header `X-Push-Token` or the path — document
that query strings are logged).

### 2.13 `manual`

**Fields.** `manual_status` (`1` UP, `0` DOWN, `2`/null PENDING) set from the monitor page. **How.** The check copies
the status (`server/monitor-types/manual.js`). **Recommendation. N** — trivial and useful for status pages
("component X degraded" set by a human) and for showing third-party services. **Security:** none.

### 2.14 `globalping` — probes from the Globalping network

**Fields.** `subtype` (`ping`, `http`, `dns`), `location` ("magic" location string, default `world`), `protocol`
(ICMP/TCP for ping, HTTP/HTTPS/HTTP2 for http, UDP/TCP for DNS), `ping_count`, `port`, `ip_family`,
`dns_resolve_server`, `dns_resolve_type`, `keyword`/`invert_keyword`, JSON query fields, headers, auth, accepted
status codes; setting `globalpingApiToken`.

**How.** `globalping` SDK: `createMeasurement({type, target, limit: 1, locations: [{magic}]})`, polls
`awaitMeasurement(id)`, evaluates the probe's result (status code, keyword, JSON query, DNS records, TLS info). Free
tier is rate-limited ("You have run out of credits").

**Recommendation. COULD**, natively via `fetch` to the fixed host `api.globalping.io` (no SDK). Valuable for
multi-region checks without running our own probes. **Security/privacy:** target URLs, headers and credentials are
sent to a third party — disallow auth headers/credentials for this type, document data flow, operator opt-in.

### 2.15 `grpc-keyword`

**Fields.** `grpc_url` (`host:port`), `grpc_protobuf` (proto source text), `grpc_service_name`, `grpc_method`,
`grpc_body` (JSON), `grpc_metadata`, `grpc_enable_tls`, `keyword`, `invert_keyword`.

**How.** `protobufjs.parse(proto)` + `@grpc/grpc-js` unary call; gRPC status code 1 (CANCELLED) is treated as OK;
keyword searched in `JSON.stringify(response)`.

**Recommendation.** Arbitrary proto: **H/S**. Instead implement **N "gRPC health"** with `node:http2`: POST
`/grpc.health.v1.Health/Check` with `content-type: application/grpc`, `te: trailers`, body = 5-byte frame header +
protobuf `HealthCheckRequest{service}` (field 1, string), read `grpc-status` trailer and decode
`HealthCheckResponse.status` (field 1 varint; `1 = SERVING`). ~120 lines, covers the standard health protocol used
by Kubernetes. **Security:** SSRF guard on the HTTP/2 connection; proto parsing of user input avoided entirely.

### 2.16 `kafka-producer`

**Fields.** `kafka_producer_brokers` (JSON array `host:port`), `kafka_producer_topic`, `kafka_producer_message`,
`kafka_producer_ssl`, `kafka_producer_allow_auto_topic_creation`, `kafka_producer_sasl_options` (JSON
`{mechanism: None|plain|scram-sha-256|scram-sha-512|aws, username, password, …}`), timeout default 1 s.

**How.** `kafkajs` connects and **produces a message** every interval (`util-server.js` l. 214–300).
**Recommendation. S** — heavy dependency and a monitor that writes data into the target system. **Security:** writes,
credentials.

### 2.17 `mqtt`

**Fields.** `hostname` (scheme `mqtt://`, `mqtts://`, `ws://`, `wss://` added if missing), `port`, `mqtt_username`,
`mqtt_password`, `mqtt_topic`, `mqtt_websocket_path`, `mqtt_check_type` (`keyword` with `mqtt_success_message`,
`json-query` with `json_path` + `expected_value` (equality only)), `conditions` (`topic`, `message`, `json_value`).

**How** (`server/monitor-types/mqtt.js`): `mqtt` library connects with random client id, subscribes, waits for the
**first message** on the topic (works best with retained messages) up to `0.8 × interval`, then disconnects.

**Recommendation. P (COULD)**: MQTT 3.1.1 over TCP/TLS needs CONNECT, CONNACK, SUBSCRIBE, SUBACK, PUBLISH parsing
(remaining-length varint) — ~250 lines; skip MQTT-over-WebSocket. **Security:** broker credentials; SSRF guard;
cap received payload (MQTT allows 256 MB messages).

### 2.18 `ntp`

**Fields.** `hostname`, `port` (123), `timeout` (10 s), `ntp_stratum_threshold` (5), `ntp_time_offset_threshold`
(1000 ms), `ntp_root_dispersion_threshold` (500 ms).

**How** (`server/monitor-types/ntp.js`, already native): `dns.lookup`, one 48-byte NTPv3 client packet (`0x1B`) via
`dgram`, parse stratum, refid, root dispersion, T2/T3; offset `((T2−T1)+(T3−T4))/2`, delay `(T4−T1)−(T3−T2)`.
DOWN for stratum 16 or thresholds exceeded; msg `Stratum: 2, RefID: …, Offset: 0.412ms, Delay: …, Dispersion: …`.

**Recommendation. N** (port Kuma's approach; validate response source address/port and the originate timestamp to
avoid accepting spoofed packets). **Security:** UDP to arbitrary hosts → SSRF guard; response size fixed.

### 2.19 `rabbitmq`

**Fields.** `rabbitmq_nodes` (JSON array of management base URLs), `rabbitmq_username`, `rabbitmq_password`.
**How.** `GET <node>/api/health/checks/alarms/` with Basic auth; 200 → healthy, 503 → `reason`; first healthy node
wins. **Recommendation. N** but as a *preset* of the HTTP/JSON check (URL + basic auth + expected status) rather than
its own type. **Security:** as HTTP.

### 2.20 `sip-options`

**How.** Spawns `sipsak -s sip:host:port --from sip:sipsak@host -v` (hidden in the container image because `sipsak`
is missing) and looks for `200 OK`. **Recommendation. P (COULD)**: send a SIP `OPTIONS` request over UDP (and TCP)
ourselves (Via/From/To/Call-ID/CSeq/Max-Forwards headers, ~60 lines) and accept any `SIP/2.0 2xx`. **Security:**
UDP; small response cap; SSRF guard.

### 2.21 `smtp`

**Fields.** `hostname`, `port` (25), `smtp_security` (`secure` = SMTPS/465, `nostarttls` = ignore STARTTLS,
`starttls` = require STARTTLS).

**How.** `nodemailer.createTransport(opts).verify()` — connect, greeting, EHLO, (STARTTLS), no AUTH since no
credentials; UP `"SMTP connection verifies successfully"`.

**Recommendation. P (SHOULD)**: banner `220`, `EHLO <our hostname>`, optional `STARTTLS` + `tls.connect({socket})`,
`QUIT`; capture the certificate for expiry monitoring (the main reason people monitor SMTP). nodemailer is already
our dependency but its `verify()` does not expose the certificate. **Security:** port 25 egress is blocked by many
clouds; never send `MAIL FROM`/`RCPT TO` (no relay testing — would turn us into an open-relay scanner).

### 2.22 `snmp`

**Fields.** `hostname`, `port` (161), `snmp_version` (`1`, `2c` default, `3`), community string stored in
`radius_password` (!), `snmp_v3_username` (v3 noAuthNoPriv only), `snmp_oid`, `json_path`, `json_path_operator`,
`expected_value`, `timeout` default 5 s, `maxretries` reused as SNMP retries.

**How.** `net-snmp` GET of one OID, `NoSuchInstance` → DOWN, value compared via `evaluateJsonQuery`.

**Recommendation. P (COULD)**: SNMPv2c GET = BER-encoded `SEQUENCE{version, community, GetRequest-PDU{request-id, 0,
0, VarBindList{OID, NULL}}}` over UDP and decoding INTEGER/OCTET STRING/OID/Counter/Gauge/TimeTicks — ~250 lines.
v3 with auth/priv is out of scope. **Security:** community strings are credentials; UDP SSRF guard; in practice only
for self-hosted (devices are on private networks).

### 2.23 `tailscale-ping`

**How.** Spawns `tailscale ping --c 1 <hostname>` (hidden in containers). Advisory GHSA-hfxh-rjv7-2369
("Authenticated remote code execution via TailscalePing", fixed by argument handling). **Recommendation. S.**

### 2.24 Database monitors — `postgres`, `mysql`, `sqlserver`, `oracledb`, `mongodb`, `redis`

**Fields.** `database_connection_string` (VARCHAR 2000; templates `postgres://username:password@host:port/database`,
`mysql://…`, `Server=<host>,<port>;Database=…;User Id=…;Password=…;Encrypt=…` for MSSQL, `localhost:1521/FREEPDB1`
for Oracle with `basic_auth_user`/`basic_auth_pass`), `database_query` (default `SELECT 1` /
`SELECT 1 FROM DUAL`; MongoDB: a JSON command document, default `{ping: 1}`), MySQL password in `radius_password`
(!), `conditions` (`result`, single row/single column required) for MySQL/MSSQL/Oracle, `json_path` +
`expected_value` for MongoDB, `ignore_tls` for Redis (`rediss://`).

**How.** Drivers `pg`, `mysql2`, `mssql` (tedious), `oracledb` (thin mode), `mongodb`, `redis` — connect, run the
query/command, disconnect; msg `"Rows: n"` or condition result.

**Recommendation.** Full query monitors: **H** (six large drivers) → WON'T in core. Instead, credential-free
**P "service handshake" checks** that prove the server process is answering its protocol:
* **Redis**: send `PING` in RESP (`*1\r\n$4\r\nPING\r\n`, optional `AUTH`), expect `+PONG` or `-NOAUTH` (alive). N/P,
  SHOULD-level cheap.
* **PostgreSQL**: send `SSLRequest` (8 bytes, code 80877103) → `S`/`N`; or StartupMessage and expect an
  `R` (authentication request) or `E` message. COULD.
* **MySQL/MariaDB**: read the initial handshake packet (protocol version 10 + server version string). COULD.
* **MongoDB**: `OP_MSG {hello: 1}` needs BSON encode/decode (~150 lines) — COULD.
* MSSQL/Oracle: plain TCP check.

**Security.** User-supplied SQL executed with user-supplied credentials (their responsibility, but the error
messages can leak schema data into notifications); connection strings are secrets; drivers are a large attack
surface (protocol parsers fed by a hostile server). In hosted mode only the handshake variants, with SSRF guard.

### 2.25 `radius`

**Fields.** `hostname`, `port` (1812), `radius_username`, `radius_password`, `radius_secret`,
`radius_called_station_id`, `radius_calling_station_id`; timeout `0.4 × interval`.
**How.** `node-radius-utils` Access-Request (PAP, MD5-hidden password); Access-Accept → UP with msg = response code;
Access-Reject/timeout → DOWN. **Recommendation. P (COULD)**: RFC 2865 packet + `User-Password` hiding with
`node:crypto` MD5 + Response-Authenticator verification, ~150 lines; self-hosted niche. **Security:** shared secret
and a real user password stored; UDP SSRF guard.

### 2.26 `gamedig` and `steam`

**gamedig fields:** `game` (one of hundreds of GameDig protocol ids), `hostname`, `port`, `gamedig_given_port_only`
(default true), `gamedig_token`. **steam fields:** `hostname`, `port`; setting `steamAPIKey`; queries
`https://api.steampowered.com/IGameServersService/GetServerList/v1/?filter=addr\<ip>:<port>&key=…` and then pings.
**Recommendation. S** (niche, GameDig is a large dependency; Steam needs an API key and only proves the server is
listed). Game servers can still use `port`/UDP-less checks.

### 2.27 Summary table

| type | Kuma implementation | our recommendation | hosted mode |
|---|---|---|---|
| http / keyword | axios, tough-cookie, openid-client, axios-ntlm | **N** | allowed (SSRF guard) |
| json-query | axios + JSONata | **N** (restricted path + operators) | allowed |
| port (TCP/TLS/STARTTLS/TLS alert) | tcp-ping, tls | **N** | allowed |
| *tls (new)* | — | **N** | allowed |
| ping | system `ping` via `@louislam/ping` | **N** via `execFile` + IP literal | allowed with clamps |
| dns | node:dns | **N** | allowed, resolver must be public IP |
| docker | axios over unix socket / tcp | **N**, opt-in | **disabled** |
| system-service | systemctl / PowerShell | **S** (COULD later) | disabled |
| pm2 | `pm2 jlist` | **S** | disabled |
| real-browser | playwright-core / Chromium | **S** | disabled |
| websocket-upgrade | ws | **P** | allowed |
| sftp | ssh2-sftp-client | **H** → offer **P** "SSH banner" | banner only |
| group | internal | **N** | allowed |
| push | internal HTTP endpoint | **N** | allowed |
| manual | internal | **N** | allowed |
| globalping | globalping SDK | COULD via fetch | operator opt-in |
| grpc-keyword | @grpc/grpc-js + protobufjs | **H** → offer **N** gRPC health (`node:http2`) | health only |
| kafka-producer | kafkajs | **S** | disabled |
| mqtt | mqtt | **P** (COULD) | allowed |
| ntp | dgram (native) | **N** | allowed |
| rabbitmq | axios | **N** as HTTP preset | allowed |
| sip-options | `sipsak` binary | **P** (COULD) | allowed |
| smtp | nodemailer verify | **P** | allowed |
| snmp | net-snmp | **P** (COULD) | disabled (private devices) |
| tailscale-ping | `tailscale` binary | **S** | disabled |
| postgres / mysql / sqlserver / oracledb / mongodb | pg, mysql2, mssql, oracledb, mongodb | **H** → offer **P** handshakes | handshake only |
| redis | redis | **P** (RESP PING) | allowed |
| radius | node-radius-utils | **P** (COULD) | disabled |
| gamedig / steam | gamedig / Steam Web API | **S** | disabled |

---

## 3. Monitor settings common to all types

Columns of the `monitor` table that apply to every (or nearly every) type. Source: `db/knex_init_db.js` l. 66–121
plus migrations, `editMonitor` in `server/server.js` l. 818–980, `Monitor.validate()` (`monitor.js` l. 1631) and
`EditMonitor.vue` defaults (l. 3357).

| setting | column | default | validation / behaviour |
|---|---|---|---|
| Friendly name | `name` VARCHAR 150 | auto-filled from URL/hostname in the UI | none server-side |
| Description | `description` TEXT | empty | shown in list & on hover; not on status pages |
| Type | `type` VARCHAR 20 | `http` | switching group → non-group unlinks children |
| Active (pause/resume) | `active` | 1 | pausing stops the timer; children of a paused group are "force inactive" |
| Heartbeat interval | `interval` (s) | 60 (UI), 20 (DB) | `≥ MIN_INTERVAL_SECOND` = **1 s** (`src/util.ts` l. 46); no maximum (uses `unlimited-timeout`) |
| Retries | `maxretries` | 0 | ≥ 0; number of consecutive failures shown as PENDING before DOWN |
| Heartbeat retry interval | `retry_interval` (s) | 60 | ≥ 1 s; used only while PENDING |
| Resend notification if down X times | `resend_interval` (beats) | 0 = off | counted in DOWN beats (`down_count`) |
| Request timeout | `timeout` (s, double) | 48 (ping 10, snmp 5, kafka 1) | UI clamps to `0.8 × interval`; 0 → 0.8 × interval |
| Upside-down mode | `upside_down` | false | §1.5 |
| Retry only on status-code failure | `retry_only_on_status_code_failure` | false | json-query only |
| Accepted status codes | `accepted_statuscodes_json` | `["200-299"]` (websocket `["1000"]`) | array of strings `"N"` or `"N-M"` |
| Max redirects | `maxredirects` | 10 | HTTP family |
| Ignore TLS/SSL error | `ignore_tls` | false | HTTP, port (TLS alert), redis, websocket, steam |
| Certificate expiry notification | `expiry_notification` | false (UI) | thresholds from setting `tlsExpiryNotifyDays` (default `[7, 14, 21]`) |
| Domain name expiry notification | `domain_expiry_notification` | true | RDAP; thresholds from setting `domainExpiryNotifyDays`; only for types listed in `TYPES_WITH_DOMAIN_EXPIRY_SUPPORT_VIA_FIELD` (`src/util.ts` l. 785) |
| IP family | `ip_family` | auto | `ipv4` / `ipv6` (HTTP, globalping) |
| Method / body / body encoding / headers | `method`, `body`, `http_body_encoding`, `headers` | GET / – / json / – | headers must be a JSON object |
| Authentication | `auth_method` + `basic_auth_user`, `basic_auth_pass`, `bearer_token`, `oauth_*`, `auth_domain`, `auth_workstation`, `tls_cert`, `tls_key`, `tls_ca` | none | see §2.1 |
| Proxy | `proxy_id` → `proxy` | the proxy flagged `default` | HTTP family only |
| Cache buster | `cache_bust` | false | random query parameter |
| Save (error) response | `save_response`, `save_error_response`, `response_max_length` | false / true / 1024 | max 1 MiB; stored brotli+base64 in `heartbeat.response` |
| Monitor group | `parent` → `monitor.id` | none | cycle check; a group can be created inline from the form |
| Tags | `monitor_tag(monitor_id, tag_id, value)` | – | see below |
| Notifications | `monitor_notification(monitor_id, notification_id)` | providers flagged *default* are pre-selected | §4 |
| Conditions | `conditions` (JSON) | `[]` | types with `supportsConditions` |
| Push token | `push_token` VARCHAR 32 | generated in browser | push only |
| Weight | `weight` | 2000 | legacy ordering, unused in 2.x UI |

**Tags.** `tag(id, name, color, created_date)` + `monitor_tag(id, monitor_id, tag_id, value TEXT)`. A tag can be
attached several times with different *values* (`env:prod`, `env:eu`), colours are free CSS colours (UI palette +
custom hex). Tags are shown in the list and detail page, optionally on status pages (`show_tags`), used in the list
filter, passed to notification providers (`monitorJSON.tags`, ntfy and Teams render them) and exported as Prometheus
labels (sanitised tag names become label names, values become label values — `server/prometheus.js`). Managed under
Settings → Tags (create, rename, recolour, delete, bulk-assign monitors).

**Proxies** (`server/proxy.js`, `proxy` table: `protocol` ∈ `http, https, socks, socks5, socks5h, socks4`, `host`,
`port`, `auth`, `username`, `password` (plaintext), `active`, `default`, `user_id`). Implemented with
`http-proxy-agent`, `https-proxy-agent`, `socks-proxy-agent` wrapped in cookie agents. The proxy dialog has
"set as default" and "apply on all existing monitors". Notifications ignore monitor proxies and use only the env var
`NOTIFICATION_PROXY` (http/https/socks).
*For us:* HTTP CONNECT proxies are easy natively (`http.request({method: 'CONNECT'})` then TLS over the socket);
SOCKS5 is ~120 lines (P). Self-hosted only (SHOULD/COULD); in hosted mode a proxy would bypass our SSRF guard
(the proxy resolves the target) → disabled.

**Certificate & domain expiry notifications.**
* TLS (`checkCertExpiryNotifications`, `util-server.js` l. 924): for each threshold in `tlsExpiryNotifyDays` and for
  each certificate in the presented chain (skipping certificates whose SHA-256 fingerprint is in Node's root store),
  if `daysRemaining ≤ threshold` send once: `"[<name>][<url>] <server|intermediate CA> certificate <CN> will expire in
  <n> days"`. De-duplication via `notification_sent_history(type='certificate', monitor_id, days)`; the history is
  cleared when the leaf fingerprint changes (renewal). Sent to all notifications of the monitor.
* Domain (`server/model/domain_expiry.js`): public suffix via `tldts`; RDAP base URL from the IANA bootstrap file
  `https://data.iana.org/rdap/dns.json` (cached in settings, bundled fallback `extra/rdap-dns.json`);
  `GET <rdap>/domain/<domain>`, takes the `expiration` event; table `domain_expiry(domain unique, expiry, last_check,
  last_expiry_notification_sent)`; notification `"Domain name <d> will expire in <n> days"`. TLDs without RDAP are
  flagged unsupported (migration `2026-02-07-0000-disable-domain-expiry-unsupported-tlds.js`).
* Settings → Notifications holds both threshold lists (add/remove days).

**Our deltas.** (1) Validate everything server-side with a schema per type (Kuma trusts the client; `add` does
`bean.import(monitor)` of the whole client object). (2) Minimum interval 20 s self-hosted / 60 s hosted (1 s is a
self-DoS and abuse amplifier). (3) Timeouts validated server-side `1 s ≤ timeout ≤ min(0.8 × interval, 60 s)`.
(4) Store type-specific config as a validated JSON column instead of ~110 nullable columns, secrets in a separate
encrypted column.

---

## 4. Notification providers

### 4.1 Model and behaviour

* Table `notification(id, name, active, user_id, is_default, config LONGTEXT)` — `config` is the whole form object
  as JSON, **including secrets in plaintext**, returned to the browser on every login (`notificationList`).
  Join table `monitor_notification(monitor_id, notification_id)`.
* `Notification.send(config, msg, monitorJSON, heartbeatJSON)` dispatches on `config.type` to one of the provider
  singletons (`server/notification.js`). Every provider returns a string ("Sent Successfully.") or throws.
* **Default enabled** (`is_default`): new monitors get it pre-checked in the form (client-side only).
* **Apply on all existing monitors** (`applyExisting`, one-shot flag): on save, inserts the relation for every monitor
  of the user (`applyNotificationEveryMonitor`).
* **Test notification**: socket event `testNotification` sends the *unsaved* form config with
  `msg = "<name> Testing"`, `monitorJSON = heartbeatJSON = null` (providers render a "test" variant). No rate limit
  (§8.7.9).
* Events that notify: status changes (§1.4), resend while DOWN, certificate expiry, domain expiry. Not: maintenance
  start/end, monitor paused, check errors of the notification itself.
* Delivery: sequential, in the check loop, no retry/backoff (Google Chat alone retries 429 with 60–180 s sleeps —
  blocking the monitor!), no delivery log, error only in server log. `NOTIFICATION_PROXY` env for egress.
* Message context available to providers: `msg` (`[name] [✅ Up] 200 - OK`), `monitorJSON` (name, type, url,
  hostname, port, path/pathName (group path), tags, description, …), `heartbeatJSON` (status, msg, ping, time,
  timezone, localDateTime, lastDownTime, response body if saved).

### 4.2 Templating

LiquidJS (`renderTemplate`, `notification-provider.js`) with context:

| variable | value |
|---|---|
| `status` | `"✅ Up"`, `"🔴 Down"` or `"⚠️ Test"` |
| `name` | monitor name or "Monitor Name not available" |
| `hostnameOrURL` | `extractAddress(monitor)`: URL, `host:port`, hostname or `"Heartbeat"` for push |
| `msg` | default message text |
| `monitorJSON`, `heartbeatJSON` | full objects (Liquid can traverse them: `{{ monitorJSON.tags[0].name }}`) |
| `STATUS`, `NAME`, `HOSTNAME_OR_URL` | v1 aliases |

Providers with templates: webhook (custom body), smtp (subject + body, optional HTML), telegram (template + parse
mode `HTML`/`MarkdownV2`/plain with automatic MarkdownV2 escaping of all values), discord (format `normal`/
`minimalist`/`custom`), slack, ntfy (title + message), google-chat, matrix, signal, evolution, openwa, max, vkteams,
fluxer. The engine is created with `root: "./no-such-directory-uptime-kuma"`, `relativeReference: false`,
`dynamicPartials: false` — the result of **two** SSTI advisories that allowed reading arbitrary files with
`{% include %}`/`{% render %}` (GHSA-vffh-c9pq-4crh, Oct 2025; GHSA-v832-4r73-wx5j, Mar 2026).
**For us:** no Liquid. A minimal `{{variable}}` substitution with a fixed variable allow-list, no tags/filters/loops,
context-aware escaping per output format (§8.7.7).

### 4.3 Full provider list (2.5.6: 108 providers; 3.0 adds `indigo`)

Grouped by *how they work* (type id as stored in `config.type`, display name in parentheses where different):

1. **Generic** — `webhook` (POST JSON / form-data / custom body, or GET with query params), `apprise` (spawns the
   `apprise` CLI → 100+ services).
2. **Incoming-webhook chat** (POST JSON to a user-supplied secret URL): `slack`, `discord`, `fluxer` (Discord-compatible),
   `mattermost`, `rocket.chat`, `teams` (Adaptive Card), `GoogleChat`, `Feishu`, `DingDing` (HMAC-signed URL),
   `WeCom` (key in URL), `YZJ`, `ZohoCliq`, `pumble`, `stackfield`, `Bitrix24`, `Kook`, `nextcloudtalk` (bot secret
   HMAC), `GoogleSheets` (Apps Script web app), `ClickUp`.
3. **Bot API token + chat/recipient id**: `telegram`, `matrix` (access token + room), `line` (Messaging API push),
   `bale`, `max`, `VK`, `VKTeams`, `OneBot`, `Milky` (QQ), `OneChat`, `threema` (Gateway `send_simple`), `nostr`
   (NIP-59 encrypted DMs to relays via `nostr-tools`), `signal` (signal-cli REST API).
4. **Push services**: `pushover`, `pushbullet`, `gotify`, `ntfy`, `Bark`, `PushDeer`, `PushPlus`, `ServerChan`,
   `WxPusher`, `WPush`, `SpugPush`, `PushByTechulus`, `pushy`, `lunasea`, `notifyapp`, `notifery`, `signalgrid`,
   `pinglet`, `gorush` (self-hosted push gateway), `Webpush` (browser push with VAPID via `web-push`),
   `HomeAssistant` (notify service).
5. **WhatsApp gateways**: `whapi`, `waha`, `evolution`, `openwa`, `Whatsapp360messenger`, `CallMeBot` (WhatsApp,
   Telegram call, Messenger via GET URL).
6. **SMS gateways**: `twilio`, `plivo`, `telnyx`, `clicksendsms`, `Elks` (46elks), `Cellsynt`, `gtxmessaging`,
   `octopush`, `SevenIO`, `SMSEagle`, `SMSGateway`, `SMSPartner`, `SMSManager`, `serwersms`, `promosms`, `smsc`,
   `smsir`, `SMSPlanet`, `amootsms`, `AliyunSMS`, `bearsms`, `egosms`, `Ooredoo`, `FreeMobile`, `Teltonika`
   (router SMS API), `Onesender`.
7. **E-mail**: `smtp` (nodemailer), `Brevo`, `Resend`, `SendGrid`, `TurboSMTP` (HTTP APIs).
8. **Incident management / on-call**: `PagerDuty`, `Opsgenie`, `JiraServiceManagement`, `Splunk` (VictorOps REST),
   `PagerTree`, `alerta`, `AlertNow`, `GoAlert`, `GrafanaOncall`, `HeiiOnCall`, `Keep`, `SIGNL4`, `squadcast`,
   `FlashDuty`, `Flowtriq`, `HaloPSA`.

Not present: **Zulip** (users go through Apprise or the generic webhook with Zulip's Slack-compatible incoming
webhook), Microsoft Teams Workflows is the current `teams` implementation (legacy O365 connectors are dead).

### 4.4 Exact request formats of the important providers

Unless stated otherwise: `POST`, `Content-Type: application/json`, the request succeeds on any 2xx (axios default),
and the "test" variant (no heartbeat) sends the plain `msg`. `<msg>` = `[name] [🔴 Down] reason`;
`<time>` = `heartbeatJSON.localDateTime` in the server time zone.

#### SMTP e-mail (`smtp.js`)
Config: `smtpHost`, `smtpPort`, `smtpSecure` (implicit TLS), `smtpIgnoreSTARTTLS`, `smtpIgnoreTLSError`,
`smtpUsername`, `smtpPassword`, `smtpFrom`, `smtpTo`, `smtpCC`, `smtpBCC`, DKIM (`smtpDkimDomain`,
`smtpDkimKeySelector`, `smtpDkimPrivateKey`, `smtpDkimHashAlgo`, `smtpDkimheaderFieldNames`, `smtpDkimskipFields`),
`smtpAdditionalHeaders` (JSON), `customSubject`, `customBody`, `htmlBody`. Default subject = `msg`, body =
`msg + "\nTime (<tz>): <time>"`. nodemailer transport, `sendMail({from, to, cc, bcc, subject, headers, text|html})`.

#### Generic webhook (`webhook.js`)
Config: `webhookURL`, `httpMethod` (`post` default | `get`), `webhookContentType` (`json` | `form-data` | `custom`),
`webhookCustomBody` (template), `webhookAdditionalHeaders` (JSON object).
* JSON: `{"heartbeat": {…heartbeatJSON}, "monitor": {…monitorJSON}, "msg": "<msg>"}` (nulls on test).
* form-data: multipart field `data` = the same JSON string.
* custom: rendered template sent as the raw body (Content-Type only from additional headers).
* GET: query `?msg=…&heartbeat=<json>&monitor=<json>`.

#### Slack (`slack.js`)
Config: `slackwebhookURL`, `slackchannel`, `slackusername`, `slackiconemo`, `slackchannelnotify` (appends
`<!channel>`), `slackrichmessage`, `slackIncludeGroupName`, `slackUseTemplate`, `slackTemplate`.
Body: `{"text": "<name>\n<msg>", "channel", "username", "icon_emoji", "attachments": []}`; rich mode adds an
attachment `{"color": "#2eb886"|"#e01e5a", "blocks": [header(plain_text name), context(group path),
section(fields: "*Message*\n<msg>", "*Time (<tz>)*\n<time>"), actions(buttons "Visit Uptime Kuma" → base URL +
`/dashboard/<id>`, "Visit site")]}`.

#### Discord (`discord.js`)
Config: `discordWebhookUrl`, `discordUsername` (default "Uptime Kuma"), `discordChannelType` (`channel`,
`postToThread` → `?thread_id=<threadId>`, `createNewForumPost` → `thread_name = postName`), `discordMessageFormat`
(`normal`/`minimalist`/`custom` + `discordMessageTemplate`), `discordPrefixMessage` (content), `disableUrl`,
`discordSuppressNotifications` (`flags: 4096`). First does `GET <webhook>` to see whether the webhook has an avatar.
Normal DOWN body: `{"username", "embeds": [{"title": "❌ Your service <name> went down. ❌", "color": 16711680,
"timestamp": <ISO>, "fields": [{"name": "Service Name"}, {"name": "Service URL"}, {"name": "Went Offline", "value":
"<t:unix:F>"}, {"name": "Time (<tz>)"}, {"name": "Error", "value": "<hb msg>"}]}]}`; UP: green `65280`, adds
"Downtime Duration" and "Ping".

#### Telegram (`telegram.js`)
Config: `telegramBotToken`, `telegramChatID`, `telegramMessageThreadID`, `telegramServerUrl` (default
`https://api.telegram.org`, self-hosted Bot API servers), `telegramSendSilently`, `telegramProtectContent`,
`telegramUseTemplate`, `telegramTemplate`, `telegramTemplateParseMode` (`plain`|`HTML`|`MarkdownV2`).
`POST <server>/bot<token>/sendMessage` `{"chat_id", "text", "disable_notification", "protect_content",
"link_preview_options": {"is_disabled": true}, "message_thread_id"?, "parse_mode"?}`.

#### Microsoft Teams (`teams.js`)
Config: `webhookUrl` (Workflows/Power Automate "post to channel" webhook), `teamsEnableTags`.
Body: `{"type": "message", "summary": "🔴 [name] went down", "attachments": [{"contentType":
"application/vnd.microsoft.card.adaptive", "content": {"type": "AdaptiveCard", "version": "1.5", "$schema": …,
"body": [Container(ColumnSet style attention|good with logo + "**[name] went down**"), FactSet(Description, Monitor,
URL, Time), optional tag Badges, ActionSet(Action.OpenUrl "Visit Uptime Kuma", "Visit Monitor URL")]}}]}`.

#### Google Chat (`google-chat.js`)
Config: `googleChatWebhookURL`, `googleChatUseTemplate`/`googleChatTemplate` (→ `{"text": …}`),
`googleChatMaxRetries` (≤ 10, retries HTTP 429 after 60–180 s).
Body: `{"fallbackText": title, "cardsV2": [{"card": {"header": {"title": "🔴 <name> went down"}, "sections":
[{"widgets": [{"textParagraph": {"text": "<b>Message:</b>\n<msg>"}}, {time}, {address}, {"buttonList": …}]}]}}]}`.

#### Mattermost (`mattermost.js`)
Config: `mattermostWebhookUrl`, `mattermostusername`, `mattermostchannel`, `mattermosticonemo` ("up down" pair),
`mattermosticonurl`. Slack-compatible attachment: `{"username": "<name> Uptime Kuma", "channel", "icon_emoji",
"icon_url", "attachments": [{"fallback", "color": "#FF0000"|"#32CD32", "title": "<path> service went down.",
"title_link": url, "fields": [{"title": "Error"|"Ping", "value"}, {"title": "Time (<tz>)", "value"}]}]}`.

#### Rocket.Chat (`rocket-chat.js`)
Config: `rocketwebhookURL`, `rocketchannel`, `rocketusername`, `rocketiconemo`. Body `{"text": "Uptime Kuma Alert",
"channel", "username", "icon_emoji", "attachments": [{"title": "Uptime Kuma Alert *Time (<tz>)*\n<time>", "text":
"*Message*\n<msg>", "color": "#ff0000"|"#32cd32", "title_link": dashboard URL}]}`.

#### Matrix (`matrix.js`)
Config: `homeserverUrl`, `internalRoomId` (`!room:server`), `accessToken`, `matrixUseTemplate`/`matrixTemplate`.
`PUT <homeserver>/_matrix/client/r0/rooms/<urlenc room>/send/m.room.message/<random txn id>` with
`Authorization: Bearer <token>`, body `{"msgtype": "m.text", "body": "<msg>"}`. (Should be `/v3/` today.)

#### ntfy (`ntfy.js`)
Config: `ntfyserverurl` (e.g. `https://ntfy.sh`), `ntfytopic`, `ntfyPriority` (1–5, default 4; DOWN uses
`ntfyPriorityDown` or priority + 1), `ntfyAuthenticationMethod` (`none`|`usernamePassword`|`accessToken`),
`ntfyusername`/`ntfypassword` (Basic) or `ntfyaccesstoken` (Bearer), `ntfyIcon`, `ntfyCall` (`X-Call` header),
`ntfyUseTemplate`, `ntfyCustomTitle`, `ntfyCustomMessage`.
`POST <server>` (JSON publishing to the root URL) `{"topic", "title": "<name> Down [Uptime-Kuma]", "message":
"<hb msg>", "priority", "tags": ["red_circle", "<tag>: <value>"…], "actions": [{"action": "view", "label": "Open
<name>", "url": "<monitor url>"}], "icon"?}`.

#### Gotify (`gotify.js`)
Config: `gotifyserverurl`, `gotifyapplicationToken`, `gotifyPriority` (default 8).
`POST <server>/message?token=<app token>` `{"message": "<msg>", "priority": 8, "title": "Uptime-Kuma"}`.
(Prefer the `X-Gotify-Key` header — keeps the token out of URLs/logs.)

#### Pushover (`pushover.js`)
Config: `pushoveruserkey`, `pushoverapptoken`, `pushoversounds`, `pushoversounds_up`, `pushoverpriority` (−2…2),
`pushovertitle`, `pushoverdevice`, `pushoverttl`.
`POST https://api.pushover.net/1/messages.json` `{"message": "<msg>\n<b>Time (<tz>)</b>: <time>", "user", "token",
"sound", "priority", "title", "retry": "30", "expire": "3600", "html": 1, "url": <dashboard link>, "url_title":
"Link to Monitor", "device"?, "ttl"?}`.

#### Pushbullet (`pushbullet.js`)
Config: `pushbulletAccessToken`. `POST https://api.pushbullet.com/v2/pushes`, header `Access-Token: <token>`,
`{"type": "note", "title": "UptimeKuma Alert: <name>", "body": "[🔴 Down] <hb msg>\nTime (<tz>): <time>"}`.

#### Signal (`signal.js`, signal-cli-rest-api)
Config: `signalURL` (full endpoint, e.g. `http://signal-api:8080/v2/send`), `signalNumber` (sender),
`signalRecipients` (comma list), `signalUseTemplate`/`signalTemplate`.
`POST <signalURL>` `{"message": "<msg>", "number": "+31…", "recipients": ["+32…", "group.xxx"]}`.

#### WhatsApp-style gateways
* **Whapi** (`whapi.js`): `POST <whapiApiUrl|https://gate.whapi.cloud>/messages/text`, `Authorization: Bearer
  <whapiAuthToken>`, `{"to": "<recipient>", "body": "<msg>"}`.
* **WAHA** (`waha.js`, self-hosted WhatsApp HTTP API): `POST <wahaApiUrl>/api/sendText`, `X-Api-Key: <wahaApiKey>`,
  `{"session": "<wahaSession>", "chatId": "<wahaChatId>", "text": "<msg>"}`.
* **Evolution API** (`evolution.js`): `POST <evolutionApiUrl|https://evolapicloud.com>/message/sendText/<urlenc
  instance>`, `apikey: <token>` header, `{"number": "<recipient>", "text": "<msg>"}` (optional custom template).
* **OpenWA** (`openwa.js`): `POST <openwaApiUrl>/api/sessions/<session>/messages/send-text`, `X-Api-Key`,
  `{"chatId", "text"}` once per comma-separated chat id (optional custom template).
* **360messenger** (`360messenger.js`): `POST https://api.360messenger.com/v2/sendMessage` (`phonenumber`, `text`) or
  `/v2/sendGroup` (`groupId`, `text`), `Authorization: Bearer <token>`.
* **CallMeBot** (`call-me-bot.js`): `GET <callMeBotEndpoint>` (the full personal URL incl. `apikey`) with `text=<msg>`
  set as query parameter.

#### PagerDuty (`pagerduty.js`, Events API v2)
Config: `pagerdutyIntegrationUrl` (`https://events.pagerduty.com/v2/enqueue`), `pagerdutyIntegrationKey`
(routing key), `pagerdutyPriority` (`critical|error|warning|info`), `pagerdutyAutoResolve` (`0` = never, `resolve`,
`acknowledge`).
`{"payload": {"summary": "[Uptime Kuma Monitor 🔴 Down] [<name>] <hb msg>", "severity": "warning", "source":
"<url or host:port>"}, "routing_key": "<key>", "event_action": "trigger"|"resolve"|"acknowledge", "dedup_key":
"Uptime Kuma/<monitor id>"}` — dedup key makes UP resolve the incident opened by DOWN.

#### Opsgenie (`opsgenie.js`, Alert API v2)
Config: `opsgenieApiKey`, `opsgenieRegion` (`us` → `https://api.opsgenie.com/v2/alerts`, `eu` →
`https://api.eu.opsgenie.com/v2/alerts`), `opsgeniePriority` (1–5 → `P1`…`P5`, default 3).
Header `Authorization: GenieKey <key>`. DOWN: `{"message": "Uptime Kuma Alert: <name>", "alias": "<name>",
"description": "<msg>", "source": "Uptime Kuma", "priority": "P3"}`; UP: `POST <alerts>/<urlenc name>/close?
identifierType=alias` `{"source": "Uptime Kuma"}`. (Alias = monitor name → renaming breaks auto-close; use the id.)

#### Splunk On-Call / VictorOps (`splunk.js`)
Config: `splunkRestURL` (REST integration URL incl. key), `pagerdutyIntegrationKey` reused as routing key,
`splunkSeverity` (`INFO|WARNING|CRITICAL`), `splunkAutoResolve` (`0` | `ACKNOWLEDGEMENT` | `RECOVERY`).
`{"message_type": "CRITICAL", "state_message": "[title] [url] <msg>", "entity_display_name": "Uptime Kuma Alert:
<name>", "routing_key", "entity_id": "Uptime Kuma/<id>"}`.

#### Home Assistant (`home-assistant.js`)
Config: `homeAssistantUrl`, `longLivedAccessToken`, `notificationService` (default `persistent_notification`, else
e.g. `mobile_app_phone`). `POST <ha>/api/services/notify/<service>`, `Authorization: Bearer <token>`,
`{"title": "Uptime Kuma", "message": "<msg>", "data": {"name", "status", "channel": "Uptime Kuma", "icon_url"}}`
(no `data` for persistent notifications).

#### Apprise (`apprise.js`)
Config: `appriseURL` (an Apprise URL like `zulip://bot@org/token`), `title`. Executes
`spawn("apprise", ["-vv", "-b", msg, appriseURL, "-t", title])` and fails if the output contains `ERROR`.
**For us: S** — command execution, a Python dependency, and an unvalidated `appriseURL` starting with `-` is an
argument-injection vector.

#### Twilio SMS (`twilio.js`)
Config: `twilioAccountSID`, `twilioApiKey` (optional, else SID), `twilioAuthToken`, `twilioFromNumber`,
`twilioToNumber`, `twilioMessagingServiceSID`.
`POST https://api.twilio.com/2010-04-01/Accounts/<SID>/Messages.json`, `Content-Type:
application/x-www-form-urlencoded`, `Authorization: Basic base64(<apiKey|SID>:<authToken>)`, form `To`, `From`,
`Body=<msg>`, `MessagingServiceSid`?.

#### LINE Messaging API (`line.js`; LINE Notify was removed by migration `2025-12-29-0000-remove-line-notify.js`)
Config: `lineChannelAccessToken`, `lineUserID`. `POST https://api.line.me/v2/bot/message/push`,
`Authorization: Bearer <token>`, `{"to": "<user id>", "messages": [{"type": "text", "text": "UptimeKuma Alert:
[🔴 Down]\nName: <name> \n<hb msg>\nTime (<tz>): <time>"}]}`.

#### DingTalk (`dingding.js`, custom robot)
Config: `webHookUrl` (`https://oapi.dingtalk.com/robot/send?access_token=…`), `secretKey`, `mentioning`
(`nobody|everyone|specify-mobiles|specify-users`), `mobileList`, `userList`.
URL `<webHookUrl>&timestamp=<ms>&sign=<urlenc base64(HMAC-SHA256(secret, "<ms>\n<secret>"))>`; body
`{"msgtype": "markdown", "markdown": {"title": "[DOWN] <name>", "text": "## [DOWN] <name> \n> <hb msg>\n> Time
(<tz>): <time>"}, "at": {"isAtAll", "atUserIds", "atMobiles"}}`; success requires `errmsg == "ok"`.

#### Feishu / Lark (`feishu.js`)
Config: `feishuWebHookUrl`. Test: `{"msg_type": "text", "content": {"text": "<msg>"}}`; events:
`{"msg_type": "interactive", "card": {"config": {"wide_screen_mode": true}, "header": {"title": {"tag":
"plain_text", "content": "UptimeKuma Alert: [Down] <name>"}, "template": "red"|"green"}, "elements": [{"tag": "div",
"text": {"tag": "lark_md", "content": "**Message**: …\n**Time (<tz>)**: …"}}]}}`. (Signature verification for
"signed" bots is not supported.)

#### WeCom (`wecom.js`, group robot)
Config: `weComBotKey`, `weComMentionedMobileList`. `POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>`
`{"msgtype": "text", "text": {"content": "UptimeKuma Monitor Down\n<msg>", "mentioned_mobile_list": […]}}`.

#### Bark (`bark.js`)
Config: `barkEndpoint` (`https://api.day.app/<device key>`), `apiVersion` (`v1`|`v2`), `barkGroup` (default
`UptimeKuma`), `barkSound` (default `telegraph`). v1: `GET <endpoint>/<urlenc title>/<urlenc msg>?icon=…&group=…&
sound=…`; v2: `POST <endpoint>` `{"title", "body", "icon", "sound", "group"}`.

#### PushDeer (`pushdeer.js`)
Config: `pushdeerKey`, `pushdeerServer` (default `https://api2.pushdeer.com`). `POST <server>/message/push`
`{"pushkey", "text": "## Uptime Kuma: <name> down", "desp": "<msg with doubled newlines>", "type": "markdown"}`.
(Its URL-trimming regex was a ReDoS — GHSA-hx7h-9vf7-5xhg.)

#### Zulip (not a Kuma provider)
Native would be `POST https://<org>.zulipchat.com/api/v1/messages`, Basic auth `<bot email>:<api key>`, form
`type=stream&to=<stream>&topic=<topic>&content=<msg>` — trivially covered by our generic webhook *if* it supports
form encoding + Basic auth, or a first-class provider (cheap).

#### Other notable formats (one line each)
* **Alerta**: `POST <alertaApiEndpoint>`, `Authorization: Key <apiKey>`, `{environment, severity: "critical",
  correlate: [], service: ["UptimeKuma"], value: "Timeout", tags: ["uptimekuma"], origin: "uptimekuma", type:
  "exceptionAlert", event, resource, group, text}`; DOWN/UP use `alertaAlertState`/`alertaRecoverState` as severity.
* **GoAlert**: `POST <goAlertBaseURL>/api/v2/generic/incoming?token=<token>` `{summary: <msg>, details, action:
  "close" (on UP)}`.
* **Grafana OnCall**: `POST <GrafanaOncallURL>` `{title: "<name> is down", message: <hb msg>, state:
  "alerting"|"ok"}`.
* **SIGNL4**: `POST <webhookURL>` `{heartbeat, monitor, monitorUrl, "X-S4-SourceSystem": "UptimeKuma",
  "X-S4-ExternalID": "UptimeKuma-<id>", "X-S4-Status": "new"|"resolved"}`.
* **Squadcast**: `POST <squadcastWebhookURL>` `{message: "<name> is DOWN", description, tags: {name: value},
  heartbeat, source: "uptime-kuma", status: "trigger"|"resolve", event_id}`.
* **PagerTree**: `POST <pagertreeIntegrationUrl>` `{event_type: "create"|"resolve", id: <monitor id>, title,
  urgency, heartbeat, monitor}`.
* **Keep**: `POST <webhookURL>/alerts/event/uptimekuma` with `x-api-key` header, `{heartbeat, monitor, msg}`.
* **Gorush**: `POST <server>/api/push` `{notifications: [{tokens, platform, message, title, priority, retry, topic}]}`.
* **Nextcloud Talk**: `POST <host>/ocs/v2.php/apps/spreed/api/v1/bot/<conversation>/message` with
  `X-Nextcloud-Talk-Bot-Random` + `X-Nextcloud-Talk-Bot-Signature = HMAC-SHA256(secret, random + message)`.
* **Threema**: `POST https://msgapi.threema.ch/send_simple` form `from, to|phone|email, secret, text`.
* **Brevo / SendGrid / Resend / TurboSMTP**: transactional mail HTTP APIs with API key headers.
* **Webpush**: RFC 8030/8291 encrypted push to a browser subscription, VAPID (RFC 8292) — possible natively with
  `node:crypto` (ECDH P-256, HKDF, AES-128-GCM, ES256 JWT).

### 4.5 Recommendation: provider strategy

**Tier 1 — implement natively first (~20).** Covers the large majority of real-world usage, all on `fetch`/
`node:https` or nodemailer (already a dependency):

| # | provider | why |
|---|---|---|
| 1 | E-mail (SMTP via nodemailer; in hosted mode via the operator's SMTP with verified recipients) | universal |
| 2 | Generic webhook (JSON / form / custom template, method, headers, HMAC signature) | covers the long tail |
| 3 | Slack (incoming webhook, Block Kit) | top chat |
| 4 | Discord (webhook embeds, threads) | top chat |
| 5 | Microsoft Teams (Workflows webhook, Adaptive Card) | enterprise |
| 6 | Google Chat (cardsV2) | Workspace users |
| 7 | Mattermost | self-hosters |
| 8 | Rocket.Chat | self-hosters |
| 9 | Telegram (Bot API, HTML parse mode, topics) | very popular |
| 10 | Matrix (client-server API v3) | self-hosters |
| 11 | ntfy | self-hosted push, very popular |
| 12 | Gotify | self-hosted push |
| 13 | Pushover | mobile push, priorities |
| 14 | Signal (signal-cli REST) | privacy users |
| 15 | PagerDuty Events v2 (trigger/resolve with dedup key) | on-call |
| 16 | Opsgenie Alerts v2 (create/close by alias = monitor id) | on-call |
| 17 | Home Assistant notify | home lab |
| 18 | Twilio SMS | SMS |
| 19 | Pushbullet | legacy but common |
| 20 | Zulip (stream message) | open-source teams |
| 21 | Web Push to the PTR dashboard (VAPID, native crypto) | no third party at all — fits our privacy story |

**Tier 2** (cheap, when asked): Splunk On-Call, Grafana OnCall, GoAlert, SIGNL4, Squadcast, PagerTree, Alerta,
LINE, DingTalk, Feishu, WeCom, Bark, PushDeer, Whapi, WAHA, Nextcloud Talk, Brevo/SendGrid/Resend mail APIs.
**Won't**: Apprise (exec), Nostr (crypto lib), regional SMS long tail — reachable through the generic webhook.

**Generic webhook with custom body template.** Most providers above are "POST a JSON document with a token
somewhere". A webhook provider with: method (POST/PUT/GET), URL, content type (`json`, `form`, `text`), body template
with `{{vars}}` JSON-escaped when inside a JSON body, extra headers (secret, stored encrypted), optional Basic auth and
an optional `X-PTR-Signature: sha256=<HMAC(body)>` header covers Slack/Mattermost/Rocket.Chat/Google Chat simple text,
ntfy, Gotify, Pushover (form), Zulip, Alerta, GoAlert, Grafana OnCall, SIGNL4, Squadcast, Keep, Whapi, WAHA,
CallMeBot, Bark v2, PushDeer, DingTalk *without* signing, WeCom, Feishu, Signal, Home Assistant. Ship **presets**
(provider templates pre-filling URL pattern, headers and body) instead of code per provider. Not coverable: request
signing (DingTalk sign, Nextcloud Talk HMAC), two-step APIs (Discord avatar probe — unnecessary anyway),
stateful dedup (PagerDuty/Opsgenie need event_action/alias logic — expressible with `{{event}}` = `trigger|resolve`
and `{{monitor.id}}` variables).

**Behaviour to keep**: default channels pre-selected for new monitors, "apply to all existing monitors", test button,
resend while down, cert/domain expiry notices, separate UP/DOWN content.
**Behaviour to change**: asynchronous delivery queue (never block checks), retry with exponential backoff (3 attempts
over ~5 min, honour `Retry-After`), per-channel delivery log (last 50 attempts, status code, truncated error),
per-tenant rate limits, channel disabled after N consecutive failures with a dashboard warning, secrets write-only,
notify on maintenance start/end (opt-in), group notifications ("3 monitors down" digest within a 30 s window to
avoid storms when a whole site is down).

---

## 5. Status pages and badges

### 5.1 Data model

* `status_page(id, slug UNIQUE, title, description, icon, theme, published, search_engine_index, show_tags,
  password, created_date, modified_date, footer_text, custom_css, show_powered_by, analytics_id,
  analytics_script_url, analytics_type, show_certificate_expiry, auto_refresh_interval, show_only_last_heartbeat,
  rss_title)` — **no `user_id`**: status pages are global to the installation.
* `status_page_cname(status_page_id, domain UNIQUE)` — custom domains.
* `group(id, name, public, active, weight, status_page_id)` — a section on a status page.
* `monitor_group(monitor_id, group_id, weight, send_url, custom_url)` — monitors in a section, order, "show URL"
  with optional custom link.
* `incident(id, title, content, style, created_date, last_updated_date, pin, active, status_page_id)`.
* `maintenance_status_page(maintenance_id, status_page_id)`.

### 5.2 Features

| feature | details (source) |
|---|---|
| Slug | `^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$`, lower-cased (`checkSlug`, `status-page-socket-handler.js` l. 530); routes `/status/:slug`; `/status` and `/status-page` serve slug `default` |
| Title / description | description is **Markdown** rendered client-side with `marked` + `DOMPurify` (`src/pages/StatusPage.vue` l. 837–850); first 155 chars (tags stripped) become `<meta name=description>` and `og:description` |
| Footer | Markdown, sanitised the same way |
| Logo / icon | upload as data URL (**PNG only**, `data:image/png;base64,`) written to `data/upload/logo<id>.png` and served from `/upload/…`; or any URL string (used as `<link rel=icon>` and in `manifest.json`) |
| Theme | `auto` / `light` / `dark` |
| Auto refresh | `auto_refresh_interval` seconds (default 300) — client reloads data |
| Show tags | monitor tags (name, colour, value) shown next to monitors |
| Show certificate expiry | days remaining per monitor (`Monitor.toPublicJSON(…, certExpiry)`) |
| Show "Powered by Uptime Kuma" | default on |
| Show only last heartbeat | renders a single status dot instead of the beat bar |
| Heartbeat bar | **last 100 heartbeats** per monitor (`/api/status-page/heartbeat/:slug`, `LIMIT 100`), public beats carry `status, time, ping` and an empty `msg`; plus 24 h uptime % per monitor. There is **no 90-day daily bar** in Kuma (a long-standing feature request); with a 60 s interval the bar covers 100 minutes |
| Overall status | `StatusPage.overallStatus`: any monitor in MAINTENANCE → "Under maintenance"; all UP → "All Systems Operational"; some non-UP → "Partially Degraded Service"; none UP → "Degraded Service"; no monitors → "No Services" |
| Monitor groups | ordered sections with ordered monitors (drag & drop in edit mode); a group monitor can be listed like any monitor |
| Show URL | per monitor `send_url` (makes the name a link) + `custom_url` override |
| Incidents | one pinned "active" incident shown as a banner: title, Markdown content, style `info`/`warning`/`danger`/`primary`/`light`/`dark`, created/updated dates; actions post/edit/unpin/resolve/delete; **incident history** with cursor pagination (`/api/status-page/:slug/incident-history?cursor=`, page size 10) |
| Maintenance | active maintenance windows linked to the page are listed (title + Markdown description) |
| Custom CSS | raw CSS injected as `<style>` (`StatusPage.vue` l. 598) — admin-only in Kuma |
| Analytics | `analytics_type` ∈ `google`, `umami`, `plausible`, `matomo`, `rybbit` + `analytics_id` + `analytics_script_url`; a `<script>` tag is generated server-side with `jsesc` + `html-escaper` (`server/analytics/*.js`) and appended to `<head>` |
| Custom domains | list of hostnames; `/api/entry-page` maps `Host` (or `X-Forwarded-Host` when `trustProxy`) to a slug and the SPA renders that page at `/` (TLS/certificates are the reverse proxy's job) |
| RSS | `/status/:slug/rss` (RSS 2.0 via `feed`): pinned incidents + currently DOWN monitors ("X is down since …"), title `rss_title` or "<title> RSS Feed"; advisory GHSA-9fg7-wgm7-57fh (missing content type → stored XSS via monitor name) |
| PWA | `/api/status-page/:slug/manifest.json` (name, start_url, icon) |
| SEO | server-side rendered `<title>`, meta/OG tags, preload JSON embedded with `jsesc({isScriptContext: true})` |
| Public JSON API | `GET /api/status-page/:slug` → `{config, incidents, publicGroupList: [{id, name, weight, monitorList: [{id, name, type, sendUrl, url?, tags?, certExpiryDaysRemaining?, validCert?}]}], maintenanceList}`; `GET /api/status-page/heartbeat/:slug` → `{heartbeatList: {<id>: [{status, time, msg: "", ping}]}, uptimeList: {"<id>_24": 0.999}}` |
| Caching | in-process `apicache`: pages/config 5 min, heartbeats 1 min, manifest 1 day; cleared on every important beat and on save |
| Entry page | Settings → General: `/` can redirect to the dashboard or to a status page |
| Unused columns | `published`, `search_engine_index`, `password` exist but are not enforced (no private/password-protected pages) |

Kuma's own XSS history on status pages: GHSA-553g-fcpf-m3wp (name), GHSA-wh8j-xr66-f296 (description),
GHSA-v4v2-8h88-65qj (attribute injection), GHSA-9fg7-wgm7-57fh (RSS).

### 5.3 Badges

Rendered with `badge-maker` (shields.io look), `Content-Type: image/svg+xml`, `Access-Control-Allow-Origin: *`,
cached 5 min in memory. Available only for monitors that are in a **public group of some status page**
(`isMonitorPublic`, `api-router.js` l. 610); otherwise a grey `N/A` badge (same response for "does not exist" and
"not public"). All accept `style` (`flat` default, `flat-square`, `plastic`, `for-the-badge`, `social`) and a
`value` override "for demo purposes" (any caller can make a badge show fake values!).

| endpoint | params (defaults) | message |
|---|---|---|
| `GET /api/badge/:id/status` | `label` ("Status"), `upLabel` ("Up"), `downLabel`, `pendingLabel`, `maintenanceLabel`, `upColor` (#66c20a), `downColor` (#c2290a), `pendingColor` (#f8a306), `maintenanceColor` (#1747f5) | last heartbeat status |
| `GET /api/badge/:id/uptime/:duration?` | duration default `24h`; bare number = hours; units `m h d w M y` (`getDataByDuration`); `label`, `labelPrefix`, `labelSuffix` ("h"), `prefix`, `suffix` ("%"), `color` (default: HSL hue 10→90 by uptime, `percentageToColor`), `labelColor` | `99.95%`, label `Uptime (24h)` |
| `GET /api/badge/:id/ping/:duration?` | as above, `color` "blue", `suffix` "ms" | average ping over duration |
| `GET /api/badge/:id/avg-response/:duration?` | hours, max 720 | average response, N/A when none |
| `GET /api/badge/:id/response` | `label` ("Response"), `suffix` "ms" | last heartbeat ping |
| `GET /api/badge/:id/cert-exp` | `date` (show date instead of days), `warnDays` (14), `downDays` (7), `upColor`/`warnColor` (#eed202)/`downColor`, `suffix` (" days") | days remaining, `Bad Cert`, `No/Bad Cert` |
| `GET /api/status-page/:slug/badge` | `label`, `upColor`, `downColor`, `partialColor` (#F6BE00), `maintenanceColor` (#808080), `style` | `Up`, `Degraded`, `Down`, `Maintenance`, `N/A` |

The UI has a badge-link generator dialog per monitor. Advisories: GHSA-c7hf-c5p5-5g6h (ping badge leaked data of
non-public monitors), GHSA-wf2j-5mc7-5c4w (High, Oct 2026: unauthenticated resource exhaustion via arbitrary monitor
ids on the ping badge — each id instantiated an in-memory `UptimeCalculator` loading stats from the DB).

**SVG format.** Two adjacent rounded rectangles (label background `#555`, message background = colour), white
11 px Verdana/DejaVu Sans text with a 1 px dark shadow, widths computed from a per-character width table, a
`<title>` and `aria-label="label: message"` for accessibility. We can generate this ourselves in ~120 lines with a
fixed Verdana width table (no `badge-maker`), XML-escaping label and message and accepting colours only as
`#rgb`/`#rrggbb` or from a named list.

---

## 6. Maintenance windows

Source: `server/model/maintenance.js`, `server/socket-handlers/maintenance-socket-handler.js`,
`src/pages/EditMaintenance.vue`.

### 6.1 Fields

`maintenance(id, title (150), description (Markdown), user_id, active, strategy, start_date, end_date, start_time,
end_time, weekdays (JSON), days_of_month (JSON), interval_day, cron, timezone, duration (s), last_start_date)`;
`monitor_maintenance(maintenance_id, monitor_id)`; `maintenance_status_page(maintenance_id, status_page_id)`.

### 6.2 Strategies

| strategy | input | implementation |
|---|---|---|
| `manual` | – | "Active/inactive manually": under maintenance whenever `active = 1` |
| `single` | `dateRange[0..1]` (start, end datetimes) | croner job at `start_date` (to refresh clients); status computed from dates |
| `recurring-interval` | every `interval_day` days, `timeRange` (start/end `HH:mm`), optional date range | cron `M H * * *` daily + check `now − last_start_date ≥ interval_day` (with a 1.1 h fudge for DST); `startAt` = start date + time |
| `recurring-weekday` | weekdays (Mon = 1 … Sun), time range, date range | cron `M H * * <list>` |
| `recurring-day-of-month` | days 1–31 and `lastDay1` (= last day, cron `L`; `lastDay2…4` are offered in the UI but **not supported** by cron and silently ignored) | cron `M H <list> * *` |
| `cron` | 5-field cron expression (`cronstrue` shows a human description) + duration in minutes, date range | croner |

Duration for recurring strategies = `end_time − start_time` (+24 h when crossing midnight). Every window is
"start event + `setTimeout(duration)`"; on server start `getRunningTimeslot()` asks croner for the run that would
have started `duration` ago to resume an in-progress window. `getStatus()` → `inactive`, `scheduled`,
`under-maintenance`, `ended` (after `end_date`), `unknown`. The UI lists upcoming timeslots (current + next run).

**Time zones.** `timezone` = an IANA zone, `UTC`, or `SAME_AS_SERVER` (server time zone from Settings → General);
croner runs the cron in that zone; `start_date`/`end_date` are interpreted in the maintenance zone
(`dayjs.tz`). DST: croner handles missing/duplicated local hours; the interval strategy subtracts 1.1 h to avoid
double/skip on DST days.

### 6.3 Effect

* Affected = monitors listed in `monitor_maintenance` **and all their descendants** (group recursion in
  `Monitor.isUnderMaintenance`).
* While under maintenance the check is **not executed**; a MAINTENANCE heartbeat is written each interval
  (push monitors record MAINTENANCE on push).
* Notifications: UP/DOWN → MAINTENANCE and MAINTENANCE → UP are silent; MAINTENANCE → DOWN notifies (the service
  did not come back). Resend counters reset.
* Uptime: maintenance beats are excluded from the ratio (`extras.maintenance`).
* Status pages linked via `maintenance_status_page` show the maintenance (title, description); monitors show the
  maintenance colour (blue); the overall status becomes "Under maintenance" as soon as *any* monitor of the page is
  in maintenance.
* Actions: pause/resume (toggles `active`), edit, delete, clone. Maintenance list is pushed to the dashboard on every
  start/end event.

**Our deltas.** (1) Evaluate windows with a pure function `isInWindow(maintenance, instant)` on every check instead of
long-lived timers (restart-safe, testable, no `setTimeout` drift); (2) implement a small 5-field cron parser with
`L`, ranges, steps and lists (no `croner`), computing next occurrences with `Intl.DateTimeFormat` for zone
conversion; (3) correct `lastDayN`; (4) optional "notify subscribers when maintenance starts/ends"; (5) in hosted mode
maintenance can only target the member's own monitors/status pages.

---

## 7. Other features

### 7.1 Dashboard (monitor list)
Tree list with groups (collapsible), each row: status pill, name, tags, 24 h uptime %, mini heartbeat bar.
Search box (name, URL, hostname, DNS resolver — client-side), filters by status (up/down/pending/maintenance),
active/paused, tags (`MonitorListFilter.vue`). **Select mode** for bulk *pause*, *resume*, *delete*
(`MonitorList.vue` `pauseSelected`/`resumeSelected`/`deleteSelected`). Top summary counters (up/down/maintenance/
unknown/pause) and a global "important events" table (paginated, `monitorImportantHeartbeatListPaged`).

### 7.2 Monitor detail page (`src/pages/Details.vue`)
Status, type-specific address, description, tags; uptime 24 h / 30 d / 1 y, average response 24 h, certificate
expiry (days, click → full chain with issuer/subject/validity/fingerprint, `CertificateInfo.vue`), domain expiry;
**response-time chart** (`PingChart.vue`, Chart.js) with periods *recent* (live beats), 3 h, 6 h, 24 h, 1 w — data
from `getMonitorChartData` (minutely buckets ≤ 24 h, hourly ≤ 30 d, daily above; avg/min/max lines and down/
maintenance bars); heartbeat bar; **event list** (important beats with status, time, message, paginated); buttons
pause/resume, edit, **clone** (route `/clone/:id`, copies everything except push token, opens the edit form), delete
(groups: with or without children), clear events, clear heartbeats; badge generator; screenshot (real browser);
saved response body viewer; push URL with code examples (bash, C#, Docker, Go, Java, JS, PHP, PowerShell, Python,
TypeScript — `extra/push-examples/`).

### 7.3 Pause / resume / delete
`pauseMonitor` sets `active = 0` and stops the timer; resume restarts it (first check immediately). Delete removes
the monitor (heartbeats/stats cascade). Deleting a group asks whether to delete its descendants recursively
(`deleteMonitorRecursively`) or to unlink them (children become top-level).

### 7.4 Import / export / backup
The JSON backup export/import of 1.x was **removed in 2.0** (deprecated since 1.23 because it was incomplete).
Backup = copy the data directory (SQLite DB, uploads, screenshots, docker TLS certs) or dump MariaDB.
*For us:* our README already documents `better-sqlite3` online backup; additionally offer a per-member JSON export
of monitor/notification/status-page **configuration without secrets** (SHOULD) and import (COULD).

### 7.5 Settings pages (`src/components/settings/*.vue`)

| page | contents |
|---|---|
| General | display time zone (browser) and **server time zone** (used for notifications, maintenance, jobs), search engine visibility (`/robots.txt` `Disallow: /`), entry page (dashboard or a status page), **primary base URL** (links in notifications), Steam API key, Globalping API token, enable NSCD (DNS cache in the container), Chrome/Chromium executable + test |
| Appearance | language, theme (auto/light/dark), heartbeat bar position (normal/bottom/none), elapsed-time display style |
| Notifications | list of notification channels (add/edit/test/delete), TLS expiry days (default 7, 14, 21), domain expiry days |
| Reverse proxy | built-in **cloudflared** (Cloudflare Tunnel token, start/stop — spawns the `cloudflared` binary), "trust proxy" yes/no (X-Forwarded-For/Host), docs for nginx/Caddy/Apache |
| Tags | CRUD tags, colours, assign monitors |
| Monitor history | keep data N days (default 365, 0 = forever), DB size, shrink database, clear all statistics |
| Docker hosts | CRUD socket/TCP hosts + test |
| Remote browsers | CRUD Playwright `ws://` endpoints + test |
| Security | change password, **2FA** (TOTP setup with QR, verify, disable), **disable authentication** (password re-check required; for SSO via reverse proxy) |
| API keys | create (name, expiry or "never"), shown once as `uk<id>_<40-char nanoid>`, stored **bcrypt-hashed**, enable/disable/delete; only used for `/metrics` |
| Proxies | CRUD HTTP/SOCKS proxies, default flag, apply to all monitors |
| About | version, update check (calls Kuma's update endpoint), beta channel opt-in |

### 7.6 Authentication and accounts (2.x)
* **Single user.** First visit shows `/setup` (username + password with strength check); a second setup is refused.
  All monitors carry `user_id` but there is no UI to add users (3.0 adds multi-user via better-auth, still without
  per-user isolation of status pages).
* Login over socket.io: global login rate limiter **20 attempts/minute for the whole server** (`server/rate-limiter.js`,
  not per IP or account), bcrypt hashes (legacy SHA-1 upgraded on login). "Remember me" = a JWT
  `{username, h: shake256(passwordHash)}` signed with a server secret, stored in `localStorage` and used with
  `loginByToken` — valid forever until the password changes (advisory GHSA-g9v2-wqcj-j99g "Persistent user
  sessions").
* **2FA**: TOTP via `notp` (`window: 1`, 30 s steps), secret = 64 random chars stored in **plaintext** in
  `user.twofa_secret`, base32 for the `otpauth://totp/Uptime%20Kuma:<user>?secret=…` URI; replay protection only
  compares with the *last used token string* (`twofa_last_token`); separate 2FA rate limiter 30/min. `loginByToken`
  does not ask for TOTP again (the JWT is the second factor's result). No recovery codes; disabling 2FA requires the
  password only.
* Other historical auth advisories: GHSA-mj22-23ff-2hrr (no Origin validation on WebSockets), GHSA-88j4-pcx8-q4q3 and
  GHSA-23q2-5gf8-gjpp (sessions not closed on password change / enabling auth).

### 7.7 API keys and Prometheus
* `GET /metrics` (`prom-client`), protected by HTTP Basic auth: when at least one API key exists, *any username* +
  API key as password; otherwise the dashboard username/password (`server/auth.js` `apiAuth`); rate limited 60/min
  globally.
* Metrics (gauges, labels = sanitised tag names + `monitor_id`, `monitor_name`, `monitor_type`, `monitor_url`,
  `monitor_hostname`, `monitor_port`): `monitor_status` (0/1/2/3), `monitor_response_time` (ms),
  `monitor_response_time_seconds{window}`, `monitor_uptime_ratio{window="1d|30d|365d"}`,
  `monitor_cert_days_remaining`, `monitor_cert_is_valid`, plus default Node process metrics.
* There is **no general REST API** (long-standing request); automation tools use the socket.io protocol.
* *For us:* the existing session-cookie REST API serves the dashboard; API keys (SHOULD) give scoped bearer
  access (`monitors:read`, `monitors:write`, `metrics:read`) to the same REST endpoints plus `/metrics`.

### 7.8 i18n
80 locales (`src/lang/*.json`, Weblate). Our dashboard is English-only today; i18n is a WON'T for the first release.

### 7.9 Misc
Domain expiry (RDAP), Webpush notifications, NSCD, cloudflared, screenshot storage, embedded MariaDB, demo mode,
update checker, `UPTIME_KUMA_LOG_RESPONSE_BODY_MONITOR_ID` debug env, `/_e2e/*` snapshot routes in test mode,
`X-Frame-Options: SAMEORIGIN` (disable with `UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN` to embed status pages),
`/.well-known/change-password`.

### 7.10 Socket.io API surface (2.5.6)
`loginByToken, login, logout, prepare2FA, save2FA, disable2FA, verifyToken, twoFAStatus, needSetup, setup, add,
editMonitor, getMonitorList, getMonitor, checkDomain, getMonitorBeats, resumeMonitor, pauseMonitor, deleteMonitor,
getTags, addTag, editTag, deleteTag, addMonitorTag, editMonitorTag, deleteMonitorTag,
monitorImportantHeartbeatListCount, monitorImportantHeartbeatListPaged, changePassword, getSettings, setSettings,
addNotification, deleteNotification, testNotification, checkApprise, getWebpushVapidPublicKey, clearEvents,
clearHeartbeats, clearStatistics, addAPIKey, getAPIKeyList, deleteAPIKey, disableAPIKey, enableAPIKey,
getMonitorChartData, getDatabaseSize, shrinkDatabase, addDockerHost, deleteDockerHost, testDockerHost,
initServerTimezone, getGameList, getPM2ProcessList, testChrome, getPushExample, disconnectOtherSocketClients,
addMaintenance, editMaintenance, addMonitorMaintenance, addMaintenanceStatusPage, getMaintenance,
getMaintenanceList, getMonitorMaintenance, getMaintenanceStatusPage, deleteMaintenance, pauseMaintenance,
resumeMaintenance, addProxy, deleteProxy, addRemoteBrowser, deleteRemoteBrowser, testRemoteBrowser, postIncident,
unpinIncident, getIncidentHistory, editIncident, deleteIncident, resolveIncident, getStatusPage, saveStatusPage,
addStatusPage, deleteStatusPage` + cloudflared events. Note that several read handlers (`getMonitorBeats`,
`getMonitorChartData`, `monitorImportantHeartbeatList*`) check *login* but not *ownership* of the monitor id — harmless
in a single-user product, an IDOR in ours. Every endpoint we build must authorise per object.

---

## 8. Requirements for PTR Analytics

Guiding principles (from `README.md` / `docs/SPEC.md`): minimal runtime dependencies (`node:` built-ins; nodemailer
and better-sqlite3 are already present — **target: zero new runtime dependencies**), strict CSP and no
`dangerouslySetInnerHTML`, every object access authorised (admin / viewer / member), soft delete + background purge,
bounded memory, rate limits everywhere, privacy by default.

### 8.1 Prioritised feature list

**MUST (first release)**

| area | requirement | reason |
|---|---|---|
| Monitor types | `http`, `keyword`, `json` (restricted JSON path), `tcp`, `tls` (certificate), `dns`, `push`, `group`, `manual` | cover ~90 % of web-site monitoring; all native |
| Core semantics | statuses UP/DOWN/PENDING/MAINTENANCE (+ internal UNKNOWN for "no data"), retries + retry interval, resend every N failed checks, upside-down mode, accepted status codes, max redirects, timeout, ignore-TLS (still capture cert) | parity with Kuma's model (§1.2–1.5) |
| HTTP options | method, headers, body (json/form/text), Basic/Bearer auth, IP family, cache-buster | common needs |
| Expiry | TLS certificate expiry warnings (thresholds 21/14/7/3/1 days, once per threshold per certificate) | frequent cause of outages |
| Scheduler | §8.3 design: monotonic, phase-jittered, concurrency-limited, restart-safe | reliability |
| Storage | §8.2 schema, raw heartbeats 48 h, hourly 90 d, daily long-term, events/outages long-term | SQLite-friendly volume |
| Uptime stats | 24 h / 7 d / 30 d / 90 d / custom range, tz-aware, maintenance excluded | dashboard & status pages |
| Notifications | channels: e-mail (SMTP), generic webhook (+ presets & HMAC signature), Slack, Discord, Telegram, Microsoft Teams, ntfy; default channels, apply-to-all, test button, async outbox with retries and delivery log | the most used channels; webhook covers the long tail |
| Dashboard | per-site **Uptime** tab, overview health indicator, monitor list with status/uptime/beat bar, search & filter, detail page with response-time chart and event list, pause/resume, clone, delete, live updates (SSE) | integration with existing UI |
| Maintenance | strategies manual, single, weekly (weekdays), monthly (days incl. last day), cron; IANA time zones; affects monitors (+ group descendants) and status pages; notification suppression as in §1.4 | parity |
| Status pages | slug, title, Markdown description/footer (safe subset), logo upload (raster only), theme, groups with ordered monitors, 90-day daily bars + current status, overall status, incidents (pinned + history), active maintenance, auto-refresh, public JSON, custom domains (self-host via reverse proxy; hosted with DNS verification) | public communication |
| Badges | status, uptime(duration), response, cert-exp, status-page badge — own SVG renderer, random public ids | README embedding |
| Security | SSRF guard (§8.7.1), secrets encryption at rest (§8.7.3), write-only secret fields, per-object authorisation, rate limits on public endpoints, safe templating | non-negotiable for a public project |
| Hosted mode | tenancy rules & limits of §8.6 | product requirement |

**SHOULD (soon after)**

| requirement | reason |
|---|---|
| `ping` via `execFile` + IP literal, `websocket` upgrade handshake, `smtp` (STARTTLS + cert), `ntp`, `redis` PING, `grpc-health` (`node:http2`), "SSH banner" | cheap native protocol checks |
| OAuth2 client-credentials and mTLS auth for HTTP | API monitoring |
| Domain expiry via RDAP (IANA bootstrap) | cheap, valuable |
| DNS "notify on record change" | hijack detection |
| More channels: Google Chat, Mattermost, Rocket.Chat, Matrix, Gotify, Pushover, Pushbullet, Signal REST, PagerDuty, Opsgenie, Home Assistant, Twilio, Zulip, Web Push to the PTR dashboard | tier 1 of §4.5 |
| Tags with values (filter, show on status pages, labels in /metrics) | organisation |
| TOTP 2FA with recovery codes for all accounts (§8.7.8) | dashboard can now trigger outbound requests and holds secrets |
| API keys (scoped bearer) + Prometheus `/metrics` | automation |
| Network sanity check ("is *our* network up?") before declaring DOWN; UNKNOWN otherwise | avoids alert storms from checker outages |
| Notification digests (several monitors of one site down within 30 s → one message) | alert fatigue |
| Notify on maintenance start/end (opt-in), incident updates as notifications | communication |
| Status page: RSS/Atom feed, "show URL" per monitor, show certificate expiry, show tags, "track this status page with PTR Analytics" | parity + dogfooding |
| JSON export of configuration (no secrets) | portability |
| Annotate analytics charts with outages; synthetic response time vs RUM TTFB | unique integration value |
| Admin view of all monitors / engine health (in-flight checks, event-loop lag, queue depth) | operability |

**COULD (later / on demand)**

| requirement | reason |
|---|---|
| `mqtt`, `snmp` v2c, `radius`, `sip-options`, Postgres/MySQL/MongoDB handshake checks | niche, P-type implementations |
| `docker` container state (self-hosted, opt-in, socket proxy recommended) | home-lab users |
| HTTP/SOCKS5 proxies per monitor (self-hosted only) | corporate networks |
| Globalping multi-region checks | without running probes |
| Status page subscriptions (e-mail double opt-in), incident updates timeline, scheduled-maintenance announcements | Statuspage-like features |
| Password-protected / unlisted status pages | private customer pages |
| WebAuthn second factor | phishing resistance |
| Response-time percentiles (log histogram per hour) | nicer charts |
| Import of an Uptime Kuma 2.x SQLite database (monitors, notifications without exotic types, status pages) | migration path |
| Push "start" signal (job duration) | cron monitoring à la Healthchecks.io |
| Tier-2 channels (§4.5) | long tail |

**WON'T**

| feature | reason |
|---|---|
| `real-browser` / remote browsers | huge dependency, uncontrollable SSRF, CPU/RAM; Speed Insights covers real UX |
| Full database query monitors (pg, mysql2, mssql, oracledb, mongodb drivers), `kafka-producer`, `gamedig`, `steam`, `grpc-keyword` with arbitrary proto, `sftp` login | heavy drivers = supply-chain risk; handshake variants instead |
| `system-service`, `pm2`, `tailscale-ping`, Apprise, `sipsak`, cloudflared integration, Chromium auto-install | command execution / host coupling (Kuma had RCE advisories here) |
| NTLM auth | legacy, crypto disabled in OpenSSL 3 |
| JSONata, LiquidJS, user-supplied regular expressions | expression languages = SSTI/ReDoS/DoS surface |
| Third-party analytics scripts and raw custom CSS on status pages in hosted mode | XSS/tracking/phishing |
| Socket.io, `disableAuth` mode, i18n (first release), MariaDB backend | not our architecture |

### 8.2 Data model

All tables in the existing SQLite database (`analytics.db`, migration `user_version` 6+). Integer primary keys
internally (compact heartbeats), random external ids in the API. Times are ms epoch integers like the rest of the
schema. Soft delete + chunked background purge exactly like sites (`docs/SPEC.md` §6.2) — **no `ON DELETE CASCADE` on
the large tables** (synchronous cascades over millions of rows would stall the server).

```sql
-- Monitors -------------------------------------------------------------------------------------------
CREATE TABLE monitors (
  id              INTEGER PRIMARY KEY,
  uid             TEXT NOT NULL UNIQUE,                 -- 12 chars [a-z0-9], API id
  site_id         TEXT NOT NULL REFERENCES sites(id),   -- tenancy & billing follow the site
  parent_id       INTEGER REFERENCES monitors(id),      -- group (same site only, no cycles)
  type            TEXT NOT NULL CHECK (type IN ('http','keyword','json','tcp','tls','dns','push','group','manual',
                    'ping','websocket','smtp','ntp','redis','grpc_health','ssh','docker' /* … */)),
  name            TEXT NOT NULL,                        -- 1..100
  description     TEXT,                                 -- ≤ 500
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  interval_s      INTEGER NOT NULL CHECK (interval_s BETWEEN 20 AND 86400),
  retry_interval_s INTEGER NOT NULL,
  max_retries     INTEGER NOT NULL DEFAULT 0 CHECK (max_retries BETWEEN 0 AND 10),
  resend_every    INTEGER NOT NULL DEFAULT 0,           -- 0 = never, else every N failed checks
  timeout_ms      INTEGER NOT NULL,                     -- ≤ min(0.8 * interval, 60 s)
  upside_down     INTEGER NOT NULL DEFAULT 0,
  cert_notify     INTEGER NOT NULL DEFAULT 1,
  domain_notify   INTEGER NOT NULL DEFAULT 0,
  config          TEXT NOT NULL,                        -- validated JSON per type, NO secrets
  secrets         BLOB,                                 -- AES-256-GCM envelope (§8.7.3)
  push_token_hash BLOB UNIQUE,                          -- sha256(token), push only
  public_id       TEXT UNIQUE,                          -- 16+ random chars for badges; NULL = no badges
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX monitors_site   ON monitors(site_id) WHERE deleted_at IS NULL;
CREATE INDEX monitors_parent ON monitors(parent_id) WHERE parent_id IS NOT NULL;

-- Small hot row per monitor: survives restarts, read by dashboard lists without touching heartbeats
CREATE TABLE monitor_state (
  monitor_id      INTEGER PRIMARY KEY REFERENCES monitors(id),
  status          INTEGER NOT NULL DEFAULT -1,          -- -1 unknown, 0 down, 1 up, 2 pending, 3 maintenance
  retries         INTEGER NOT NULL DEFAULT 0,
  failed_since_notify INTEGER NOT NULL DEFAULT 0,       -- resend counter
  last_check_at   INTEGER, last_change_at INTEGER, last_push_at INTEGER,
  last_latency_ms INTEGER, last_msg TEXT,
  open_outage_id  INTEGER
);

-- Raw results, short retention (default 48 h). Compact: ~25–35 bytes/row incl. index.
CREATE TABLE heartbeats (
  monitor_id INTEGER NOT NULL,
  ts         INTEGER NOT NULL,                          -- ms
  status     INTEGER NOT NULL,
  latency_ms INTEGER,                                   -- NULL when not UP
  msg        TEXT,                                      -- ≤ 200 chars; NULL when equal to "OK"/previous
  PRIMARY KEY (monitor_id, ts)
) WITHOUT ROWID;

-- State changes = Kuma's "important" beats; long retention; drives event list, notifications, RSS
CREATE TABLE monitor_events (
  id         INTEGER PRIMARY KEY,
  monitor_id INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  from_status INTEGER, to_status INTEGER NOT NULL,
  msg        TEXT
);
CREATE INDEX monitor_events_monitor_ts ON monitor_events(monitor_id, ts);

-- Outages (first failure → recovery); time-weighted downtime, MTTR, status-page incidents
CREATE TABLE outages (
  id INTEGER PRIMARY KEY, monitor_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL,      -- first failed check (start of PENDING streak)
  confirmed_at INTEGER,             -- became DOWN (NULL = flap that recovered while pending)
  ended_at INTEGER,                 -- NULL while open
  cause TEXT
);
CREATE INDEX outages_monitor ON outages(monitor_id, started_at);

-- Aggregates: durations in ms (time-weighted) + check counts + latency sums (mergeable)
CREATE TABLE monitor_stats_hour (
  monitor_id INTEGER NOT NULL, bucket INTEGER NOT NULL,          -- UTC hour start, seconds
  up_ms INTEGER NOT NULL DEFAULT 0, down_ms INTEGER NOT NULL DEFAULT 0,
  pending_ms INTEGER NOT NULL DEFAULT 0, maint_ms INTEGER NOT NULL DEFAULT 0,
  checks INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
  lat_n INTEGER NOT NULL DEFAULT 0, lat_sum INTEGER NOT NULL DEFAULT 0,
  lat_min INTEGER, lat_max INTEGER,
  PRIMARY KEY (monitor_id, bucket)
) WITHOUT ROWID;
CREATE TABLE monitor_stats_day (… same columns, bucket = UTC day start …) WITHOUT ROWID;

CREATE TABLE monitor_tls (monitor_id INTEGER PRIMARY KEY, checked_at INTEGER, valid INTEGER, hostname_ok INTEGER,
  subject TEXT, issuer TEXT, sans TEXT /* JSON */, not_before INTEGER, not_after INTEGER,
  fingerprint256 TEXT, chain TEXT /* JSON: [{subject, issuer, not_after, fingerprint256, type}] */);
CREATE TABLE expiry_notices (monitor_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('cert','domain')),
  fingerprint TEXT NOT NULL, threshold_days INTEGER NOT NULL, sent_at INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, kind, fingerprint, threshold_days)) WITHOUT ROWID;
CREATE TABLE domain_expiry (domain TEXT PRIMARY KEY, expires_at INTEGER, checked_at INTEGER, rdap_status TEXT);

-- Tags --------------------------------------------------------------------------------------------------
CREATE TABLE tags (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES users(id), name TEXT NOT NULL,
  color TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  UNIQUE (owner_id, name));
CREATE TABLE monitor_tags (monitor_id INTEGER NOT NULL, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  value TEXT NOT NULL DEFAULT '', PRIMARY KEY (monitor_id, tag_id, value)) WITHOUT ROWID;

-- Notifications -----------------------------------------------------------------------------------------
CREATE TABLE notify_channels (id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE,
  owner_id INTEGER REFERENCES users(id),               -- NULL = operator channel
  type TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL /* non-secret JSON */, secrets BLOB,
  is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  verified_at INTEGER,                                 -- e-mail recipients in hosted mode
  consecutive_failures INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE monitor_channels (monitor_id INTEGER NOT NULL, channel_id INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, channel_id)) WITHOUT ROWID;
CREATE INDEX monitor_channels_channel ON monitor_channels(channel_id);
CREATE TABLE notify_outbox (id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL, monitor_id INTEGER,
  event TEXT NOT NULL,                                 -- down|up|resend|cert|domain|maint_start|maint_end|test
  payload TEXT NOT NULL,                               -- rendered-context JSON (no secrets)
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX notify_outbox_due ON notify_outbox(next_attempt_at);
CREATE TABLE notify_log (id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL, monitor_id INTEGER, ts INTEGER NOT NULL,
  event TEXT NOT NULL, ok INTEGER NOT NULL, http_status INTEGER, error TEXT /* ≤ 300, redacted */);
CREATE INDEX notify_log_channel_ts ON notify_log(channel_id, ts);

-- Maintenance -------------------------------------------------------------------------------------------
CREATE TABLE maintenances (id INTEGER PRIMARY KEY, uid TEXT UNIQUE NOT NULL, owner_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL, description TEXT, active INTEGER NOT NULL DEFAULT 1,
  strategy TEXT NOT NULL CHECK (strategy IN ('manual','single','weekly','monthly','interval','cron')),
  tz TEXT NOT NULL,                                    -- IANA
  starts_at INTEGER, ends_at INTEGER,                  -- single window, or validity range of recurring ones
  time_start TEXT, time_end TEXT,                      -- 'HH:MM' local
  weekdays TEXT, days_of_month TEXT,                   -- JSON arrays; days may include 'L','L-1'…
  interval_days INTEGER, cron TEXT, duration_s INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE maintenance_monitors (maintenance_id INTEGER NOT NULL, monitor_id INTEGER NOT NULL,
  PRIMARY KEY (maintenance_id, monitor_id)) WITHOUT ROWID;
CREATE INDEX maintenance_monitors_monitor ON maintenance_monitors(monitor_id);
CREATE TABLE maintenance_status_pages (maintenance_id INTEGER NOT NULL, status_page_id INTEGER NOT NULL,
  PRIMARY KEY (maintenance_id, status_page_id)) WITHOUT ROWID;

-- Status pages ------------------------------------------------------------------------------------------
CREATE TABLE status_pages (id INTEGER PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id),
  slug TEXT NOT NULL UNIQUE,                           -- ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$, reserved words refused
  title TEXT NOT NULL, description TEXT, footer TEXT,  -- Markdown subset, ≤ 5 000 chars
  logo_asset TEXT,                                     -- sha256 of uploaded image
  theme TEXT NOT NULL DEFAULT 'auto', published INTEGER NOT NULL DEFAULT 0, noindex INTEGER NOT NULL DEFAULT 0,
  show_tags INTEGER NOT NULL DEFAULT 0, show_cert_expiry INTEGER NOT NULL DEFAULT 0,
  show_powered_by INTEGER NOT NULL DEFAULT 1, refresh_s INTEGER NOT NULL DEFAULT 60,
  custom_css TEXT,                                     -- self-hosted only, served as a separate stylesheet
  analytics_site_id TEXT REFERENCES sites(id),         -- track this page with our own tracker
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE status_page_domains (domain TEXT PRIMARY KEY, status_page_id INTEGER NOT NULL,
  verify_token TEXT NOT NULL, verified_at INTEGER);
CREATE TABLE status_page_sections (id INTEGER PRIMARY KEY, status_page_id INTEGER NOT NULL, name TEXT NOT NULL,
  position INTEGER NOT NULL);
CREATE TABLE status_page_monitors (section_id INTEGER NOT NULL, monitor_id INTEGER NOT NULL, position INTEGER NOT NULL,
  display_name TEXT, show_url INTEGER NOT NULL DEFAULT 0, link_url TEXT,
  PRIMARY KEY (section_id, monitor_id)) WITHOUT ROWID;
CREATE INDEX status_page_monitors_monitor ON status_page_monitors(monitor_id);
CREATE TABLE incidents (id INTEGER PRIMARY KEY, status_page_id INTEGER NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL, style TEXT NOT NULL CHECK (style IN ('info','warning','danger','success','neutral')),
  pinned INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER, resolved_at INTEGER);
CREATE INDEX incidents_page ON incidents(status_page_id, created_at);
CREATE TABLE assets (sha256 TEXT PRIMARY KEY, owner_id INTEGER, mime TEXT NOT NULL CHECK (mime IN
  ('image/png','image/jpeg','image/webp')), bytes BLOB NOT NULL, created_at INTEGER NOT NULL);

-- Security ----------------------------------------------------------------------------------------------
CREATE TABLE user_mfa (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret BLOB NOT NULL /* encrypted */, enabled_at INTEGER, last_step INTEGER NOT NULL DEFAULT 0);
CREATE TABLE user_recovery_codes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash BLOB NOT NULL, used_at INTEGER, PRIMARY KEY (user_id, code_hash)) WITHOUT ROWID;
CREATE TABLE api_keys (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, prefix TEXT NOT NULL UNIQUE, key_hash BLOB NOT NULL, scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER);
```

Ownership: monitors and status pages through `site_id → sites.owner_id`; tags, channels and maintenance through
`owner_id` (NULL = operator objects, visible to admins/viewers). Cross-object links (monitor ↔ channel, monitor ↔
maintenance, monitor ↔ status page) are only accepted when both sides belong to the same owner (and for status
pages: monitors of the same site — simple to reason about and to bill).

**Volume estimates** (row ≈ 30 bytes incl. B-tree overhead for heartbeats, ≈ 60 bytes for hourly stats):

| scale | checks/s | heartbeats/day | raw 48 h | hourly stats 90 d | daily stats/yr | events |
|---|---|---|---|---|---|---|
| 50 monitors @ 60 s (typical self-host) | 0.8 | 72 k | ~4 MB | ~6.5 MB | ~1 MB | tiny |
| 1 000 monitors @ 60 s | 17 | 1.44 M | ~86 MB | ~130 MB | ~22 MB | ~MBs |
| 10 000 monitors @ 60 s (large hosted) | 167 | 14.4 M | ~860 MB | ~1.3 GB | ~220 MB | ~10s of MB |
| 1 000 monitors @ 20 s | 50 | 4.3 M | ~260 MB | ~130 MB | ~22 MB | ~MBs |

Kuma at the same scale writes ~5 statements per check and keeps a *minutely* table (1 440 rows/day/monitor), i.e. as
many rows as raw 60 s heartbeats — pointless when we keep raw beats for 48 h anyway.

**Retention & aggregation strategy.**
* Raw `heartbeats`: `UPTIME_RAW_RETENTION_HOURS` (default 48; ≥ 25 so "last 24 h" charts always have raw data).
  24 h charts read raw beats (≤ 4 320 points per monitor at 20 s; down-sample to ≤ 300 points server-side).
* `monitor_stats_hour`: 90 days (enables tz-correct daily bars for the last 90 days in any time zone and 7/30/90 d
  charts). `monitor_stats_day` (UTC days) and `monitor_events`/`outages`: `UPTIME_RETENTION_DAYS` (default 400; 0 =
  forever), used for > 90 d ranges and yearly SLA.
* Aggregates are **maintained incrementally in memory** per monitor (current hour/day row) and flushed with
  `INSERT … ON CONFLICT DO UPDATE` in the batch transaction; because raw beats exist for 48 h, the last hours can be
  **recomputed from raw data at startup** (crash consistency without per-beat upserts).
* Writes are batched: results go into an in-memory queue, flushed every 500 ms or 200 results in one
  `BEGIN IMMEDIATE … COMMIT` (prepared statements). Expected write time at 10 k monitors: < 5 ms per flush.
* Purge job (hourly, chunked `DELETE … WHERE rowid IN (SELECT … LIMIT 5000)` style with yielding, like the analytics
  retention job): old raw beats, hourly rows, notify_log (30 d), outbox rows delivered/failed; deleted monitors.
* Optional later: move uptime tables to a separate `uptime.db` (own writer connection) if contention with analytics
  ingest shows up — keep the repository layer DB-agnostic to allow this.

**Uptime computation (time-weighted).** Each result's status is assumed to hold from its timestamp until the next
result, capped at `interval + timeout + 5 s`; time beyond the cap (server down, scheduler stalled) is *no data* and
excluded (Kuma silently ignores gaps but is count-based — §1.6). Durations are split across hour boundaries when
added to buckets. Ratios:
* `uptime = up_ms / (up_ms + down_ms + pending_ms)` — PENDING counted as unavailable (conservative, same as Kuma),
  maintenance excluded, no-data excluded; the UI shows "x min unconfirmed failures" separately.
* Average/min/max latency from `lat_sum/lat_n`, `lat_min`, `lat_max` (UP checks only).
* Outage duration = `ended_at − started_at` (from the first failed check, not from confirmation); MTTR and
  "incidents in period" from `outages`.
* Status-page 90-day bar: per local day (page time zone), colour from uptime ratio (≥ 99.9 % green, ≥ 99 % light,
  ≥ 95 % orange, else red; maintenance-only days blue; no data grey), tooltip with outages of that day.

### 8.3 Scheduler design

* **Dedicated worker thread** (`uptime-engine`) with its own better-sqlite3 write connection (WAL, `busy_timeout`),
  so check bursts never delay ingest/dashboard requests and a crash in a protocol parser is contained (the main
  thread restarts the worker with backoff). Main thread ↔ engine via `MessagePort` (config changes, "check now",
  push beats, SSE fan-out).
* **One timer, one min-heap** keyed by next run time on the **monotonic clock** (`performance.now()`), not one
  `setTimeout` per monitor; wall-clock time (`Date.now()`) only for timestamps.
* **Phase jitter**: each monitor gets a stable phase `hash(uid) mod interval`; runs at `phase + k·interval`. New or
  edited monitors run once immediately, then align to their phase. Spreads load evenly and survives restarts.
* **Anchored, non-accumulating**: next run = previous *scheduled* time + interval (no drift); if a check overruns
  its slot, missed slots are skipped (never a backlog burst). PENDING uses `retry_interval` anchored to the failure
  time.
* **Concurrency limits** (semaphores): global in-flight checks (`UPTIME_CHECK_CONCURRENCY`, default 64), per owner
  (default 8), per destination IP (2, so 50 monitors on one host do not hammer it simultaneously), per heavy kind
  (ping processes 8). Waiting checks are served fairly between owners (round robin), and a check that waited longer
  than its interval is dropped and recorded as *no data* with an engine-overload warning (never as DOWN).
* **Deadlines**: every check gets `AbortSignal.timeout(timeout_ms)` + a watchdog at `timeout + 5 s` that destroys
  sockets/kills child processes; DNS via `dns.Resolver` with `{timeout, tries}` (c-ares, async) — **not**
  `dns.lookup`, which runs on the 4-thread libuv pool, cannot be cancelled and would let slow resolvers starve
  `zlib`/`crypto`/`fs` for the whole server.
* **Restart behaviour**: load `monitor_state`; continue retry counters and resend counters; the interval between
  shutdown and startup becomes *no data*; first runs are spread over `min(interval, 30 s)`; push monitors get a grace
  of one interval after startup before "no heartbeat" can fire (Kuma does the same by delaying the first push beat);
  open outages stay open. Graceful shutdown (SIGTERM): stop scheduling, wait ≤ 5 s for in-flight checks, flush the
  write queue and the outbox.
* **Clock changes**: monotonic scheduling is immune to NTP steps/DST; if `|Δwall − Δmono| > 2 s` between two ticks
  log a warning, clamp negative durations to 0 and never attribute the jump to up/down time. Maintenance windows
  and cron are evaluated against wall clock + IANA zone at each check (pure function), so a stepped clock only shifts
  which window is active.
* **Group monitors** are event-driven: re-evaluated when a child's status changes (debounced 1 s) and at their own
  interval as a fallback.
* **Network sanity check** (SHOULD): when ≥ 50 % of monitors (min 5) fail within one minute, probe two canaries
  (configurable, default the resolver plus `https://<PUBLIC_URL>`-independent targets); if they fail, record
  UNKNOWN and pause notifications until connectivity returns.
* **Observability**: engine metrics (in-flight, queue length, checks/s, event-loop delay via
  `perf_hooks.monitorEventLoopDelay`, dropped checks, outbox depth) on an admin-only endpoint and `/metrics`.

### 8.4 Check engine and notification pipeline

* Check plug-in contract (mirrors Kuma's `MonitorType`): `validate(config) → normalised config`,
  `check(ctx) → {status, latencyMs, msg, tls?, extra?}`, `capabilities {conditions, customStatus, hostedAllowed}`.
  `ctx` provides the SSRF-safe `connect()`/`httpRequest()`/`resolve()` helpers, the abort signal and decrypted
  secrets; plug-ins never use `net`/`http` directly (lint rule), so the guard cannot be bypassed.
* Status transition logic is a **pure function** `(previousState, result, monitorSettings, inMaintenance) →
  {state, beat, event?, notify?}` reproducing §1.3/§1.4 (important/notify tables, retries, resend, upside-down),
  unit-tested against a matrix of cases.
* Notifications go through the **outbox**: the engine inserts rows in the same transaction as the event; a
  dispatcher (concurrency 8, per channel 1) renders and sends; retries at 30 s, 2 min, 10 min (honour `Retry-After`,
  no retry on 4xx except 408/429); after 3 failures → `notify_log` error and `consecutive_failures++`; 10
  consecutive failures → channel auto-disabled + dashboard warning + e-mail to the owner. Digest window 30 s per
  owner+site. UP after DOWN always delivered even if DOWN was digested.
* Provider implementations are data-driven where possible (§4.5 presets); each provider declares its hosts (fixed
  API hosts vs user-supplied URLs) so hosted mode can apply the SSRF guard and HTTPS-only rule to user URLs.

### 8.5 Integration with the existing analytics

* **Monitors belong to sites.** Every monitor has `site_id`; authorisation, hosted billing, soft delete and
  suspension follow the site. Operator monitors (infrastructure) live on admin-owned sites.
* **Onboarding**: when a site is created, offer "Monitor https://<domain>/ (HTTP, 60 s, certificate expiry)" for
  each non-wildcard domain (opt-in checkbox) and a default e-mail channel to the account address (verified already).
* **Site → Uptime tab** (`SiteLayout` gets a new tab next to Analytics / Speed Insights / Live / Settings): current
  status per monitor, uptime tiles (24 h / 7 d / 30 d / 90 d with comparison to the previous period — same period
  picker and `tz` semantics as stats, `docs/SPEC.md` §4.7), response-time chart (Bklit line/area: avg + min/max band),
  90-day bar, outages table, certificate & domain expiry, maintenance windows, notification log.
* **Overview**: each site card gets a health indicator (worst current status of its monitors, "2/3 up"), 30-day
  uptime and a banner when any monitor is DOWN; the existing `GET /api/overview` grows an optional `uptime` block
  (no extra query per card — read `monitor_state`).
* **Correlation (unique to us)**: outages drawn as shaded ranges on the visitors/pageviews chart and on the Speed
  Insights TTFB chart; "synthetic response time vs. real-user TTFB p75" panel.
* **Status pages** are per site and can be tracked with PTR's own `script.js` (first-party, cookie-less) by selecting
  one of the owner's sites — replacing Kuma's Google/Umami/Plausible/Matomo/Rybbit script injection.
* **Live**: an SSE stream `GET /api/uptime/stream` (authenticated, same-origin) pushes beats/state changes for the
  sites the user can access; the dashboard falls back to polling.
* **Privacy**: monitoring stores no visitor data. Response bodies are never stored by default; a debug "store last
  failing response (≤ 4 KB)" option is self-hosted only and admin-only.
* **CLI**: `cli monitors list|pause|resume`, `cli rotate-secrets-key`, `cli mfa-reset <email>`.

### 8.6 Tenancy rules for hosted mode

| rule | value (env, default) |
|---|---|
| Visibility | members see/manage only monitors, status pages and incidents of **their** sites and their own tags, channels and maintenance windows; admins see all; viewers read-only all (self-hosted only, as today) |
| Monitors per site | `MEMBER_MONITORS_PER_SITE` = 10 (billing: included per paid site) |
| Status pages per site | `MEMBER_STATUS_PAGES_PER_SITE` = 1 |
| Minimum interval | `MEMBER_MIN_INTERVAL_S` = 60 (self-hosted global minimum `UPTIME_MIN_INTERVAL_S` = 20) |
| Timeout | ≤ 30 s; retries ≤ 5 |
| Concurrency | ≤ 4 in-flight checks per member |
| Notification channels | ≤ 10 per member, ≤ 5 per monitor; ≤ 120 deliveries/hour per member; test sends 5/min and 30/hour |
| E-mail channels | recipients must confirm (double opt-in link, one-click unsubscribe + `List-Unsubscribe` headers); sent through the operator SMTP with fixed `MAIL_FROM`; count against `MAIL_MAX_PER_HOUR`; member-supplied SMTP servers not allowed in hosted mode |
| Webhook / self-hosted provider URLs | `https://` only, SSRF guard with private ranges denied |
| Custom domains for status pages | DNS TXT verification `_ptr-status.<domain>`; TLS by the operator's reverse proxy (on-demand TLS in Caddy with an `ask` endpoint that only approves verified domains) |
| Status page content | Markdown subset only, raster logo ≤ 512 KB, **no custom CSS**, no third-party scripts |
| Suspended sites | monitors paused (state kept), status pages show the last state with "monitoring paused", badges grey |
| Unverified accounts | cannot create monitors or channels |
| Disabled types | `docker`, `system-service`, `pm2`, `real-browser`, `tailscale`, `kafka`, `snmp`, `radius`, full DB drivers, proxies, globalping (unless operator opt-in) |
| Restricted types | `ping` (count ≤ 5, size ≤ 1 472, interval ≥ 60 s); `dns` (resolver must be a public IP literal; no hostname resolvers); `tcp` (private ranges denied by the guard); responses stored never |
| Egress identity | `User-Agent: PTR-Uptime/<version> (+<PUBLIC_URL>/uptime-bot)` page explaining the checks and an abuse contact; operator kill switch per destination (`UPTIME_TARGET_DENYLIST`) |
| Third-party protection | global cap per destination IP across all tenants (e.g. ≤ 1 check/5 s), so the service cannot be used as a distributed load generator |
| Self-targeting | refuse targets resolving to the server's own addresses / `PUBLIC_URL` host (loops) |

### 8.7 Threat model

Assets: tenant isolation, stored credentials/tokens, the server's network position (internal networks, cloud
metadata), mail/IP reputation, availability of the analytics service, dashboard sessions. Attackers: anonymous
internet users (public status pages, badges, push endpoint), hosted-mode members (malicious sign-ups), compromised
or hostile monitored targets (they control responses, banners, certificates, DNS), and compromised third-party
notification endpoints.

#### 8.7.1 SSRF (monitors, notification endpoints, OAuth token URLs, RDAP)

Kuma has **no** SSRF protection by design (internal monitoring is a feature); its advisory GHSA-qjxc-h5jf-c7rj
documents cloud-metadata exposure. Our guard, used by every outbound connection of the engine and the notifier:

1. **Parse** URLs with WHATWG `new URL()`, which normalises the tricky IPv4 forms (`http://2130706433/`,
   `http://0x7f.1/`, `http://0177.0.0.1/`, `http://127.1/` all become `127.0.0.1`) and IDNs (punycode). Allowed
   schemes: `http`, `https` (`ws`/`wss` mapped). Reject userinfo in URLs (credentials belong in secret fields).
   Hostname fields of non-URL types are accepted only as a valid LDH hostname (≤ 253, labels ≤ 63) or an IP literal
   accepted by `net.isIP()`; anything else — e.g. `0177.0.0.1`, `127.1`, `0x7f000001`, which `getaddrinfo` would
   happily interpret — is rejected.
2. **Resolve** ourselves (`dns.Resolver`, A and AAAA, with timeout), collect **all** addresses.
3. **Classify** every address with `net.BlockList` (built-in). If **any** address is blocked the target is refused
   (prevents mixing a public and a private A record). Before matching, unwrap embedded IPv4: IPv4-mapped
   `::ffff:0:0/96` (both `::ffff:127.0.0.1` and `::ffff:7f00:1` spellings), NAT64 `64:ff9b::/96`, 6to4 `2002::/16`,
   Teredo `2001::/32` (or block the latter three outright).
4. **Pin**: connect to the checked IP literal (custom `lookup` in `http.request`/`tls.connect` that returns only
   the validated address; `servername` = original hostname for SNI; `Host` header = original host). This defeats
   **DNS rebinding** (no second resolution between check and use) and `autoSelectFamily` surprises (only validated
   addresses are offered).
5. **Redirects** are followed manually (≤ `max_redirects`, default 5 in hosted mode); each hop repeats 1–4; the
   `Authorization`/cookie headers are dropped on cross-origin hops; `https → http` downgrade only if the monitor
   allows it.
6. **No ambient proxies**: our agents must not honour `HTTP(S)_PROXY`/`NODE_USE_ENV_PROXY` (the README tells
   operators to set `NODE_USE_ENV_PROXY=1` for GeoIP downloads — a proxy resolves the target itself and would bypass
   the guard). Explicit per-monitor proxies are self-hosted only.
7. **Block list** (hosted mode / `UPTIME_PRIVATE_TARGETS=deny`):
   IPv4 `0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10 (CGNAT, incl. Alibaba metadata 100.100.100.200), 127.0.0.0/8,
   169.254.0.0/16 (link-local, AWS/GCP/Azure/OpenStack metadata 169.254.169.254, ECS 169.254.170.2),
   172.16.0.0/12, 192.0.0.0/24 (incl. Oracle metadata 192.0.0.192), 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16,
   198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32`;
   IPv6 `::/128, ::1/128, ::ffff:0:0/96*, 64:ff9b::/96*, 64:ff9b:1::/48, 100::/64, 2001::/23 (incl. Teredo
   2001::/32*), 2001:db8::/32, 2002::/16*, 3fff::/20, 5f00::/16, fc00::/7 (incl. AWS IMDS fd00:ec2::254),
   fe80::/10, fec0::/10, ff00::/8` (* = check embedded IPv4); plus the server's own public addresses and the
   `PUBLIC_URL` host. `UPTIME_TARGET_ALLOWLIST` (CIDRs/hostnames) for operator exceptions.
8. **Self-hosted default** (`UPTIME_PRIVATE_TARGETS=allow`): private ranges allowed (that is the point of internal
   monitoring) but link-local/metadata (`169.254.0.0/16`, `fd00:ec2::254`, `100.100.100.200`, `192.0.0.192`),
   `0.0.0.0/8`, multicast and broadcast stay blocked unless `UPTIME_ALLOW_METADATA=true`. Only admins (not viewers)
   can create monitors in self-hosted mode.
9. **Oracles**: error messages returned to members must not distinguish "connection refused" vs "timeout" vs
   "blocked" for denied ranges (blocked targets are rejected at *save* time with a generic "target not allowed";
   resolution changes later lead to a DOWN beat "target not allowed").
10. The same guard applies to UDP (`ntp`, `dns` resolver, `snmp`, `radius`, `sip`) and to raw TCP types.

#### 8.7.2 Resource exhaustion

| vector | mitigation |
|---|---|
| Many monitors / short intervals | per-member and global limits, minimum intervals, scheduler semaphores, fair queueing, overload = *no data* not DOWN |
| Huge responses / decompression bombs | stream bodies, abort after `UPTIME_MAX_BODY_BYTES` (1 MiB; keyword search with chunk overlap of `len(keyword)−1`), cap decompressed bytes separately, `maxHeaderSize` 16 KB, ≤ 100 headers, never buffer whole responses; Kuma buffers unlimited bodies |
| Slowloris targets (trickling headers/body) | total deadline per check (abort signal) + socket idle timeout + watchdog; bounded concurrency caps file descriptors |
| Slow DNS | c-ares `Resolver` with timeout/tries instead of `getaddrinfo` (libuv pool starvation) |
| Hostile protocol peers (SMTP banner floods, MQTT 256 MB packets, SNMP BER bombs) | per-protocol byte caps, length checks before allocation, depth limits in BER/protobuf decoders, line length caps |
| Expensive expressions | no JSONata/regex; restricted JSON path with depth ≤ 32 and parse size ≤ 1 MiB |
| Push endpoint floods | per-token 1/s burst 10, per-IP limits, coalesce to ≤ 1 stored beat/s/monitor |
| Public status pages / badges / RSS floods | in-memory TTL cache (30–60 s) with bounded LRU, per-IP rate limit, ETag/`Cache-Control`, O(1) reads from `monitor_state`/stats (no per-request object creation for unknown ids — Kuma's GHSA-wf2j-5mc7-5c4w) |
| Storage growth | retention jobs, msg ≤ 200 chars, events coalesced for flapping (≥ 30 events/h → flap state) |
| Notification storms | digest window, per-member hourly caps, channel auto-disable |
| Engine crash loops | worker thread isolation, restart backoff, per-type circuit breaker after repeated exceptions |

#### 8.7.3 Secrets at rest

* Secrets: HTTP auth passwords/tokens, OAuth client secrets, mTLS private keys, Redis/DB passwords, MQTT/SNMP
  credentials, **webhook URLs that embed tokens** (Slack, Discord, Teams, Google Chat, WeCom, DingTalk), bot tokens,
  API keys of providers, SMTP passwords, proxy passwords, TOTP secrets. Kuma stores all of them in plaintext and
  sends them to the browser.
* Encryption: AES-256-GCM (`node:crypto`), 96-bit random nonce per value, AAD = `"<table>:<column>:<row id>"`
  (prevents moving ciphertexts between rows/tenants), envelope `v1.<keyId>.<nonce>.<ciphertext+tag>` (base64url).
  Key from `SECRETS_KEY` (32 bytes base64) or `SECRETS_KEY_FILE`; if neither is set a key file is generated in
  `DATA_DIR` with mode 0600 and a startup warning recommends keeping it outside the data volume/backups. Key
  rotation: multiple keys by id, `cli rotate-secrets-key` re-encrypts in chunks.
* Hashed instead of encrypted where we never need the clear value: push tokens (sha256), API keys (sha256 of
  256-bit keys), recovery codes, e-mail verification tokens (existing pattern).
* API: secret fields are **write-only** — responses carry `{"set": true, "hint": "…ab12"}`; `PATCH` keeps a secret
  when omitted and clears it with `null`. Test-notification requests may carry unsaved secrets but nothing is
  persisted or logged.
* Logs & errors: redact URLs (path tokens like `/bot<token>/`, query `token=`), `Authorization` headers and secret
  values from error strings before logging or storing in `notify_log`/heartbeat messages; Fastify request logging
  must redact `/api/push/*` paths.
* Backups: the README already treats DB backups as secrets; add "the key file is required to restore secrets".

#### 8.7.4 XSS / CSS injection on public status pages

* **Isolation**: in hosted mode serve public status pages from a separate origin (`STATUS_PAGE_ORIGIN`, e.g.
  `https://status.example.com/<slug>`, plus verified custom domains). The dashboard session cookie is host-only and
  `SameSite=Strict`, so code on the status origin cannot ride a session; a same-origin XSS under `PUBLIC_URL` would
  be an account takeover because our CSRF defence is a header any same-origin script can set.
* **No HTML from users**: titles, monitor names, incident text, footer and description are rendered as React text;
  Markdown subset (paragraphs, emphasis, strong, inline code, lists, links) is parsed by our own small parser into
  React elements; links only `http:`/`https:`/`mailto:` with `rel="noopener noreferrer nofollow ugc"`; no raw HTML,
  no images in Markdown. Never `dangerouslySetInnerHTML` (Kuma's DOMPurify + `v-html` approach produced three XSS
  advisories).
* **CSP** for status pages: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors
  'none'` (an embed option lists explicit origins). Preload data is delivered as JSON via an API call, not inline
  script (Kuma inlines `window.preloadData` and needs `jsesc` to stay safe).
* **Custom CSS** (self-hosted only): stored ≤ 20 KB, served as `/status/<slug>/custom.css` (`text/css`, nosniff) so
  `style-src 'self'` keeps working; CSP blocks `@import`/`url()` exfiltration to other origins; reject `</`,
  `@import`, `expression(`, `-moz-binding`, `behavior:`. Residual risk = visual spoofing (fake login overlays) →
  disabled in hosted mode.
* **Logos**: raster only (PNG/JPEG/WebP detected by magic bytes, ≤ 512 KB, dimensions ≤ 2048 px read from the
  header), stored content-addressed, served with the sniffed type, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`; **no SVG** (script) and no remote logo URLs (visitor IPs
  would leak to third parties).
* **RSS**: XML-escaped, `application/rss+xml; charset=utf-8`, nosniff (Kuma GHSA-9fg7-wgm7-57fh).
* **Data minimisation**: public JSON exposes display names, status, latency, uptime and (optional) cert days — never
  messages, internal URLs/hostnames (only when "show URL" with an explicit link), ids are public ids.

#### 8.7.5 Badge abuse

* Enumeration: random `public_id` per monitor (Kuma uses sequential ids and leaked data of non-public monitors —
  GHSA-c7hf-c5p5-5g6h); badges disabled until the owner enables them or the monitor is on a published status page.
* No `value` override (Kuma lets anyone render fake values from the real endpoint).
* Parameter injection: label/message ≤ 64 chars, XML-escaped; colours `^#[0-9a-fA-F]{3,6}$` or a named list; style
  enum; durations from a fixed list (`24h, 7d, 30d, 90d, 1y`).
* DoS: rendered SVGs cached by normalised parameters (bounded LRU, 60 s), per-IP rate limit, reads only precomputed
  state; unknown ids return a static N/A SVG without any DB/stat-object work.
* Headers: `Cache-Control: public, max-age=60`, `Cross-Origin-Resource-Policy: cross-origin`,
  `Access-Control-Allow-Origin: *`, no cookies.

#### 8.7.6 Push-token guessing

* 192-bit server-generated tokens (`randomBytes(24).toString('base64url')`), stored as sha256, unique index lookup;
  regenerate button; Kuma's tokens are generated in the browser and accepted from the client.
* Rate limits: 404 responses per IP (e.g. 30/min → 429), per-token rate as above; identical 404 for unknown token,
  paused monitor and deleted site (no oracle).
* Token also accepted via `X-Push-Token` header (keeps it out of proxy logs); docs warn that query strings and paths
  are logged by reverse proxies.

#### 8.7.7 Template injection in notification messages

* Kuma's LiquidJS templates were exploitable twice for arbitrary file read (GHSA-vffh-c9pq-4crh,
  GHSA-v832-4r73-wx5j). We use **no template engine**: `{{name}}` placeholders resolved from a flat, frozen,
  `Object.create(null)` allow-list (`monitor.name`, `monitor.url`, `monitor.type`, `site.name`, `status`,
  `status_emoji`, `event`, `message`, `latency_ms`, `time_iso`, `time_local`, `timezone`, `down_duration`,
  `dashboard_url`, `tags`), single pass (substituted values are never re-scanned — a monitor named `{{…}}` stays
  literal), unknown placeholders rejected at save time, templates ≤ 4 KB.
* **Context-aware escaping per sink**: JSON bodies → JSON string escaping (placeholder must sit inside a string, the
  rendered body must parse as JSON); form → URL encoding; Telegram HTML/MarkdownV2 → respective escaping; Slack
  mrkdwn → `&<>` escaping; Discord → Markdown escaping + `allowed_mentions: {parse: []}` (a hostile target's error
  text must not ping `@everyone`); HTML e-mail → HTML escaping; header values → CR/LF stripped.
* Attacker-controlled content reaches messages through target error messages, banners, DNS records, monitor names
  (members) — always truncate (≤ 200 chars), strip control/bidi characters (`U+202E` spoofing), and never include
  response bodies by default.

#### 8.7.8 2FA bypasses and account security

Kuma 2.x weaknesses to avoid: "remember me" JWT that skips TOTP forever (until password change), TOTP secret in
plaintext, replay check by last token string only, no recovery codes, 2FA disable with password only, global (not
per-account/IP) login rate limit.

Requirements:
* MFA is checked **before any session is created**: `POST /api/auth/login` → `{mfaRequired: true, mfaToken}`
  (32 random bytes, sha256 stored, 5 min, single use, bound to user) → `POST /api/auth/mfa {mfaToken, code}` →
  session cookie. Every other session-creating path (`/api/auth/verify`, future SSO) goes through the same gate;
  password reset never creates a session and never disables MFA.
* TOTP per RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step), 160-bit secret encrypted at rest, enrolment requires a valid
  code, replay protection by storing the last accepted **time step** (reject `step ≤ last_step`),
  `timingSafeEqual`, attempts limited per mfaToken (5) and per account (10/15 min) in addition to IP limits.
* 10 single-use recovery codes (hashed); disabling MFA or regenerating codes requires password **and** a current
  code; enabling/disabling revokes other sessions; members' MFA can be reset only by an admin via CLI.
* API keys are scoped, hashed, expiring and can never create dashboard sessions; `/metrics` only accepts keys with
  `metrics:read`.
* Optional policy `REQUIRE_MFA_FOR_ADMINS=true` (operator accounts can reach every tenant's secrets indirectly).

#### 8.7.9 Notification abuse as spam relay / request forgery

* E-mail in hosted mode only to **double-opt-in verified** recipients (verification mail states who added the
  address and for which site), fixed From, `List-Unsubscribe` one-click, global and per-member caps, member content
  limited to short fields — otherwise a member turns our SMTP into a spam cannon with our reputation.
* Test notifications are rate-limited (5/min, 30/h per member), SSRF-guarded, and use a fixed test text (no free-form
  content).
* Webhook/chat deliveries per member capped per hour; ≤ 5 channels per monitor; outbound webhooks sign bodies
  (`X-PTR-Signature: sha256=…` HMAC with a per-channel secret) so receivers can reject forgeries; requests carry our
  identifying User-Agent.
* SMS/voice providers always use the member's own credentials — no operator-paid SMS.
* Flapping monitors cannot generate unbounded messages: flap detection + digest + hourly caps.

#### 8.7.10 Tenant isolation and IDOR

Every monitor/channel/maintenance/status-page/incident/tag endpoint authorises the object and every **referenced**
object (Kuma's `saveStatusPage` accepts arbitrary monitor ids and several read handlers skip ownership checks —
§7.10). Public endpoints take public ids or slugs only. 404 for both "not found" and "not yours". Tests for each
endpoint with a second member account (existing pattern in our test suite).

#### 8.7.11 Command execution and local resources

Only `ping` may execute a process: fixed absolute binary path, `execFile` (no shell), fixed argument vector, IP
literal as the last argument after `--`-safe ordering, `LC_ALL=C`, timeout and kill. No Apprise, sipsak, tailscale,
pm2, systemctl, cloudflared, Chromium. Docker socket access only with explicit opt-in and container-name validation.
No `file:` URLs anywhere (Kuma GHSA-2qgm-m29m-cj2h).

#### 8.7.12 Supply chain and parser safety

Zero new runtime dependencies for the core; every protocol parser we write is fuzz-tested (vitest property tests
with random bytes) and bounds-checked. Hostile servers are the norm: TLS certificate fields, banners, DNS TXT
records and JSON bodies are untrusted input to our parsers and to the dashboard (rendered as text).

#### 8.7.13 Privacy

Checks reveal the server's IP to targets (documented); notification channels transfer monitor names/messages to
third parties chosen by the user; RDAP queries reveal monitored domains to registries; Globalping (if enabled) sends
targets to a third party. No visitor data is involved. Status page analytics only via our own cookie-less tracker.

### 8.8 API sketch and configuration

REST under `/api` with the existing conventions (cookie session, `X-PA-Request: 1`, JSON errors):

```
GET/POST   /api/sites/:siteId/monitors                 list (with state) / create
GET/PATCH/DELETE /api/monitors/:uid                    detail / update / soft delete
POST       /api/monitors/:uid/{pause|resume|clone|check-now|push-token}
GET        /api/monitors/:uid/heartbeats?from&to       raw (≤ 48 h, down-sampled)
GET        /api/monitors/:uid/stats?period&tz          uptime, latency series, outages
GET        /api/monitors/:uid/events?cursor            state changes
GET/POST/PATCH/DELETE /api/notification-channels[/:uid] ; POST /api/notification-channels/test
GET/POST/PATCH/DELETE /api/tags, /api/maintenances, /api/sites/:siteId/status-pages, /api/status-pages/:id/incidents
GET        /api/uptime/stream                          SSE
GET        /api/uptime/overview?period&tz              per-site health for the overview page
--- public (no auth, CORS *, cached) ---
ALL        /api/push/:token                            push (GET/POST/HEAD)
GET        /status/:slug  (SPA, status origin)         GET /api/public/status/:slug, …/heartbeats, …/incidents, /status/:slug/rss
GET        /api/public/badge/:publicId/{status|uptime|response|cert}.svg ; /api/public/status/:slug/badge.svg
GET        /metrics                                    Bearer API key with metrics:read
```

New environment variables (proposal):

| variable | default | meaning |
|---|---|---|
| `UPTIME_ENABLED` | `true` | turn the feature off entirely |
| `UPTIME_MIN_INTERVAL_S` / `MEMBER_MIN_INTERVAL_S` | `20` / `60` | minimum check interval |
| `UPTIME_CHECK_CONCURRENCY` | `64` | global in-flight checks |
| `UPTIME_PRIVATE_TARGETS` | `allow` (self-hosted), forced `deny` with `SIGNUP_ENABLED` | SSRF policy |
| `UPTIME_ALLOW_METADATA` | `false` | allow link-local/metadata targets |
| `UPTIME_TARGET_ALLOWLIST` / `UPTIME_TARGET_DENYLIST` | – | CIDRs/hostnames |
| `UPTIME_MAX_BODY_BYTES` | `1048576` | response cap |
| `UPTIME_RAW_RETENTION_HOURS` / `UPTIME_RETENTION_DAYS` | `48` / `400` | retention |
| `UPTIME_PING_BINARY` | `/bin/ping` | empty disables the ping type |
| `UPTIME_DOCKER_ENABLED` | `false` | docker monitor type (self-hosted) |
| `SECRETS_KEY` / `SECRETS_KEY_FILE` | generated file in `DATA_DIR` | encryption key |
| `STATUS_PAGE_ORIGIN` | – | separate origin for public status pages (required in hosted mode) |
| `MEMBER_MONITORS_PER_SITE`, `MEMBER_STATUS_PAGES_PER_SITE`, `MEMBER_NOTIFY_PER_HOUR` | `10`, `1`, `120` | hosted limits |
| `REQUIRE_MFA_FOR_ADMINS` | `false` | policy |

### 8.9 Open questions for the specification

1. Pricing: are monitors included per paid site (proposal: 10) or a separate Stripe price per monitor pack?
2. Should viewers (self-hosted) be allowed to acknowledge outages / post incidents, or stay strictly read-only?
3. Status page origin in self-hosted mode: same origin under `/status/` (simpler) vs mandatory separate host
   (safer) — proposal: same origin allowed only when custom CSS is off.
4. Do we need multi-region checking (own lightweight probes or Globalping) before calling the feature "uptime
   monitoring" in hosted mode? Single-location checks produce false positives on network partitions; the network
   sanity check (§8.3) mitigates but does not replace it.
5. Kuma import tool scope (COULD): which types/providers to map, and whether to import history (`stat_daily`).
