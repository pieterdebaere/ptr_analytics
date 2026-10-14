// Read-only queries over the monitor tables written by the uptime engine (column contract:
// uptime/schema/core.ts). Used by public status pages, badges and /metrics. Never writes.
import type { DB } from '../../db/index.js';
import { addDays, localDateOf, startOfLocalDay } from '../../lib/time.js';
import { MaintenanceRepo } from '../data/maintenance.js';
import { currentWindow, nextWindow } from '../maintenance/index.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface MonitorInfo {
  id: number;
  uid: string;
  siteId: string;
  siteName: string;
  siteSuspended: boolean;
  name: string;
  type: string;
  active: boolean;
  config: string;
  publicId: string | null;
  /** -1 unknown, 0 down, 1 up, 2 pending, 3 maintenance (monitor_state; -1 without a row). */
  status: number;
  lastCheckAt: number | null;
  lastChangeAt: number | null;
  latencyMs: number | null;
}

interface MonitorRow {
  id: number;
  uid: string;
  site_id: string;
  site_name: string;
  suspended: number;
  name: string;
  type: string;
  active: number;
  config: string;
  public_id: string | null;
  status: number;
  last_check_at: number | null;
  last_change_at: number | null;
  last_latency_ms: number | null;
}

const toInfo = (r: MonitorRow): MonitorInfo => ({
  id: r.id,
  uid: r.uid,
  siteId: r.site_id,
  siteName: r.site_name,
  siteSuspended: r.suspended === 1,
  name: r.name,
  type: r.type,
  active: r.active === 1,
  config: r.config,
  publicId: r.public_id,
  status: r.status,
  lastCheckAt: r.last_check_at,
  lastChangeAt: r.last_change_at,
  latencyMs: r.last_latency_ms,
});

/** Live monitors of live sites only (soft-deleted monitors/sites are invisible). */
const MONITOR_SELECT = `
  SELECT m.id, m.uid, m.site_id, si.name AS site_name, si.suspended, m.name, m.type, m.active, m.config, m.public_id,
         COALESCE(st.status, -1) AS status, st.last_check_at, st.last_change_at, st.last_latency_ms
  FROM monitors m
  JOIN sites si ON si.id = m.site_id AND si.deleted_at IS NULL
  LEFT JOIN monitor_state st ON st.monitor_id = m.id
  WHERE m.deleted_at IS NULL`;

export function monitorsForSites(db: DB, siteIds: readonly string[]): MonitorInfo[] {
  if (siteIds.length === 0) return [];
  return (
    db
      .prepare(`${MONITOR_SELECT} AND m.site_id IN (SELECT value FROM json_each(?)) ORDER BY m.site_id, m.position, m.id`)
      .all(JSON.stringify(siteIds)) as MonitorRow[]
  ).map(toInfo);
}

export function monitorsByIds(db: DB, ids: readonly number[]): Map<number, MonitorInfo> {
  const out = new Map<number, MonitorInfo>();
  if (ids.length === 0) return out;
  const rows = db.prepare(`${MONITOR_SELECT} AND m.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as MonitorRow[];
  for (const r of rows) out.set(r.id, toInfo(r));
  return out;
}

/** Id of the live monitor with this badge id (cheap validity check for cached badges). */
export function monitorIdByPublicId(db: DB, publicId: string): number | null {
  const r = db
    .prepare(
      `SELECT m.id FROM monitors m JOIN sites si ON si.id = m.site_id AND si.deleted_at IS NULL
       WHERE m.public_id = ? AND m.deleted_at IS NULL`,
    )
    .get(publicId) as { id: number } | undefined;
  return r?.id ?? null;
}

export function monitorByPublicId(db: DB, publicId: string): MonitorInfo | null {
  const r = db.prepare(`${MONITOR_SELECT} AND m.public_id = ?`).get(publicId) as MonitorRow | undefined;
  return r ? toInfo(r) : null;
}

/** Monitors of one site by uid (validation of status-page sections). */
export function monitorIdsByUid(db: DB, siteId: string, uids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (uids.length === 0) return out;
  const rows = db
    .prepare('SELECT id, uid FROM monitors WHERE site_id = ? AND deleted_at IS NULL AND uid IN (SELECT value FROM json_each(?))')
    .all(siteId, JSON.stringify(uids)) as Array<{ id: number; uid: string }>;
  for (const r of rows) out.set(r.uid, r.id);
  return out;
}

/** Time-weighted uptime since `since` from the hourly aggregates: up / (up + down + pending). */
export function uptimeRatios(db: DB, ids: readonly number[], since: number): Map<number, number | null> {
  const out = new Map<number, number | null>();
  for (const id of ids) out.set(id, null);
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT monitor_id, SUM(up_ms) AS up, SUM(down_ms) AS down, SUM(pending_ms) AS pending
       FROM monitor_stats_hour WHERE monitor_id IN (SELECT value FROM json_each(?)) AND bucket >= ?
       GROUP BY monitor_id`,
    )
    .all(JSON.stringify(ids), Math.floor(since / HOUR) * HOUR) as Array<{ monitor_id: number; up: number; down: number; pending: number }>;
  for (const r of rows) {
    const total = r.up + r.down + r.pending;
    out.set(r.monitor_id, total > 0 ? r.up / total : null);
  }
  return out;
}

