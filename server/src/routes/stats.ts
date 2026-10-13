import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAuth } from '../auth/guard.js';
import { badRequest } from '../lib/errors.js';
import { VITALS_COLUMNS, parseFilters, parseLimit, queryString, type Filters, type Query, type VitalsDimension } from '../stats/filters.js';
import { resolvePeriod, type ResolvedRange } from '../stats/period.js';
import { BREAKDOWN_DIMENSIONS, type BreakdownDimension } from '../stats/queries.js';
import { VITAL_METRICS, type VitalMetric } from '../stats/vitals-score.js';
import { loadSite } from './sites.js';

type SiteRoute = { Params: { id: string }; Querystring: Query };

export interface StatsParams {
  range: ResolvedRange;
  filters: Filters;
}

export function parseStatsParams(ctx: AppContext, q: Query): StatsParams {
  const range = resolvePeriod(
    {
      period: queryString(q, 'period', 16),
      from: queryString(q, 'from', 10),
      to: queryString(q, 'to', 10),
      tz: queryString(q, 'tz', 64),
    },
    ctx.now(),
  );
  return { range, filters: parseFilters(q) };
}

function enumParam<T extends string>(q: Query, key: string, allowed: readonly T[]): T {
  const v = queryString(q, key, 32);
  if (v === undefined || !(allowed as readonly string[]).includes(v)) throw badRequest(`invalid ${key}`);
  return v as T;
}

export async function statsRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  app.addHook('preHandler', requireAuth(ctx));

  app.get<{ Querystring: Query }>('/api/overview', async (request) => {
    const { range } = parseStatsParams(ctx, request.query);
    const noFilters: Filters = { columns: [] };
    const sites = ctx.sites.list().map((site) => {
      const totals = ctx.stats.totals(site.id, range.from, range.to, noFilters);
      return {
        id: site.id,
        name: site.name,
        domains: site.domains,
        visitors: totals.visitors,
        pageviews: totals.pageviews,
        previousVisitors: ctx.stats.visitors(site.id, range.previous.from, range.previous.to, noFilters),
        series: ctx.stats.timeseries(site.id, range, noFilters).map((p) => p.visitors),
      };
    });
    return { sites };
  });

  app.get<SiteRoute>('/api/sites/:id/stats/summary', async (request) => {
    const site = loadSite(ctx, request.params.id);
    const { range, filters } = parseStatsParams(ctx, request.query);
    const current = ctx.stats.totals(site.id, range.from, range.to, filters);
    const previous = ctx.stats.totals(site.id, range.previous.from, range.previous.to, filters);
    return { ...current, previous };
  });

  app.get<SiteRoute>('/api/sites/:id/stats/timeseries', async (request) => {
    const site = loadSite(ctx, request.params.id);
    const { range, filters } = parseStatsParams(ctx, request.query);
    return { interval: range.interval, points: ctx.stats.timeseries(site.id, range, filters) };
  });

  app.get<SiteRoute>('/api/sites/:id/stats/breakdown', async (request) => {
    const site = loadSite(ctx, request.params.id);
    const { range, filters } = parseStatsParams(ctx, request.query);
    const dimension = enumParam<BreakdownDimension>(request.query, 'dimension', BREAKDOWN_DIMENSIONS);
    const limit = parseLimit(request.query);
    return { dimension, rows: ctx.stats.breakdown(site.id, range, filters, dimension, limit) };
  });

  app.get<SiteRoute>('/api/sites/:id/stats/event-props', async (request) => {
    const site = loadSite(ctx, request.params.id);
    const { range, filters } = parseStatsParams(ctx, request.query);
    if (filters.event === undefined || filters.event === null) throw badRequest('event is required');
    const limit = parseLimit(request.query, 100);
    return { rows: ctx.stats.eventProps(site.id, range, filters, filters.event, limit) };
  });

  app.get<SiteRoute>('/api/sites/:id/stats/realtime', async (request) => {
    const site = loadSite(ctx, request.params.id);
    return { visitors: ctx.stats.realtime(site.id, ctx.now()) };
  });

  // ---- Speed Insights ----

  app.get<SiteRoute>('/api/sites/:id/vitals/summary', async (request) => {
    const site = loadSite(ctx, request.params.id);
    const { range, filters } = parseStatsParams(ctx, request.query);
    return ctx.vitals.summary(site.id, range, filters);
  });

  app.get<SiteRoute>('/api/sites/:id/vitals/timeseries', async (request) => {
    const site = loadSite(ctx, request.params.id);
    const { range, filters } = parseStatsParams(ctx, request.query);
    const metric = enumParam<VitalMetric | 'RES'>(request.query, 'metric', [...VITAL_METRICS, 'RES']);
    return { interval: range.interval, points: ctx.vitals.timeseries(site.id, range, filters, metric) };
  });

  app.get<SiteRoute>('/api/sites/:id/vitals/breakdown', async (request) => {
    const site = loadSite(ctx, request.params.id);
    const { range, filters } = parseStatsParams(ctx, request.query);
    const metric = enumParam<VitalMetric>(request.query, 'metric', VITAL_METRICS);
    const dimension = enumParam<VitalsDimension>(request.query, 'dimension', Object.keys(VITALS_COLUMNS) as VitalsDimension[]);
    const limit = parseLimit(request.query);
    return { rows: ctx.vitals.breakdown(site.id, range, filters, metric, dimension, limit) };
  });
}
