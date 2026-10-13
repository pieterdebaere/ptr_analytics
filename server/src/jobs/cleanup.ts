import type { AppContext } from '../context.js';

const DAY = 86_400_000;
/** Initial rows per DELETE; each chunk is its own short write transaction. */
export const CLEANUP_CHUNK = 1000;
const MIN_CHUNK = 100;
const MAX_CHUNK = 5000;
/** Chunk sizes adapt so one DELETE blocks the event loop for about this long. */
const TARGET_CHUNK_MS = 25;

export interface CleanupResult {
  authSessions: number;
  events: number;
  vitals: number;
  sessions: number;
}

/** Pause between chunks: as long as the chunk took (max 100 ms), i.e. at most ~50% of the main thread. */
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, Math.round(ms)))));

/** One cleanup run per context at a time; overlapping calls share the running one. */
const running = new WeakMap<AppContext, Promise<CleanupResult>>();

/**
 * Hourly maintenance: expired login sessions, salts of past days, analytics data older
 * than RETENTION_DAYS (and the analytics sessions that belong to it), rate limiter sweep.
 *
 * Old analytics data is deleted in small chunks, pausing between them,
 * so even the first run after enabling RETENTION_DAYS on years of data never blocks
 * requests for long. Never rejects: errors are logged (the result then is partial).
 */
export function runCleanup(ctx: AppContext): Promise<CleanupResult> {
  const current = running.get(ctx);
  if (current) return current;
  const result: CleanupResult = {
    authSessions: 0,
    events: 0,
    vitals: 0,
    sessions: 0,
  };
  const p = cleanup(ctx, result)
    .catch((err: unknown) => {
      ctx.log.error({ err }, 'cleanup job failed');
      return result;
    })
    .finally(() => running.delete(ctx));
  running.set(ctx, p);
  return p;
}

async function cleanup(c: AppContext, result: CleanupResult): Promise<CleanupResult> {
  const now = c.now();
  result.authSessions = c.authSessions.purgeExpired(now);
  c.salts.purgeOld(now);

  if (c.config.retentionDays > 0) {
    const cutoff = now - c.config.retentionDays * DAY;
    const db = c.db;
    // rowid chunks through the (site_id, ts) indexes, per site
    const delEvents = db.prepare(
      'DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE site_id = ? AND ts < ? LIMIT ?)',
    );
    const delVitals = db.prepare(
      'DELETE FROM vitals WHERE rowid IN (SELECT rowid FROM vitals WHERE site_id = ? AND ts < ? LIMIT ?)',
    );
    // Analytics sessions whose last activity is older than the retention window.
    const delSessions = db.prepare(
      'DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE last_seen_at < ? LIMIT ?)',
    );
    // Random-keyed indexes (sessions) make some deletes far costlier per row than others:
    // adapt the chunk size to the measured time instead of using a fixed row count.
    const drain = async (run: (limit: number) => number, add: (n: number) => void): Promise<void> => {
      let size = CLEANUP_CHUNK;
      for (;;) {
        if (!db.open) return;
        const started = performance.now();
        const n = run(size);
        const ms = performance.now() - started;
        add(n);
        if (n < size) return;
        if (ms > TARGET_CHUNK_MS * 2) size = Math.max(MIN_CHUNK, Math.floor(size / 2));
        else if (ms < TARGET_CHUNK_MS / 2) size = Math.min(MAX_CHUNK, size * 2);
        await pause(ms);
      }
    };
    for (const siteId of c.sites.ids()) {
      await drain(
        (limit) => delEvents.run(siteId, cutoff, limit).changes,
        (n) => (result.events += n),
      );
      await drain(
        (limit) => delVitals.run(siteId, cutoff, limit).changes,
        (n) => (result.vitals += n),
      );
    }
    await drain(
      (limit) => delSessions.run(cutoff, limit).changes,
      (n) => (result.sessions += n),
    );
  }

  c.limits.ingest?.sweep();
  c.limits.loginIp.sweep();
  c.limits.loginEmail.sweep();
  return result;
}
