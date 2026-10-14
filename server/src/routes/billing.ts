import type { FastifyError, FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireMember } from '../auth/access.js';
import { requireAuth } from '../auth/guard.js';
import { MAX_PAID_SITES } from '../billing/service.js';
import { verifyStripeSignature } from '../billing/stripe.js';
import { isPlainObject, field, objectBody } from '../lib/body.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';

/** Stripe events of the handled types are a few KB; 256 KB leaves ample headroom. */
export const WEBHOOK_BODY_LIMIT = 256 * 1024;
const EVENT_ID_RE = /^evt_[A-Za-z0-9_]{1,250}$/;

function parsePaidSites(v: unknown, min: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > MAX_PAID_SITES) {
    throw badRequest(`paidSites must be an integer between ${min} and ${MAX_PAID_SITES}`);
  }
  return v;
}

/** Member billing endpoints (spec 6.4). */
export async function billingRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const billing = ctx.billing;
  const publicUrl = ctx.config.publicUrl ?? '';
  const auth = requireAuth(ctx);

  /** Mutations need billing to be enabled (404 otherwise) and a member account (403). */
  const member = (request: { user: Parameters<typeof requireMember>[0] }) => {
    if (!billing.enabled) throw notFound();
    return requireMember(request.user);
  };

  app.get('/api/billing', { preHandler: auth }, async (request) => billing.summary(requireMember(request.user)));

  app.post('/api/billing/checkout', { preHandler: auth }, async (request) => {
    const user = member(request);
    const paidSites = parsePaidSites(field(objectBody(request.body), 'paidSites'), 1);
    const url = await billing.checkout(user, paidSites, {
      success: `${publicUrl}/billing?checkout=success`,
      cancel: `${publicUrl}/billing?checkout=cancel`,
    });
    return { url };
  });

  app.post('/api/billing/quantity', { preHandler: auth }, async (request) => {
    const user = member(request);
    const paidSites = parsePaidSites(field(objectBody(request.body), 'paidSites'), 0);
    return { billing: await billing.setQuantity(user, paidSites) };
  });

  app.post('/api/billing/portal', { preHandler: auth }, async (request) => {
    const user = member(request);
    return { url: await billing.portal(user, `${publicUrl}/billing`) };
  });
}

/**
 * POST /api/billing/webhook — encapsulated: the raw-body JSON parser (needed for the
 * signature) and the 256 KB limit only apply here. With billing disabled every request is
 * answered 404 in onRequest, before any body is read. No session, no CSRF header (exempted by
 * route in security.ts); authenticity comes from the Stripe signature alone.
 */
export async function billingWebhookRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const secret = ctx.config.cloud.stripeWebhookSecret;

  app.addHook('onRequest', async (_request, reply) => {
    if (!ctx.billing.enabled || secret === null) return reply.code(404).send({ error: 'not found' });
    return undefined;
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_req, body, done) => {
    done(null, body);
  });

  app.setErrorHandler((err: FastifyError | HttpError, request, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const status = err.statusCode ?? 500;
    if (status === 413) return reply.code(413).send({ error: 'payload too large' });
    if (status === 415) return reply.code(415).send({ error: 'unsupported media type' });
    if (status >= 400 && status < 500) return reply.code(400).send({ error: 'bad request' });
    request.log.error({ errName: err.name }, 'stripe webhook failed');
    return reply.code(500).send({ error: 'internal error' });
  });

  app.post('/api/billing/webhook', { bodyLimit: WEBHOOK_BODY_LIMIT }, async (request, reply) => {
    if (!ctx.billing.enabled || secret === null) throw notFound();
    const raw = request.body;
    if (!Buffer.isBuffer(raw)) throw badRequest();
    if (!verifyStripeSignature(raw, request.headers['stripe-signature'], secret, ctx.now())) {
      return reply.code(400).send({ error: 'invalid signature' });
    }
    let event: unknown;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw badRequest();
    }
    if (!isPlainObject(event)) throw badRequest();
    const id = event['id'];
    const type = event['type'];
    const data = event['data'];
    if (typeof id !== 'string' || !EVENT_ID_RE.test(id) || typeof type !== 'string' || type.length > 100) throw badRequest();
    const object = isPlainObject(data) && isPlainObject(data['object']) ? data['object'] : null;
    if (!object) throw badRequest();

    // Idempotency: claim the event id; a redelivery (or concurrent duplicate) is acknowledged.
    const claimed = ctx.db.prepare('INSERT OR IGNORE INTO stripe_events (id, received_at) VALUES (?, ?)').run(id, ctx.now());
    if (claimed.changes === 0) return { received: true, duplicate: true };
    try {
      await ctx.billing.handleEvent({ type, object });
    } catch (err) {
      // Release the claim so Stripe's retry is processed (the failure is already logged).
      ctx.db.prepare('DELETE FROM stripe_events WHERE id = ?').run(id);
      throw err instanceof HttpError ? err : new HttpError(500, 'internal error');
    }
    return { received: true };
  });
}
