import type { DB } from '../db/index.js';
import { generateSiteId } from '../lib/ids.js';

export interface Site {
  id: string;
  name: string;
  domains: string[];
  createdAt: number;
  /** Owning member, or null for operator sites (created by an admin). */
  ownerId: number | null;
  /** Over the owner's allowance: ingest drops its events (hosted mode). */
  suspended: boolean;
}

interface SiteRow {
  id: string;
  name: string;
  domains: string;
  created_at: number;
  owner_id: number | null;
  suspended: number;
}

function parseDomains(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

const toSite = (r: SiteRow): Site => ({
  id: r.id,
  name: r.name,
  domains: parseDomains(r.domains),
  createdAt: r.created_at,
  ownerId: r.owner_id,
  suspended: r.suspended === 1,
});

const COLUMNS = 'id, name, domains, created_at, owner_id, suspended';
/** Soft-deleted sites (v5) are invisible everywhere until the purge job removes them. */
const LIVE = 'deleted_at IS NULL';

/** Sites that were deleted or whose suspension may have changed (allowance recomputed). */
export type SiteChange = { kind: 'deleted'; siteId: string; ownerId: number | null } | { kind: 'suspension'; ownerId: number };
export type SiteChangeListener = (change: SiteChange) => void;

export class SiteRepo {
  private readonly listeners = new Set<SiteChangeListener>();

  constructor(private readonly db: DB) {}

  /**
   * Subscribe to site deletions and suspension changes (the uptime engine reschedules at once,
   * public status caches are dropped). Listeners run on the next tick, i.e. after the surrounding
   * transaction committed. Returns the unsubscribe function.
   */
  onChange(fn: SiteChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(change: SiteChange): void {
    if (this.listeners.size === 0) return;
    setImmediate(() => {
      for (const fn of this.listeners) {
        try {
          fn(change);
        } catch {
          // a listener must never break the change itself
        }
      }
    });
  }

  list(): Site[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM sites WHERE ${LIVE} ORDER BY name COLLATE NOCASE, id`).all() as SiteRow[]).map(
      toSite,
    );
  }

  listByOwner(ownerId: number): Site[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM sites WHERE owner_id = ? AND ${LIVE} ORDER BY name COLLATE NOCASE, id`)
        .all(ownerId) as SiteRow[]
    ).map(toSite);
  }

  countByOwner(ownerId: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM sites WHERE owner_id = ? AND ${LIVE}`).get(ownerId) as { n: number }).n;
  }

  byId(id: string): Site | null {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM sites WHERE id = ? AND ${LIVE}`).get(id) as SiteRow | undefined;
    return r ? toSite(r) : null;
  }

  ids(): string[] {
    return (this.db.prepare(`SELECT id FROM sites WHERE ${LIVE}`).all() as Array<{ id: string }>).map((r) => r.id);
  }

  /** Soft-deleted sites still waiting for their data to be purged (oldest first). */
  deletedIds(): string[] {
    return (
      this.db.prepare('SELECT id FROM sites WHERE deleted_at IS NOT NULL ORDER BY deleted_at, rowid').all() as Array<{ id: string }>
    ).map((r) => r.id);
  }

  create(name: string, domains: string[], now: number, ownerId: number | null = null): Site {
    const insert = this.db.prepare('INSERT OR IGNORE INTO sites (id, name, domains, created_at, owner_id) VALUES (?, ?, ?, ?, ?)');
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = generateSiteId();
      if (insert.run(id, name, JSON.stringify(domains), now, ownerId).changes === 1) {
        return { id, name, domains, createdAt: now, ownerId, suspended: false };
      }
    }
    throw new Error('could not allocate a unique site id');
  }

  update(id: string, patch: { name?: string; domains?: string[] }): Site | null {
    const site = this.byId(id);
    if (!site) return null;
    const name = patch.name ?? site.name;
    const domains = patch.domains ?? site.domains;
    this.db.prepare(`UPDATE sites SET name = ?, domains = ? WHERE id = ? AND ${LIVE}`).run(name, JSON.stringify(domains), id);
    return { ...site, name, domains };
  }

  /**
   * Soft delete: the site disappears immediately (access checks, lists, stats, ingest); its
   * analytics data is removed in the background by `purgeDeletedSites()`, which deletes the
   * row last. Never a synchronous cascade over millions of rows on the main thread.
   */
  delete(id: string, now: number): boolean {
    const ownerId = (this.db.prepare(`SELECT owner_id FROM sites WHERE id = ? AND ${LIVE}`).get(id) as { owner_id: number | null } | undefined)?.owner_id ?? null;
    const deleted = this.db.prepare(`UPDATE sites SET deleted_at = ?, suspended = 0 WHERE id = ? AND ${LIVE}`).run(now, id).changes > 0;
    // Uptime monitors follow the site (spec 8.1): hidden and unscheduled at once, purged with the site.
    if (deleted) {
      this.db
        .prepare('UPDATE monitors SET deleted_at = ?, active = 0, push_token_hash = NULL, public_id = NULL WHERE site_id = ? AND deleted_at IS NULL')
        .run(now, id);
      this.emit({ kind: 'deleted', siteId: id, ownerId });
    }
    return deleted;
  }

  /** Remove the row of a soft-deleted site whose data has been purged. */
  removeDeleted(id: string): boolean {
    return this.db.prepare('DELETE FROM sites WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes > 0;
  }

  /**
   * Keep the owner's `allowance` oldest sites active and suspend the newer ones (null = no
   * limit). Nothing is deleted.
   */
  applyAllowance(ownerId: number, allowance: number | null): boolean {
    const before = this.suspendedIds(ownerId);
    if (allowance === null) {
      this.db.prepare(`UPDATE sites SET suspended = 0 WHERE owner_id = ? AND suspended <> 0 AND ${LIVE}`).run(ownerId);
    } else {
      this.db
        .prepare(
          `UPDATE sites SET suspended = CASE WHEN rowid IN (
              SELECT rowid FROM sites WHERE owner_id = ? AND ${LIVE} ORDER BY created_at, rowid LIMIT ?
            ) THEN 0 ELSE 1 END
           WHERE owner_id = ? AND ${LIVE}`,
        )
        .run(ownerId, Math.max(0, allowance), ownerId);
    }
    const changed = this.suspendedIds(ownerId) !== before;
    if (changed) this.emit({ kind: 'suspension', ownerId });
    return changed;
  }

  private suspendedIds(ownerId: number): string {
    return (
      this.db.prepare(`SELECT id FROM sites WHERE owner_id = ? AND suspended = 1 AND ${LIVE} ORDER BY id`).all(ownerId) as Array<{ id: string }>
    )
      .map((r) => r.id)
      .join(',');
  }
}
