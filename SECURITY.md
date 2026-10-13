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
