import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { hostnameAllowed } from '../lib/domains.js';
import { visitorId } from '../lib/salts.js';
import { isBot, parseUserAgent } from '../lib/ua.js';
import { parseIngestPayload } from '../ingest/payload.js';

export const INGEST_BODY_LIMIT = 8 * 1024;

function cors(reply: FastifyReply): void {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
  reply.header('Access-Control-Max-Age', '86400');
}

const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid payload' });

/** POST /api/event — the public ingest endpoint (spec 4.3). Encapsulated plugin. */
export async function ingestRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;

  // Trackers send JSON as text/plain (no CORS preflight). Parse it with Fastify's safe JSON
  // parser (prototype poisoning -> error). This parser only exists in this encapsulated context.
  const jsonParser = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: INGEST_BODY_LIMIT }, jsonParser);

  app.addHook('onRequest', async (_request, reply) => {
    cors(reply);
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status === 413) return reply.code(413).send({ error: 'payload too large' });
    if (status === 415) return reply.code(415).send({ error: 'unsupported media type' });
    if (status >= 400 && status < 500) return invalid(reply);
    request.log.error({ err }, 'ingest failed');
    return reply.code(500).send({ error: 'internal error' });
  });

  app.options('/api/event', async (_request, reply) => reply.code(204).send());

  app.post('/api/event', { bodyLimit: INGEST_BODY_LIMIT }, async (request, reply) => {
    const now = ctx.now();
    const ip = request.ip;
    if (ctx.limits.ingest && !ctx.limits.ingest.hit(ip)) {
      return reply.code(429).send({ error: 'too many requests' });
    }

    const payload = parseIngestPayload(request.body);
    if (!payload) return invalid(reply);

    const site = ctx.sites.byId(payload.site);
    if (!site) return invalid(reply);
    if (!hostnameAllowed(site.domains, payload.url.hostname)) return invalid(reply);

    const origin = request.headers.origin;
    if (origin !== undefined && origin !== 'null') {
      let originHost: string;
      try {
        originHost = new URL(origin).hostname;
      } catch {
        return invalid(reply);
      }
      if (!hostnameAllowed(site.domains, originHost)) return invalid(reply);
    }

    const userAgent = request.headers['user-agent'];
    if (isBot(userAgent)) return reply.code(202).send();
    const ua = userAgent as string;

    const salt = ctx.salts.current(now);
    ctx.ingest.write(
      payload,
      {
        visitorId: visitorId(salt, site.id, ip, ua),
        country: ctx.geo.lookup(ip, request.headers),
        ua: parseUserAgent(ua, payload.width),
      },
      now,
    );
    return reply.code(202).send();
  });
}
