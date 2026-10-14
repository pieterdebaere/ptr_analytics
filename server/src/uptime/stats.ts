// Read side of the uptime data (API, status pages, badges): uptime ratios, heartbeat series,
// period statistics and 90-day bars, all time-zone aware (lib/time) and bounded.
import type { DB } from '../db/index.js';
import { HOUR, addDays, localDateOf, startOfLocalDay, startOfLocalHour } from '../lib/time.js';
import { chunks } from './data/monitors.js';
import { DAY_MS, HOUR_MS, uptimeRatio } from './engine/aggregate.js';

/** Hourly stats are kept this long (spec §8.2). */
export const HOURLY_RETENTION_MS = 90 * DAY_MS;
export const MAX_POINTS = 500;

interface StatRow {
  monitor_id: number;
  bucket: number;
  up_ms: number;
  down_ms: number;
  pending_ms: number;
  maint_ms: number;
  checks: number;
  failures: number;
  lat_n: number;
  lat_sum: number;
  lat_min: number | null;
  lat_max: number | null;
}

export interface Totals {
  up_ms: number;
  down_ms: number;
  pending_ms: number;
  maint_ms: number;
  checks: number;
  failures: number;
  lat_n: number;
  lat_sum: number;
  lat_min: number | null;
  lat_max: number | null;
}

const emptyTotals = (): Totals => ({
  up_ms: 0,
  down_ms: 0,
  pending_ms: 0,
  maint_ms: 0,
  checks: 0,
  failures: 0,
  lat_n: 0,
  lat_sum: 0,
  lat_min: null,
  lat_max: null,
});

function add(t: Totals, r: Omit<StatRow, 'monitor_id' | 'bucket'>): void {
  t.up_ms += r.up_ms;
  t.down_ms += r.down_ms;
  t.pending_ms += r.pending_ms;
  t.maint_ms += r.maint_ms;
  t.checks += r.checks;
  t.failures += r.failures;
  t.lat_n += r.lat_n;
  t.lat_sum += r.lat_sum;
  if (r.lat_min !== null) t.lat_min = t.lat_min === null ? r.lat_min : Math.min(t.lat_min, r.lat_min);
  if (r.lat_max !== null) t.lat_max = t.lat_max === null ? r.lat_max : Math.max(t.lat_max, r.lat_max);
}

type Table = 'monitor_stats_hour' | 'monitor_stats_day';

function rows(db: DB, table: Table, monitorId: number, from: number, to: number): StatRow[] {
  return db.prepare(`SELECT * FROM ${table} WHERE monitor_id = ? AND bucket >= ? AND bucket < ? ORDER BY bucket`).all(monitorId, from, to) as StatRow[];
}

/** Aggregated totals per monitor over [from, to) (bucket starts), for many monitors at once. */
export function totalsFor(db: DB, table: Table, monitorIds: readonly number[], from: number, to: number): Map<number, Totals> {
  const out = new Map<number, Totals>();
  for (const chunk of chunks(monitorIds, 400)) {
    if (chunk.length === 0) continue;
    const list = db
      .prepare(
        `SELECT monitor_id, SUM(up_ms) AS up_ms, SUM(down_ms) AS down_ms, SUM(pending_ms) AS pending_ms, SUM(maint_ms) AS maint_ms,
           SUM(checks) AS checks, SUM(failures) AS failures, SUM(lat_n) AS lat_n, SUM(lat_sum) AS lat_sum,
           MIN(lat_min) AS lat_min, MAX(lat_max) AS lat_max
         FROM ${table} WHERE monitor_id IN (${chunk.map(() => '?').join(',')}) AND bucket >= ? AND bucket < ? GROUP BY monitor_id`,
      )
      .all(...chunk, from, to) as StatRow[];
    for (const r of list) {
      const t = emptyTotals();
      add(t, r);
      out.set(r.monitor_id, t);
    }
  }
  return out;
}

/** Totals for one monitor over [from, to): hourly rows when available, daily rows beyond. */
export function rangeTotals(db: DB, monitorId: number, from: number, to: number, now: number): Totals {
  const hourlyFrom = Math.floor((now - HOURLY_RETENTION_MS) / HOUR_MS) * HOUR_MS + HOUR_MS;
  const t = emptyTotals();
  if (from >= hourlyFrom) {
    for (const r of rows(db, 'monitor_stats_hour', monitorId, Math.floor(from / HOUR_MS) * HOUR_MS, to)) add(t, r);
    return t;
  }
  for (const r of rows(db, 'monitor_stats_day', monitorId, Math.floor(from / DAY_MS) * DAY_MS, to)) add(t, r);
  return t;
}

