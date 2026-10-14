import { createHmac } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { mapStatus } from '../src/billing/service.js';
import { HttpStripeClient, StripeError, parseSubscription, signStripePayload, verifyStripeSignature } from '../src/billing/stripe.js';
import { loadConfig } from '../src/config.js';
import {
  BILLING_ENV,
  CLOUD_URL,
  FakeStripe,
  api,
  captureMail,
  createCloudApp,
  login,
  makeFixtures,
  pageview,
  post,
  sendEvent,
  signupMember,
  type CloudTestApp,
} from './helpers.js';

const SECRET = BILLING_ENV['STRIPE_WEBHOOK_SECRET'] as string;

let t: CloudTestApp;
afterEach(async () => {
  await t?.app.close();
});

let evtSeq = 0;
function event(type: string, object: Record<string, unknown>, id = `evt_test${++evtSeq}`): Record<string, unknown> {
  return { id, object: 'event', type, data: { object } };
}

function webhook(
  body: unknown,
  o: { secret?: string; ts?: number; header?: string; contentType?: string } = {},
): Promise<LightMyRequestResponse> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const ts = o.ts ?? Math.floor(t.clock.t / 1000);
  return t.app.inject({
    method: 'POST',
    url: '/api/billing/webhook',
    headers: {
      'content-type': o.contentType ?? 'application/json; charset=utf-8',
      'stripe-signature': o.header ?? signStripePayload(raw, o.secret ?? SECRET, ts),
    },
    payload: raw,
  });
}

async function billingOf(cookie: string): Promise<Record<string, unknown>> {
  const res = await api(t.app, cookie, 'GET', '/api/billing');
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

async function createSites(cookie: string, n: number, prefix: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    t.clock.t += 1000;
    const res = await api(t.app, cookie, 'POST', '/api/sites', { name: `${prefix}${i}`, domains: [`${prefix}${i}.example`] });
    expect(res.statusCode, res.body).toBe(201);
    ids.push((res.json() as { site: { id: string } }).site.id);
  }
  return ids;
}

const suspendedOf = (ids: string[]) => ids.map((id) => t.ctx.sites.byId(id)?.suspended);

/** Member with a paid subscription for `paid` sites (checkout + completed webhook). */
async function subscribedMember(email: string, paid: number): Promise<{ cookie: string; id: number; customer: string; sub: string }> {
  const m = await signupMember(t, email);
  const res = await api(t.app, m.cookie, 'POST', '/api/billing/checkout', { paidSites: paid });
  expect(res.statusCode, res.body).toBe(200);
  const customer = t.ctx.users.billing(m.id)?.stripeCustomerId as string;
  const sub = t.stripe.addSubscription(customer, paid);
  const wh = await webhook(event('checkout.session.completed', { id: 'cs_1', customer, subscription: sub.id, client_reference_id: String(m.id) }));
  expect(wh.statusCode, wh.body).toBe(200);
  return { ...m, customer, sub: sub.id };
}

describe('webhook signature verification', () => {
  const body = Buffer.from('{"id":"evt_1"}');
  const now = 1_760_000_000_000;
  const ts = now / 1000;
  const sig = (b: Buffer | string, s = SECRET, at = ts) => createHmac('sha256', s).update(`${at}.`).update(b).digest('hex');

  it('accepts a valid signature', () => {
    expect(verifyStripeSignature(body, `t=${ts},v1=${sig(body)}`, SECRET, now)).toBe(true);
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, ts), SECRET, now + 299_000)).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and malformed headers', () => {
    expect(verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), `t=${ts},v1=${sig(body)}`, SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${ts},v1=${sig(body, 'whsec_other')}`, SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${ts + 1},v1=${sig(body)}`, SECRET, now)).toBe(false);
    for (const h of [undefined, '', `v1=${sig(body)}`, `t=${ts}`, `t=abc,v1=${sig(body)}`, `t=${ts},t=${ts},v1=${sig(body)}`, `t=${ts},v0=${sig(body)}`, 'x'.repeat(5000), ['a']]) {
      expect(verifyStripeSignature(body, h, SECRET, now)).toBe(false);
    }
    // v1 must be the hex HMAC (no truncation / other encodings)
    expect(verifyStripeSignature(body, `t=${ts},v1=${sig(body).slice(0, 62)}`, SECRET, now)).toBe(false);
  });

  it('rejects old and far-future timestamps (5 minute tolerance)', () => {
    expect(verifyStripeSignature(body, `t=${ts},v1=${sig(body)}`, SECRET, now + 301_000)).toBe(false);
    expect(verifyStripeSignature(body, `t=${ts},v1=${sig(body)}`, SECRET, now - 301_000)).toBe(false);
  });

  it('accepts when any of several v1 signatures matches (secret rotation)', () => {
    const header = `t=${ts},v1=${'0'.repeat(64)},v1=${sig(body)},v0=deadbeef`;
    expect(verifyStripeSignature(body, header, SECRET, now)).toBe(true);
    expect(verifyStripeSignature(body, `t=${ts},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`, SECRET, now)).toBe(false);
  });
});

