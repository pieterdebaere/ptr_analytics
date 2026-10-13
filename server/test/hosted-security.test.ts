import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startupMessages } from '../src/app.js';
import { runCli } from '../src/cli.js';
import { ConfigError, isValidEmail, loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { purgeDeletedSites } from '../src/jobs/purge.js';
import { rateLimitKey48 } from '../src/lib/client-ip.js';
import { Mailer, smtpTransport, verifyEmailMail, type OutgoingMail } from '../src/mail.js';
import { WorkerPool, resolveWorkerEntry } from '../src/stats/pool.js';
import { DEFAULT_STATS_OPTIONS, Limiter, StatsService, statsService } from '../src/stats/service.js';
import {
  ADMIN_EMAIL,
  CLOUD_ENV,
  api,
  createCloudApp,
  createTestApp,
  login,
  pageview,
  post,
  sendEvent,
  signupMember,
  tmpDir,
  type CloudTestApp,
  type TestApp,
} from './helpers.js';

const PASSWORD = 'member password 123';

let t: CloudTestApp | TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

const cloud = async (env: Record<string, string> = {}, billing = false): Promise<CloudTestApp> => {
  const app = await createCloudApp({ env, billing });
  t = app;
  return app;
};

const count = (app: TestApp, sql: string, ...params: unknown[]): number =>
  (app.ctx.db.prepare(sql).get(...params) as { n: number }).n;

// ---- M2: addresses, global caps, mail queue ----

describe('email addresses (mail bombing via address parsing)', () => {
  it('accepts plain mailboxes only', () => {
    for (const ok of ['a@example.com', 'first.last+tag@sub.example.co.uk', "o'brien@example.ie", 'ü@exämple.de']) {
      expect(isValidEmail(ok), ok).toBe(true);
    }
    for (const bad of [
      'a<victim@example.com>',
      '"x"<victim@example.com>',
      'Name <victim@example.com>',
      'a@example.com,victim@example.com',
      'a@example.com;victim@example.com',
      '(comment)victim@example.com',
      '"a b"@example.com',
      'a@[127.0.0.1]',
      'a:b@example.com',
      'a\\b@example.com',
      'a @example.com',
      'a@b@example.com',
      `${'x'.repeat(65)}@example.com`,
      'a‮@example.com',
    ]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it('rejects display-name forms at sign-up and forgot-password', async () => {
    const app = await cloud();
    for (const email of ['a<victim@example.com>', '"x"<victim@example.com>', 'a@example.com, victim@example.com']) {
      expect((await post(app.app, '/api/auth/signup', { email, password: PASSWORD })).statusCode, email).toBe(400);
      expect((await post(app.app, '/api/auth/forgot', { email })).statusCode, email).toBe(400);
    }
    await app.ctx.mailer?.idle();
    expect(app.mail.sent).toHaveLength(0);
  });

  it('rate limits sign-ups per IPv6 /48 as well as per /64', async () => {
    expect(rateLimitKey48('2001:db8:aaaa:1::1')).toBe('2001:db8:aaaa::/48');
    expect(rateLimitKey48('203.0.113.1')).toBeNull();
    const app = await cloud();
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) {
      // a different /64 every time: the /64 bucket alone would never trigger
      const ip = `2001:db8:aaaa:${(i + 1).toString(16)}::1`;
      codes.push((await post(app.app, '/api/auth/signup', { email: `v6-${i}@example.com`, password: PASSWORD }, ip)).statusCode);
    }
    expect(codes.slice(0, 30).every((c) => c === 202)).toBe(true);
    expect(codes[30]).toBe(429);
    // another /48 is unaffected
    expect((await post(app.app, '/api/auth/signup', { email: 'v6-x@example.com', password: PASSWORD }, '2001:db8:bbbb:1::1')).statusCode).toBe(202);
  });

  it('caps sign-ups per hour globally (503, same for every address)', async () => {
    const app = await cloud({ SIGNUP_MAX_PER_HOUR: '2' });
    expect((await post(app.app, '/api/auth/signup', { email: 'g1@example.com', password: PASSWORD }, '192.0.2.1')).statusCode).toBe(202);
    expect((await post(app.app, '/api/auth/signup', { email: 'g2@example.com', password: PASSWORD }, '192.0.2.2')).statusCode).toBe(202);
    const fresh = await post(app.app, '/api/auth/signup', { email: 'g3@example.com', password: PASSWORD }, '192.0.2.3');
    const existing = await post(app.app, '/api/auth/signup', { email: ADMIN_EMAIL, password: PASSWORD }, '192.0.2.4');
    expect(fresh.statusCode).toBe(503);
    expect(fresh.json()).toEqual({ error: 'please try again later' });
    expect(existing.body).toBe(fresh.body);
    expect(app.ctx.users.byEmail('g3@example.com')).toBeNull();
    app.clock.t += 3_600_000;
    expect((await post(app.app, '/api/auth/signup', { email: 'g3@example.com', password: PASSWORD }, '192.0.2.3')).statusCode).toBe(202);
  });

  it('caps outgoing mail per hour: sign-up and forgot answer 503 instead of silently dropping', async () => {
    const app = await cloud({ MAIL_MAX_PER_HOUR: '2' });
    await signupMember(app, 'm1@example.com');
    expect((await post(app.app, '/api/auth/forgot', { email: 'm1@example.com' })).statusCode).toBe(202);
    // two mails sent this hour: whatever the address, the answer is now 503
    const known = await post(app.app, '/api/auth/forgot', { email: 'm1@example.com' }, '192.0.2.9');
    const unknown = await post(app.app, '/api/auth/forgot', { email: 'nobody@example.com' }, '192.0.2.9');
    expect(known.statusCode).toBe(503);
    expect(unknown.body).toBe(known.body);
    const signup = await post(app.app, '/api/auth/signup', { email: 'm2@example.com', password: PASSWORD }, '192.0.2.10');
    expect(signup.statusCode).toBe(503);
    expect(app.ctx.users.byEmail('m2@example.com')).toBeNull();
    await app.ctx.mailer?.idle();
    expect(app.mail.sent).toHaveLength(2);
  });

  it('caps the number of unverified accounts', async () => {
    const app = await cloud({ MAX_UNVERIFIED_ACCOUNTS: '2' });
    for (const [i, email] of ['u1@example.com', 'u2@example.com'].entries()) {
      expect((await post(app.app, '/api/auth/signup', { email, password: PASSWORD }, `192.0.2.${i + 1}`)).statusCode).toBe(202);
    }
    expect((await post(app.app, '/api/auth/signup', { email: 'u3@example.com', password: PASSWORD }, '192.0.2.3')).statusCode).toBe(503);
    expect(app.ctx.users.countUnverified()).toBe(2);
  });

  it('SMTP: STARTTLS required for smtp:// unless allowed, recipient passed as an address object', async () => {
    const created: Array<Record<string, unknown>> = [];
    const mails: Array<Record<string, unknown>> = [];
    const fake = (options: unknown) => {
      created.push(options as Record<string, unknown>);
      return { sendMail: async (m: unknown) => void mails.push(m as Record<string, unknown>), close: () => {} } as never;
    };
    await smtpTransport('smtp://u:p@mail.example.com:587', {}, fake).send({
      ...verifyEmailMail('https://x/verify#token=1'),
      from: 'PTR <no-reply@example.com>',
      to: 'user@example.com',
    });
    smtpTransport('smtp://u:p@localhost:25', { allowInsecure: true }, fake);
    smtpTransport('smtps://u:p@mail.example.com:465', {}, fake);
    expect(created.map((c) => c['requireTLS'])).toEqual([true, undefined, undefined]);
    expect(mails[0]?.['to']).toEqual({ name: '', address: 'user@example.com' });
  });

  it('mailer: bounded queue, hourly cap, one queued mail per recipient and template', async () => {
    const sent: OutgoingMail[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const log = { warn: () => {}, error: () => {} };
    const mailer = new Mailer(
      {
        async send(m) {
          await gate;
          sent.push(m);
        },
      },
      'PTR <no-reply@example.com>',
      log,
      { maxQueue: 2, maxPerHour: 10 },
    );
    // two are sending right away (concurrency 2), the rest waits in the queue
    expect(mailer.send('a@example.com', verifyEmailMail('https://x/verify#token=1'))).toBe('queued');
    expect(mailer.send('b@example.com', verifyEmailMail('https://x/verify#token=2'))).toBe('queued');
    expect(mailer.send('c@example.com', verifyEmailMail('https://x/verify#token=3'))).toBe('queued');
    expect(mailer.send('C@example.com', verifyEmailMail('https://x/verify#token=4'))).toBe('replaced');
    expect(mailer.send('d@example.com', verifyEmailMail('https://x/verify#token=5'))).toBe('queued');
    expect(mailer.hasCapacity()).toBe(false);
    expect(mailer.send('e@example.com', verifyEmailMail('https://x/verify#token=6'))).toBe('rejected');
    release();
    await mailer.idle();
    expect(sent.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com', 'C@example.com', 'd@example.com']);
    expect(sent[2]?.text).toContain('token=4');
    expect(mailer.hasCapacity()).toBe(true);
    await mailer.close();
  });
});

// ---- hosted-mode configuration ----

describe('hosted-mode configuration', () => {
  const base = { DATA_DIR: '/tmp/x' };
  it('requires an https PUBLIC_URL unless explicitly allowed for development', () => {
    expect(() => loadConfig({ ...base, ...CLOUD_ENV, PUBLIC_URL: 'http://analytics.example.com' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ...CLOUD_ENV, PUBLIC_URL: 'http://analytics.example.com' })).toThrow(/https/);
    const dev = loadConfig({ ...base, ...CLOUD_ENV, PUBLIC_URL: 'http://localhost:3000', ALLOW_INSECURE_PUBLIC_URL: 'true' });
    expect(dev.cloud.signupEnabled).toBe(true);
    expect(startupMessages(dev).warn.join('\n')).toMatch(/ALLOW_INSECURE_PUBLIC_URL/);
    // self-hosted mode is unaffected
    expect(loadConfig({ ...base, PUBLIC_URL: 'http://analytics.example.com' }).publicUrl).toBe('http://analytics.example.com');
  });

  it('has env-configurable global caps with sane defaults', () => {
    expect(loadConfig({ ...base, ...CLOUD_ENV }).cloud).toMatchObject({
      signupMaxPerHour: 200,
      mailMaxPerHour: 500,
      maxUnverifiedAccounts: 5000,
      smtpAllowInsecure: false,
    });
    expect(() => loadConfig({ ...base, ...CLOUD_ENV, MAIL_MAX_PER_HOUR: '0' })).toThrow(ConfigError);
  });

  it('warns loudly about TRUST_PROXY=false and cleartext SMTP', () => {
    const noProxy = startupMessages(loadConfig({ ...base, ...CLOUD_ENV }));
    expect(noProxy.warn.join('\n')).toMatch(/TRUST_PROXY=false/);
    expect(startupMessages(loadConfig({ ...base, ...CLOUD_ENV, TRUST_PROXY: '1' })).warn.join('\n')).not.toMatch(/TRUST_PROXY=false/);
    // smtp:// requires STARTTLS by default (no warning); opting out warns
    expect(noProxy.warn.join('\n')).not.toMatch(/cleartext/);
    const insecure = startupMessages(loadConfig({ ...base, ...CLOUD_ENV, TRUST_PROXY: '1', SMTP_ALLOW_INSECURE: 'true' }));
    expect(insecure.warn.join('\n')).toMatch(/cleartext/);
    expect(insecure.warn.join('\n')).not.toContain('smtp-secret');
  });

  it('CLI refuses viewers in hosted mode', async () => {
    const env = { ...CLOUD_ENV, DATA_DIR: tmpDir() };
    await expect(runCli(['create-user', 'v@example.com', 'viewer'], env, () => {})).rejects.toThrow(/hosted mode/);
  });
});

// ---- L3: webhook body limit ----

describe('Stripe webhook route', () => {
  it('rejects before reading the body when billing is disabled', async () => {
    const app = await cloud();
    const res = await app.app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: `{"x":"${'a'.repeat(900_000)}"}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('accepts at most 256 KB when billing is enabled', async () => {
    const app = await cloud({}, true);
    const res = await app.app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' },
      payload: `{"x":"${'a'.repeat(300_000)}"}`,
    });
    expect(res.statusCode).toBe(413);
  });
});

// ---- L1: Stripe and role changes / deletions ----

describe('Stripe subscriptions and role changes', () => {
  async function paying(app: CloudTestApp, email: string): Promise<{ id: number; customer: string; sub: string }> {
    const m = await signupMember(app, email);
    const { id: customer } = await app.stripe.createCustomer({ email, userId: m.id });
    app.ctx.users.setStripeCustomer(m.id, customer);
    const sub = app.stripe.addSubscription(customer, 1);
    app.ctx.billing.applySubscriptions(m.id, customer, [sub]);
    return { id: m.id, customer, sub: sub.id };
  }

  it('blocks role changes away from member while a subscription is live', async () => {
    const app = await cloud({}, true);
    const m = await paying(app, 'payer@example.com');
    const admin = await login(app.app);
    const res = await api(app.app, admin, 'PATCH', `/api/users/${m.id}`, { role: 'admin' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: expect.stringMatching(/active subscription/) });
    expect(app.ctx.users.byId(m.id)?.role).toBe('member');
    // once cancelled the role can change
    app.stripe.subs.get(m.sub)!.status = 'canceled';
    app.ctx.billing.applySubscriptions(m.id, m.customer, [...app.stripe.subs.values()]);
    expect((await api(app.app, admin, 'PATCH', `/api/users/${m.id}`, { role: 'admin' })).statusCode).toBe(200);
  });

  it('deleting any user with a Stripe customer cancels its subscriptions and deletes the customer', async () => {
    const app = await cloud({}, true);
    const m = await paying(app, 'former@example.com');
    const admin = await login(app.app);
    app.stripe.subs.get(m.sub)!.status = 'canceled';
    app.ctx.billing.applySubscriptions(m.id, m.customer, [...app.stripe.subs.values()]);
    expect((await api(app.app, admin, 'PATCH', `/api/users/${m.id}`, { role: 'admin' })).statusCode).toBe(200);
    // a subscription started later (e.g. an old Checkout link) is not known locally
    const late = app.stripe.addSubscription(m.customer, 2);
    app.stripe.failing = true;
    expect((await api(app.app, admin, 'DELETE', `/api/users/${m.id}`)).statusCode).toBe(502);
    expect(app.ctx.users.byId(m.id)).not.toBeNull();
    app.stripe.failing = false;
    expect((await api(app.app, admin, 'DELETE', `/api/users/${m.id}`)).statusCode).toBe(204);
    expect(app.stripe.subs.get(late.id)?.status).toBe('canceled');
    expect(app.stripe.customers.get(m.customer)?.deleted).toBe(true);
  });

  it('CLI delete-user refuses accounts with a Stripe customer', async () => {
    const dir = tmpDir();
    const env = { DATA_DIR: dir };
    await runCli(['create-user', 'cust@example.com', 'member'], env, () => {});
    const db = openDatabase(path.join(dir, 'analytics.db'));
    db.prepare(`UPDATE users SET stripe_customer_id = 'cus_123' WHERE email = 'cust@example.com'`).run();
    db.close();
    await expect(runCli(['delete-user', 'cust@example.com'], env, () => {})).rejects.toThrow(/Stripe customer/);
  });
});

// ---- M3: soft delete ----

function bulkInsert(app: TestApp, siteId: string, n: number): void {
  const ev = app.ctx.db.prepare(
    `INSERT INTO events (site_id, ts, type, visitor_id, session_id, hostname, path) VALUES (?, ?, 'pageview', ?, ?, 'example.com', '/')`,
  );
  const se = app.ctx.db.prepare('INSERT INTO sessions (id, site_id, visitor_id, started_at, last_seen_at, pageviews) VALUES (?, ?, ?, ?, ?, 1)');
  const vi = app.ctx.db.prepare(`INSERT INTO vitals (site_id, ts, metric, value, hostname, path) VALUES (?, ?, 'LCP', 1000, 'example.com', '/')`);
  app.ctx.db.transaction(() => {
    for (let i = 0; i < n; i++) {
      ev.run(siteId, app.clock.t - i, `v${i % 500}`, `s${siteId}${i % 2000}`);
      if (i < 2000) se.run(`s${siteId}${i}`, siteId, `v${i % 500}`, app.clock.t, app.clock.t);
      if (i % 10 === 0) vi.run(siteId, app.clock.t - i);
    }
  })();
}

describe('soft-deleted sites', () => {
  it('disappear at once everywhere, keep their data until the background purge, then are gone', async () => {
    const app = await cloud();
    const m = await signupMember(app, 'owner@example.com');
    const admin = await login(app.app);
    const created = await api(app.app, m.cookie, 'POST', '/api/sites', { name: 'Big', domains: ['big.example'] });
    const id = (created.json() as { site: { id: string } }).site.id;
    const keep = app.ctx.sites.create('Keep', ['keep.example'], app.clock.t, m.id).id;
    bulkInsert(app, id, 30_000);
    bulkInsert(app, keep, 100);
    await sendEvent(app.app, pageview(id, 'https://big.example/live'));

    // the repository-level delete is a flag: no cascade over the analytics rows
    app.ctx.sites.delete(id, app.clock.t);
    expect(count(app, 'SELECT COUNT(*) AS n FROM events WHERE site_id = ?', id)).toBe(30_001);
    for (const [cookie, who] of [
      [m.cookie, 'member'],
      [admin, 'admin'],
    ] as const) {
      for (const p of [`/api/sites/${id}`, `/api/sites/${id}/stats/summary`, `/api/sites/${id}/stats/live`, `/api/sites/${id}/export`]) {
        expect((await api(app.app, cookie, 'GET', p)).statusCode, `${who} ${p}`).toBe(404);
      }
      expect((await api(app.app, cookie, 'DELETE', `/api/sites/${id}`)).statusCode).toBe(404);
      const list = (await api(app.app, cookie, 'GET', '/api/sites')).json() as { sites: Array<{ id: string }> };
      expect(list.sites.map((s) => s.id)).not.toContain(id);
      const overview = (await api(app.app, cookie, 'GET', '/api/overview?period=7d')).json() as { sites: Array<{ id: string }> };
      expect(overview.sites.map((s) => s.id)).not.toContain(id);
      const live = (await api(app.app, cookie, 'GET', '/api/live')).json() as { sites: Array<{ id: string }> };
      expect(live.sites.map((s) => s.id)).not.toContain(id);
    }
    // ingest treats it like an unknown site
    expect((await sendEvent(app.app, pageview(id, 'https://big.example/'))).statusCode).toBe(400);
    // it no longer counts against the allowance
    expect(((await api(app.app, m.cookie, 'GET', '/api/billing')).json() as { sitesUsed: number }).sitesUsed).toBe(1);

    // the purge deletes in chunks and yields to the event loop between them
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    try {
      expect(await purgeDeletedSites(app.ctx)).toBe(1);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(1);
    for (const table of ['events', 'sessions', 'vitals']) {
      expect(count(app, `SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ?`, id), table).toBe(0);
    }
    expect(count(app, 'SELECT COUNT(*) AS n FROM sites WHERE id = ?', id)).toBe(0);
    expect(count(app, 'SELECT COUNT(*) AS n FROM events WHERE site_id = ?', keep)).toBe(100);
  });

  it('DELETE /api/sites/:id soft-deletes and schedules the purge', async () => {
    const app = await cloud();
    const m = await signupMember(app, 'del@example.com');
    const id = ((await api(app.app, m.cookie, 'POST', '/api/sites', { name: 'S', domains: ['s.example'] })).json() as { site: { id: string } }).site.id;
    bulkInsert(app, id, 500);
    expect((await api(app.app, m.cookie, 'DELETE', `/api/sites/${id}`)).statusCode).toBe(204);
    expect(app.ctx.sites.byId(id)).toBeNull();
    for (let i = 0; i < 100 && count(app, 'SELECT COUNT(*) AS n FROM sites WHERE id = ?', id) > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(count(app, 'SELECT COUNT(*) AS n FROM sites WHERE id = ?', id)).toBe(0);
    expect(count(app, 'SELECT COUNT(*) AS n FROM events WHERE site_id = ?', id)).toBe(0);
  });

  it('deleting an account detaches its sites first: no synchronous cascade into their data', async () => {
    const app = await cloud();
    const m = await signupMember(app, 'gone@example.com');
    const ids = [1, 2].map((i) => app.ctx.sites.create(`G${i}`, [`g${i}.example`], app.clock.t, m.id).id);
    for (const id of ids) bulkInsert(app, id, 5000);

    app.ctx.users.delete(m.id, app.clock.t);
    expect(app.ctx.users.byId(m.id)).toBeNull();
    // the user's sites are hidden and ownerless, their rows untouched until the purge
    expect(ids.map((id) => app.ctx.sites.byId(id))).toEqual([null, null]);
    expect(app.ctx.db.prepare(`SELECT owner_id, deleted_at IS NOT NULL AS deleted FROM sites WHERE id IN (?, ?)`).all(...ids)).toEqual([
      { owner_id: null, deleted: 1 },
      { owner_id: null, deleted: 1 },
    ]);
    expect(count(app, 'SELECT COUNT(*) AS n FROM events')).toBe(10_000);
    expect(await purgeDeletedSites(app.ctx)).toBe(2);
    expect(count(app, 'SELECT COUNT(*) AS n FROM events')).toBe(0);
    expect(count(app, 'SELECT COUNT(*) AS n FROM sites')).toBe(0);
  });

  it('DELETE /api/account goes through the same path', async () => {
    const app = await cloud();
    const m = await signupMember(app, 'self@example.com');
    const id = ((await api(app.app, m.cookie, 'POST', '/api/sites', { name: 'S', domains: ['s.example'] })).json() as { site: { id: string } }).site.id;
    bulkInsert(app, id, 1000);
    expect((await api(app.app, m.cookie, 'DELETE', '/api/account', { password: PASSWORD })).statusCode).toBe(204);
    expect(app.ctx.sites.byId(id)).toBeNull();
    await purgeDeletedSites(app.ctx);
    expect(count(app, 'SELECT COUNT(*) AS n FROM events')).toBe(0);
  });
});

// ---- M4: stats / export fairness ----

describe('stats and export fairness', () => {
  it('keeps global query slots for users with nothing in flight', () => {
    const l = new Limiter(10, 6, 8); // reserve is capped at a quarter: 2
    const a = Array.from({ length: 6 }, () => l.tryAcquire('a'));
    expect(a.every((r) => r !== null)).toBe(true);
    expect(l.tryAcquire('a')).toBeNull(); // per-user cap
    expect(l.tryAcquire('b')).not.toBeNull(); // 7
    expect(l.tryAcquire('b')).not.toBeNull(); // 8
    expect(l.tryAcquire('b')).toBeNull(); // only first requests may use the last 2 slots
    expect(l.tryAcquire('c')).not.toBeNull(); // 9
    expect(l.tryAcquire('d')).not.toBeNull(); // 10
    expect(l.tryAcquire('e')).toBeNull(); // full
    a[0]!();
    expect(l.tryAcquire('e')).not.toBeNull();
    expect(DEFAULT_STATS_OPTIONS).toMatchObject({ maxInFlight: 32, maxInFlightPerUser: 6, reservedInFlight: 8, maxExports: 2, maxExportsPerUser: 1 });
  });

  it('aborts exports that make no progress or run too long, freeing the slot', async () => {
    const app = await createTestApp();
    t = app;
    const siteId = app.ctx.sites.create('S', ['example.com'], app.clock.t).id;
    const spec = { siteId, from: 0, to: app.clock.t + 1, filters: { columns: [] } };

    const idle = new StatsService(app.ctx, { ...DEFAULT_STATS_OPTIONS, exportIdleTimeoutMs: 50 });
    const session = await idle.openExport('u1', spec);
    const reasons: string[] = [];
    session.onAbort((r) => reasons.push(r));
    expect(idle.exportsInFlight).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(reasons).toEqual(['idle']);
    expect(idle.exportsInFlight).toBe(0);
    expect((await session.next()).done).toBe(true);
    await idle.close();

    const long = new StatsService(app.ctx, { ...DEFAULT_STATS_OPTIONS, exportIdleTimeoutMs: 10_000, exportMaxDurationMs: 60 });
    const s2 = await long.openExport('u1', spec);
    await new Promise((r) => setTimeout(r, 120));
    expect(s2.aborted).toBe('duration');
    expect(long.exportsInFlight).toBe(0);
    await long.close();
  });

  it('cuts off a client that stops reading an export (slow-reading client)', async () => {
    const app = await createTestApp({ build: { statsOptions: { exportIdleTimeoutMs: 300 } } });
    t = app;
    const cookie = await login(app.app);
    const siteId = app.ctx.sites.create('S', ['example.com'], app.clock.t).id;
    bulkInsert(app, siteId, 150_000);
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.app.server.address() as AddressInfo;
    const service = statsService(app.ctx);

    // the server side of the connection: it must be closed by the server
    const serverClosed = new Promise<void>((resolve) => {
      app.app.server.once('connection', (socket) => socket.once('close', () => resolve()));
    });
    let status: number | undefined;
    const req = http.get({ host: '127.0.0.1', port, path: `/api/sites/${siteId}/export?period=7d`, headers: { cookie } }, (res) => {
      status = res.statusCode;
      // read nothing: the server's buffers fill up and the export stops making progress
      res.pause();
    });
    req.on('error', () => {});
    for (let i = 0; i < 100 && service.exportsInFlight === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(service.exportsInFlight).toBe(1);
    const started = Date.now();
    await serverClosed;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(status).toBe(200);
    expect(service.exportsInFlight).toBe(0);
    req.destroy();
    // the slot is free for the next export of the same user
    const next = await service.openExport('u1', { siteId, from: 0, to: app.clock.t + 1, filters: { columns: [] } });
    next.close();
  }, 30_000);

  it('serves queued queries fairly between users (worker pool)', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'analytics.db');
    const app = await createTestApp({ build: { dbPath } });
    t = app;
    const entry = resolveWorkerEntry();
    expect(entry).not.toBeNull();
    const pool = new WorkerPool(dbPath, entry!, 1, 30_000);
    try {
      const order: string[] = [];
      const op = (n: number) => ({ kind: 'realtime' as const, siteId: 'x', now: n });
      const runs = [
        ...[1, 2, 3, 4, 5].map((n) => pool.run(op(n), undefined, 'heavy').then(() => order.push(`heavy${n}`))),
        pool.run(op(6), undefined, 'light').then(() => order.push('light')),
      ];
      await Promise.all(runs);
      // the light user's single query runs right after the heavy user's first, not after all five
      expect(order).toEqual(['heavy1', 'light', 'heavy2', 'heavy3', 'heavy4', 'heavy5']);
    } finally {
      await pool.close();
    }
  }, 30_000);
});