/** Average latency (ms) of UP checks since `since`. */
export function avgLatency(db: DB, id: number, since: number): number | null {
  const r = db
    .prepare('SELECT SUM(lat_sum) AS s, SUM(lat_n) AS n FROM monitor_stats_hour WHERE monitor_id = ? AND bucket >= ?')
    .get(id, Math.floor(since / HOUR) * HOUR) as { s: number | null; n: number | null };
  return r.n ? Math.round((r.s ?? 0) / r.n) : null;
}

export interface DayBar {
  /** Start of the local day (ms). */
  t: number;
  upRatio: number | null;
  maintenance: boolean;
}

/**
 * Daily bars over the last `days` local days (in `tz`, today included) from the hourly
 * aggregates, plus the uptime over the whole range.
 */
export function dailyBars(
  db: DB,
  ids: readonly number[],
  tz: string,
  days: number,
  now: number,
): Map<number, { bars: DayBar[]; uptime: number | null }> {
  const today = localDateOf(now, tz);
  const starts: number[] = [];
  for (let i = 0; i <= days; i++) starts.push(startOfLocalDay(addDays(today, i - days + 1), tz));
  const from = starts[0] as number;
  const acc = new Map<number, Array<{ up: number; bad: number; maint: number }>>();
  for (const id of ids) acc.set(id, Array.from({ length: days }, () => ({ up: 0, bad: 0, maint: 0 })));
  if (ids.length > 0) {
    const rows = db
      .prepare(
        `SELECT monitor_id, bucket, up_ms, down_ms, pending_ms, maint_ms FROM monitor_stats_hour
         WHERE monitor_id IN (SELECT value FROM json_each(?)) AND bucket >= ? AND bucket < ?`,
      )
      .all(JSON.stringify(ids), Math.floor(from / HOUR) * HOUR, starts[days] as number) as Array<{
      monitor_id: number;
      bucket: number;
      up_ms: number;
      down_ms: number;
      pending_ms: number;
      maint_ms: number;
    }>;
    for (const r of rows) {
      // Index of the local day containing the bucket start (binary search).
      let lo = 0;
      let hi = days - 1;
      if (r.bucket < from) continue;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] as number) <= r.bucket) lo = mid;
        else hi = mid - 1;
      }
      const cell = acc.get(r.monitor_id)?.[lo];
      if (!cell) continue;
      cell.up += r.up_ms;
      cell.bad += r.down_ms + r.pending_ms;
      cell.maint += r.maint_ms;
    }
  }
  const out = new Map<number, { bars: DayBar[]; uptime: number | null }>();
  for (const [id, cells] of acc) {
    let up = 0;
    let total = 0;
    const bars = cells.map((c, i) => {
      up += c.up;
      total += c.up + c.bad;
      return { t: starts[i] as number, upRatio: c.up + c.bad > 0 ? c.up / (c.up + c.bad) : null, maintenance: c.maint > 0 };
    });
    out.set(id, { bars, uptime: total > 0 ? up / total : null });
  }
  return out;
}

/** Days until the certificate expires (floor), from monitor_tls. */
export function certDaysLeft(db: DB, ids: readonly number[], now: number): Map<number, number> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare('SELECT monitor_id, not_after FROM monitor_tls WHERE not_after IS NOT NULL AND monitor_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)) as Array<{ monitor_id: number; not_after: number }>;
  for (const r of rows) out.set(r.monitor_id, Math.floor((r.not_after - now) / DAY));
  return out;
}