describe('Stripe REST client', () => {
  it('sends form-encoded requests with a bearer key and parses subscriptions defensively', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new HttpStripeClient('sk_test_key123456', async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/checkout/sessions')) return Response.json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
      if (url.includes('/v1/subscriptions?')) {
        return Response.json({
          data: [{ id: 'sub_1', customer: 'cus_1', status: 'active', created: 5, cancel_at_period_end: false, items: { data: [{ id: 'si_1', quantity: 3, price: { id: 'price_x' } }] } }],
        });
      }
      return Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such customer: cus_secret' } }, { status: 404 });
    });
    const { url } = await client.createCheckoutSession({
      customerId: 'cus_1',
      priceId: 'price_x',
      quantity: 3,
      successUrl: `${CLOUD_URL}/billing?checkout=success`,
      cancelUrl: `${CLOUD_URL}/billing?checkout=cancel`,
      userId: 7,
      automaticTax: true,
    });
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    const first = calls[0]!;
    expect((first.init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk_test_key123456');
    const params = new URLSearchParams(first.init.body as string);
    expect(Object.fromEntries(params)).toEqual({
      mode: 'subscription',
      customer: 'cus_1',
      'line_items[0][price]': 'price_x',
      'line_items[0][quantity]': '3',
      success_url: `${CLOUD_URL}/billing?checkout=success`,
      cancel_url: `${CLOUD_URL}/billing?checkout=cancel`,
      client_reference_id: '7',
      'subscription_data[metadata][user_id]': '7',
      allow_promotion_codes: 'false',
      'automatic_tax[enabled]': 'true',
      'customer_update[address]': 'auto',
      'customer_update[name]': 'auto',
      billing_address_collection: 'required',
    });
    const subs = await client.listSubscriptions('cus_1');
    expect(subs).toEqual([{ id: 'sub_1', customer: 'cus_1', status: 'active', created: 5, cancelAtPeriodEnd: false, items: [{ id: 'si_1', priceId: 'price_x', quantity: 3 }] }]);
    expect(calls[1]!.url).toContain('customer=cus_1');
    const err = await client.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeError);
    expect(String(err)).not.toContain('cus_secret');
    expect(String(err)).not.toContain('sk_test');
    await client.cancelSubscription('sub_gone'); // 404 = already gone
    expect(() => parseSubscription({ id: 'sub_1' })).toThrow(StripeError);
    await expect(client.retrieveSubscription('../v1/customers')).rejects.toBeInstanceOf(StripeError);
  });

  it('maps Stripe statuses', () => {
    expect(mapStatus('incomplete_expired')).toBe('canceled');
    expect(mapStatus('paused')).toBe('unpaid');
    expect(mapStatus('weird')).toBe('incomplete');
    expect(mapStatus('past_due')).toBe('past_due');
  });
});

