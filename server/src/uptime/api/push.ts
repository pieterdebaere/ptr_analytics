// Public push endpoint (docs/SPEC.md §8.4): GET|POST|HEAD /api/push/:token?status=up|down&msg=&ping=
// or GET|POST|HEAD /api/push with the token in an `X-Push-Token` header (keeps it out of access
// logs). No auth (the token is the credential), CORS *, rate limited per client IP and per token
// (token bucket: 1 push per second, bursts of 10). At most one beat per second is stored per
// monitor: pushes arriving faster are coalesced (the latest one is recorded a second after the
// previous beat). HEAD only checks the token (link scanners / unfurlers never record a beat).
// Only sha256(token) is stored; the lookup is by hash, so its timing does not depend on how much
// of a guessed token matches. Unknown, paused or suspended → the same 404.
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
/** Token bucket per push token: sustained rate and burst. */
export const PUSH_PER_TOKEN_PER_S = 1;
export const PUSH_TOKEN_BURST = 10;
export const PUSH_PER_IP_PER_MIN = 600;
/** Stored beats per monitor: at most one per this interval (faster pushes are coalesced). */
export const PUSH_COALESCE_MS = 1000;
export const PUSH_TOKEN_HEADER = 'x-push-token';
const DUMMY_HASH = sha256Hex('not-a-token');

type PushRoute = { Params: { token?: string }; Querystring: Record<string, unknown> };

function cors(reply: FastifyReply): void {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'X-Push-Token, Content-Type');
  reply.header('Access-Control-Max-Age', '86400');
}

/** Bounded token buckets (rate per second, burst), keyed by token hash. */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number,
    private readonly maxKeys = 50_000,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key);
    let tokens = this.burst;
    if (b) tokens = Math.min(this.burst, b.tokens + (Math.max(0, t - b.at) * this.perSecond) / 1000);
    if (tokens < 1) {
      if (b) {
        b.tokens = tokens;
        b.at = t;
      }
      return false;
    }
    this.buckets.delete(key);
    this.buckets.set(key, { tokens: tokens - 1, at: t });
    if (this.buckets.size > this.maxKeys) {
      // Evict refilled buckets first (they carry no state), then the least recently used.
      for (const [k, v] of this.buckets) {
        if (this.buckets.size <= this.maxKeys * 0.9) break;
        if (v.tokens + ((t - v.at) * this.perSecond) / 1000 >= this.burst) this.buckets.delete(k);
      }
      while (this.buckets.size > this.maxKeys) {
        const first = this.buckets.keys().next();
        if (first.done) break;
        this.buckets.delete(first.value);
      }
    }
    return true;
  }
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
  const perToken = new TokenBuckets(PUSH_PER_TOKEN_PER_S, PUSH_TOKEN_BURST, ctx.now, 50_000);
  const perIp = new RateLimiter(PUSH_PER_IP_PER_MIN, 60_000, ctx.now, 50_000);
  /** Per monitor: when the last beat was stored, and the latest push waiting to be stored. */
  const beats = new Map<number, { last: number; pending: PushInput | null; timer: NodeJS.Timeout | null }>();
  let closing = false;

  const store = (id: number, input: PushInput): void => {
    if (!ctx.db.open) return;
    // Re-read: the monitor may have been paused, deleted or suspended meanwhile.
    const m = repo.byId(id);
    if (!m || m.type !== 'push' || !m.active || m.siteSuspended) return;
    recordPush(ctx, m, input);
  };

  /** Store now, or coalesce into one beat a second after the previous one. */
  const coalesce = (m: MonitorRecord, input: PushInput): void => {
    const now = ctx.now();
    let st = beats.get(m.id);
    if (!st || now - st.last >= PUSH_COALESCE_MS || now < st.last) {
      if (st?.timer) clearTimeout(st.timer);
      beats.delete(m.id);
      beats.set(m.id, { last: now, pending: null, timer: null });
      recordPush(ctx, m, input);
      if (beats.size > 50_000) {
        for (const [id, v] of beats) {
          if (beats.size <= 40_000) break;
          if (v.timer === null) beats.delete(id);
        }
      }
      return;
    }
    st.pending = input; // the latest push wins
    if (st.timer !== null || closing) return;
    const entry = st;
    st.timer = setTimeout(() => {
      entry.timer = null;
      const pending = entry.pending;
      entry.pending = null;
      entry.last = ctx.now();
      if (pending && !closing) store(m.id, pending);
    }, Math.max(1, entry.last + PUSH_COALESCE_MS - now));
    st.timer.unref();
  };

  app.addHook('onClose', async () => {
    closing = true;
    for (const [id, st] of beats) {
      if (st.timer) clearTimeout(st.timer);
      if (st.pending) store(id, st.pending);
    }
    beats.clear();
    if (ctx.db.open) (uptimeRuntime(ctx).processor as { flush?: () => void } | null)?.flush?.();
  });

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
    const header = request.headers[PUSH_TOKEN_HEADER];
    const token = request.params.token ?? (typeof header === 'string' ? header.trim() : undefined);
    const valid = typeof token === 'string' && TOKEN_RE.test(token);
    const hash = valid ? sha256Hex(token) : DUMMY_HASH;
    const head = request.method === 'HEAD';
    if (!head && !perToken.take(hash)) {
      reply.header('Retry-After', '1');
      throw tooMany();
    }
    const input = parsePushQuery(request.query);
    const m = repo.byPushTokenHash(hash);
    if (!valid || !m || m.type !== 'push' || !m.active || m.siteSuspended) throw notFound();
    if (!head) coalesce(m, input);
    return { ok: true };
  };

  // HEAD is served by Fastify's automatic HEAD route for the GET handler (headers only; no beat).
  app.route<PushRoute>({ method: ['GET', 'POST'], url: '/api/push/:token', handler });
  app.route<PushRoute>({ method: ['GET', 'POST'], url: '/api/push', handler });
  app.options('/api/push/:token', async (_request, reply) => reply.code(204).send());
  app.options('/api/push', async (_request, reply) => reply.code(204).send());
}
