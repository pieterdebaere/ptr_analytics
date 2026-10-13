import type { DB } from '../db/index.js';
import { StatementCache } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import {
  EVENT_COLUMNS,
  columnFilterSql,
  customEventFilterSql,
  pageviewFilterSql,
  type ColumnFilterKey,
  type Filters,
  type SqlFragment,
} from './filters.js';
import type { Bucket, ResolvedRange } from './period.js';

export const BREAKDOWN_DIMENSIONS = [...(Object.keys(EVENT_COLUMNS) as ColumnFilterKey[]), 'event'] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export interface Totals {
  visitors: number;
  pageviews: number;
  bounceRate: number | null;
  events: number;
}

export interface TimeseriesPoint {
  t: number;
  visitors: number;
  pageviews: number;
  /** sessions with pageviews <= 1 / sessions started in the bucket (matching filters); null if none */
  bounceRate: number | null;
}

export interface BreakdownRow {
  value: string | null;
  visitors: number;
  count: number;
}

export interface EventPropRow {
  key: string;
  value: string | null;
  visitors: number;
  count: number;
}

/** `WITH b(i, s, e) AS (VALUES ...)` for a list of buckets, fully parameterised. */
export function bucketCte(buckets: readonly Bucket[]): SqlFragment {
  if (buckets.length === 0) throw new Error('no buckets');
  const params: unknown[] = [];
  const rows = buckets.map((b, i) => {
    params.push(i, b.start, b.end);
    return '(?, ?, ?)';
  });
  return { sql: `WITH b(i, s, e) AS (VALUES ${rows.join(', ')})`, params };
}

export class StatsQueries {
  private readonly stmts: StatementCache;

  constructor(db: DB) {
    this.stmts = new StatementCache(db);
  }

  private get<T>(sql: string, params: unknown[]): T {
    return this.stmts.get(sql).get(...params) as T;
  }

  private all<T>(sql: string, params: unknown[]): T[] {
    return this.stmts.get(sql).all(...params) as T[];
  }

