import type { DB } from '../db/index.js';
import { StatementCache } from '../db/index.js';
import { ExportCursors, type ExportBatch, type ExportSpec } from './export.js';
import type { Filters, VitalsDimension } from './filters.js';
import type { ResolvedRange } from './period.js';
import {
  StatsQueries,
  bucketCte,
  type BreakdownDimension,
  type BreakdownRow,
  type EventPropRow,
  type TimeseriesPoint,
  type Totals,
} from './queries.js';
import { VitalsQueries, type VitalsBreakdownRow, type VitalsPoint, type VitalsSummary } from './vitals.js';
import type { VitalMetric } from './vitals-score.js';

/**
 * Every heavy dashboard read is expressed as a plain, structured-cloneable operation so it
 * can run either in a worker thread (own read-only connection) or in-process.
 */
export type StatsOp =
  | { kind: 'summary'; siteId: string; range: ResolvedRange; filters: Filters }
  | {
      kind: 'timeseries';
      siteId: string;
      range: ResolvedRange;
      filters: Filters;
    }
  | {
      kind: 'breakdown';
      siteId: string;
      range: ResolvedRange;
      filters: Filters;
      dimension: BreakdownDimension;
      limit: number;
    }
  | {
      kind: 'eventProps';
      siteId: string;
      range: ResolvedRange;
      filters: Filters;
      event: string;
      limit: number;
    }
  | { kind: 'realtime'; siteId: string; now: number }
  | { kind: 'overview'; sites: OverviewSiteInput[]; range: ResolvedRange }
  | {
      kind: 'vitalsSummary';
      siteId: string;
      range: ResolvedRange;
      filters: Filters;
    }
  | {
      kind: 'vitalsTimeseries';
      siteId: string;
      range: ResolvedRange;
      filters: Filters;
      metric: VitalMetric | 'RES';
    }
  | {
      kind: 'vitalsBreakdown';
      siteId: string;
      range: ResolvedRange;
      filters: Filters;
      metric: VitalMetric;
      dimension: VitalsDimension;
      limit: number;
    }
  | { kind: 'exportOpen'; spec: ExportSpec }
  | { kind: 'exportNext'; handle: number }
  | { kind: 'exportClose'; handle: number };

export type StatsOpKind = StatsOp['kind'];

export interface OverviewSiteInput {
  id: string;
  name: string;
  domains: string[];
}

export interface OverviewSite extends OverviewSiteInput {
  visitors: number;
  pageviews: number;
  previousVisitors: number;
  series: number[];
}

export interface StatsResults {
  summary: Totals & { previous: Totals };
  timeseries: TimeseriesPoint[];
  breakdown: BreakdownRow[];
  eventProps: EventPropRow[];
  realtime: number;
  overview: OverviewSite[];
  vitalsSummary: VitalsSummary;
  vitalsTimeseries: VitalsPoint[];
  vitalsBreakdown: VitalsBreakdownRow[];
  exportOpen: number;
  exportNext: ExportBatch;
  exportClose: null;
}

export type OpOf<K extends StatsOpKind> = Extract<StatsOp, { kind: K }>;

/** Executes StatsOps against one connection (synchronously). */
export class StatsHandlers {
  private readonly stats: StatsQueries;
  private readonly vitals: VitalsQueries;
  private readonly stmts: StatementCache;
  private readonly exports: ExportCursors;

  constructor(db: DB, allowTempWrites?: <T>(fn: () => T) => T) {
    this.stats = new StatsQueries(db);
    this.vitals = new VitalsQueries(db);
    this.stmts = new StatementCache(db, 50);
    this.exports = new ExportCursors(db, allowTempWrites);
  }

  run<K extends StatsOpKind>(op: OpOf<K>): StatsResults[K] {
    return this.dispatch(op as StatsOp) as StatsResults[K];
  }