describe('billing flow', () => {
  it('reports the allowance and creates a Checkout session for a new customer', async () => {
    t = await createCloudApp({ billing: true });
    const m = await signupMember(t, 'payer@example.com');
    expect(await billingOf(m.cookie)).toEqual({
      enabled: true,
      freeSites: 1,
      pricePerSiteCents: 100,
      currency: 'eur',
      sitesUsed: 0,
      sitesAllowed: 1,
      paidSites: 0,
      status: 'none',
      hasCustomer: false,
      cancelAtPeriodEnd: false,
    });
    await createSites(m.cookie, 1, 'free');
    const over = await api(t.app, m.cookie, 'POST', '/api/sites', { name: 'two', domains: ['two.example'] });
    expect(over.statusCode).toBe(402);
    expect(over.json()).toEqual({ error: 'site limit reached', code: 'upgrade_required' });

    for (const bad of [0, 1001, 1.5, '2', null, -1]) {
      expect((await api(t.app, m.cookie, 'POST', '/api/billing/checkout', { paidSites: bad })).statusCode).toBe(400);
    }
    const res = await api(t.app, m.cookie, 'POST', '/api/billing/checkout', { paidSites: 2 });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { url: string }).url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const customer = t.ctx.users.billing(m.id)?.stripeCustomerId as string;
    expect(t.stripe.customers.get(customer)).toEqual({ email: 'payer@example.com', userId: m.id, deleted: false });
    expect(t.stripe.checkouts[0]).toEqual({
      customerId: customer,
      priceId: 'price_persite123',
      quantity: 2,
      successUrl: `${CLOUD_URL}/billing?checkout=success`,
      cancelUrl: `${CLOUD_URL}/billing?checkout=cancel`,
      userId: m.id,
      automaticTax: false,
    });
    // a second checkout reuses the customer
    expect((await api(t.app, m.cookie, 'POST', '/api/billing/checkout', { paidSites: 1 })).statusCode).toBe(200);
    expect(t.stripe.customers.size).toBe(1);
    expect(await billingOf(m.cookie)).toMatchObject({ hasCustomer: true, status: 'none' });
  });

  it('syncs the subscription from the API on webhooks and lifts the limit', async () => {
    t = await createCloudApp({ billing: true });
    const m = await subscribedMember('sub@example.com', 2);
    expect(await billingOf(m.cookie)).toMatchObject({ status: 'active', paidSites: 2, sitesAllowed: 3 });
    await createSites(m.cookie, 3, 's');
    expect((await api(t.app, m.cookie, 'POST', '/api/sites', { name: 'x', domains: ['x.example'] })).statusCode).toBe(402);
    // checkout is refused while subscribed
    const again = await api(t.app, m.cookie, 'POST', '/api/billing/checkout', { paidSites: 1 });
    expect(again.statusCode).toBe(409);
  });

  it('quantity changes update Stripe and recompute suspensions (oldest sites stay active)', async () => {
    t = await createCloudApp({ billing: true });
    const m = await subscribedMember('q@example.com', 3);
    const sites = await createSites(m.cookie, 4, 'q');
    expect(suspendedOf(sites)).toEqual([false, false, false, false]);

    // decrease: prorated credit, newest sites suspended
    let res = await api(t.app, m.cookie, 'POST', '/api/billing/quantity', { paidSites: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ billing: { paidSites: 1, sitesAllowed: 2, sitesUsed: 4, status: 'active' } });
    expect(t.stripe.updates.at(-1)?.p).toMatchObject({ item: { quantity: 1 }, prorationBehavior: 'create_prorations' });
    expect(suspendedOf(sites)).toEqual([false, false, true, true]);
    expect((await sendEvent(t.app, pageview(sites[3]!, 'https://q3.example/'))).statusCode).toBe(202);
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });

    // increase: invoiced now, only applied once paid
    res = await api(t.app, m.cookie, 'POST', '/api/billing/quantity', { paidSites: 3 });
    expect(t.stripe.updates.at(-1)?.p).toMatchObject({ item: { quantity: 3 }, prorationBehavior: 'always_invoice', paymentBehavior: 'pending_if_incomplete' });
    expect(suspendedOf(sites)).toEqual([false, false, false, false]);

    // a declined payment leaves the quantity (and the allowance) unchanged
    t.stripe.declineIncreases = true;
    res = await api(t.app, m.cookie, 'POST', '/api/billing/quantity', { paidSites: 10 });
    expect(res.json()).toMatchObject({ billing: { paidSites: 3 } });

    // 0 = cancel at period end; the paid sites stay until Stripe ends the subscription
    res = await api(t.app, m.cookie, 'POST', '/api/billing/quantity', { paidSites: 0 });
    expect(res.json()).toMatchObject({ billing: { paidSites: 3, cancelAtPeriodEnd: true, status: 'active' } });
    // resubscribe before the end
    t.stripe.declineIncreases = false;
    res = await api(t.app, m.cookie, 'POST', '/api/billing/quantity', { paidSites: 3 });
    expect(res.json()).toMatchObject({ billing: { paidSites: 3, cancelAtPeriodEnd: false } });

    // the subscription ends: only the free site stays active
    t.stripe.subs.get(m.sub)!.status = 'canceled';
    expect((await webhook(event('customer.subscription.deleted', { id: m.sub, customer: m.customer }))).statusCode).toBe(200);
    expect(await billingOf(m.cookie)).toMatchObject({ status: 'canceled', paidSites: 0, sitesAllowed: 1 });
    expect(suspendedOf(sites)).toEqual([false, true, true, true]);
    // nothing was deleted, and a new checkout is possible again
    expect(t.ctx.sites.countByOwner(m.id)).toBe(4);
    expect((await api(t.app, m.cookie, 'POST', '/api/billing/checkout', { paidSites: 1 })).statusCode).toBe(200);
    // deleting an active site lets the next oldest one become active
    expect((await api(t.app, m.cookie, 'DELETE', `/api/sites/${sites[0]}`)).statusCode).toBe(204);
    expect(suspendedOf(sites.slice(1))).toEqual([false, true, true]);
  });

  it('past_due keeps the paid sites; unpaid does not', async () => {
    t = await createCloudApp({ billing: true });
    const m = await subscribedMember('late@example.com', 2);
    t.stripe.subs.get(m.sub)!.status = 'past_due';
    await webhook(event('customer.subscription.updated', { id: m.sub, customer: m.customer }));
    expect(await billingOf(m.cookie)).toMatchObject({ status: 'past_due', paidSites: 2, sitesAllowed: 3 });
    t.stripe.subs.get(m.sub)!.status = 'unpaid';
    await webhook(event('customer.subscription.updated', { id: m.sub, customer: m.customer }));
    expect(await billingOf(m.cookie)).toMatchObject({ status: 'unpaid', paidSites: 0, sitesAllowed: 1 });
    expect((await api(t.app, m.cookie, 'POST', '/api/billing/quantity', { paidSites: 1 })).statusCode).toBe(409);
  });

  it('quantity needs an active subscription; portal needs a customer', async () => {
    t = await createCloudApp({ billing: true });
    const m = await signupMember(t, 'none@example.com');
    expect((await api(t.app, m.cookie, 'POST', '/api/billing/quantity', { paidSites: 1 })).statusCode).toBe(409);
    expect((await api(t.app, m.cookie, 'POST', '/api/billing/portal')).statusCode).toBe(409);
    await api(t.app, m.cookie, 'POST', '/api/billing/checkout', { paidSites: 1 });
    const portal = await api(t.app, m.cookie, 'POST', '/api/billing/portal');
    expect(portal.statusCode).toBe(200);
    expect((portal.json() as { url: string }).url).toMatch(/^https:\/\/billing\.stripe\.com\//);
  });

  it('billing endpoints are for members only and need the CSRF header', async () => {
    t = await createCloudApp({ billing: true });
    const admin = await login(t.app);
    expect((await api(t.app, admin, 'GET', '/api/billing')).statusCode).toBe(403);
    expect((await api(t.app, admin, 'POST', '/api/billing/checkout', { paidSites: 1 })).statusCode).toBe(403);
    expect((await api(t.app, admin, 'POST', '/api/billing/portal')).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/billing' })).statusCode).toBe(401);
    const m = await signupMember(t, 'csrf@example.com');
    const noHeader = await t.app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { cookie: m.cookie }, payload: { paidSites: 1 } });
    expect(noHeader.statusCode).toBe(403);
    expect(t.stripe.calls).toEqual([]);
  });

  it('Stripe failures become a generic 502 and are logged without secrets', async () => {
    const lines: string[] = [];
    const fixtures = makeFixtures();
    const stripe = new FakeStripe();
    const mail = captureMail();
    const app = await buildApp(
      loadConfig({ ...BILLING_ENV, DATA_DIR: fixtures.root, TRACKER_FILE: fixtures.trackerFile, DASHBOARD_DIR: fixtures.dashboardDir }),
      { dbPath: ':memory:', logStream: { write: (l: string) => lines.push(l) }, stripe, mailTransport: mail.transport },
    );
    t = { app, ctx: app.ctx, clock: { t: Date.now() }, fixtures, mail, stripe } as unknown as CloudTestApp;
    const m = await signupMember(t, 'fail@example.com');
    stripe.failing = true;
    const res = await api(app, m.cookie, 'POST', '/api/billing/checkout', { paidSites: 1 });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'payment provider unavailable, try again later' });
    const log = lines.join('\n');
    expect(log).toContain('Stripe customer creation failed');
    expect(log).not.toContain('sk_test_supersecretkey123');
    expect(log).not.toContain('whsec_');
    expect(log).not.toContain('smtp-secret');
  });
});

