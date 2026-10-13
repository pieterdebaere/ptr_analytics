/**
 * Schema migrations. Each entry upgrades the schema by one version; the current version is
 * stored in `PRAGMA user_version`. Never edit a released migration — append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  // v1 — initial schema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
  CREATE INDEX auth_sessions_expires ON auth_sessions(expires_at);

  CREATE TABLE sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domains TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE salts (
    day TEXT PRIMARY KEY,
    salt BLOB NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    visitor_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    pageviews INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_visitor ON sessions(site_id, visitor_id, last_seen_at);
  CREATE INDEX sessions_last_seen ON sessions(last_seen_at);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('pageview', 'event')),
    name TEXT,
    visitor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    path TEXT NOT NULL,
    referrer TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_term TEXT,
    utm_content TEXT,
    country TEXT,
    device TEXT,
    browser TEXT,
    os TEXT,
    props TEXT
  );
  CREATE INDEX events_site_ts ON events(site_id, ts);
  CREATE INDEX events_site_type_ts ON events(site_id, type, ts);

  CREATE TABLE vitals (
    id INTEGER PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    metric TEXT NOT NULL CHECK (metric IN ('LCP', 'FCP', 'CLS', 'INP', 'TTFB')),
    value REAL NOT NULL,
    hostname TEXT NOT NULL,
    path TEXT NOT NULL,
    country TEXT,
    device TEXT,
    browser TEXT,
    os TEXT
  );
  CREATE INDEX vitals_site_metric_ts ON vitals(site_id, metric, ts);
  CREATE INDEX vitals_site_ts ON vitals(site_id, ts);
  `,
  // v2 — per-bucket bounce rate looks sessions up by start time
  `
  CREATE INDEX sessions_site_started ON sessions(site_id, started_at);
  `,
];