  totals(siteId: string, from: number, to: number, filters: Filters): Totals {
    const pv = pageviewFilterSql(filters, 'e', siteId, from, to);
    const base = `FROM events e WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?${pv.sql}`;
    const main = this.get<{ visitors: number; pageviews: number }>(
      `SELECT COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}`,
      [siteId, from, to, ...pv.params],
    );
    const bounce = this.get<{ sessions: number; bounces: number }>(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(s.pageviews <= 1), 0) AS bounces FROM sessions s
       WHERE s.id IN (SELECT e.session_id ${base})`,
      [siteId, from, to, ...pv.params],
    );
    const ev = customEventFilterSql(filters, 'e');
    const events = this.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events e WHERE e.site_id = ? AND e.type = 'event' AND e.ts >= ? AND e.ts < ?${ev.sql}`,
      [siteId, from, to, ...ev.params],
    );
    return {
      visitors: main.visitors,
      pageviews: main.pageviews,
      bounceRate: bounce.sessions > 0 ? bounce.bounces / bounce.sessions : null,
      events: events.n,
    };
  }

  /** Visitors only (cheaper; used for the overview's previous period). */
  visitors(siteId: string, from: number, to: number, filters: Filters): number {
    const pv = pageviewFilterSql(filters, 'e', siteId, from, to);
    return this.get<{ n: number }>(
      `SELECT COUNT(DISTINCT e.visitor_id) AS n FROM events e WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?${pv.sql}`,
      [siteId, from, to, ...pv.params],
    ).n;
  }

  timeseries(siteId: string, range: ResolvedRange, filters: Filters): TimeseriesPoint[] {
    const cte = bucketCte(range.buckets);
    const pv = pageviewFilterSql(filters, 'e', siteId, range.from, range.to);
    const rows = this.all<{ i: number; visitors: number; pageviews: number }>(
      `${cte.sql}
       SELECT b.i AS i, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(e.id) AS pageviews
       FROM b LEFT JOIN events e
         ON e.site_id = ? AND e.type = 'pageview' AND e.ts >= b.s AND e.ts < b.e${pv.sql}
       GROUP BY b.i ORDER BY b.i`,
      [...cte.params, siteId, ...pv.params],
    );
    // Sessions that started in the bucket and have at least one matching pageview in range.
    const bounceRows = this.all<{ i: number; sessions: number; bounces: number }>(
      `${cte.sql}
       SELECT b.i AS i, COUNT(s.id) AS sessions, COALESCE(SUM(s.pageviews <= 1), 0) AS bounces
       FROM b LEFT JOIN sessions s
         ON s.site_id = ? AND s.started_at >= b.s AND s.started_at < b.e
        AND s.id IN (SELECT e.session_id FROM events e
                     WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?${pv.sql})
       GROUP BY b.i ORDER BY b.i`,
      [...cte.params, siteId, siteId, range.from, range.to, ...pv.params],
    );
    const points: TimeseriesPoint[] = range.buckets.map((b) => ({ t: b.start, visitors: 0, pageviews: 0, bounceRate: null }));
    for (const r of rows) {
      const p = points[r.i];
      if (p) {
        p.visitors = r.visitors;
        p.pageviews = r.pageviews;
      }
    }
    for (const r of bounceRows) {
      const p = points[r.i];
      if (p && r.sessions > 0) p.bounceRate = r.bounces / r.sessions;
    }
    return points;
  }

  breakdown(siteId: string, range: ResolvedRange, filters: Filters, dimension: BreakdownDimension, limit: number): BreakdownRow[] {
    if (dimension === 'event') {
      const ev = customEventFilterSql(filters, 'e');
      return this.all<BreakdownRow>(
        `SELECT e.name AS value, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS count
         FROM events e WHERE e.site_id = ? AND e.type = 'event' AND e.ts >= ? AND e.ts < ?${ev.sql}
         GROUP BY e.name ORDER BY visitors DESC, count DESC, value LIMIT ?`,
        [siteId, range.from, range.to, ...ev.params, limit],
      );
    }
    const col = EVENT_COLUMNS[dimension];
    if (col === undefined) throw badRequest('invalid dimension');
    const pv = pageviewFilterSql(filters, 'e', siteId, range.from, range.to);
    return this.all<BreakdownRow>(
      `SELECT e.${col} AS value, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS count
       FROM events e WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?${pv.sql}
       GROUP BY e.${col} ORDER BY visitors DESC, count DESC, value LIMIT ?`,
      [siteId, range.from, range.to, ...pv.params, limit],
    );
  }

  eventProps(siteId: string, range: ResolvedRange, filters: Filters, eventName: string, limit: number): EventPropRow[] {
    const cols = columnFilterSql(filters, 'e');
    return this.all<EventPropRow>(
      `SELECT j.key AS key,
              CASE j.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL
                          ELSE CAST(j.value AS TEXT) END AS value,
              COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS count
       FROM events e, json_each(CASE WHEN json_valid(e.props) THEN e.props END) j
       WHERE e.site_id = ? AND e.type = 'event' AND e.name = ? AND e.ts >= ? AND e.ts < ?
         AND e.props IS NOT NULL AND json_valid(e.props)${cols.sql}
       GROUP BY 1, 2 ORDER BY visitors DESC, count DESC, key, value LIMIT ?`,
      [siteId, eventName, range.from, range.to, ...cols.params, limit],
    );
  }

  realtime(siteId: string, now: number): number {
    return this.get<{ n: number }>(
      `SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE site_id = ? AND ts >= ? AND ts <= ?`,
      [siteId, now - LIVE_WINDOW_MS, now],
    ).n;
  }

  /** Live map of one site (spec 4.7): last 5 minutes. */
  live(siteId: string, now: number): LiveSite {
    const from = now - LIVE_WINDOW_MS;
    const visitors = this.realtime(siteId, now);
    const countries = this.all<LiveCountry>(
      `SELECT country, COUNT(DISTINCT visitor_id) AS visitors FROM events
       WHERE site_id = ? AND ts >= ? AND ts <= ?
       GROUP BY country ORDER BY visitors DESC, country LIMIT ?`,
      [siteId, from, now, LIVE_MAX_COUNTRIES],
    );
    const recent = this.all<LiveRecent>(
      `SELECT ts, country, path FROM events
       WHERE site_id = ? AND type = 'pageview' AND ts >= ? AND ts <= ?
       ORDER BY ts DESC, id DESC LIMIT ?`,
      [siteId, from, now, LIVE_MAX_RECENT],
    );
    return { visitors, countries, recent };
  }

  /** Live map over several sites (null = every site). */
  liveAll(siteIds: readonly string[] | null, now: number): LiveAll {
    const from = now - LIVE_WINDOW_MS;
    if (siteIds !== null && siteIds.length === 0) return { visitors: 0, countries: [], sites: [] };
    // Visitor ids are per site (the hash includes the site id), so (site, visitor) pairs are
    // distinct visitors. The site IN (...) lets every site use the (site_id, ts) index.
    const scope =
      siteIds === null
        ? { sql: 'site_id IN (SELECT id FROM sites)', params: [] as unknown[] }
        : { sql: `site_id IN (${siteIds.map(() => '?').join(', ')})`, params: [...siteIds] as unknown[] };
    const perSite = this.all<{ id: string; visitors: number }>(
      `SELECT site_id AS id, COUNT(DISTINCT visitor_id) AS visitors FROM events
       WHERE ${scope.sql} AND ts >= ? AND ts <= ?
       GROUP BY site_id ORDER BY visitors DESC, site_id`,
      [...scope.params, from, now],
    );
    const countries = this.all<LiveCountry>(
      `SELECT country, COUNT(*) AS visitors FROM (
         SELECT DISTINCT site_id, visitor_id, country FROM events WHERE ${scope.sql} AND ts >= ? AND ts <= ?
       ) GROUP BY country ORDER BY visitors DESC, country LIMIT ?`,
      [...scope.params, from, now, LIVE_MAX_COUNTRIES],
    );
    return { visitors: perSite.reduce((n, r) => n + r.visitors, 0), countries, sites: perSite };
  }
}

export const LIVE_WINDOW_MS = 5 * 60_000;
const LIVE_MAX_RECENT = 50;
const LIVE_MAX_COUNTRIES = 300;

export interface LiveCountry {
  country: string | null;
  visitors: number;
}

export interface LiveRecent {
  ts: number;
  country: string | null;
  path: string;
}

export interface LiveSite {
  visitors: number;
  countries: LiveCountry[];
  recent: LiveRecent[];
}

export interface LiveAll {
  visitors: number;
  countries: LiveCountry[];
  sites: Array<{ id: string; visitors: number }>;
}