export interface TagInfo {
  name: string;
  color: string;
  value: string;
}

export function tagsFor(db: DB, ids: readonly number[]): Map<number, TagInfo[]> {
  const out = new Map<number, TagInfo[]>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT mt.monitor_id, t.name, t.color, mt.value FROM monitor_tags mt JOIN tags t ON t.id = mt.tag_id
       WHERE mt.monitor_id IN (SELECT value FROM json_each(?)) ORDER BY t.name, mt.value`,
    )
    .all(JSON.stringify(ids)) as Array<{ monitor_id: number; name: string; color: string; value: string }>;
  for (const r of rows) {
    const list = out.get(r.monitor_id) ?? [];
    list.push({ name: r.name, color: r.color, value: r.value });
    out.set(r.monitor_id, list);
  }
  return out;
}

/**
 * Public link for a monitor ("show URL"): only an http(s) `url` from its configuration,
 * reduced to origin + path — credentials, query string (tokens, API keys) and fragment are
 * never published. Anything else (hosts, ports, DNS names, connection strings) stays hidden.
 */
export function publicMonitorUrl(configJson: string): string | null {
  let cfg: unknown;
  try {
    cfg = JSON.parse(configJson);
  } catch {
    return null;
  }
  if (typeof cfg !== 'object' || cfg === null) return null;
  const raw = (cfg as Record<string, unknown>)['url'];
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- maintenance */

export interface MaintenanceWindow {
  title: string;
  description: string | null;
  /** Window bounds (ms); null for open-ended manual maintenance. */
  start: number | null;
  end: number | null;
  status: 'under-maintenance' | 'scheduled';
}

/** Upcoming windows are listed when they start within this horizon. */
const UPCOMING_MS = 7 * DAY;

/**
 * Maintenance shown on a status page: active maintenances explicitly linked to the page
 * (`statusPageUids`), evaluated with the engine's window logic (uptime/maintenance): the
 * current window ("under-maintenance") or the next one starting within 7 days ("scheduled").
 * A maintenance linked only to monitors of the page is NOT announced (its title and
 * description may be internal): the affected monitors still show status "maintenance".
 */
export function maintenanceForPage(db: DB, statusPageId: number, now: number): MaintenanceWindow[] {
  const ids = (
    db
      .prepare(
        `SELECT id FROM maintenances WHERE active = 1
           AND id IN (SELECT maintenance_id FROM maintenance_status_pages WHERE status_page_id = ?)
         ORDER BY id LIMIT 100`,
      )
      .all(statusPageId) as Array<{ id: number }>
  ).map((r) => r.id);
  const out: MaintenanceWindow[] = [];
  for (const m of new MaintenanceRepo(db).byIds(ids)) {
    const base = { title: m.title, description: m.description };
    const cur = currentWindow(m, now);
    if (cur) {
      const open = m.strategy === 'manual' || !Number.isFinite(cur.end);
      out.push({ ...base, start: open ? null : cur.start, end: open ? null : cur.end, status: 'under-maintenance' });
      continue;
    }
    const next = nextWindow(m, now);
    if (next && next.start > now && next.start - now <= UPCOMING_MS && Number.isFinite(next.end)) {
      out.push({ ...base, start: next.start, end: next.end, status: 'scheduled' });
    }
  }
  out.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  return out;
}

/* ---------------------------------------------------------------- outages */

export interface OutageInfo {
  monitorId: number;
  startedAt: number;
  confirmedAt: number | null;
  endedAt: number | null;
}

/** Confirmed outages of these monitors started after `since` (newest first). */
export function recentOutages(db: DB, ids: readonly number[], since: number, limit: number): OutageInfo[] {
  if (ids.length === 0) return [];
  return (
    db
      .prepare(
        `SELECT monitor_id, started_at, confirmed_at, ended_at FROM outages
         WHERE monitor_id IN (SELECT value FROM json_each(?)) AND confirmed_at IS NOT NULL AND started_at >= ?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(JSON.stringify(ids), since, limit) as Array<{ monitor_id: number; started_at: number; confirmed_at: number | null; ended_at: number | null }>
  ).map((r) => ({ monitorId: r.monitor_id, startedAt: r.started_at, confirmedAt: r.confirmed_at, endedAt: r.ended_at }));
}