describe('webhook endpoint', () => {
  it('needs no session or CSRF header but a valid signature; dedupes event ids', async () => {
    t = await createCloudApp({ billing: true });
    const m = await signupMember(t, 'hook@example.com');
    await api(t.app, m.cookie, 'POST', '/api/billing/checkout', { paidSites: 1 });
    const customer = t.ctx.users.billing(m.id)?.stripeCustomerId as string;
    t.stripe.addSubscription(customer, 4);
    const ev = event('customer.subscription.created', { id: 'sub_x', customer, quantity: 999 });

    expect((await webhook(ev, { secret: 'whsec_wrong' })).statusCode).toBe(400);
    expect((await webhook(ev, { ts: Math.floor(t.clock.t / 1000) - 301 })).statusCode).toBe(400);
    expect((await webhook(ev, { header: '' })).statusCode).toBe(400);
    const tampered = JSON.stringify(ev).replace('"quantity":999', '"quantity":998');
    expect((await webhook(tampered, { header: signStripePayload(JSON.stringify(ev), SECRET, Math.floor(t.clock.t / 1000)) })).statusCode).toBe(400);
    expect(t.ctx.users.billing(m.id)?.paidSites).toBe(0);

    const before = t.stripe.calls.length;
    const ok = await webhook(ev);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ received: true });
    // state comes from the API (4), not from the payload (999)
    expect(t.ctx.users.billing(m.id)).toMatchObject({ paidSites: 4, status: 'active' });
    const calls = t.stripe.calls.length;
    expect(calls).toBeGreaterThan(before);
    const dup = await webhook(ev);
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toEqual({ received: true, duplicate: true });
    expect(t.stripe.calls.length).toBe(calls);
  });

  it('cannot be used to escalate: unknown customers, foreign references and other prices are ignored', async () => {
    t = await createCloudApp({ billing: true });
    const victim = await subscribedMember('victim@example.com', 1);
    const attacker = await signupMember(t, 'attacker@example.com');
    await api(t.app, attacker.cookie, 'POST', '/api/billing/checkout', { paidSites: 1 });
    const attackerCustomer = t.ctx.users.billing(attacker.id)?.stripeCustomerId as string;

    // unknown customer: no Stripe call, nothing changes
    const calls = t.stripe.calls.length;
    expect((await webhook(event('customer.subscription.updated', { id: 'sub_1', customer: 'cus_unknown' }))).statusCode).toBe(200);
    expect(t.stripe.calls.length).toBe(calls);
    // a checkout session whose reference points at another member is ignored
    await webhook(event('checkout.session.completed', { customer: attackerCustomer, client_reference_id: String(victim.id) }));
    expect(t.stripe.calls.length).toBe(calls);
    // the attacker's customer has a subscription on another price: not counted
    t.stripe.addSubscription(attackerCustomer, 50, 'active', 'price_other');
    await webhook(event('customer.subscription.created', { customer: attackerCustomer }));
    expect(t.ctx.users.billing(attacker.id)).toMatchObject({ paidSites: 0, status: 'none' });
    // a webhook naming the victim's customer only re-syncs the victim from Stripe
    await webhook(event('customer.subscription.updated', { customer: victim.customer, metadata: { user_id: String(attacker.id) } }));
    expect(t.ctx.users.billing(victim.id)).toMatchObject({ paidSites: 1, status: 'active' });
    expect(t.ctx.users.billing(attacker.id)).toMatchObject({ paidSites: 0 });
    // unrelated event types are acknowledged and ignored
    expect((await webhook(event('invoice.paid', { customer: attackerCustomer }))).statusCode).toBe(200);
  });

  it('releases the event id when Stripe fails so the retry is processed', async () => {
    t = await createCloudApp({ billing: true });
    const m = await signupMember(t, 'retry@example.com');
    await api(t.app, m.cookie, 'POST', '/api/billing/checkout', { paidSites: 1 });
    const customer = t.ctx.users.billing(m.id)?.stripeCustomerId as string;
    t.stripe.addSubscription(customer, 2);
    const ev = event('customer.subscription.created', { customer });
    t.stripe.failing = true;
    expect((await webhook(ev)).statusCode).toBe(502);
    t.stripe.failing = false;
    expect((await webhook(ev)).json()).toEqual({ received: true });
    expect(t.ctx.users.billing(m.id)?.paidSites).toBe(2);
  });

  it('enforces content type and the 1 MB body limit', async () => {
    t = await createCloudApp({ billing: true });
    expect((await webhook(event('x', {}), { contentType: 'text/plain' })).statusCode).toBe(415);
    const big = JSON.stringify({ id: 'evt_big', type: 'x', data: { object: {} }, pad: 'x'.repeat(1024 * 1024) });
    expect((await webhook(big)).statusCode).toBe(413);
    // up to 1 MB is accepted (unlike other API routes, limited to 64 KB)
    const mid = JSON.stringify({ id: 'evt_mid', type: 'invoice.paid', data: { object: {} }, pad: 'x'.repeat(200_000) });
    expect((await webhook(mid)).statusCode).toBe(200);
    expect((await webhook('{"id": "evt_bad"')).statusCode).toBe(400);
    expect((await webhook({ id: 'not-an-event', type: 'x', data: { object: {} } })).statusCode).toBe(400);
  });

  it('is 404 when billing is disabled', async () => {
    t = await createCloudApp();
    expect((await webhook(event('invoice.paid', {}))).statusCode).toBe(404);
    const m = await signupMember(t, 'free@example.com');
    expect((await api(t.app, m.cookie, 'POST', '/api/billing/checkout', { paidSites: 1 })).statusCode).toBe(404);
    expect(await billingOf(m.cookie)).toMatchObject({ enabled: false, sitesAllowed: 10 });
  });
});

