// Batched writes (ANALYSIS §8.2): results are queued in memory and written every ~500 ms or 200
// results in ONE short transaction (prepared statements), so checks never hold the write lock and
// a flush blocks the event loop for a few milliseconds at most.
import type Database from 'better-sqlite3';
import type { DB } from '../../db/index.js';
import { emptyDelta, mergeDelta, type StatDelta } from './aggregate.js';

export type WriteOp = (s: Statements) => void;

/**
 * A statement guarded by `WHERE EXISTS (SELECT 1 FROM monitors WHERE id = ? AND uid = ?)`: `run(uid,
 * id, ...)` appends the monitor id (first value) and the uid. Comparing the uid too means a late
 * write can never land on another monitor, even if an id were ever handed out again (ids are
 * AUTOINCREMENT since v6; this is defence in depth, audit HIGH 1).
 */
export interface Guarded {
  run(uid: string, ...args: unknown[]): Database.RunResult;
}

const GUARD = 'EXISTS (SELECT 1 FROM monitors WHERE id = ? AND uid = ?)';

function guarded(stmt: Database.Statement): Guarded {
  return { run: (uid: string, ...args: unknown[]) => stmt.run(...args, args[0], uid) };
}

export interface Statements {
  db: DB;
  heartbeat: Guarded;
  state: Guarded;
  event: Guarded;
  outageOpen: Guarded;
  outageConfirm: Database.Statement;
  outageClose: Database.Statement;
  outbox: Database.Statement;
  channels: Database.Statement;
  monitorChannels: Database.Statement;
  tls: Guarded;
  noticeExists: Database.Statement;
  noticeInsert: Database.Statement;
  domainExpiry: Database.Statement;
  statHour: Guarded;
  statDay: Guarded;
}

const STAT_UPSERT = (table: string): string => `
  INSERT INTO ${table} (monitor_id, bucket, up_ms, down_ms, pending_ms, maint_ms, checks, failures, lat_n, lat_sum, lat_min, lat_max)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${GUARD}
  ON CONFLICT (monitor_id, bucket) DO UPDATE SET
    up_ms = up_ms + excluded.up_ms, down_ms = down_ms + excluded.down_ms,
    pending_ms = pending_ms + excluded.pending_ms, maint_ms = maint_ms + excluded.maint_ms,
    checks = checks + excluded.checks, failures = failures + excluded.failures,
    lat_n = lat_n + excluded.lat_n, lat_sum = lat_sum + excluded.lat_sum,
    lat_min = CASE WHEN excluded.lat_min IS NULL THEN lat_min WHEN lat_min IS NULL THEN excluded.lat_min ELSE MIN(lat_min, excluded.lat_min) END,
    lat_max = CASE WHEN excluded.lat_max IS NULL THEN lat_max WHEN lat_max IS NULL THEN excluded.lat_max ELSE MAX(lat_max, excluded.lat_max) END`;

