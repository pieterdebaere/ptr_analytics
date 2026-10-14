// Migration v6, part 3 — status pages, incidents, assets, MFA, API keys (owner: status pages & security).
// v6 is not released yet: this SQL may still be edited.
export const STATUS_SCHEMA = `
CREATE TABLE status_pages (
  id                INTEGER PRIMARY KEY,
  uid               TEXT NOT NULL UNIQUE,
  site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, -- small table: the site purge may cascade
  slug              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  description       TEXT,                                   -- Markdown subset
  footer            TEXT,                                   -- Markdown subset
  logo_asset        TEXT,                                   -- assets.sha256
  theme             TEXT NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto', 'light', 'dark')),
  accent            TEXT,                                   -- '#rrggbb'
  published         INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  noindex           INTEGER NOT NULL DEFAULT 0 CHECK (noindex IN (0, 1)),
  show_tags         INTEGER NOT NULL DEFAULT 0 CHECK (show_tags IN (0, 1)),
  show_cert_expiry  INTEGER NOT NULL DEFAULT 0 CHECK (show_cert_expiry IN (0, 1)),
  show_powered_by   INTEGER NOT NULL DEFAULT 1 CHECK (show_powered_by IN (0, 1)),
  refresh_s         INTEGER NOT NULL DEFAULT 60,
  tz                TEXT NOT NULL DEFAULT 'UTC',            -- IANA zone of the daily bars
  analytics_site_id TEXT REFERENCES sites(id) ON DELETE SET NULL, -- track the page with our own tracker
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX status_pages_site ON status_pages(site_id) WHERE deleted_at IS NULL;

-- Claims of custom domains. Several pages (tenants) may claim the same domain while it is
-- unverified, so nobody can squat a domain they do not control; only one verified row per
-- domain (partial unique index below). Unverified claims expire after 7 days.
CREATE TABLE status_page_domains (
  domain         TEXT NOT NULL,
  status_page_id INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  verify_token   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  verified_at    INTEGER,
  PRIMARY KEY (domain, status_page_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX status_page_domains_verified ON status_page_domains(domain) WHERE verified_at IS NOT NULL;
CREATE INDEX status_page_domains_pending ON status_page_domains(created_at) WHERE verified_at IS NULL;

CREATE TABLE status_page_sections (
  id             INTEGER PRIMARY KEY,
  status_page_id INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  position       INTEGER NOT NULL
);
CREATE INDEX status_page_sections_page ON status_page_sections(status_page_id, position);

CREATE TABLE status_page_monitors (
  section_id   INTEGER NOT NULL REFERENCES status_page_sections(id) ON DELETE CASCADE,
  monitor_id   INTEGER NOT NULL,
  position     INTEGER NOT NULL,
  display_name TEXT,
  show_url     INTEGER NOT NULL DEFAULT 0 CHECK (show_url IN (0, 1)),
  PRIMARY KEY (section_id, monitor_id)
) WITHOUT ROWID;
CREATE INDEX status_page_monitors_monitor ON status_page_monitors(monitor_id);

CREATE TABLE incidents (
  id             INTEGER PRIMARY KEY,
  uid            TEXT NOT NULL UNIQUE,
  status_page_id INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,                             -- Markdown subset
  style          TEXT NOT NULL CHECK (style IN ('info', 'warning', 'danger', 'success', 'neutral')),
  pinned         INTEGER NOT NULL DEFAULT 1 CHECK (pinned IN (0, 1)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER,
  resolved_at    INTEGER
);
CREATE INDEX incidents_page ON incidents(status_page_id, created_at);

CREATE TABLE maintenance_status_pages (
  maintenance_id INTEGER NOT NULL REFERENCES maintenances(id) ON DELETE CASCADE,
  status_page_id INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  PRIMARY KEY (maintenance_id, status_page_id)
) WITHOUT ROWID;

CREATE TABLE assets (
  sha256     TEXT PRIMARY KEY,
  owner_id   INTEGER,
  mime       TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes      BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE user_mfa (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret BLOB NOT NULL,                                -- encrypted
  enabled_at  INTEGER,                                      -- NULL while enrolment is pending
  last_step   INTEGER NOT NULL DEFAULT 0,                   -- replay protection
  -- Progressive lockout (auth/mfa.ts): consecutive failures (reset only by a correct factor),
  -- failures in the current 24 h window (never reset by a success), lock end, last alert mail.
  fail_streak      INTEGER NOT NULL DEFAULT 0,
  fail_window_at   INTEGER NOT NULL DEFAULT 0,
  fail_window_n    INTEGER NOT NULL DEFAULT 0,
  locked_until     INTEGER NOT NULL DEFAULT 0,
  fail_notified_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE user_recovery_codes (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   INTEGER,
  PRIMARY KEY (user_id, code_hash)
) WITHOUT ROWID;

CREATE TABLE api_keys (
  id           INTEGER PRIMARY KEY,
  uid          TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL UNIQUE,
  key_hash     TEXT NOT NULL,
  scopes       TEXT NOT NULL,                               -- JSON array
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX api_keys_user ON api_keys(user_id);
CREATE INDEX status_pages_analytics_site ON status_pages(analytics_site_id) WHERE analytics_site_id IS NOT NULL;
CREATE INDEX status_pages_logo ON status_pages(logo_asset) WHERE logo_asset IS NOT NULL;
CREATE INDEX status_page_domains_page ON status_page_domains(status_page_id);
`;
