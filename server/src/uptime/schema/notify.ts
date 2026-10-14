// Migration v6, part 2 — notification channels, outbox, delivery log (owner: notifications).
// v6 is not released yet: this SQL may still be edited.
//
// notify_channels.owner_id cascades on user deletion (a deleted member's channels and their
// encrypted secrets go with it). The other tables reference channels without foreign keys;
// the dispatcher's housekeeping removes orphaned link/outbox/log rows in small chunks.
// Channel ids are AUTOINCREMENT: an id is never handed out again, so rows left behind by a
// deleted channel can never attach to another tenant's new channel (the dispatcher and the log
// endpoint additionally check that the monitor of a row belongs to the channel's owner).
export const NOTIFY_SCHEMA = `
CREATE TABLE notify_channels (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  uid                  TEXT NOT NULL UNIQUE,
  owner_id             INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = operator channel
  type                 TEXT NOT NULL,                       -- provider id from the provider registry
  name                 TEXT NOT NULL,
  config               TEXT NOT NULL,                       -- non-secret JSON
  secrets              BLOB,                                -- AES-256-GCM envelope, AAD "channel:<uid>"
  is_default           INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER
);
CREATE INDEX notify_channels_owner ON notify_channels(owner_id) WHERE deleted_at IS NULL;

-- E-mail recipients of an e-mail channel (double opt-in in hosted mode, one-click unsubscribe).
-- Tokens are stored as sha256 hex; the unsubscribe token itself is needed for every mail and is
-- kept encrypted (AAD "notify-unsub:<channel uid>:<address>").
CREATE TABLE notify_email_recipients (
  channel_id        INTEGER NOT NULL REFERENCES notify_channels(id) ON DELETE CASCADE,
  address           TEXT NOT NULL,                          -- lower-cased plain address
  verified_at       INTEGER,
  unsubscribed_at   INTEGER,
  verify_token_hash TEXT UNIQUE,
  verify_expires_at INTEGER,
  verify_sent_at    INTEGER,
  unsub_token_hash  TEXT NOT NULL UNIQUE,
  unsub_token_enc   BLOB NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (channel_id, address)
) WITHOUT ROWID;

-- Hosted members' e-mail opt-outs: an address that unsubscribed from (or declined) a channel of
-- this owner never gets an opt-in mail from this owner again — only the recipient can undo it
-- (re-subscribe form, authorised by the recipient's unsubscribe token). Survives removing the
-- address from the channel and deleting the channel.
CREATE TABLE notify_email_optouts (
  owner_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address          TEXT NOT NULL,
  unsub_token_hash TEXT NOT NULL,                           -- sha256 hex of the recipient's last unsubscribe token
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (owner_id, address)
) WITHOUT ROWID;
CREATE INDEX notify_email_optouts_token ON notify_email_optouts(unsub_token_hash);

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
CREATE INDEX notify_outbox_channel ON notify_outbox(channel_id, id);

CREATE TABLE notify_log (
  id          INTEGER PRIMARY KEY,
  channel_id  INTEGER NOT NULL,
  monitor_id  INTEGER,
  ts          INTEGER NOT NULL,
  event       TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  http_status INTEGER,
  error       TEXT                                          -- ≤ 300 chars, redacted
);
CREATE INDEX notify_log_channel_ts ON notify_log(channel_id, ts);
CREATE INDEX notify_log_ts ON notify_log(ts);
`;
