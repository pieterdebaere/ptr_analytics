/**
 * A migration that rebuilds a table (SQLite cannot alter CHECK constraints). It runs with
 * `foreign_keys = OFF` (otherwise DROP TABLE would cascade-delete child rows); afterwards
 * the foreign keys pointing at the rebuilt tables are checked: any violation that did not
 * exist before the migration rolls the whole migration back. Pre-existing orphans elsewhere
 * (e.g. rows left behind by an old crash) do not block the upgrade; they are only logged.
 */
export interface RebuildMigration {
  sql: string;
  foreignKeysOff: true;
  /** Tables dropped and re-created by this migration. */
  rebuilds: readonly string[];
}

export type Migration = string | RebuildMigration;

/**
 * Schema migrations. Each entry upgrades the schema by one version; the current version is
 * stored in `PRAGMA user_version`. Never edit a released migration — append a new one.
 */
export const MIGRATIONS: readonly Migration[] = [
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
  // v3 — stats performance:
  // * custom events by name (event filter visitor sets, event props, export with event=)
  // * pageview counting (COUNT(DISTINCT visitor_id), bounce session sets) from the index alone;
  //   replaces events_site_type_ts, which is a prefix of it
  `
  CREATE INDEX events_site_type_name_ts ON events(site_id, type, name, ts);
  CREATE INDEX events_site_type_ts_visitor ON events(site_id, type, ts, visitor_id, session_id);
  DROP INDEX events_site_type_ts;
  `,
  // v4 — hosted ("cloud") mode: member role, email verification, billing, site ownership
  {
    foreignKeysOff: true,
    rebuilds: ['users'],
    sql: `
  CREATE TABLE users_v4 (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'viewer', 'member')),
    created_at INTEGER NOT NULL,
    email_verified_at INTEGER,
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT,
    subscription_status TEXT NOT NULL DEFAULT 'none'
      CHECK (subscription_status IN ('none', 'active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete')),
    paid_sites INTEGER NOT NULL DEFAULT 0 CHECK (paid_sites >= 0),
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1))
  );
  -- Existing (operator-created) accounts count as verified.
  INSERT INTO users_v4 (id, email, password_hash, role, created_at, email_verified_at)
    SELECT id, email, password_hash, role, created_at, created_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_v4 RENAME TO users;
  CREATE INDEX users_stripe_subscription ON users(stripe_subscription_id);
  CREATE INDEX users_unverified ON users(created_at) WHERE email_verified_at IS NULL;

  -- NULL owner = operator site (created by an admin, or before this version): never
  -- suspended, and deleting an admin account never deletes sites.
  ALTER TABLE sites ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE sites ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1));
  CREATE INDEX sites_owner ON sites(owner_id, created_at);

  CREATE TABLE user_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX user_tokens_user ON user_tokens(user_id, purpose);
  CREATE INDEX user_tokens_expires ON user_tokens(expires_at);

  -- Processed Stripe webhook event ids (idempotency).
  CREATE TABLE stripe_events (
    id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX stripe_events_received ON stripe_events(received_at);
  `,
  },
  // v5 — soft-deleted sites: hidden at once, their data is purged in the background in small
  // chunks (a cascading DELETE of a big site would block the server for seconds).
  `
  ALTER TABLE sites ADD COLUMN deleted_at INTEGER;
  CREATE INDEX sites_deleted ON sites(deleted_at) WHERE deleted_at IS NOT NULL;
  `,
];