function prepare(db: DB): Statements {
  return {
    db,
    // Rows are only written while the monitor row exists (no orphans after a purge).
    heartbeat: guarded(db.prepare(
      `INSERT OR REPLACE INTO heartbeats (monitor_id, ts, status, latency_ms, msg) SELECT ?, ?, ?, ?, ? WHERE ${GUARD}`,
    )),
    state: guarded(db.prepare(
      `INSERT INTO monitor_state (monitor_id, status, retries, failed_since_notify, last_check_at, last_change_at, last_push_at,
         last_latency_ms, last_msg, open_outage_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${GUARD}
       ON CONFLICT (monitor_id) DO UPDATE SET status = excluded.status, retries = excluded.retries,
         failed_since_notify = excluded.failed_since_notify, last_check_at = excluded.last_check_at,
         last_change_at = excluded.last_change_at, last_push_at = excluded.last_push_at,
         last_latency_ms = excluded.last_latency_ms, last_msg = excluded.last_msg, open_outage_id = excluded.open_outage_id`,
    )),
    event: guarded(db.prepare(
      `INSERT INTO monitor_events (monitor_id, ts, from_status, to_status, msg) SELECT ?, ?, ?, ?, ? WHERE ${GUARD}`,
    )),
    outageOpen: guarded(db.prepare(
      `INSERT INTO outages (monitor_id, started_at, confirmed_at, ended_at, cause) SELECT ?, ?, ?, NULL, ? WHERE ${GUARD}`,
    )),
    outageConfirm: db.prepare('UPDATE outages SET confirmed_at = ?, cause = COALESCE(?, cause) WHERE id = ? AND confirmed_at IS NULL'),
    outageClose: db.prepare('UPDATE outages SET ended_at = ? WHERE id = ? AND ended_at IS NULL'),
    outbox: db.prepare(
      'INSERT INTO notify_outbox (channel_id, monitor_id, event, payload, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    ),
    channels: db.prepare(
      `SELECT c.id FROM monitor_channels mc JOIN notify_channels c ON c.id = mc.channel_id
       WHERE mc.monitor_id = ? AND c.active = 1 AND c.deleted_at IS NULL ORDER BY c.id`,
    ),
    // Recipients of a monitor's notification: only while that very monitor (id and uid) is live.
    monitorChannels: db.prepare(
      `SELECT c.id FROM monitor_channels mc JOIN notify_channels c ON c.id = mc.channel_id
       WHERE mc.monitor_id = ? AND c.active = 1 AND c.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM monitors m WHERE m.id = mc.monitor_id AND m.uid = ? AND m.deleted_at IS NULL)
       ORDER BY c.id`,
    ),
    tls: guarded(db.prepare(
      `INSERT INTO monitor_tls (monitor_id, checked_at, valid, hostname_ok, subject, issuer, sans, not_before, not_after, fingerprint256, chain)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${GUARD}
       ON CONFLICT (monitor_id) DO UPDATE SET checked_at = excluded.checked_at, valid = excluded.valid, hostname_ok = excluded.hostname_ok,
         subject = excluded.subject, issuer = excluded.issuer, sans = excluded.sans, not_before = excluded.not_before,
         not_after = excluded.not_after, fingerprint256 = excluded.fingerprint256, chain = excluded.chain`,
    )),
    noticeExists: db.prepare('SELECT 1 FROM expiry_notices WHERE monitor_id = ? AND kind = ? AND fingerprint = ? AND threshold_days = ?'),
    noticeInsert: db.prepare(
      'INSERT OR IGNORE INTO expiry_notices (monitor_id, kind, fingerprint, threshold_days, sent_at) VALUES (?, ?, ?, ?, ?)',
    ),
    domainExpiry: db.prepare(
      `INSERT INTO domain_expiry (domain, expires_at, checked_at, rdap_status) VALUES (?, ?, ?, NULL)
       ON CONFLICT (domain) DO UPDATE SET expires_at = excluded.expires_at, checked_at = excluded.checked_at`,
    ),
    statHour: guarded(db.prepare(STAT_UPSERT('monitor_stats_hour'))),
    statDay: guarded(db.prepare(STAT_UPSERT('monitor_stats_day'))),
  };
}

export interface WriterOptions {
  flushMs: number;
  maxBatch: number;
  /** Hard cap on queued results; beyond it the oldest batch is dropped (logged). */
  maxQueued: number;
  onError(err: unknown): void;
}

/** Queue of write operations + pre-aggregated stat deltas, flushed in one transaction. */
export class BatchWriter {
  private ops: WriteOp[] = [];
  private hour = new Map<string, StatEntry>();
  private day = new Map<string, StatEntry>();
  private results = 0;
  private timer: NodeJS.Timeout | null = null;
  private stmts: Statements | null = null;
  private closed = false;

  constructor(
    private readonly db: DB,
    private readonly opts: WriterOptions,
  ) {}

  get pending(): number {
    return this.results;
  }

  /** Queue the writes of one result. */
  add(ops: WriteOp[], stats?: { hour: Map<number, StatDelta>; day: Map<number, StatDelta>; monitorId: number; uid: string }): void {
    if (this.closed) return;
    this.ops.push(...ops);
    if (stats) {
      for (const [bucket, d] of stats.hour) merge(this.hour, stats.monitorId, stats.uid, bucket, d);
      for (const [bucket, d] of stats.day) merge(this.day, stats.monitorId, stats.uid, bucket, d);
    }
    this.results++;
    if (this.results >= this.opts.maxQueued) {
      this.opts.onError(new Error(`uptime write queue overflow: dropping ${this.results} queued results`));
      this.reset();
      return;
    }
    if (this.results >= this.opts.maxBatch) this.flush();
    else this.arm();
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.opts.flushMs);
    this.timer.unref();
  }

  private reset(): void {
    this.ops = [];
    this.hour = new Map();
    this.day = new Map();
    this.results = 0;
  }

  /** Write everything queued now (never throws). */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.results === 0 && this.ops.length === 0) return;
    const ops = this.ops;
    const hour = this.hour;
    const day = this.day;
    this.reset();
    if (!this.db.open) return;
    try {
      this.stmts ??= prepare(this.db);
      const s = this.stmts;
      let failed: unknown = null;
      this.db
        .transaction(() => {
          // One bad row (e.g. a monitor purged meanwhile) must not roll back the whole batch:
          // a failing statement only undoes itself.
          for (const op of ops) {
            try {
              op(s);
            } catch (err) {
              failed ??= err;
            }
          }
          for (const { monitorId, uid, bucket, d } of hour.values()) s.statHour.run(uid, monitorId, bucket, ...deltaValues(d));
          for (const { monitorId, uid, bucket, d } of day.values()) s.statDay.run(uid, monitorId, bucket, ...deltaValues(d));
        })
        .immediate();
      if (failed !== null) this.opts.onError(failed);
    } catch (err) {
      this.opts.onError(err);
    }
  }

  close(): void {
    this.flush();
    this.closed = true;
  }
}

interface StatEntry {
  monitorId: number;
  uid: string;
  bucket: number;
  d: StatDelta;
}

function merge(map: Map<string, StatEntry>, monitorId: number, uid: string, bucket: number, d: StatDelta): void {
  const key = `${monitorId}:${uid}:${bucket}`;
  let e = map.get(key);
  if (!e) {
    e = { monitorId, uid, bucket, d: emptyDelta() };
    map.set(key, e);
  }
  mergeDelta(e.d, d);
}

function deltaValues(d: StatDelta): unknown[] {
  return [d.up_ms, d.down_ms, d.pending_ms, d.maint_ms, d.checks, d.failures, d.lat_n, d.lat_sum, d.lat_min, d.lat_max];
}