  private dispatch(op: StatsOp): StatsResults[StatsOpKind] {
    switch (op.kind) {
      case 'summary': {
        const { siteId, range, filters } = op;
        const current = this.stats.totals(siteId, range.from, range.to, filters);
        const previous = this.stats.totals(siteId, range.previous.from, range.previous.to, filters);
        return { ...current, previous };
      }
      case 'timeseries':
        return this.stats.timeseries(op.siteId, op.range, op.filters);
      case 'breakdown':
        return this.stats.breakdown(op.siteId, op.range, op.filters, op.dimension, op.limit);
      case 'eventProps':
        return this.stats.eventProps(op.siteId, op.range, op.filters, op.event, op.limit);
      case 'realtime':
        return this.stats.realtime(op.siteId, op.now);
      case 'overview':
        return this.overview(op.sites, op.range);
      case 'vitalsSummary':
        return this.vitals.summary(op.siteId, op.range, op.filters);
      case 'vitalsTimeseries':
        return this.vitals.timeseries(op.siteId, op.range, op.filters, op.metric);
      case 'vitalsBreakdown':
        return this.vitals.breakdown(op.siteId, op.range, op.filters, op.metric, op.dimension, op.limit);
      case 'exportOpen':
        return this.exports.open(op.spec);
      case 'exportNext':
        return this.exports.next(op.handle);
      case 'exportClose':
        this.exports.close(op.handle);
        return null;
    }
  }

  /**
   * Overview of all sites with only what the overview needs (no bounce rate / events):
   * three grouped queries over all sites instead of ~10 queries per site.
   */
  private overview(sites: OverviewSiteInput[], range: ResolvedRange): OverviewSite[] {
    if (sites.length === 0) return [];
    const ids = sites.map((s) => s.id);
    const inList = ids.map(() => '?').join(', ');
    const totals = this.stmts
      .get(
        `SELECT e.site_id AS id, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews
         FROM events e WHERE e.site_id IN (${inList}) AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?
         GROUP BY e.site_id`,
      )
      .all(...ids, range.from, range.to) as Array<{
      id: string;
      visitors: number;
      pageviews: number;
    }>;
    const previous = this.stmts
      .get(
        `SELECT e.site_id AS id, COUNT(DISTINCT e.visitor_id) AS visitors
         FROM events e WHERE e.site_id IN (${inList}) AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?
         GROUP BY e.site_id`,
      )
      .all(...ids, range.previous.from, range.previous.to) as Array<{
      id: string;
      visitors: number;
    }>;
    const cte = bucketCte(range.buckets);
    const series = this.stmts
      .get(
        // CROSS JOIN pins the bucket list as the outer loop, so each bucket is an index range
        // scan (with a plain JOIN + site IN-list the planner scans all of the sites' pageviews).
        `${cte.sql}
         SELECT e.site_id AS id, b.i AS i, COUNT(DISTINCT e.visitor_id) AS visitors
         FROM b CROSS JOIN events e
           ON e.site_id IN (${inList}) AND e.type = 'pageview' AND e.ts >= b.s AND e.ts < b.e
         GROUP BY e.site_id, b.i`,
      )
      .all(...cte.params, ...ids) as Array<{
      id: string;
      i: number;
      visitors: number;
    }>;

    const out = new Map<string, OverviewSite>();
    for (const s of sites) {
      out.set(s.id, {
        id: s.id,
        name: s.name,
        domains: s.domains,
        visitors: 0,
        pageviews: 0,
        previousVisitors: 0,
        series: range.buckets.map(() => 0),
      });
    }
    for (const r of totals) {
      const o = out.get(r.id);
      if (o) {
        o.visitors = r.visitors;
        o.pageviews = r.pageviews;
      }
    }
    for (const r of previous) {
      const o = out.get(r.id);
      if (o) o.previousVisitors = r.visitors;
    }
    for (const r of series) {
      const o = out.get(r.id);
      if (o && r.i >= 0 && r.i < o.series.length) o.series[r.i] = r.visitors;
    }
    return sites.map((s) => out.get(s.id) as OverviewSite);
  }
}
