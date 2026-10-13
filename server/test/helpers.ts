import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildOptions } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { StripeError, type CheckoutParams, type StripeClient, type StripeSubscription } from '../src/billing/stripe.js';
import type { MailTransport, OutgoingMail } from '../src/mail.js';

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'correct horse battery';

export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
export const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
export const FIREFOX_MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:129.0) Gecko/20100101 Firefox/129.0';

export function tmpDir(prefix = 'pa-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Fixtures {
  root: string;
  trackerFile: string;
  dashboardDir: string;
}

/** A fake tracker build and dashboard build (with a dotfile that must never be served). */
export function makeFixtures(): Fixtures {
  const root = tmpDir();
  const trackerFile = path.join(root, 'tracker', 'script.js');
  fs.mkdirSync(path.dirname(trackerFile), { recursive: true });
  fs.writeFileSync(trackerFile, '(function(){window.pa=function(){}})();\n');
  const dashboardDir = path.join(root, 'dashboard');
  fs.mkdirSync(path.join(dashboardDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'index.html'), '<!doctype html><title>PTR</title><div id="root"></div>');
  fs.writeFileSync(path.join(dashboardDir, 'assets', 'app-abc123.js'), 'console.log("app");');
  fs.writeFileSync(path.join(dashboardDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dashboardDir, '.env'), 'SECRET=hunter2');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP-SECRET-OUTSIDE-ROOT');
  return { root, trackerFile, dashboardDir };
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  clock: { t: number };
  fixtures: Fixtures;
}

export async function createTestApp(
  opts: { env?: Record<string, string>; now?: number; build?: BuildOptions; fixtures?: Fixtures } = {},
): Promise<TestApp> {
  const fixtures = opts.fixtures ?? makeFixtures();
  const config = loadConfig({
    DATA_DIR: path.join(fixtures.root, 'data'),
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    TRACKER_FILE: fixtures.trackerFile,
    DASHBOARD_DIR: fixtures.dashboardDir,
    ...opts.env,
  });
  const clock = { t: opts.now ?? Date.UTC(2026, 5, 15, 12, 0, 0) };
  const app = await buildApp(config, { dbPath: ':memory:', logger: false, now: () => clock.t, ...opts.build });
  return { app, ctx: app.ctx, clock, fixtures };
}

export function cookieFrom(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first) throw new Error('no set-cookie header');
  return first.split(';')[0] as string;
}

export async function login(app: FastifyInstance, email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-pa-request': '1' },
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return cookieFrom(res);
}

/** Authenticated API call with the CSRF header. */
export function api(
  app: FastifyInstance,
  cookie: string,
  method: InjectOptions['method'],
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const req: InjectOptions = { method, url, headers: { cookie, 'x-pa-request': '1' } };
  if (payload !== undefined) req.payload = payload as InjectOptions['payload'];
  return app.inject(req);
}

