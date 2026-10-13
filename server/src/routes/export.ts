import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAuth } from '../auth/guard.js';
import { csvRow } from '../lib/csv.js';
import { formatLocalDate } from '../lib/time.js';
import { columnFilterSql, type Filters, type Query } from '../stats/filters.js';
import { loadSite } from './sites.js';
import { parseStatsParams } from './stats.js';

const HEADER = [
  'timestamp',
  'type',
  'name',
  'hostname',
  'path',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'country',
  'device',
  'browser',
  'os',
  'props',
] as const;

interface ExportRow {
  id: number;
  ts: number;
  type: string;
  name: string | null;
  hostname: string;
  path: string;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  country: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  props: string | null;
}

const BATCH = 1000;

/** SQL + params selecting raw events in range with filters (event filter: see spec 4.7). */
function exportQuery(siteId: string, from: number, to: number, filters: Filters): { sql: string; params: unknown[] } {
  const cols = columnFilterSql(filters, 'e');
  let sql = `SELECT e.id, e.ts, e.type, e.name, e.hostname, e.path, e.referrer, e.utm_source, e.utm_medium,
       e.utm_campaign, e.utm_term, e.utm_content, e.country, e.device, e.browser, e.os, e.props
     FROM events e
     WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND (e.ts > ? OR (e.ts = ? AND e.id > ?))${cols.sql}`;
  const params: unknown[] = [...cols.params];
  if (filters.event !== undefined) {
    // custom events with that name, plus pageviews of visitors that triggered it
    const nameCond = filters.event === null ? 'IS NULL' : '= ?';
    sql += ` AND ((e.type = 'event' AND e.name ${nameCond}) OR (e.type = 'pageview' AND e.visitor_id IN (
       SELECT x.visitor_id FROM events x WHERE x.site_id = ? AND x.type = 'event' AND x.ts >= ? AND x.ts < ? AND x.name ${nameCond})))`;
    if (filters.event !== null) params.push(filters.event);
    params.push(siteId, from, to);
    if (filters.event !== null) params.push(filters.event);
  }
  sql += ' ORDER BY e.ts, e.id LIMIT ?';
  return { sql, params };
}

export async function exportRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;

  app.get<{ Params: { id: string }; Querystring: Query }>(
    '/api/sites/:id/export',
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const site = loadSite(ctx, request.params.id);
      const { range, filters } = parseStatsParams(ctx, request.query);
      const { sql, params } = exportQuery(site.id, range.from, range.to, filters);
      const stmt = ctx.db.prepare(sql);

      // Keyset pagination: each batch is a short synchronous query, so the (single) DB
      // connection is never held busy between stream reads.
      let lastTs = -Infinity;
      let lastId = -1;
      let headerSent = false;
      let done = false;
      const stream = new Readable({
        read() {
          if (done) return;
          try {
            let chunk = '';
            if (!headerSent) {
              chunk += csvRow(HEADER);
              headerSent = true;
            }
            const tsParam = lastTs === -Infinity ? range.from - 1 : lastTs;
            const rows = stmt.all(site.id, range.from, range.to, tsParam, tsParam, lastId, ...params, BATCH) as ExportRow[];
            for (const r of rows) {
              chunk += csvRow([
                new Date(r.ts).toISOString(),
                r.type,
                r.name,
                r.hostname,
                r.path,
                r.referrer,
                r.utm_source,
                r.utm_medium,
                r.utm_campaign,
                r.utm_term,
                r.utm_content,
                r.country,
                r.device,
                r.browser,
                r.os,
                r.props,
              ]);
            }
            const last = rows[rows.length - 1];
            if (last) {
              lastTs = last.ts;
              lastId = last.id;
            }
            if (rows.length < BATCH) done = true;
            if (chunk) this.push(chunk);
            if (done) this.push(null);
          } catch (err) {
            this.destroy(err as Error);
          }
        },
      });

      const fileName = `ptr-analytics-${site.id}-${formatLocalDate(range.fromDate)}-${formatLocalDate(range.toDate)}.csv`;
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${fileName}"`)
        .header('Cache-Control', 'no-store');
      return reply.send(stream);
    },
  );
}
