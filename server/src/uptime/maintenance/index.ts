// Maintenance evaluation: a monitor is under maintenance when it, or any ancestor group, is linked
// to an active maintenance whose current window contains `now` (ANALYSIS §6.3).
import type { DB } from '../../db/index.js';
import { MaintenanceRepo, type MaintenanceRecord } from '../data/maintenance.js';
import { currentWindow, maintenanceStatus, nextWindow, type Window } from './windows.js';

export { currentWindow, maintenanceStatus, nextWindow } from './windows.js';
export type { MaintenanceDef, MaintenanceStatus, Window } from './windows.js';

const MAX_DEPTH = 32;
/** Window lookups are cheap but run for every check: cache them briefly. */
const CACHE_MS = 5_000;

/** Monitor id and its ancestors (group parents), cycle- and depth-safe. */
export function withAncestors(id: number, parentOf: (id: number) => number | null | undefined): number[] {
  const out = [id];
  const seen = new Set(out);
  let cur: number | null | undefined = parentOf(id);
  while (cur !== null && cur !== undefined && !seen.has(cur) && out.length < MAX_DEPTH) {
    out.push(cur);
    seen.add(cur);
    cur = parentOf(cur);
  }
  return out;
}

/** In-memory index for the engine: reloaded on changes and periodically. */
export class MaintenanceIndex {
  private byMonitor = new Map<number, MaintenanceRecord[]>();
  private all: MaintenanceRecord[] = [];
  private readonly cache = new Map<number, { at: number; window: Window | null }>();

  constructor(private readonly repo: MaintenanceRepo) {}

  reload(): void {
    const active = this.repo.listActive();
    const byId = new Map(active.map((m) => [m.id, m]));
    const byMonitor = new Map<number, MaintenanceRecord[]>();
    for (const link of this.repo.allLinks()) {
      const m = byId.get(link.maintenanceId);
      if (!m) continue;
      const list = byMonitor.get(link.monitorId) ?? [];
      list.push(m);
      byMonitor.set(link.monitorId, list);
    }
    this.all = active;
    this.byMonitor = byMonitor;
    this.cache.clear();
  }

  /** Active maintenances (for start/end notifications). */
  active(): readonly MaintenanceRecord[] {
    return this.all;
  }

  window(m: MaintenanceRecord, now: number): Window | null {
    const c = this.cache.get(m.id);
    if (c && now >= c.at && now - c.at < CACHE_MS && (c.window === null || now < c.window.end)) return c.window;
    const window = currentWindow(m, now);
    this.cache.set(m.id, { at: now, window });
    return window;
  }

  isUnderMaintenance(monitorId: number, now: number, parentOf: (id: number) => number | null | undefined): boolean {
    for (const id of withAncestors(monitorId, parentOf)) {
      for (const m of this.byMonitor.get(id) ?? []) if (this.window(m, now)) return true;
    }
    return false;
  }
}

/** Standalone check against the database (API, status pages): monitor or any ancestor in a window. */
export function isUnderMaintenance(db: DB, monitorId: number, now: number): boolean {
  return underMaintenance(db, [monitorId], now).has(monitorId);
}

/** The subset of `monitorIds` currently under maintenance (including through ancestor groups). */
export function underMaintenance(db: DB, monitorIds: readonly number[], now: number): Set<number> {
  const out = new Set<number>();
  if (monitorIds.length === 0) return out;
  const parents = new Map(
    (db.prepare('SELECT id, parent_id FROM monitors WHERE deleted_at IS NULL').all() as Array<{ id: number; parent_id: number | null }>).map((r) => [
      r.id,
      r.parent_id,
    ]),
  );
  const chains = monitorIds.map((id) => ({ id, chain: withAncestors(id, (x) => parents.get(x)) }));
  const all = [...new Set(chains.flatMap((c) => c.chain))];
  const repo = new MaintenanceRepo(db);
  const inWindow = new Set<number>();
  const decided = new Map<number, boolean>();
  for (const { monitorId, m } of repo.activeForMonitors(all)) {
    let open = decided.get(m.id);
    if (open === undefined) {
      open = currentWindow(m, now) !== null;
      decided.set(m.id, open);
    }
    if (open) inWindow.add(monitorId);
  }
  for (const c of chains) if (c.chain.some((id) => inWindow.has(id))) out.add(c.id);
  return out;
}

/** Computed status + next/current window of a maintenance (API, status pages). */
export function maintenanceInfo(m: MaintenanceRecord, now: number): { status: ReturnType<typeof maintenanceStatus>; nextWindow: Window | null } {
  const status = maintenanceStatus(m, now);
  const w = nextWindow(m, now);
  return { status, nextWindow: w && Number.isFinite(w.end) ? w : null };
}
