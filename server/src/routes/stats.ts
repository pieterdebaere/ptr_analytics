import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAuth } from '../auth/guard.js';
import { HttpError, badRequest, forbidden } from '../lib/errors.js';
import {
  VITALS_COLUMNS,
  parseFilters,
  parseLimit,
  queryString,
  type Filters,
  type Query,
  type VitalsDimension,
} from '../stats/filters.js';
import type { OpOf, StatsOpKind, StatsResults } from '../stats/ops.js';
import { resolvePeriod, type ResolvedRange } from '../stats/period.js';
import { BREAKDOWN_DIMENSIONS, type BreakdownDimension } from '../stats/queries.js';
import { statsService } from '../stats/service.js';
import { VITAL_METRICS, type VitalMetric } from '../stats/vitals-score.js';
import { accessibleSites, siteFromRequest } from '../auth/access.js';
import { currentUser } from '../auth/guard.js';

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

/** Speed Insights only know the vitals columns (path, hostname, country, device, browser, os). */
function parseVitalsParams(ctx: AppContext, q: Query): StatsParams {
  const p = parseStatsParams(ctx, q);
  if (p.filters.event !== undefined || p.filters.columns.some((c) => !Object.hasOwn(VITALS_COLUMNS, c.key))) {
    throw badRequest('filter not supported for speed insights');
  }
  return p;
}

function enumParam<T extends string>(q: Query, key: string, allowed: readonly T[]): T {
  const v = queryString(q, key, 32);
  if (v === undefined || !(allowed as readonly string[]).includes(v)) throw badRequest(`invalid ${key}`);
  return v as T;
}

const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * onRequest: refuse heavy authenticated GETs initiated by another site, including sibling
 * subdomains (`same-site`), e.g. `<img src=/api/sites/x/export?...>` used to load the
 * server. Browsers send Sec-Fetch-Site; non-browser clients without it are unaffected.
 */
export async function rejectCrossSiteFetch(request: FastifyRequest): Promise<void> {
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && !(typeof site === 'string' && ALLOWED_FETCH_SITES.has(site))) throw forbidden();
}

/** Admission-control key: the logged-in user. */
export function userKey(request: FastifyRequest): string {
  return request.user ? `u${request.user.id}` : 'anonymous';
}

