import type { DB } from '../db/index.js';
import { StatementCache } from '../db/index.js';
import { VITALS_COLUMNS, columnFilterSql, type Filters, type VitalsDimension } from './filters.js';
import type { ResolvedRange } from './period.js';
import { bucketCte } from './queries.js';
import {
  RES_WEIGHTS,
  VITAL_METRICS,
  metricScore,
  rate,
  realExperienceScore,
  type Rating,
  type VitalMetric,
} from './vitals-score.js';

export interface MetricSummary {
  p75: number | null;
  count: number;
  score: number | null;
  rating: Rating | null;
}

export interface VitalsSummary {
  score: number | null;
  metrics: Record<VitalMetric, MetricSummary>;
}

export interface VitalsPoint {
  t: number;
  value: number | null;
  count: number;
}

export interface VitalsBreakdownRow {
  value: string | null;
  p75: number;
  count: number;
  rating: Rating;
}

/**
 * Nearest-rank p75 inside SQL: number rows per partition by value and keep the row whose
 * rank is ceil(0.75 * n) = (3n + 3) / 4 (integer division).
 */
const P75_PICK = 'rn = (3 * cnt + 3) / 4';

function round(metric: VitalMetric, v: number): number {
  return metric === 'CLS' ? Math.round(v * 10000) / 10000 : Math.round(v * 10) / 10;
}

function summarize(metric: VitalMetric, p75: number | null, count: number): MetricSummary {
  if (p75 === null || count === 0) return { p75: null, count, score: null, rating: null };
  return { p75: round(metric, p75), count, score: metricScore(metric, p75), rating: rate(metric, p75) };
}

export class VitalsQueries {
  private readonly stmts: StatementCache;

  constructor(db: DB) {
    this.stmts = new StatementCache(db);
  }

  private all<T>(sql: string, params: unknown[]): T[] {
    return this.stmts.get(sql).all(...params) as T[];
  }

  private filter(filters: Filters): { sql: string; params: unknown[] } {
    return columnFilterSql(filters, 'v', VITALS_COLUMNS);
  }

  summary(siteId: string, range: ResolvedRange, filters: Filters): VitalsSummary {
    const f = this.filter(filters);
    const rows = this.all<{ metric: VitalMetric; p75: number; cnt: number }>(
      `WITH x AS (
         SELECT v.metric AS metric, v.value AS value,
                ROW_NUMBER() OVER (PARTITION BY v.metric ORDER BY v.value) AS rn,
                COUNT(*) OVER (PARTITION BY v.metric) AS cnt
         FROM vitals v WHERE v.site_id = ? AND v.ts >= ? AND v.ts < ?${f.sql}
       )
       SELECT metric, value AS p75, cnt FROM x WHERE ${P75_PICK}`,
      [siteId, range.from, range.to, ...f.params],
    );
    const byMetric = new Map(rows.map((r) => [r.metric, r]));
    const metrics = {} as Record<VitalMetric, MetricSummary>;
    const p75s: Partial<Record<VitalMetric, number>> = {};
    for (const m of VITAL_METRICS) {
      const r = byMetric.get(m);
      metrics[m] = summarize(m, r?.p75 ?? null, r?.cnt ?? 0);
      if (r) p75s[m] = r.p75;
    }
    return { score: realExperienceScore(p75s), metrics };
  }

  timeseries(siteId: string, range: ResolvedRange, filters: Filters, metric: VitalMetric | 'RES'): VitalsPoint[] {
    const cte = bucketCte(range.buckets);
    const f = this.filter(filters);
    const metrics: readonly VitalMetric[] = metric === 'RES' ? RES_WEIGHTS.map(([m]) => m) : [metric];
    const placeholders = metrics.map(() => '?').join(', ');
    const rows = this.all<{ i: number; metric: VitalMetric; p75: number; cnt: number }>(
      `${cte.sql}, x AS (
         SELECT b.i AS i, v.metric AS metric, v.value AS value,
                ROW_NUMBER() OVER (PARTITION BY b.i, v.metric ORDER BY v.value) AS rn,
                COUNT(*) OVER (PARTITION BY b.i, v.metric) AS cnt
         FROM b JOIN vitals v
           ON v.site_id = ? AND v.metric IN (${placeholders}) AND v.ts >= b.s AND v.ts < b.e${f.sql}
       )
       SELECT i, metric, value AS p75, cnt FROM x WHERE ${P75_PICK}`,
      [...cte.params, siteId, ...metrics, ...f.params],
    );

    const perBucket: Array<Partial<Record<VitalMetric, { p75: number; cnt: number }>>> = range.buckets.map(() => ({}));
    for (const r of rows) {
      const slot = perBucket[r.i];
      if (slot) slot[r.metric] = { p75: r.p75, cnt: r.cnt };
    }
    return range.buckets.map((b, i) => {
      const slot = perBucket[i] ?? {};
      if (metric === 'RES') {
        const p75s: Partial<Record<VitalMetric, number>> = {};
        let count = 0;
        for (const m of metrics) {
          const s = slot[m];
          if (s) {
            p75s[m] = s.p75;
            count += s.cnt;
          }
        }
        return { t: b.start, value: realExperienceScore(p75s), count };
      }
      const s = slot[metric];
      return { t: b.start, value: s ? round(metric, s.p75) : null, count: s?.cnt ?? 0 };
    });
  }

  breakdown(
    siteId: string,
    range: ResolvedRange,
    filters: Filters,
    metric: VitalMetric,
    dimension: VitalsDimension,
    limit: number,
  ): VitalsBreakdownRow[] {
    const col = VITALS_COLUMNS[dimension];
    const f = this.filter(filters);
    const rows = this.all<{ value: string | null; p75: number; cnt: number }>(
      `WITH x AS (
         SELECT v.${col} AS dim, v.value AS value,
                ROW_NUMBER() OVER (PARTITION BY v.${col} ORDER BY v.value) AS rn,
                COUNT(*) OVER (PARTITION BY v.${col}) AS cnt
         FROM vitals v WHERE v.site_id = ? AND v.metric = ? AND v.ts >= ? AND v.ts < ?${f.sql}
       )
       SELECT dim AS value, value AS p75, cnt FROM x WHERE ${P75_PICK}
       ORDER BY cnt DESC, dim LIMIT ?`,
      [siteId, metric, range.from, range.to, ...f.params, limit],
    );
    return rows.map((r) => ({ value: r.value, p75: round(metric, r.p75), count: r.cnt, rating: rate(metric, r.p75) }));
  }
}
