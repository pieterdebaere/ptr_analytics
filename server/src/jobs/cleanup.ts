import type { AppContext } from '../context.js';

const DAY = 86_400_000;

export interface CleanupResult {
  authSessions: number;
  events: number;
  vitals: number;
  sessions: number;
}

/**
 * Hourly maintenance: expired login sessions, salts of past days, analytics data older
 * than RETENTION_DAYS (and the analytics sessions that belong to it), rate limiter sweep.
 */
export function runCleanup(ctx: AppContext): CleanupResult {
  const now = ctx.now();
  const result: CleanupResult = { authSessions: 0, events: 0, vitals: 0, sessions: 0 };
  result.authSessions = ctx.authSessions.purgeExpired(now);
  ctx.salts.purgeOld(now);

  if (ctx.config.retentionDays > 0) {
    const cutoff = now - ctx.config.retentionDays * DAY;
    const delEvents = ctx.db.prepare('DELETE FROM events WHERE site_id = ? AND ts < ?');
    const delVitals = ctx.db.prepare('DELETE FROM vitals WHERE site_id = ? AND ts < ?');
    // Per site so the (site_id, ts) indexes are used; one short transaction per site.
    for (const siteId of ctx.sites.ids()) {
      ctx.db.transaction(() => {
        result.events += delEvents.run(siteId, cutoff).changes;
        result.vitals += delVitals.run(siteId, cutoff).changes;
      })();
    }
    // Analytics sessions whose last activity is older than the retention window.
    result.sessions = ctx.db.prepare('DELETE FROM sessions WHERE last_seen_at < ?').run(cutoff).changes;
  }

  ctx.limits.ingest?.sweep();
  ctx.limits.loginIp.sweep();
  ctx.limits.loginEmail.sweep();
  return result;
}
