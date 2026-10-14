// Migration v6, part 1 — monitors, heartbeats, stats, maintenance, tags (owner: uptime core).
// v6 is not released yet: this SQL may still be edited. After release, append new migrations instead.
// Ids of monitors, tags and maintenances are AUTOINCREMENT: an id is never handed out twice, so rows
// that reference a deleted object by id (links, outbox/log rows, late writes) never reach a new one.
// No ON DELETE CASCADE on large tables: soft delete + chunked background purge (see jobs/purge.ts).
export const CORE_SCHEMA = `
CREATE TABLE monitors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,       -- never reused: late writes / links of a purged monitor cannot reach a new one
  uid              TEXT NOT NULL UNIQUE,                    -- 12 chars [a-z0-9], external id
  site_id          TEXT NOT NULL REFERENCES sites(id),      -- tenancy, billing and soft delete follow the site
  parent_id        INTEGER REFERENCES monitors(id),         -- group monitor (same site, no cycles)
  type             TEXT NOT NULL,                           -- validated against the checker registry
  name             TEXT NOT NULL,
  description      TEXT,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  interval_s       INTEGER NOT NULL,
  retry_interval_s INTEGER NOT NULL,
  max_retries      INTEGER NOT NULL DEFAULT 0,
  resend_every     INTEGER NOT NULL DEFAULT 0,              -- 0 = never, else every N failed checks while DOWN
  timeout_ms       INTEGER NOT NULL,
  upside_down      INTEGER NOT NULL DEFAULT 0 CHECK (upside_down IN (0, 1)),
  cert_notify      INTEGER NOT NULL DEFAULT 1 CHECK (cert_notify IN (0, 1)),
  domain_notify    INTEGER NOT NULL DEFAULT 0 CHECK (domain_notify IN (0, 1)),
  config           TEXT NOT NULL,                           -- validated JSON per type, never secrets
  secrets          BLOB,                                    -- AES-256-GCM envelope (uptime/secrets.ts)
  secret_keys      TEXT,                                    -- JSON array of the secret field names set (API: secretsSet)
  push_token_hash  TEXT UNIQUE,                             -- sha256 hex of the push token (push monitors)
  public_id        TEXT UNIQUE,                             -- random id for badges; NULL = badges off
  position         INTEGER NOT NULL DEFAULT 0,
  manual_status    INTEGER,                                 -- manual monitors: 0 down, 1 up, 2 pending; NULL = not set
  manual_msg       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER
);
CREATE INDEX monitors_site ON monitors(site_id, position) WHERE deleted_at IS NULL;
CREATE INDEX monitors_parent ON monitors(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX monitors_deleted ON monitors(deleted_at) WHERE deleted_at IS NOT NULL;

-- Hot row per monitor; survives restarts.
CREATE TABLE monitor_state (
  monitor_id          INTEGER PRIMARY KEY REFERENCES monitors(id),
  status              INTEGER NOT NULL DEFAULT -1,          -- -1 unknown, 0 down, 1 up, 2 pending, 3 maintenance
  retries             INTEGER NOT NULL DEFAULT 0,
  failed_since_notify INTEGER NOT NULL DEFAULT 0,
  last_check_at       INTEGER,
  last_change_at      INTEGER,
  last_push_at        INTEGER,
  last_latency_ms     INTEGER,
  last_msg            TEXT,
  open_outage_id      INTEGER
);

CREATE TABLE heartbeats (
  monitor_id INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  status     INTEGER NOT NULL,
  latency_ms INTEGER,
  msg        TEXT,
  PRIMARY KEY (monitor_id, ts)
) WITHOUT ROWID;

CREATE TABLE monitor_events (
  id          INTEGER PRIMARY KEY,
  monitor_id  INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  from_status INTEGER,
  to_status   INTEGER NOT NULL,
  msg         TEXT
);
CREATE INDEX monitor_events_monitor_ts ON monitor_events(monitor_id, ts);

CREATE TABLE outages (
  id           INTEGER PRIMARY KEY,
  monitor_id   INTEGER NOT NULL,
  started_at   INTEGER NOT NULL,
  confirmed_at INTEGER,
  ended_at     INTEGER,
  cause        TEXT
);
CREATE INDEX outages_monitor ON outages(monitor_id, started_at);

CREATE TABLE monitor_stats_hour (
  monitor_id INTEGER NOT NULL,
  bucket     INTEGER NOT NULL,                              -- UTC hour start, ms
  up_ms      INTEGER NOT NULL DEFAULT 0,
  down_ms    INTEGER NOT NULL DEFAULT 0,
  pending_ms INTEGER NOT NULL DEFAULT 0,
  maint_ms   INTEGER NOT NULL DEFAULT 0,
  checks     INTEGER NOT NULL DEFAULT 0,
  failures   INTEGER NOT NULL DEFAULT 0,
  lat_n      INTEGER NOT NULL DEFAULT 0,
  lat_sum    INTEGER NOT NULL DEFAULT 0,
  lat_min    INTEGER,
  lat_max    INTEGER,
  PRIMARY KEY (monitor_id, bucket)
) WITHOUT ROWID;

CREATE TABLE monitor_stats_day (
  monitor_id INTEGER NOT NULL,
  bucket     INTEGER NOT NULL,                              -- UTC day start, ms
  up_ms      INTEGER NOT NULL DEFAULT 0,
  down_ms    INTEGER NOT NULL DEFAULT 0,
  pending_ms INTEGER NOT NULL DEFAULT 0,
  maint_ms   INTEGER NOT NULL DEFAULT 0,
  checks     INTEGER NOT NULL DEFAULT 0,
  failures   INTEGER NOT NULL DEFAULT 0,
  lat_n      INTEGER NOT NULL DEFAULT 0,
  lat_sum    INTEGER NOT NULL DEFAULT 0,
  lat_min    INTEGER,
  lat_max    INTEGER,
  PRIMARY KEY (monitor_id, bucket)
) WITHOUT ROWID;

CREATE TABLE monitor_tls (
  monitor_id     INTEGER PRIMARY KEY,
  checked_at     INTEGER,
  valid          INTEGER,
  hostname_ok    INTEGER,
  subject        TEXT,
  issuer         TEXT,
  sans           TEXT,                                      -- JSON array
  not_before     INTEGER,
  not_after      INTEGER,
  fingerprint256 TEXT,
  chain          TEXT                                       -- JSON
);

CREATE TABLE expiry_notices (
  monitor_id     INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('cert', 'domain')),
  fingerprint    TEXT NOT NULL,
  threshold_days INTEGER NOT NULL,
  sent_at        INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, kind, fingerprint, threshold_days)
) WITHOUT ROWID;

CREATE TABLE domain_expiry (
  domain      TEXT PRIMARY KEY,
  expires_at  INTEGER,
  checked_at  INTEGER,
  rdap_status TEXT
);

CREATE TABLE tags (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  uid      TEXT NOT NULL UNIQUE,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = operator tag (few rows: cascade is cheap)
  name     TEXT NOT NULL,
  color    TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  UNIQUE (owner_id, name)
);
CREATE TABLE monitor_tags (
  monitor_id INTEGER NOT NULL,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  value      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (monitor_id, tag_id, value)
) WITHOUT ROWID;
CREATE INDEX monitor_tags_tag ON monitor_tags(tag_id);

CREATE TABLE maintenances (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT NOT NULL UNIQUE,
  owner_id      INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = operator
  title         TEXT NOT NULL,
  description   TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  strategy      TEXT NOT NULL CHECK (strategy IN ('manual', 'single', 'weekly', 'monthly', 'interval', 'cron')),
  tz            TEXT NOT NULL,
  starts_at     INTEGER,
  ends_at       INTEGER,
  time_start    TEXT,
  time_end      TEXT,
  weekdays      TEXT,
  days_of_month TEXT,
  interval_days INTEGER,
  cron          TEXT,
  duration_s    INTEGER,
  notified_start INTEGER,                                   -- window start for which maint_start was sent (engine)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX maintenances_owner ON maintenances(owner_id);
CREATE INDEX tags_owner ON tags(owner_id);
CREATE TABLE maintenance_monitors (
  maintenance_id INTEGER NOT NULL REFERENCES maintenances(id) ON DELETE CASCADE,
  monitor_id     INTEGER NOT NULL,
  PRIMARY KEY (maintenance_id, monitor_id)
) WITHOUT ROWID;
CREATE INDEX maintenance_monitors_monitor ON maintenance_monitors(monitor_id);
`;