export interface SendOptions {
  ua?: string;
  ip?: string;
  origin?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

/** POST /api/event as a tracker would (text/plain JSON). */
export function sendEvent(app: FastifyInstance, body: unknown, o: SendOptions = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {
    'content-type': o.contentType ?? 'text/plain;charset=UTF-8',
    'user-agent': o.ua ?? CHROME_UA,
    ...o.headers,
  };
  if (o.origin) headers['origin'] = o.origin;
  return app.inject({
    method: 'POST',
    url: '/api/event',
    headers,
    remoteAddress: o.ip ?? '203.0.113.1',
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function pageview(site: string, url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { site, type: 'pageview', url, ...extra };
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

// ---- hosted ("cloud") mode ----

export const CLOUD_URL = 'https://analytics.example.com';

export const CLOUD_ENV: Record<string, string> = {
  PUBLIC_URL: CLOUD_URL,
  SIGNUP_ENABLED: 'true',
  SMTP_URL: 'smtp://user:smtp-secret@127.0.0.1:2525',
  MAIL_FROM: 'PTR Analytics <no-reply@example.com>',
};

export const BILLING_ENV: Record<string, string> = {
  ...CLOUD_ENV,
  BILLING_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_test_supersecretkey123',
  STRIPE_WEBHOOK_SECRET: 'whsec_testwebhooksecret123',
  STRIPE_PRICE_ID: 'price_persite123',
  FREE_SITES: '1',
};

export interface MailCapture {
  sent: OutgoingMail[];
  transport: MailTransport;
}

export function captureMail(): MailCapture {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    transport: {
      async send(m) {
        sent.push(m);
      },
    },
  };
}

/** Extract the token from the (only) link in a captured mail. */
export function tokenFromMail(mail: OutgoingMail | undefined, page: 'verify' | 'reset'): string {
  if (!mail) throw new Error('no mail');
  const m = new RegExp(`${CLOUD_URL.replace(/[.]/g, '\\.')}/${page}\\?token=([A-Za-z0-9_-]{43})`).exec(mail.text);
  if (!m) throw new Error(`no ${page} link in mail: ${mail.text}`);
  return m[1] as string;
}

export interface CloudTestApp extends TestApp {
  mail: MailCapture;
  stripe: FakeStripe;
}

export async function createCloudApp(opts: { env?: Record<string, string>; billing?: boolean } = {}): Promise<CloudTestApp> {
  const mail = captureMail();
  const stripe = new FakeStripe();
  const t = await createTestApp({
    env: { ...(opts.billing ? BILLING_ENV : CLOUD_ENV), ...opts.env },
    build: { mailTransport: mail.transport, stripe },
  });
  return { ...t, mail, stripe };
}

/** POST with the CSRF header (no session). */
export function post(app: FastifyInstance, url: string, payload: unknown, ip = '198.51.100.7'): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url, headers: { 'x-pa-request': '1' }, remoteAddress: ip, payload: payload as InjectOptions['payload'] });
}

/** Sign up + verify a member through the API; returns its session cookie and id. */
export async function signupMember(t: CloudTestApp, email: string, password = 'member password 123'): Promise<{ cookie: string; id: number }> {
  const before = t.mail.sent.length;
  const res = await post(t.app, '/api/auth/signup', { email, password, acceptTerms: true }, `198.51.100.${(before % 200) + 1}`);
  if (res.statusCode !== 202) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  await t.ctx.mailer?.idle();
  const token = tokenFromMail(t.mail.sent[t.mail.sent.length - 1], 'verify');
  const v = await post(t.app, '/api/auth/verify', { token });
  if (v.statusCode !== 200) throw new Error(`verify failed: ${v.statusCode} ${v.body}`);
  return { cookie: cookieFrom(v), id: (v.json() as { user: { id: number } }).user.id };
}

let fakeSeq = 0;
const fakeId = (prefix: string): string => `${prefix}_${(++fakeSeq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** In-memory Stripe for tests (no network). */
export class FakeStripe implements StripeClient {
  customers = new Map<string, { email: string; userId: number; deleted: boolean }>();
  subs = new Map<string, StripeSubscription>();
  checkouts: CheckoutParams[] = [];
  updates: Array<{ id: string; p: Parameters<StripeClient['updateSubscription']>[1] }> = [];
  calls: string[] = [];
  /** When set, every call fails like an unreachable API. */
  failing = false;
  /** When set, quantity increases stay pending (payment failed). */
  declineIncreases = false;
  priceId = 'price_persite123';

  private check(name: string): void {
    this.calls.push(name);
    if (this.failing) throw new StripeError(500, 'api_error', undefined);
  }

  async createCustomer(p: { email: string; userId: number }): Promise<{ id: string }> {
    this.check('createCustomer');
    const id = fakeId('cus');
    this.customers.set(id, { ...p, deleted: false });
    return { id };
  }

  async createCheckoutSession(p: CheckoutParams): Promise<{ url: string }> {
    this.check('createCheckoutSession');
    this.checkouts.push(p);
    return { url: `https://checkout.stripe.com/c/pay/${fakeId('cs_test')}` };
  }

  async createPortalSession(p: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    this.check('createPortalSession');
    return { url: `https://billing.stripe.com/p/session/${p.customerId}` };
  }

  async listSubscriptions(customerId: string): Promise<StripeSubscription[]> {
    this.check('listSubscriptions');
    return [...this.subs.values()].filter((s) => s.customer === customerId).sort((a, b) => b.created - a.created).map((s) => structuredClone(s));
  }

  async retrieveSubscription(id: string): Promise<StripeSubscription> {
    this.check('retrieveSubscription');
    const s = this.subs.get(id);
    if (!s) throw new StripeError(404, 'invalid_request_error', 'resource_missing');
    return structuredClone(s);
  }

  async updateSubscription(id: string, p: Parameters<StripeClient['updateSubscription']>[1]): Promise<StripeSubscription> {
    this.check('updateSubscription');
    this.updates.push({ id, p });
    const s = this.subs.get(id);
    if (!s) throw new StripeError(404, 'invalid_request_error', 'resource_missing');
    if (p.cancelAtPeriodEnd !== undefined) s.cancelAtPeriodEnd = p.cancelAtPeriodEnd;
    if (p.item) {
      const item = s.items.find((i) => i.id === p.item?.id);
      if (!item) throw new StripeError(400, 'invalid_request_error', undefined);
      const pending = this.declineIncreases && p.paymentBehavior === 'pending_if_incomplete' && p.item.quantity > item.quantity;
      if (!pending) item.quantity = p.item.quantity;
    }
    return structuredClone(s);
  }

  async cancelSubscription(id: string): Promise<void> {
    this.check('cancelSubscription');
    const s = this.subs.get(id);
    if (s) s.status = 'canceled';
  }

  async deleteCustomer(id: string): Promise<void> {
    this.check('deleteCustomer');
    const c = this.customers.get(id);
    if (c) c.deleted = true;
  }

  /** Simulate a completed Checkout: a subscription for the customer. */
  addSubscription(customer: string, quantity: number, status = 'active', priceId = this.priceId): StripeSubscription {
    const sub: StripeSubscription = {
      id: fakeId('sub'),
      customer,
      status,
      created: Math.floor(Date.now() / 1000) + this.subs.size,
      cancelAtPeriodEnd: false,
      items: [{ id: fakeId('si'), priceId, quantity }],
    };
    this.subs.set(sub.id, sub);
    return sub;
  }
}