describe('account deletion with billing', () => {
  it('cancels subscriptions and deletes the Stripe customer first', async () => {
    t = await createCloudApp({ billing: true });
    const m = await subscribedMember('bye@example.com', 2);
    t.stripe.failing = true;
    expect((await api(t.app, m.cookie, 'DELETE', '/api/account', { password: 'member password 123' })).statusCode).toBe(502);
    expect(t.ctx.users.byId(m.id)).not.toBeNull();
    t.stripe.failing = false;
    expect((await api(t.app, m.cookie, 'DELETE', '/api/account', { password: 'member password 123' })).statusCode).toBe(204);
    expect(t.stripe.subs.get(m.sub)?.status).toBe('canceled');
    expect(t.stripe.customers.get(m.customer)?.deleted).toBe(true);
    expect(t.ctx.users.byId(m.id)).toBeNull();
  });

  it('admin deletion of a member also cancels', async () => {
    t = await createCloudApp({ billing: true });
    const m = await subscribedMember('kicked@example.com', 1);
    const admin = await login(t.app);
    expect((await api(t.app, admin, 'DELETE', `/api/users/${m.id}`)).statusCode).toBe(204);
    expect(t.stripe.subs.get(m.sub)?.status).toBe('canceled');
  });
});

describe('startup', () => {
  it('recomputes suspensions when the allowance settings change', async () => {
    t = await createCloudApp({ env: { MEMBER_SITE_LIMIT: '5' } });
    const m = await signupMember(t, 'cfg@example.com');
    const ids = await createSites(m.cookie, 3, 'c');
    expect(suspendedOf(ids)).toEqual([false, false, false]);
    t.ctx.config.cloud.memberSiteLimit = 1;
    t.ctx.billing.recomputeAll();
    expect(suspendedOf(ids)).toEqual([false, true, true]);
    // members can still read suspended sites
    expect((await api(t.app, m.cookie, 'GET', `/api/sites/${ids[2]}/stats/summary`)).statusCode).toBe(200);
    expect((await post(t.app, '/api/auth/login', { email: 'cfg@example.com', password: 'member password 123' })).statusCode).toBe(200);
  });
});
