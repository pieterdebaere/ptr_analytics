// Migration v6, part 2 — notification channels, outbox, delivery log (owner: notifications).
// v6 is not released yet: this SQL may still be edited.
export const NOTIFY_SCHEMA = `
CREATE TABLE notify_channels (
  id                   INTEGER PRIMARY KEY,
  uid                  TEXT NOT NULL UNIQUE,
  owner_id             INTEGER REFERENCES users(id),        -- NULL = operator channel
  type                 TEXT NOT NULL,                       -- provider id from the provider registry
  name                 TEXT NOT NULL,
  config               TEXT NOT NULL,                       -- non-secret JSON
  secrets              BLOB,                                -- AES-256-GCM envelope
  is_default           INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  verified_at          INTEGER,                             -- e-mail recipients (hosted mode: double opt-in)
  verify_token_hash    TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER
);
CREATE INDEX notify_channels_owner ON notify_channels(owner_id) WHERE deleted_at IS NULL;

CREATE TABLE monitor_channels (
  monitor_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, channel_id)
) WITHOUT ROWID;
CREATE INDEX monitor_channels_channel ON monitor_channels(channel_id);

-- Written by the uptime engine in the same transaction as the monitor event; drained by the dispatcher.
CREATE TABLE notify_outbox (
  id              INTEGER PRIMARY KEY,
  channel_id      INTEGER NOT NULL,
  monitor_id      INTEGER,
  event           TEXT NOT NULL CHECK (event IN ('down', 'up', 'resend', 'cert', 'domain', 'maint_start', 'maint_end', 'test')),
  payload         TEXT NOT NULL,                            -- NotifyPayload JSON (uptime/types.ts), never secrets
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX notify_outbox_due ON notify_outbox(next_attempt_at);

CREATE TABLE notify_log (
  id          INTEGER PRIMARY KEY,
  channel_id  INTEGER NOT NULL,
  monitor_id  INTEGER,
  ts          INTEGER NOT NULL,
  event       TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  http_status INTEGER,
  error       TEXT
);
CREATE INDEX notify_log_channel_ts ON notify_log(channel_id, ts);
CREATE INDEX notify_log_ts ON notify_log(ts);
`;
