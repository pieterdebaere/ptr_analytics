// Maintenance windows repository. Maintenances belong to a user (`owner_id`, NULL = operator).
import type { DB } from '../../db/index.js';
import { generateSiteId } from '../../lib/ids.js';
import type { DayOfMonth, MaintenanceDef, Strategy } from '../maintenance/windows.js';
import { chunks } from './monitors.js';

export const MAINTENANCE_UID_RE = /^[a-z0-9]{12}$/;

export interface MaintenanceRecord extends MaintenanceDef {
  id: number;
  uid: string;
  ownerId: number | null;
  title: string;
  description: string | null;
  notifiedStart: number | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: number;
  uid: string;
  owner_id: number | null;
  title: string;
  description: string | null;
  active: number;
  strategy: Strategy;
  tz: string;
  starts_at: number | null;
  ends_at: number | null;
  time_start: string | null;
  time_end: string | null;
  weekdays: string | null;
  days_of_month: string | null;
  interval_days: number | null;
  cron: string | null;
  duration_s: number | null;
  notified_start: number | null;
  created_at: number;
  updated_at: number;
}

function parseArray(s: string | null): unknown[] {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const toRecord = (r: Row): MaintenanceRecord => ({
  id: r.id,
  uid: r.uid,
  ownerId: r.owner_id,
  title: r.title,
  description: r.description,
  active: r.active === 1,
  strategy: r.strategy,
  tz: r.tz,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  timeStart: r.time_start,
  timeEnd: r.time_end,
  weekdays: parseArray(r.weekdays).filter((x): x is number => Number.isInteger(x)),
  daysOfMonth: parseArray(r.days_of_month).filter((x): x is DayOfMonth => x === 'L' || Number.isInteger(x)),
  intervalDays: r.interval_days,
  cron: r.cron,
  durationS: r.duration_s,
  notifiedStart: r.notified_start,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type MaintenanceInput = Omit<MaintenanceRecord, 'id' | 'uid' | 'ownerId' | 'notifiedStart' | 'createdAt' | 'updatedAt'>;

export class MaintenanceRepo {
  constructor(private readonly db: DB) {}

  list(ownerId: number | null | 'all'): MaintenanceRecord[] {
    const rows =
      ownerId === 'all'
        ? (this.db.prepare('SELECT * FROM maintenances ORDER BY id DESC').all() as Row[])
        : (this.db.prepare('SELECT * FROM maintenances WHERE owner_id IS ? ORDER BY id DESC').all(ownerId) as Row[]);
    return rows.map(toRecord);
  }

  /** Paused maintenances whose window start was announced (the engine still owes a maint_end). */
  listPausedAnnounced(): MaintenanceRecord[] {
    return (this.db.prepare('SELECT * FROM maintenances WHERE active = 0 AND notified_start IS NOT NULL ORDER BY id').all() as Row[]).map(toRecord);
  }

  /** Active maintenances with at least one monitor (engine cache). */
  listActive(): MaintenanceRecord[] {
    return (this.db.prepare('SELECT * FROM maintenances WHERE active = 1 ORDER BY id').all() as Row[]).map(toRecord);
  }

  byUid(uid: string): MaintenanceRecord | null {
    if (!MAINTENANCE_UID_RE.test(uid)) return null;
    const r = this.db.prepare('SELECT * FROM maintenances WHERE uid = ?').get(uid) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  byIds(ids: readonly number[]): MaintenanceRecord[] {
    const out: MaintenanceRecord[] = [];
    for (const chunk of chunks(ids, 500)) {
      if (chunk.length === 0) continue;
      out.push(...(this.db.prepare(`SELECT * FROM maintenances WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Row[]).map(toRecord));
    }
    return out;
  }

  countByOwner(ownerId: number | null): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM maintenances WHERE owner_id IS ?').get(ownerId) as { n: number }).n;
  }

  countCronByOwner(ownerId: number | null): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM maintenances WHERE owner_id IS ? AND strategy = 'cron'`).get(ownerId) as { n: number }).n;
  }

  create(ownerId: number | null, m: MaintenanceInput, now: number): MaintenanceRecord {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO maintenances (uid, owner_id, title, description, active, strategy, tz, starts_at, ends_at, time_start,
         time_end, weekdays, days_of_month, interval_days, cron, duration_s, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      const uid = generateSiteId();
      const res = stmt.run(uid, ownerId, ...values(m), now, now);
      if (res.changes === 1) return this.byUid(uid) as MaintenanceRecord;
    }
    throw new Error('could not allocate a unique maintenance uid');
  }

  update(id: number, m: MaintenanceInput, now: number): void {
    this.db
      .prepare(
        `UPDATE maintenances SET title = ?, description = ?, active = ?, strategy = ?, tz = ?, starts_at = ?, ends_at = ?,
           time_start = ?, time_end = ?, weekdays = ?, days_of_month = ?, interval_days = ?, cron = ?, duration_s = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(...values(m), now, id);
  }

  setActive(id: number, active: boolean, now: number): void {
    this.db.prepare('UPDATE maintenances SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, now, id);
  }

  setNotifiedStart(id: number, start: number | null): void {
    this.db.prepare('UPDATE maintenances SET notified_start = ? WHERE id = ?').run(start, id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM maintenances WHERE id = ?').run(id);
  }

  // ---- links ----

  monitorIds(maintenanceId: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT mm.monitor_id FROM maintenance_monitors mm JOIN monitors m ON m.id = mm.monitor_id
           WHERE mm.maintenance_id = ? AND m.deleted_at IS NULL ORDER BY mm.monitor_id`,
        )
        .all(maintenanceId) as Array<{ monitor_id: number }>
    ).map((r) => r.monitor_id);
  }

  /** maintenance id -> monitor uids, for API output. */
  monitorUids(ids: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    for (const chunk of chunks(ids, 500)) {
      if (chunk.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT mm.maintenance_id AS mid, m.uid FROM maintenance_monitors mm JOIN monitors m ON m.id = mm.monitor_id
           JOIN sites s ON s.id = m.site_id
           WHERE m.deleted_at IS NULL AND s.deleted_at IS NULL AND mm.maintenance_id IN (${chunk.map(() => '?').join(',')})
           ORDER BY m.id`,
        )
        .all(...chunk) as Array<{ mid: number; uid: string }>;
      for (const r of rows) out.set(r.mid, [...(out.get(r.mid) ?? []), r.uid]);
    }
    return out;
  }

  statusPageUids(ids: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    for (const chunk of chunks(ids, 500)) {
      if (chunk.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT ms.maintenance_id AS mid, p.uid FROM maintenance_status_pages ms JOIN status_pages p ON p.id = ms.status_page_id
           WHERE p.deleted_at IS NULL AND ms.maintenance_id IN (${chunk.map(() => '?').join(',')}) ORDER BY p.id`,
        )
        .all(...chunk) as Array<{ mid: number; uid: string }>;
      for (const r of rows) out.set(r.mid, [...(out.get(r.mid) ?? []), r.uid]);
    }
    return out;
  }

  /** Status pages by uid (live) with the owner of their site, for link validation. */
  statusPagesByUid(uids: readonly string[]): Array<{ id: number; uid: string; ownerId: number | null }> {
    const out: Array<{ id: number; uid: string; ownerId: number | null }> = [];
    for (const chunk of chunks(uids, 500)) {
      if (chunk.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT p.id, p.uid, s.owner_id FROM status_pages p JOIN sites s ON s.id = p.site_id
           WHERE p.deleted_at IS NULL AND s.deleted_at IS NULL AND p.uid IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as Array<{ id: number; uid: string; owner_id: number | null }>;
      out.push(...rows.map((r) => ({ id: r.id, uid: r.uid, ownerId: r.owner_id })));
    }
    return out;
  }

  setMonitors(maintenanceId: number, monitorIds: readonly number[]): void {
    this.db.prepare('DELETE FROM maintenance_monitors WHERE maintenance_id = ?').run(maintenanceId);
    const ins = this.db.prepare('INSERT OR IGNORE INTO maintenance_monitors (maintenance_id, monitor_id) VALUES (?, ?)');
    for (const id of monitorIds) ins.run(maintenanceId, id);
  }

  setStatusPages(maintenanceId: number, pageIds: readonly number[]): void {
    this.db.prepare('DELETE FROM maintenance_status_pages WHERE maintenance_id = ?').run(maintenanceId);
    const ins = this.db.prepare('INSERT OR IGNORE INTO maintenance_status_pages (maintenance_id, status_page_id) VALUES (?, ?)');
    for (const id of pageIds) ins.run(maintenanceId, id);
  }

  /** maintenance id -> monitor ids for every link (engine cache). */
  allLinks(): Array<{ maintenanceId: number; monitorId: number }> {
    return (this.db.prepare('SELECT maintenance_id, monitor_id FROM maintenance_monitors').all() as Array<{ maintenance_id: number; monitor_id: number }>).map(
      (r) => ({ maintenanceId: r.maintenance_id, monitorId: r.monitor_id }),
    );
  }

  /** Maintenances linked to any of these monitors (active only). */
  activeForMonitors(monitorIds: readonly number[]): Array<{ monitorId: number; m: MaintenanceRecord }> {
    const out: Array<{ monitorId: number; m: MaintenanceRecord }> = [];
    for (const chunk of chunks(monitorIds, 500)) {
      if (chunk.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT mm.monitor_id AS link_monitor_id, mt.* FROM maintenance_monitors mm JOIN maintenances mt ON mt.id = mm.maintenance_id
           WHERE mt.active = 1 AND mm.monitor_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as Array<Row & { link_monitor_id: number }>;
      for (const r of rows) out.push({ monitorId: r.link_monitor_id, m: toRecord(r) });
    }
    return out;
  }
}

function values(m: MaintenanceInput): unknown[] {
  return [
    m.title,
    m.description,
    m.active ? 1 : 0,
    m.strategy,
    m.tz,
    m.startsAt,
    m.endsAt,
    m.timeStart,
    m.timeEnd,
    m.weekdays.length > 0 ? JSON.stringify(m.weekdays) : null,
    m.daysOfMonth.length > 0 ? JSON.stringify(m.daysOfMonth) : null,
    m.intervalDays,
    m.cron,
    m.durationS,
  ];
}
