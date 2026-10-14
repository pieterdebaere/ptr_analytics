// Public push endpoint (docs/SPEC.md §8.4): GET|POST|HEAD /api/push/:token?status=up|down&msg=&ping=
// No auth (the token is the credential), CORS *, rate limited per token and per client IP. Only
// sha256(token) is stored; the lookup is by hash, so its timing does not depend on how much of a
// guessed token matches. Unknown, paused or suspended → the same 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { clientIp, rateLimitKey } from '../../lib/client-ip.js';
import { HttpError, notFound, tooMany } from '../../lib/errors.js';
import { sha256Hex } from '../../lib/ids.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { cleanText } from '../../lib/text.js';
import { MonitorRepo, type MonitorRecord } from '../data/monitors.js';
import { processorFor } from '../engine/processor.js';
import { isUnderMaintenance } from '../maintenance/index.js';
import { uptimeRuntime } from '../runtime.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const PUSH_PER_TOKEN_PER_MIN = 60;
export const PUSH_PER_IP_PER_MIN = 600;
const DUMMY_HASH = sha256Hex('not-a-token');

type PushRoute = { Params: { token: string }; Querystring: Record<string, unknown> };

function cors(reply: FastifyReply): void {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  reply.header('Access-Control-Max-Age', '86400');
}

function qs(q: Record<string, unknown>, key: string): string | undefined {
  const v = q[key];
  return typeof v === 'string' ? v : undefined;
}

export interface PushInput {
  ok: boolean;
  msg: string;
  latencyMs: number | null;
}

export function parsePushQuery(q: Record<string, unknown>): PushInput {
  const statusRaw = (qs(q, 'status') ?? 'up').toLowerCase();
  if (statusRaw !== 'up' && statusRaw !== 'down') throw new HttpError(400, 'status must be up or down');
  const msgRaw = qs(q, 'msg');
  if (msgRaw !== undefined && msgRaw.length > 2000) throw new HttpError(400, 'msg too long');
  const msg = cleanText((msgRaw ?? '').trim(), 200) || (statusRaw === 'up' ? 'OK' : 'Down');
  const pingRaw = qs(q, 'ping');
  let latencyMs: number | null = null;
  if (pingRaw !== undefined && /^\d{1,9}(\.\d{1,6})?$/.test(pingRaw)) latencyMs = Math.round(Number(pingRaw));
  return { ok: statusRaw === 'up', msg, latencyMs };
}

/** Record a push: through the running engine, or directly when no engine runs (tests, CLI). */
export function recordPush(ctx: AppContext, m: MonitorRecord, input: PushInput): void {
  const engine = uptimeRuntime(ctx).engine;
  if (engine) {
    engine.push(m.id, input);
    return;
  }
  const now = ctx.now();
  processorFor(ctx).record(m, { kind: 'check', ok: input.ok, msg: input.msg, latencyMs: input.latencyMs }, isUnderMaintenance(ctx.db, m.id, now), {
    ts: now,
    push: true,
  });
}

export async function pushRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const repo = new MonitorRepo(ctx.db);
  const perToken = new RateLimiter(PUSH_PER_TOKEN_PER_MIN, 60_000, ctx.now, 50_000);
  const perIp = new RateLimiter(PUSH_PER_IP_PER_MIN, 60_000, ctx.now, 50_000);

  // Any (small) body is accepted and ignored: push clients send all sorts of content types.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 8192 }, (_req, _body, done) => done(null, undefined));
  app.addHook('onRequest', async (_request, reply) => cors(reply));

  const handler = async (request: FastifyRequest<PushRoute>, reply: FastifyReply): Promise<unknown> => {
    const ipKey = rateLimitKey(clientIp(request));
    if (!perIp.hit(ipKey)) {
      reply.header('Retry-After', '60');
      throw tooMany();
    }
    const token = request.params.token;
    const valid = typeof token === 'string' && TOKEN_RE.test(token);
    const hash = valid ? sha256Hex(token) : DUMMY_HASH;
    if (!perToken.hit(hash)) {
      reply.header('Retry-After', '60');
      throw tooMany();
    }
    const input = parsePushQuery(request.query);
    const m = repo.byPushTokenHash(hash);
    if (!valid || !m || m.type !== 'push' || !m.active || m.siteSuspended) throw notFound();
    recordPush(ctx, m, input);
    return { ok: true };
  };

  // HEAD is served by Fastify's automatic HEAD route for the GET handler (headers only).
  app.route<PushRoute>({ method: ['GET', 'POST'], url: '/api/push/:token', handler });
  app.options('/api/push/:token', async (_request, reply) => reply.code(204).send());
}
