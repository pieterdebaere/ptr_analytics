import type { AppContext } from '../context.js';
import { drainChunks } from './chunks.js';
import { purgeSiteUptime } from '../uptime/data/purge.js';

/** One purge per context at a time; a request during a run schedules one more run. */
const state = new WeakMap<AppContext, { running: Promise<number>; again: boolean }>();

/**
 * Remove the data of soft-deleted sites (spec 6.2): events, vitals and analytics sessions in
 * small chunks with pauses (the same adaptive chunking as the retention cleanup), then the
 * site row itself, whose cascade is then trivial. Deleting a site with millions of events
 * therefore never blocks the event loop for more than a few tens of milliseconds at a time.
 *
 * Returns the number of site rows removed. Never rejects (errors are logged); overlapping
 * calls share the running purge, and a call during a run makes it run once more afterwards
 * so sites deleted meanwhile are picked up.
 */
export function purgeDeletedSites(ctx: AppContext): Promise<number> {
  const current = state.get(ctx);
  if (current) {
    current.again = true;
    return current.running;
  }
  const entry = { running: Promise.resolve(0), again: false };
  entry.running = (async () => {
    let removed = 0;
    try {
      do {
        entry.again = false;
        removed += await purgeOnce(ctx);
      } while (entry.again && ctx.db.open);
    } catch (err) {
      ctx.log.error({ err }, 'purging deleted sites failed');
    } finally {
      state.delete(ctx);
    }
    return removed;
  })();
  state.set(ctx, entry);
  return entry.running;
}

/** Start a purge in the background (after a site or account deletion), after the response. */
export function schedulePurge(ctx: AppContext): void {
  setImmediate(() => {
    if (ctx.db.open) void purgeDeletedSites(ctx);
  });
}

async function purgeOnce(ctx: AppContext): Promise<number> {
  const db = ctx.db;
  if (!db.open) return 0;
  const ids = ctx.sites.deletedIds();
  if (ids.length === 0) return 0;
  const delEvents = db.prepare('DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE site_id = ? LIMIT ?)');
  const delVitals = db.prepare('DELETE FROM vitals WHERE rowid IN (SELECT rowid FROM vitals WHERE site_id = ? LIMIT ?)');
  const delSessions = db.prepare('DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE site_id = ? LIMIT ?)');
  let removed = 0;
  for (const id of ids) {
    await drainChunks(db, (limit) => delEvents.run(id, limit).changes);
    await drainChunks(db, (limit) => delVitals.run(id, limit).changes);
    await drainChunks(db, (limit) => delSessions.run(id, limit).changes);
    // Uptime monitors reference the site without a cascade (their history is large): purge them first.
    await purgeSiteUptime(ctx, id);
    if (!db.open) return removed;
    // Nothing is left to cascade into; ingest never writes to a deleted site meanwhile.
    if (ctx.sites.removeDeleted(id)) removed++;
  }
  return removed;
}