/** 24-hour (hourly table) and 30-day (daily table) uptime per monitor. */
export function recentUptimes(db: DB, monitorIds: readonly number[], now: number): Map<number, { uptime24h: number | null; uptime30d: number | null }> {
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const h = totalsFor(db, 'monitor_stats_hour', monitorIds, hourStart - 23 * HOUR_MS, hourStart + HOUR_MS);
  const d = totalsFor(db, 'monitor_stats_day', monitorIds, dayStart - 29 * DAY_MS, dayStart + DAY_MS);
  const out = new Map<number, { uptime24h: number | null; uptime30d: number | null }>();
  for (const id of monitorIds) {
    const a = h.get(id);
    const b = d.get(id);
    out.set(id, { uptime24h: a ? uptimeRatio(a) : null, uptime30d: b ? uptimeRatio(b) : null });
  }
  return out;
}

/** Number of recent heartbeats included with every monitor in list responses. */
export const RECENT_BEATS = 50;

export interface RecentBeat {
  t: number;
  status: number;
  latencyMs: number | null;
}

/**
 * The last `limit` heartbeats of many monitors (oldest first), one query per 400 monitors: a CTE
 * finds each monitor's cut-off timestamp with one primary-key seek (`ORDER BY ts DESC LIMIT 1
 * OFFSET limit-1`) and the join reads exactly the rows after it.
 */
export function recentBeats(db: DB, monitorIds: readonly number[], limit = RECENT_BEATS): Map<number, RecentBeat[]> {
  const out = new Map<number, RecentBeat[]>();
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  for (const chunk of chunks(monitorIds, 400)) {
    if (chunk.length === 0) continue;
    const rows = db
      .prepare(
        `WITH ids(id) AS (VALUES ${chunk.map(() => '(?)').join(',')}),
         cut AS (
           SELECT id, COALESCE((SELECT ts FROM heartbeats WHERE monitor_id = ids.id ORDER BY ts DESC LIMIT 1 OFFSET ${n - 1}), 0) AS c FROM ids
         )
         SELECT h.monitor_id AS m, h.ts AS t, h.status AS s, h.latency_ms AS l
         FROM cut JOIN heartbeats h ON h.monitor_id = cut.id AND h.ts >= cut.c
         ORDER BY h.monitor_id, h.ts`,
      )
      .raw()
      .all(...chunk) as Array<[number, number, number, number | null]>;
    for (const [m, t, status, latencyMs] of rows) {
      let list = out.get(m);
      if (!list) {
        list = [];
        out.set(m, list);
      }
      list.push({ t, status, latencyMs });
    }
  }
  return out;
}

// ---------------------------------------------------------------- heartbeat series

export interface SeriesPoint {
  t: number;
  status: number;
  latencyMs: number | null;
  latencyMin: number | null;
  latencyMax: number | null;
  upRatio: number | null;
}

export type SeriesInterval = 'raw' | 'hour' | 'day';

/** Worst status first: down, pending, up, maintenance, unknown. */
const SEVERITY: Record<number, number> = { 0: 5, 2: 4, 1: 3, 3: 2, [-1]: 1 };
const worse = (a: number, b: number): number => ((SEVERITY[b] ?? 0) > (SEVERITY[a] ?? 0) ? b : a);

export function chooseInterval(from: number, to: number, now: number, rawRetentionHours: number): SeriesInterval {
  const span = to - from;
  if (span <= 48 * HOUR && from >= now - rawRetentionHours * HOUR) return 'raw';
  if (span <= MAX_POINTS * HOUR && from >= now - HOURLY_RETENTION_MS) return 'hour';
  return 'day';
}

