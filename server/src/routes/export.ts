import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAuth } from '../auth/guard.js';
import { HttpError } from '../lib/errors.js';
import { csvRow } from '../lib/csv.js';
import { formatLocalDate } from '../lib/time.js';
import { EXPORT_HEADER } from '../stats/export.js';
import type { Query } from '../stats/filters.js';
import { statsService, type ExportSession } from '../stats/service.js';
import { siteFromRequest } from '../auth/access.js';
import { parseStatsParams, rejectCrossSiteFetch, userKey, type StatsParams } from './stats.js';

type ExportRoute = { Params: { id: string }; Querystring: Query };

/**
 * A pull-based CSV stream: one keyset page is fetched (off the main thread, or after yielding
 * to the event loop in-process) per `read()`, so a slow client applies backpressure and the
 * event loop is never monopolised. Destroying the stream (client gone) stops it.
 */
function csvStream(session: ExportSession): Readable {
  let fetching = false;
  let headerSent = false;
  const stream: Readable = new Readable({
    highWaterMark: 64 * 1024,
    read() {
      if (!headerSent) {
        headerSent = true;
        this.push(csvRow(EXPORT_HEADER));
      }
      pull();
    },
    destroy(err, cb) {
      session.close();
      cb(err);
    },
  });
  const pull = (): void => {
    if (fetching || stream.destroyed) return;
    fetching = true;
    session.next().then(
      (batch) => {
        fetching = false;
        if (stream.destroyed) return;
        if (batch.csv) stream.push(batch.csv);
        if (batch.done) stream.push(null);
        else if (!batch.csv) pull(); // (cannot happen: a non-final page is never empty)
      },
      (err: unknown) => {
        fetching = false;
        stream.destroy(err instanceof Error ? err : new Error(String(err)));
      },
    );
  };
  return stream;
}

export async function exportRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const service = statsService(ctx);
  app.addHook('onRequest', rejectCrossSiteFetch);
  app.addHook('onClose', async () => service.close());

  const prepare = (request: FastifyRequest<ExportRoute>): { siteId: string; fileName: string } & StatsParams => {
    const site = siteFromRequest(ctx, request, request.params.id);
    const params = parseStatsParams(ctx, request.query);
    const fileName = `ptr-analytics-${site.id}-${formatLocalDate(params.range.fromDate)}-${formatLocalDate(params.range.toDate)}.csv`;
    return { siteId: site.id, fileName, ...params };
  };

  const csvHeaders = (reply: FastifyReply, fileName: string): void => {
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .header('Cache-Control', 'no-store');
  };

  // HEAD: headers only. (Fastify's automatic HEAD route would run the export and drain it.)
  app.head<ExportRoute>('/api/sites/:id/export', { preHandler: requireAuth(ctx) }, async (request, reply) => {
    csvHeaders(reply, prepare(request).fileName);
    return reply.send();
  });

  app.get<ExportRoute>(
    '/api/sites/:id/export',
    { preHandler: requireAuth(ctx), exposeHeadRoute: false },
    async (request, reply) => {
      const { siteId, fileName, range, filters } = prepare(request);
      let session: ExportSession;
      try {
        session = await service.openExport(userKey(request), {
          siteId,
          from: range.from,
          to: range.to,
          filters,
        });
      } catch (err) {
        if (err instanceof HttpError && (err.statusCode === 429 || err.statusCode === 503)) {
          reply.header('Retry-After', err.statusCode === 429 ? '30' : '5');
        }
        throw err;
      }
      // the client may have gone away while the cursor was opened
      if (request.raw.destroyed || reply.raw.destroyed) {
        session.close();
        return reply;
      }
      const stream = csvStream(session);
      csvHeaders(reply, fileName);
      // Stop (and free the export slot) as soon as the connection closes, whatever the state.
      reply.raw.once('close', () => {
        if (!stream.destroyed) stream.destroy();
      });
      return reply.send(stream);
    },
  );
}
