# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Instead, report them
privately via GitHub's [private vulnerability reporting](https://github.com/pieterdebaere/ptr_analytics/security/advisories/new).

Include a description, steps to reproduce and the affected version/commit. You can
expect an acknowledgement within a few days. Once a fix is released the advisory will be
published and you will be credited unless you prefer otherwise.

## Supported versions

Only the latest release (and `main`) receives security fixes.

## Security model in short

* The dashboard and its API require a login. Sessions are random 256-bit tokens in an
  `HttpOnly`, `SameSite=Strict` cookie (`Secure` and `__Host-` prefixed when `PUBLIC_URL`
  is `https://…` or `COOKIE_SECURE=true`); only a SHA-256 hash of the token is stored.
* Passwords are hashed with scrypt (with a cap on concurrent hashing). Login attempts are
  rate limited per (account, IP), per IP, and per account across all IPs.
* State-changing API requests require a custom header and a matching `Origin` (CSRF).
* All dashboard responses carry a strict Content Security Policy and related headers.
* All SQL is parameterised; user-chosen dimensions are mapped through an allow-list.
* The public ingest endpoint (`POST /api/event`) is unauthenticated by design — like every
  web analytics product, anyone can send (fake) events for a site id they know. It is
  protected by strict validation, a payload size limit, domain/Origin checks and per-IP
  rate limiting, but it is not a trust boundary for data accuracy.
* No IP addresses, cookies or persistent visitor identifiers are stored. Visitor ids are
  hashes with a salt that rotates daily; old salts are deleted with SQLite `secure_delete`
  and the WAL is truncated, so they cannot be recovered from the database files.
  The *current* day's salt is in the database, so protect the data directory and backups.

### Hosted mode (`SIGNUP_ENABLED`)

* Tenancy is enforced in one place on every site-scoped endpoint (settings, stats, speed
  insights, export, live map): members only reach sites they own; any other site answers
  `404`, exactly like a site that does not exist. Viewers cannot change anything.
* Sign-up and "forgot password" always answer `202` after the same work and send mail in the
  background, so neither the response nor its timing reveals whether an address has an
  account. Signing up with an existing address mails a password-reset link instead of a
  verification link, so an account pre-registered by someone else cannot be activated by the
  real owner clicking a link; resetting the password replaces the stranger's password.
* Verification and reset tokens are 256-bit random, stored only as SHA-256, single use,
  short-lived (24 h / 1 h) and only the newest one per purpose is valid. A reset signs out
  every session. Sign-up, forgot-password and token submission are rate limited per IP and
  per address.
* Stripe webhooks are verified with HMAC-SHA256 over the raw body (constant-time compare,
  5 minute tolerance, 1 MB limit) and de-duplicated by event id. They are only a trigger:
  the subscription state is always re-read from the Stripe API for the customer id the
  server stored itself, so a webhook can never grant more sites than are paid for, nor
  affect another account. Stripe errors are logged without keys or request bodies.
* SMTP credentials and Stripe secrets are never logged or echoed in configuration errors.

## Hardening checklist for operators

* Run behind a TLS-terminating reverse proxy and set `PUBLIC_URL` to the `https://` URL.
* Set `TRUST_PROXY` to the exact number of proxy hops (usually `1`), and only when the
  server port is reachable exclusively through those proxies. If it is directly reachable,
  use `false`; any other value lets clients spoof their IP and bypass per-IP rate limits.
* Remove `ADMIN_EMAIL` and `ADMIN_PASSWORD` from the environment after the first start.
* The data directory and database are created owner-only (`0700`/`0600`); keep backups
  just as private (they contain password hashes and the current salt).
* Keep the container read-only and unprivileged (see `docker-compose.yml`).
* Back up the `/data` volume.
* Hosted mode: use a restricted Stripe key where possible, keep `TRUST_PROXY` correct (the
  sign-up rate limits are per client IP), and only enable `SIGNUP_ENABLED` with a working
  SMTP setup and `PUBLIC_URL` on https.
