import type { AppContext } from '../context.js';
import { drainChunks } from './chunks.js';
import { purgeDeletedSites } from './purge.js';
import { runUptimeCleanup } from '../uptime/data/purge.js';

export { CLEANUP_CHUNK } from './chunks.js';

const DAY = 86_400_000;
const UNVERIFIED_TTL_MS = 7 * DAY;
/** Stripe retries a webhook for up to 3 days; keep processed ids well beyond that. */
const STRIPE_EVENT_TTL_MS = 30 * DAY;

export interface CleanupResult {
  authSessions: number;
  userTokens: number;
  unverifiedUsers: number;
  events: number;
  vitals: number;
  sessions: number;
  /** Soft-deleted sites whose data was purged and whose row was removed. */
  deletedSites: number;
}

/** One cleanup run per context at a time; overlapping calls share the running one. */
const running = new WeakMap<AppContext, Promise<CleanupResult>>();

/**
 * Hourly maintenance: expired login sessions, salts of past days, analytics data older
 * than RETENTION_DAYS (and the analytics sessions that belong to it), the data of deleted
 * sites (see purge.ts), rate limiter sweep.
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
    userTokens: 0,
    unverifiedUsers: 0,
    events: 0,
    vitals: 0,
    sessions: 0,
    deletedSites: 0,
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
  result.userTokens = c.userTokens.purgeExpired(now);
  // Sign-ups never verified within a week are removed (they cannot log in or own sites).
  result.unverifiedUsers = c.users.purgeUnverified(now - UNVERIFIED_TTL_MS);
  c.db.prepare('DELETE FROM stripe_events WHERE received_at < ?').run(now - STRIPE_EVENT_TTL_MS);
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
    const drain = (run: (limit: number) => number, add: (n: number) => void): Promise<void> => drainChunks(db, run, add);
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

  // Sites deleted while the server was down (or by the CLI), or an interrupted purge.
  result.deletedSites = await purgeDeletedSites(c);

  // Uptime: raw heartbeats / stats / events retention and deleted monitors (spec 8.2).
  await runUptimeCleanup(c);

  c.limits.ingest?.sweep();
  c.limits.loginIp.sweep();
  c.limits.loginEmail.sweep();
  c.limits.loginEmailIp.sweep();
  c.limits.signupIp.sweep();
  c.limits.signupIp48.sweep();
  c.limits.signupEmail.sweep();
  c.limits.verifyResend.sweep();
  c.limits.verifyResendDaily.sweep();
  c.limits.forgotIp.sweep();
  c.limits.forgotEmail.sweep();
  c.limits.tokenIp.sweep();
  return result;
}