/** Raw beats in [from, to), down-sampled to ≤ MAX_POINTS equal time slots when needed. */
export function rawSeries(db: DB, monitorId: number, from: number, to: number): SeriesPoint[] {
  const list = db
    .prepare('SELECT ts, status, latency_ms FROM heartbeats WHERE monitor_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT 200000')
    .all(monitorId, from, to) as Array<{ ts: number; status: number; latency_ms: number | null }>;
  if (list.length <= MAX_POINTS) {
    return list.map((r) => ({
      t: r.ts,
      status: r.status,
      latencyMs: r.latency_ms,
      latencyMin: r.latency_ms,
      latencyMax: r.latency_ms,
      upRatio: r.status === 1 ? 1 : r.status === 0 || r.status === 2 ? 0 : null,
    }));
  }
  const slot = Math.ceil((to - from) / MAX_POINTS);
  const out: SeriesPoint[] = [];
  let cur: { t: number; status: number; up: number; fail: number; n: number; sum: number; min: number | null; max: number | null } | null = null;
  const push = (): void => {
    if (!cur) return;
    out.push({
      t: cur.t,
      status: cur.status,
      latencyMs: cur.n > 0 ? Math.round(cur.sum / cur.n) : null,
      latencyMin: cur.min,
      latencyMax: cur.max,
      upRatio: cur.up + cur.fail > 0 ? cur.up / (cur.up + cur.fail) : null,
    });
  };
  for (const r of list) {
    const t = from + Math.floor((r.ts - from) / slot) * slot;
    if (!cur || cur.t !== t) {
      push();
      cur = { t, status: -1, up: 0, fail: 0, n: 0, sum: 0, min: null, max: null };
    }
    cur.status = cur.status === -1 ? r.status : worse(cur.status, r.status);
    if (r.status === 1) cur.up++;
    else if (r.status === 0 || r.status === 2) cur.fail++;
    if (r.status === 1 && r.latency_ms !== null) {
      cur.n++;
      cur.sum += r.latency_ms;
      cur.min = cur.min === null ? r.latency_ms : Math.min(cur.min, r.latency_ms);
      cur.max = cur.max === null ? r.latency_ms : Math.max(cur.max, r.latency_ms);
    }
  }
  push();
  return out;
}

export interface Bucket {
  start: number;
  end: number;
}

/** Local hour buckets covering [from, to) in tz. */
export function hourBuckets(from: number, to: number, tz: string): Bucket[] {
  const out: Bucket[] = [];
  let t = startOfLocalHour(from, tz);
  while (t < to && out.length < 10_000) {
    out.push({ start: t, end: t + HOUR });
    t += HOUR;
  }
  return out;
}

/** Local day buckets covering [from, to) in tz (DST-correct lengths). */
export function dayBuckets(from: number, to: number, tz: string): Bucket[] {
  const out: Bucket[] = [];
  let d = localDateOf(from, tz);
  let start = startOfLocalDay(d, tz);
  while (start < to && out.length < 10_000) {
    const next = addDays(d, 1);
    const end = startOfLocalDay(next, tz);
    out.push({ start, end });
    d = next;
    start = end;
  }
  return out;
}

/** Aggregate stat rows (hourly when within retention, else daily) into the given buckets. */
export function bucketTotals(db: DB, monitorId: number, buckets: readonly Bucket[], now: number): Totals[] {
  const out = buckets.map(() => emptyTotals());
  if (buckets.length === 0) return out;
  const from = (buckets[0] as Bucket).start;
  const to = (buckets[buckets.length - 1] as Bucket).end;
  const hourlyFrom = now - HOURLY_RETENTION_MS;
  const useHourly = from >= hourlyFrom - DAY_MS;
  const list = useHourly
    ? rows(db, 'monitor_stats_hour', monitorId, Math.floor(from / HOUR_MS) * HOUR_MS, to)
    : rows(db, 'monitor_stats_day', monitorId, Math.floor(from / DAY_MS) * DAY_MS, to);
  let i = 0;
  for (const r of list) {
    // a row belongs to the bucket containing its start (UTC hour / day)
    const at = useHourly ? r.bucket : Math.max(r.bucket, from);
    while (i < buckets.length && (buckets[i] as Bucket).end <= at) i++;
    if (i >= buckets.length) break;
    if ((buckets[i] as Bucket).start > at) continue;
    add(out[i] as Totals, r);
  }
  return out;
}

function pointOf(t: number, tot: Totals): SeriesPoint {
  let status = -1;
  if (tot.down_ms > 0) status = 0;
  else if (tot.pending_ms > 0) status = 2;
  else if (tot.up_ms > 0) status = 1;
  else if (tot.maint_ms > 0) status = 3;
  return {
    t,
    status,
    latencyMs: tot.lat_n > 0 ? Math.round(tot.lat_sum / tot.lat_n) : null,
    latencyMin: tot.lat_min,
    latencyMax: tot.lat_max,
    upRatio: uptimeRatio(tot),
  };
}

export function heartbeatSeries(
  db: DB,
  monitorId: number,
  range: { from: number; to: number; tz: string },
  now: number,
  rawRetentionHours: number,
): { interval: SeriesInterval; points: SeriesPoint[] } {
  const to = Math.min(range.to, now + HOUR);
  const interval = chooseInterval(range.from, to, now, rawRetentionHours);
  if (interval === 'raw') return { interval, points: rawSeries(db, monitorId, range.from, to) };
  let buckets = interval === 'hour' ? hourBuckets(range.from, to, range.tz) : dayBuckets(range.from, to, range.tz);
  if (buckets.length > MAX_POINTS) {
    // Down-sample: merge k consecutive buckets.
    const k = Math.ceil(buckets.length / MAX_POINTS);
    const merged: Bucket[] = [];
    for (let i = 0; i < buckets.length; i += k) {
      merged.push({ start: (buckets[i] as Bucket).start, end: (buckets[Math.min(buckets.length, i + k) - 1] as Bucket).end });
    }
    buckets = merged;
  }
  const totals = bucketTotals(db, monitorId, buckets, now);
  return { interval, points: buckets.map((b, i) => pointOf(b.start, totals[i] as Totals)) };
}

