// Uptime retention and purge of deleted monitors (docs/SPEC.md §8.2): small chunked deletes with
// pauses (jobs/chunks.ts), never a synchronous cascade over large tables.
import type { AppContext } from '../../context.js';
import type { DB } from '../../db/index.js';
import { drainChunks } from '../../jobs/chunks.js';
import { uptimeRuntime } from '../runtime.js';
import { unlinkMonitor } from './monitors.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const HOURLY_STATS_DAYS = 90;
const FOREVER = Number.MAX_SAFE_INTEGER;

export interface UptimeCleanupResult {
  heartbeats: number;
  stats: number;
  events: number;
  outages: number;
  deletedMonitors: number;
}

type Stmt = { run(params: Record<string, unknown>): { changes: number } };

/** Delete statements for one table keyed by (monitor_id, <time column>), chunked by row count. */
function chunkedDeletes(db: DB): {
  heartbeats: Stmt;
  statHour: Stmt;
  statDay: Stmt;
  events: Stmt;
  outages: Stmt;
} {
  // WITHOUT ROWID tables: delete everything older than the (limit+1)-th oldest row, i.e. at most `limit` rows.
  const byTime = (table: string, col: string): Stmt =>
    db.prepare(
      `DELETE FROM ${table} WHERE monitor_id = @m AND ${col} < MIN(@cut, COALESCE(
         (SELECT ${col} FROM ${table} WHERE monitor_id = @m AND ${col} < @cut ORDER BY ${col} LIMIT 1 OFFSET @lim), @cut))`,
    ) as unknown as Stmt;
  return {
    heartbeats: byTime('heartbeats', 'ts'),
    statHour: byTime('monitor_stats_hour', 'bucket'),
    statDay: byTime('monitor_stats_day', 'bucket'),
    events: db.prepare(
      'DELETE FROM monitor_events WHERE id IN (SELECT id FROM monitor_events WHERE monitor_id = @m AND ts < @cut LIMIT @lim)',
    ) as unknown as Stmt,
    // open outages are kept until they end
    outages: db.prepare(
      `DELETE FROM outages WHERE id IN (SELECT id FROM outages WHERE monitor_id = @m AND started_at < @cut
         AND (ended_at IS NOT NULL OR @cut = ${FOREVER}) LIMIT @lim)`,
    ) as unknown as Stmt,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Remove everything of soft-deleted monitors (and monitors of deleted sites), then their rows. */
export async function purgeDeletedMonitors(ctx: AppContext, siteId?: string): Promise<number> {
  const db = ctx.db;
  if (!db.open) return 0;
  const ids = (
    siteId === undefined
      ? db
          .prepare(
            `SELECT m.id FROM monitors m JOIN sites s ON s.id = m.site_id
             WHERE m.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL ORDER BY m.id`,
          )
          .all()
      : db.prepare('SELECT id FROM monitors WHERE site_id = ? ORDER BY id').all(siteId)
  ) as Array<{ id: number }>;
  if (ids.length === 0) return 0;
  // Stop checking them and write out queued results first (late writes are dropped by the writer).
  const rt = uptimeRuntime(ctx);
  for (const { id } of ids) rt.engine?.monitorChanged(id);
  (rt.processor as { flush?: () => void } | null)?.flush?.();
  const del = chunkedDeletes(db);
  let removed = 0;
  for (const { id } of ids) {
    for (const stmt of [del.heartbeats, del.statHour, del.statDay, del.events, del.outages]) {
      await drainChunks(db, (limit) => stmt.run({ m: id, cut: FOREVER, lim: limit }).changes);
    }
    if (!db.open) return removed;
    db.transaction(() => {
      db.prepare('UPDATE monitors SET parent_id = NULL WHERE parent_id = ?').run(id);
      unlinkMonitor(db, id);
      db.prepare('DELETE FROM monitor_state WHERE monitor_id = ?').run(id);
      db.prepare('DELETE FROM monitor_tls WHERE monitor_id = ?').run(id);
      db.prepare('DELETE FROM expiry_notices WHERE monitor_id = ?').run(id);
      // late writes of a check that was in flight during the deletion
      db.prepare('DELETE FROM heartbeats WHERE monitor_id = ?').run(id);
      db.prepare('DELETE FROM monitor_stats_hour WHERE monitor_id = ?').run(id);
      db.prepare('DELETE FROM monitor_stats_day WHERE monitor_id = ?').run(id);
      db.prepare('DELETE FROM monitor_events WHERE monitor_id = ?').run(id);
      db.prepare('DELETE FROM outages WHERE monitor_id = ?').run(id);
      if (db.prepare('DELETE FROM monitors WHERE id = ?').run(id).changes > 0) removed++;
    })();
    await sleep(1);
  }
  return removed;
}

/**
 * Called by the site purge (jobs/purge.ts) before a soft-deleted site row is removed: its monitors
 * reference it without a cascade (their data is large), so they go first. Status pages cascade.
 */
export async function purgeSiteUptime(ctx: AppContext, siteId: string): Promise<void> {
  const db = ctx.db;
  if (!db.open) return;
  const now = ctx.now();
  db.prepare('UPDATE monitors SET deleted_at = COALESCE(deleted_at, ?), active = 0, push_token_hash = NULL, public_id = NULL WHERE site_id = ?').run(
    now,
    siteId,
  );
  await purgeDeletedMonitors(ctx, siteId);
}

/** Hourly retention: raw beats, hourly stats (90 d), daily stats / events / outages (UPTIME_RETENTION_DAYS). */
export async function uptimeRetention(ctx: AppContext, result: UptimeCleanupResult): Promise<void> {
  const db = ctx.db;
  if (!db.open) return;
  const now = ctx.now();
  const cfg = ctx.config.uptime;
  const rawCut = now - cfg.rawRetentionHours * HOUR;
  const hourCut = now - HOURLY_STATS_DAYS * DAY;
  const longCut = cfg.retentionDays > 0 ? now - cfg.retentionDays * DAY : null;
  const del = chunkedDeletes(db);
  const ids = (db.prepare('SELECT id FROM monitors ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);
  for (const id of ids) {
    if (!db.open) return;
    await drainChunks(db, (limit) => del.heartbeats.run({ m: id, cut: rawCut, lim: limit }).changes, (n) => (result.heartbeats += n));
    await drainChunks(db, (limit) => del.statHour.run({ m: id, cut: hourCut, lim: limit }).changes, (n) => (result.stats += n));
    if (longCut !== null) {
      await drainChunks(db, (limit) => del.statDay.run({ m: id, cut: longCut, lim: limit }).changes, (n) => (result.stats += n));
      await drainChunks(db, (limit) => del.events.run({ m: id, cut: longCut, lim: limit }).changes, (n) => (result.events += n));
      await drainChunks(db, (limit) => del.outages.run({ m: id, cut: longCut, lim: limit }).changes, (n) => (result.outages += n));
    }
  }
  if (longCut !== null) {
    db.prepare('DELETE FROM expiry_notices WHERE sent_at < ?').run(longCut);
  }
  db.prepare('DELETE FROM domain_expiry WHERE checked_at < ?').run(now - 30 * DAY);
}

const running = new WeakMap<AppContext, Promise<UptimeCleanupResult>>();

/** Hourly uptime cleanup (retention + deleted monitors). Never rejects; overlapping calls share a run. */
export function runUptimeCleanup(ctx: AppContext): Promise<UptimeCleanupResult> {
  const current = running.get(ctx);
  if (current) return current;
  const result: UptimeCleanupResult = { heartbeats: 0, stats: 0, events: 0, outages: 0, deletedMonitors: 0 };
  const p = (async () => {
    result.deletedMonitors = await purgeDeletedMonitors(ctx);
    await uptimeRetention(ctx, result);
    return result;
  })()
    .catch((err: unknown) => {
      ctx.log.error({ err }, 'uptime cleanup failed');
      return result;
    })
    .finally(() => running.delete(ctx));
  running.set(ctx, p);
  return p;
}

/** Purge deleted monitors in the background (after a deletion), after the response. */
export function schedulePurgeMonitors(ctx: AppContext): void {
  setImmediate(() => {
    if (!ctx.db.open) return;
    void purgeDeletedMonitors(ctx).catch((err: unknown) => ctx.log.error({ err }, 'purging deleted monitors failed'));
  });
}