export async function statsRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const service = statsService(ctx);
  app.addHook('onRequest', rejectCrossSiteFetch);
  app.addHook('preHandler', requireAuth(ctx));
  app.addHook('onClose', async () => service.close());

  const run = async <K extends StatsOpKind>(
    request: FastifyRequest,
    reply: FastifyReply,
    op: OpOf<K>,
    cache = true,
  ): Promise<StatsResults[K]> => {
    try {
      return await service.query(userKey(request), op, { cache });
    } catch (err) {
      if (err instanceof HttpError && (err.statusCode === 429 || err.statusCode === 503)) reply.header('Retry-After', '5');
      throw err;
    }
  };

  app.get<{ Querystring: Query }>('/api/overview', async (request, reply) => {
    const { range } = parseStatsParams(ctx, request.query);
    const sites = accessibleSites(ctx, currentUser(request)).map((s) => ({ id: s.id, name: s.name, domains: s.domains }));
    return {
      sites: await run(request, reply, { kind: 'overview', sites, range }),
    };
  });

  app.get<SiteRoute>('/api/sites/:id/stats/summary', async (request, reply) => {
    const site = siteFromRequest(ctx, request, request.params.id);
    const { range, filters } = parseStatsParams(ctx, request.query);
    return run(request, reply, {
      kind: 'summary',
      siteId: site.id,
      range,
      filters,
    });
  });

  app.get<SiteRoute>('/api/sites/:id/stats/timeseries', async (request, reply) => {
    const site = siteFromRequest(ctx, request, request.params.id);
    const { range, filters } = parseStatsParams(ctx, request.query);
    return {
      interval: range.interval,
      points: await run(request, reply, {
        kind: 'timeseries',
        siteId: site.id,
        range,
        filters,
      }),
    };
  });

  app.get<SiteRoute>('/api/sites/:id/stats/breakdown', async (request, reply) => {
    const site = siteFromRequest(ctx, request, request.params.id);
    const { range, filters } = parseStatsParams(ctx, request.query);
    const dimension = enumParam<BreakdownDimension>(request.query, 'dimension', BREAKDOWN_DIMENSIONS);
    const limit = parseLimit(request.query);
    const rows = await run(request, reply, {
      kind: 'breakdown',
      siteId: site.id,
      range,
      filters,
      dimension,
      limit,
    });
    return { dimension, rows };
  });

  app.get<SiteRoute>('/api/sites/:id/stats/event-props', async (request, reply) => {
    const site = siteFromRequest(ctx, request, request.params.id);
    const { range, filters } = parseStatsParams(ctx, request.query);
    if (filters.event === undefined || filters.event === null) throw badRequest('event is required');
    const limit = parseLimit(request.query, 100);
    const rows = await run(request, reply, {
      kind: 'eventProps',
      siteId: site.id,
      range,
      filters,
      event: filters.event,
      limit,
    });
    return { rows };
  });

  app.get<SiteRoute>('/api/sites/:id/stats/realtime', async (request, reply) => {
    const site = siteFromRequest(ctx, request, request.params.id);
    // keyed on the current time: never cached
    return {
      visitors: await run(request, reply, { kind: 'realtime', siteId: site.id, now: ctx.now() }, false),
    };
  });

  // ---- Live map (globe): last 5 minutes, never cached ----

  app.get<SiteRoute>('/api/sites/:id/stats/live', async (request, reply) => {
    const site = siteFromRequest(ctx, request, request.params.id);
    return run(request, reply, { kind: 'live', siteId: site.id, now: ctx.now() }, false);
  });

  app.get('/api/live', async (request, reply) => {
    const user = currentUser(request);
    const sites = accessibleSites(ctx, user);
    // admins/viewers: every site (resolved in SQL); members: their own sites only
    const siteIds = user.role === 'member' ? sites.map((s) => s.id) : null;
    const result = await run(request, reply, { kind: 'liveAll', siteIds, now: ctx.now() }, false);
    const names = new Map(sites.map((s) => [s.id, s.name]));
    return {
      visitors: result.visitors,
      countries: result.countries,
      sites: result.sites.flatMap((r) => {
        const name = names.get(r.id);
        return name === undefined ? [] : [{ id: r.id, name, visitors: r.visitors }];
      }),
    };
  });

  // ---- Speed Insights ----

  app.get<SiteRoute>('/api/sites/:id/vitals/summary', async (request, reply) => {
    const site = siteFromRequest(ctx, request, request.params.id);
    const { range, filters } = parseVitalsParams(ctx, request.query);
    return run(request, reply, {
      kind: 'vitalsSummary',
      siteId: site.id,
      range,
      filters,
    });
  });

  app.get<SiteRoute>('/api/sites/:id/vitals/timeseries', async (request, reply) => {
    const site = siteFromRequest(ctx, request, request.params.id);
    const { range, filters } = parseVitalsParams(ctx, request.query);
    const metric = enumParam<VitalMetric | 'RES'>(request.query, 'metric', [...VITAL_METRICS, 'RES']);
    const points = await run(request, reply, {
      kind: 'vitalsTimeseries',
      siteId: site.id,
      range,
      filters,
      metric,
    });
    return { interval: range.interval, points };
  });

  app.get<SiteRoute>('/api/sites/:id/vitals/breakdown', async (request, reply) => {
    const site = siteFromRequest(ctx, request, request.params.id);
    const { range, filters } = parseVitalsParams(ctx, request.query);
    const metric = enumParam<VitalMetric>(request.query, 'metric', VITAL_METRICS);
    const dimension = enumParam<VitalsDimension>(request.query, 'dimension', Object.keys(VITALS_COLUMNS) as VitalsDimension[]);
    const limit = parseLimit(request.query);
    const rows = await run(request, reply, {
      kind: 'vitalsBreakdown',
      siteId: site.id,
      range,
      filters,
      metric,
      dimension,
      limit,
    });
    return { rows };
  });
}