// ---------------------------------------------------------------- period statistics

export interface DailyBar {
  t: number;
  upRatio: number | null;
  maintenance: boolean;
}

/** One bar per local day (tz), oldest first, ending today. */
export function dailyBars(db: DB, monitorId: number, tz: string, days: number, now: number): DailyBar[] {
  const today = localDateOf(now, tz);
  const first = addDays(today, -(days - 1));
  const buckets = dayBuckets(startOfLocalDay(first, tz), startOfLocalDay(addDays(today, 1), tz), tz);
  const totals = bucketTotals(db, monitorId, buckets, now);
  return buckets.map((b, i) => {
    const t = totals[i] as Totals;
    return { t: b.start, upRatio: uptimeRatio(t), maintenance: t.maint_ms > 0 };
  });
}

export interface PeriodStats {
  uptime: number | null;
  previousUptime: number | null;
  avgLatencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  checks: number;
  outages: number;
  downtimeMs: number;
  mttrMs: number | null;
  bars: DailyBar[];
}

export function periodStats(
  db: DB,
  monitorId: number,
  range: { from: number; to: number; tz: string; previous: { from: number; to: number } },
  now: number,
): PeriodStats {
  const cur = rangeTotals(db, monitorId, range.from, range.to, now);
  const prev = rangeTotals(db, monitorId, range.previous.from, range.previous.to, now);
  const outages = db
    .prepare(
      `SELECT started_at, ended_at FROM outages WHERE monitor_id = ? AND confirmed_at IS NOT NULL
         AND started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at LIMIT 10000`,
    )
    .all(monitorId, range.to, range.from) as Array<{ started_at: number; ended_at: number | null }>;
  const ended = outages.filter((o) => o.ended_at !== null);
  const mttrMs = ended.length > 0 ? Math.round(ended.reduce((s, o) => s + ((o.ended_at as number) - o.started_at), 0) / ended.length) : null;
  return {
    uptime: uptimeRatio(cur),
    previousUptime: uptimeRatio(prev),
    avgLatencyMs: cur.lat_n > 0 ? Math.round(cur.lat_sum / cur.lat_n) : null,
    minLatencyMs: cur.lat_min,
    maxLatencyMs: cur.lat_max,
    checks: cur.checks,
    outages: outages.length,
    downtimeMs: cur.down_ms,
    mttrMs,
    bars: dailyBars(db, monitorId, range.tz, 90, now),
  };
}

// ---------------------------------------------------------------- events & outages

export interface EventJson {
  id: number;
  ts: number;
  from: number | null;
  to: number;
  msg: string | null;
}

export function listEvents(db: DB, monitorId: number, before: number | null, limit: number): EventJson[] {
  const list = db
    .prepare(
      `SELECT id, ts, from_status, to_status, msg FROM monitor_events WHERE monitor_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
    )
    .all(monitorId, before ?? Number.MAX_SAFE_INTEGER, limit) as Array<{ id: number; ts: number; from_status: number | null; to_status: number; msg: string | null }>;
  return list.map((r) => ({ id: r.id, ts: r.ts, from: r.from_status, to: r.to_status, msg: r.msg }));
}

export interface OutageJson {
  id: number;
  startedAt: number;
  confirmedAt: number | null;
  endedAt: number | null;
  cause: string | null;
}

export function listOutages(db: DB, monitorId: number, limit: number, opts: { confirmedOnly?: boolean; since?: number } = {}): OutageJson[] {
  const list = db
    .prepare(
      `SELECT id, started_at, confirmed_at, ended_at, cause FROM outages WHERE monitor_id = ?
         ${opts.confirmedOnly ? 'AND confirmed_at IS NOT NULL' : ''} AND (ended_at IS NULL OR ended_at >= ?)
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(monitorId, opts.since ?? 0, limit) as Array<{ id: number; started_at: number; confirmed_at: number | null; ended_at: number | null; cause: string | null }>;
  return list.map((r) => ({ id: r.id, startedAt: r.started_at, confirmedAt: r.confirmed_at, endedAt: r.ended_at, cause: r.cause }));
}
