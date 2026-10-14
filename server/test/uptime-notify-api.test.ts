import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../src/lib/password.js';
import type { AppContext } from '../src/context.js';
import { startNotifier } from '../src/uptime/notify/dispatcher.js';
import { setNotifyOverrides } from '../src/uptime/notify/state.js';
import { CLOUD_URL, api, captureMail, createCloudApp, createTestApp, login, signupMember, type CloudTestApp } from './helpers.js';
import { FakeNet, TEST_SECRETS_KEY, downPayload } from './uptime-notify-fakes.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

async function selfHosted(env: Record<string, string> = {}) {
  const mail = captureMail();
  const t = await createTestApp({ env: { SECRETS_KEY: TEST_SECRETS_KEY, PUBLIC_URL: CLOUD_URL, ...env } });
  apps.push(t.app);
  const net = new FakeNet();
  setNotifyOverrides(t.ctx, { net: () => net, mailTransport: mail.transport });
  const cookie = await login(t.app);
  return { ...t, net, mail, cookie };
}

async function cloud(env: Record<string, string> = {}) {
  const t = await createCloudApp({ env: { SECRETS_KEY: TEST_SECRETS_KEY, ...env } });
  apps.push(t.app);
  const net = new FakeNet();
  setNotifyOverrides(t.ctx, { net: () => net });
  return { ...t, net };
}

let monitorSeq = 0;
function addMonitor(ctx: AppContext, siteId: string): { id: number; uid: string } {
  const uid = `mon${String(++monitorSeq).padStart(9, '0')}`;
  const now = ctx.now();
  const r = ctx.db
    .prepare(
      `INSERT INTO monitors (uid, site_id, type, name, interval_s, retry_interval_s, timeout_ms, config, created_at, updated_at)
       VALUES (?, ?, 'http', ?, 60, 60, 10000, '{}', ?, ?)`,
    )
    .run(uid, siteId, `Monitor ${uid}`, now, now);
  return { id: Number(r.lastInsertRowid), uid };
}

const WEBHOOK = { type: 'webhook', name: 'Ops hook', config: { url: 'https://hooks.example.com/ptr', signingSecret: 'sig-secret-123' } };

describe('providers endpoint', () => {
  it('lists providers with fields; members do not see self-hosted-only fields', async () => {
    const s = await selfHosted();
    const res = await api(s.app, s.cookie, 'GET', '/api/notification-providers');
    expect(res.statusCode).toBe(200);
    const providers = (res.json() as { providers: Array<{ id: string; hostedAllowed: boolean; fields: Array<{ key: string }>; presets?: unknown[] }> }).providers;
    const email = providers.find((p) => p.id === 'email');
    expect(email?.fields.map((f) => f.key)).toContain('smtpUrl');
    expect(providers.find((p) => p.id === 'webhook')?.presets?.length).toBeGreaterThan(0);
    expect(providers.every((p) => typeof p.hostedAllowed === 'boolean')).toBe(true);

    const c = await cloud();
    const m = await signupMember(c, 'a@example.com');
    const r2 = await api(c.app, m.cookie, 'GET', '/api/notification-providers');
    const email2 = (r2.json() as { providers: Array<{ id: string; fields: Array<{ key: string }> }> }).providers.find((p) => p.id === 'email');
    expect(email2?.fields.map((f) => f.key)).toEqual(['to']);
  });

  it('requires a session', async () => {
    const s = await selfHosted();
    expect((await s.app.inject({ method: 'GET', url: '/api/notification-channels' })).statusCode).toBe(401);
    const post = await s.app.inject({ method: 'POST', url: '/api/notification-channels', headers: { cookie: s.cookie }, payload: WEBHOOK });
    expect(post.statusCode).toBe(403); // CSRF header missing
  });
});

describe('channel CRUD and write-only secrets', () => {
  it('never returns secrets; "" keeps, null clears', async () => {
    const s = await selfHosted();
    const res = await api(s.app, s.cookie, 'POST', '/api/notification-channels', { ...WEBHOOK, isDefault: true });
    expect(res.statusCode).toBe(201);
    const ch = (res.json() as { channel: Record<string, any> }).channel;
    expect(ch.uid).toMatch(/^[a-z0-9]{12}$/);
    expect(ch.secretsSet).toEqual(['signingSecret']);
    expect(ch.config.signingSecret).toBeUndefined();
    expect(ch).toMatchObject({ type: 'webhook', name: 'Ops hook', isDefault: true, active: true, verified: true, consecutiveFailures: 0, monitorCount: 0 });
    expect(res.body).not.toContain('sig-secret-123');
    const raw = s.ctx.db.prepare('SELECT secrets, config FROM notify_channels WHERE uid = ?').get(ch.uid) as { secrets: Buffer; config: string };
    expect(raw.secrets.toString('latin1')).not.toContain('sig-secret-123');
    expect(raw.config).not.toContain('sig-secret-123');

    const get = await api(s.app, s.cookie, 'GET', `/api/notification-channels/${ch.uid}`);
    expect(get.body).not.toContain('sig-secret-123');
    const list = await api(s.app, s.cookie, 'GET', '/api/notification-channels');
    expect((list.json() as { channels: unknown[] }).channels).toHaveLength(1);

    const keep = await api(s.app, s.cookie, 'PATCH', `/api/notification-channels/${ch.uid}`, {
      name: 'Renamed',
      config: { url: 'https://hooks.example.com/v2', signingSecret: '' },
    });
    expect(keep.statusCode).toBe(200);
    expect((keep.json() as { channel: { secretsSet: string[]; name: string; config: { url: string } } }).channel).toMatchObject({
      name: 'Renamed',
      secretsSet: ['signingSecret'],
      config: { url: 'https://hooks.example.com/v2' },
    });
    const clear = await api(s.app, s.cookie, 'PATCH', `/api/notification-channels/${ch.uid}`, { config: { url: 'https://hooks.example.com/v2', signingSecret: null } });
    expect((clear.json() as { channel: { secretsSet: string[] } }).channel.secretsSet).toEqual([]);

    const bad = await api(s.app, s.cookie, 'PATCH', `/api/notification-channels/${ch.uid}`, { type: 'slack' });
    expect(bad.statusCode).toBe(400);
    const invalid = await api(s.app, s.cookie, 'POST', '/api/notification-channels', { type: 'webhook', name: 'x', config: { url: 'ftp://x' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ field: 'url' });
    expect((await api(s.app, s.cookie, 'POST', '/api/notification-channels', { type: 'nope', name: 'x' })).statusCode).toBe(400);

    const del = await api(s.app, s.cookie, 'DELETE', `/api/notification-channels/${ch.uid}`);
    expect(del.statusCode).toBe(204);
    expect((await api(s.app, s.cookie, 'GET', `/api/notification-channels/${ch.uid}`)).statusCode).toBe(404);
  });

  it('viewers see operator channels read-only', async () => {
    const s = await selfHosted();
    await api(s.app, s.cookie, 'POST', '/api/notification-channels', WEBHOOK);
    s.ctx.users.create('viewer@example.com', await hashPassword('viewer password 1'), 'viewer', s.ctx.now());
    const v = await login(s.app, 'viewer@example.com', 'viewer password 1');
    const list = await api(s.app, v, 'GET', '/api/notification-channels');
    const chans = (list.json() as { channels: Array<{ uid: string }> }).channels;
    expect(chans).toHaveLength(1);
    const uid = chans[0]?.uid as string;
    expect((await api(s.app, v, 'POST', '/api/notification-channels', WEBHOOK)).statusCode).toBe(403);
    expect((await api(s.app, v, 'PATCH', `/api/notification-channels/${uid}`, { name: 'x' })).statusCode).toBe(403);
    expect((await api(s.app, v, 'DELETE', `/api/notification-channels/${uid}`)).statusCode).toBe(403);
    expect((await api(s.app, v, 'POST', `/api/notification-channels/${uid}/test`)).statusCode).toBe(403);
    expect((await api(s.app, v, 'GET', `/api/notification-channels/${uid}/log`)).statusCode).toBe(200);
  });
});

describe('tenancy (hosted mode)', () => {
  it('member A cannot see or touch member B channels; admins do not see member channels', async () => {
    const c = await cloud();
    const a = await signupMember(c, 'a@example.com');
    const b = await signupMember(c, 'b@example.com');
    const res = await api(c.app, a.cookie, 'POST', '/api/notification-channels', WEBHOOK);
    expect(res.statusCode).toBe(201);
    const uid = (res.json() as { channel: { uid: string; operator: boolean } }).channel.uid;
    for (const [method, url, body] of [
      ['GET', `/api/notification-channels/${uid}`, undefined],
      ['PATCH', `/api/notification-channels/${uid}`, { name: 'pwned' }],
      ['DELETE', `/api/notification-channels/${uid}`, undefined],
      ['POST', `/api/notification-channels/${uid}/test`, undefined],
      ['GET', `/api/notification-channels/${uid}/log`, undefined],
      ['POST', '/api/notification-channels/test', { uid, type: 'webhook', config: { url: 'https://evil.example.com/' } }],
    ] as const) {
      const r = await api(c.app, b.cookie, method, url, body);
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await api(c.app, b.cookie, 'GET', '/api/notification-channels')).json()).toEqual({ channels: [] });
    const admin = await login(c.app);
    expect((await api(c.app, admin, 'GET', '/api/notification-channels')).json()).toEqual({ channels: [] });
    expect((await api(c.app, admin, 'GET', `/api/notification-channels/${uid}`)).statusCode).toBe(404);
    // Owner still has it, unchanged.
    expect((await api(c.app, a.cookie, 'GET', `/api/notification-channels/${uid}`)).json()).toMatchObject({ channel: { name: 'Ops hook' } });
    expect(c.net.requests).toHaveLength(0);
  });

  it('enforces member limits and hosted URL rules', async () => {
    const c = await cloud({ MEMBER_NOTIFY_CHANNELS: '2' });
    const a = await signupMember(c, 'a@example.com');
    expect((await api(c.app, a.cookie, 'POST', '/api/notification-channels', WEBHOOK)).statusCode).toBe(201);
    expect((await api(c.app, a.cookie, 'POST', '/api/notification-channels', WEBHOOK)).statusCode).toBe(201);
    const third = await api(c.app, a.cookie, 'POST', '/api/notification-channels', WEBHOOK);
    expect(third.statusCode).toBe(409);
    expect(third.json()).toMatchObject({ code: 'limit_reached' });

    const c2 = await cloud();
    const m = await signupMember(c2, 'm@example.com');
    const http = await api(c2.app, m.cookie, 'POST', '/api/notification-channels', { type: 'webhook', name: 'x', config: { url: 'http://hooks.example.com/' } });
    expect(http.statusCode).toBe(400);
    expect(http.json()).toMatchObject({ field: 'url' });
    const ip = await api(c2.app, m.cookie, 'POST', '/api/notification-channels', { type: 'webhook', name: 'x', config: { url: 'https://169.254.169.254/' } });
    expect(ip.statusCode).toBe(400);
    const smtp = await api(c2.app, m.cookie, 'POST', '/api/notification-channels', {
      type: 'email',
      name: 'x',
      config: { to: ['x@example.com'], smtpUrl: 'smtps://u:p@smtp.example.com', from: 'a@example.com' },
    });
    expect(smtp.statusCode).toBe(400);
  });

  it('applyToExisting links only monitors of the same owner', async () => {
    const c = await cloud();
    const a = await signupMember(c, 'a@example.com');
    const b = await signupMember(c, 'b@example.com');
    const siteA = c.ctx.sites.create('A', ['a.example.com'], c.ctx.now(), a.id);
    const siteB = c.ctx.sites.create('B', ['b.example.com'], c.ctx.now(), b.id);
    const opSite = c.ctx.sites.create('Op', ['op.example.com'], c.ctx.now(), null);
    const a1 = addMonitor(c.ctx, siteA.id);
    const a2 = addMonitor(c.ctx, siteA.id);
    const b1 = addMonitor(c.ctx, siteB.id);
    const op1 = addMonitor(c.ctx, opSite.id);
    const res = await api(c.app, a.cookie, 'POST', '/api/notification-channels', { ...WEBHOOK, applyToExisting: true });
    const ch = (res.json() as { channel: { uid: string; monitorCount: number } }).channel;
    expect(ch.monitorCount).toBe(2);
    const links = (cid: string) =>
      (c.ctx.db
        .prepare('SELECT mc.monitor_id AS id FROM monitor_channels mc JOIN notify_channels c ON c.id = mc.channel_id WHERE c.uid = ? ORDER BY 1')
        .all(cid) as Array<{ id: number }>).map((r) => r.id);
    expect(links(ch.uid)).toEqual([a1.id, a2.id]);
    expect(links(ch.uid)).not.toContain(b1.id);

    const admin = await login(c.app);
    const op = await api(c.app, admin, 'POST', '/api/notification-channels', { ...WEBHOOK, applyToExisting: true });
    const opCh = (op.json() as { channel: { uid: string; operator: boolean } }).channel;
    expect(opCh.operator).toBe(true);
    expect(links(opCh.uid)).toEqual([op1.id]);

    // Deleting removes the links.
    await api(c.app, a.cookie, 'DELETE', `/api/notification-channels/${ch.uid}`);
    expect(c.ctx.db.prepare('SELECT count(*) AS n FROM monitor_channels WHERE monitor_id IN (?, ?)').get(a1.id, a2.id)).toEqual({ n: 0 });
  });

  it('deleting a member account removes its channels', async () => {
    const c = await cloud();
    const a = await signupMember(c, 'a@example.com', 'member password 123');
    await api(c.app, a.cookie, 'POST', '/api/notification-channels', WEBHOOK);
    const del = await api(c.app, a.cookie, 'DELETE', '/api/account', { password: 'member password 123' });
    expect(del.statusCode).toBe(204);
    expect(c.ctx.db.prepare('SELECT count(*) AS n FROM notify_channels').get()).toEqual({ n: 0 });
  });
});

describe('test sends', () => {
  it('saved and unsaved channels, redacted errors, rate limits', async () => {
    const s = await selfHosted();
    const res = await api(s.app, s.cookie, 'POST', '/api/notification-channels', {
      type: 'telegram',
      name: 'TG',
      config: { botToken: '123456789:AAH-abcdefghijklmnopqrstuvwxyz012345', chatId: '42' },
    });
    const uid = (res.json() as { channel: { uid: string } }).channel.uid;
    const ok = await api(s.app, s.cookie, 'POST', `/api/notification-channels/${uid}/test`);
    expect(ok.json()).toEqual({ ok: true });
    expect(s.net.last.url).toContain('/bot123456789:AAH-abcdefghijklmnopqrstuvwxyz012345/sendMessage');
    expect((JSON.parse(s.net.last.bodyText) as { text: string }).text).toContain('Test notification');

    s.net.handler = (req) => new Error(`getaddrinfo ENOTFOUND while calling ${req.url}`);
    const fail = await api(s.app, s.cookie, 'POST', `/api/notification-channels/${uid}/test`);
    const body = fail.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('ENOTFOUND');
    expect(body.error).not.toContain('AAH-abcdefghijklmnopqrstuvwxyz012345');

    // Unsaved form for the saved channel: the stored token fills the omitted secret.
    s.net.handler = () => ({ status: 200, body: '{"ok":true}' });
    const unsaved = await api(s.app, s.cookie, 'POST', '/api/notification-channels/test', { uid, type: 'telegram', config: { chatId: '43' } });
    expect(unsaved.json()).toEqual({ ok: true });
    expect((JSON.parse(s.net.last.bodyText) as { chat_id: number }).chat_id).toBe(43);
    expect(s.net.last.url).toContain('AAH-abcdefghijklmnopqrstuvwxyz012345');

    const fresh = await api(s.app, s.cookie, 'POST', '/api/notification-channels/test', { type: 'ntfy', config: { topic: 'abc' } });
    expect(fresh.json()).toEqual({ ok: true });
    // 4 test sends so far, the 5th is allowed, the 6th within a minute is not.
    expect((await api(s.app, s.cookie, 'POST', '/api/notification-channels/test', { type: 'ntfy', config: { topic: 'abc' } })).statusCode).toBe(200);
    const limited = await api(s.app, s.cookie, 'POST', '/api/notification-channels/test', { type: 'ntfy', config: { topic: 'abc' } });
    expect(limited.statusCode).toBe(429);
    s.clock.t += 61_000;
    expect((await api(s.app, s.cookie, 'POST', `/api/notification-channels/${uid}/test`)).statusCode).toBe(200);

    const log = await api(s.app, s.cookie, 'GET', `/api/notification-channels/${uid}/log?limit=10`);
    const entries = (log.json() as { entries: Array<{ event: string; ok: boolean; error: string | null }> }).entries;
    expect(entries.map((e) => e.ok)).toEqual([true, false, true]);
    expect(entries.every((e) => e.event === 'test')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('AAH-abcdefghijklmnopqrstuvwxyz012345');
    expect((await api(s.app, s.cookie, 'GET', `/api/notification-channels/${uid}/log?limit=abc`)).statusCode).toBe(400);
  });

  it('self-hosted e-mail goes through the operator SMTP (SMTP_URL) without opt-in', async () => {
    const s = await selfHosted({ SMTP_URL: 'smtp://u:p@127.0.0.1:2525', MAIL_FROM: 'PTR <no-reply@example.com>' });
    const res = await api(s.app, s.cookie, 'POST', '/api/notification-channels', { type: 'email', name: 'Mail', config: { to: ['ops@example.com'] } });
    const ch = (res.json() as { channel: { uid: string; verified: boolean; recipients: unknown[] } }).channel;
    expect(ch.verified).toBe(true);
    expect(ch.recipients).toEqual([{ address: 'ops@example.com', verified: true, unsubscribed: false }]);
    const r = await api(s.app, s.cookie, 'POST', `/api/notification-channels/${ch.uid}/test`);
    expect(r.json()).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.mail.sent).toHaveLength(1);
    expect(s.mail.sent[0]?.to).toBe('ops@example.com');
    expect(s.mail.sent[0]?.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/analytics\.example\.com\/api\/notification-channels\/unsubscribe\?token=/);
  });
});

describe('e-mail double opt-in (hosted)', () => {
  async function setup(): Promise<CloudTestApp & { net: FakeNet; member: { cookie: string; id: number }; uid: string }> {
    const c = await cloud();
    const member = await signupMember(c, 'owner@example.com');
    const before = c.mail.sent.length;
    const res = await api(c.app, member.cookie, 'POST', '/api/notification-channels', { type: 'email', name: 'Alerts', config: { to: ['Friend@Example.com'] } });
    expect(res.statusCode).toBe(201);
    const ch = (res.json() as { channel: { uid: string; verified: boolean; recipients: unknown[] } }).channel;
    expect(ch.verified).toBe(false);
    expect(ch.recipients).toEqual([{ address: 'friend@example.com', verified: false, unsubscribed: false }]);
    await c.ctx.mailer?.idle();
    expect(c.mail.sent.length).toBe(before + 1);
    return { ...c, member, uid: ch.uid };
  }

  function verifyToken(t: CloudTestApp): string {
    const mail = t.mail.sent[t.mail.sent.length - 1];
    expect(mail?.to).toBe('friend@example.com');
    expect(mail?.text).toContain('owner@example.com');
    const m = /\/api\/notification-channels\/verify\?token=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '');
    expect(m).not.toBeNull();
    return (m as RegExpExecArray)[1] as string;
  }

  it('nothing is sent before confirmation; verify link is single use; unsubscribe is one-click and idempotent', async () => {
    const t = await setup();
    const notifier = startNotifier(t.ctx, { autoStart: false });
    const chId = (t.ctx.db.prepare('SELECT id FROM notify_channels WHERE uid = ?').get(t.uid) as { id: number }).id;
    const enqueue = () =>
      t.ctx.db
        .prepare("INSERT INTO notify_outbox (channel_id, monitor_id, event, payload, next_attempt_at, created_at) VALUES (?, NULL, 'down', ?, ?, ?)")
        .run(chId, JSON.stringify(downPayload()), t.ctx.now(), t.ctx.now());

    // Not confirmed: skipped and logged, nothing mailed, test refused.
    enqueue();
    const mailsBefore = t.mail.sent.length;
    await notifier.runOnce();
    await t.ctx.mailer?.idle();
    expect(t.mail.sent.length).toBe(mailsBefore);
    expect((await api(t.app, t.member.cookie, 'POST', `/api/notification-channels/${t.uid}/test`)).json()).toMatchObject({ ok: false });
    const log1 = (await api(t.app, t.member.cookie, 'GET', `/api/notification-channels/${t.uid}/log`)).json() as { entries: Array<{ error: string }> };
    expect(log1.entries[0]?.error).toMatch(/no confirmed recipients/);

    // Confirm (public GET, no session).
    const token = verifyToken(t);
    const v = await t.app.inject({ method: 'GET', url: `/api/notification-channels/verify?token=${token}` });
    expect(v.statusCode).toBe(200);
    expect(v.headers['content-type']).toContain('text/html');
    expect(v.body).toContain('friend@example.com');
    const again = await t.app.inject({ method: 'GET', url: `/api/notification-channels/verify?token=${token}` });
    expect(again.statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/notification-channels/verify?token=x' })).statusCode).toBe(400);
    const ch = (await api(t.app, t.member.cookie, 'GET', `/api/notification-channels/${t.uid}`)).json() as { channel: { verified: boolean } };
    expect(ch.channel.verified).toBe(true);

    // Delivered with unsubscribe headers through the operator mailer.
    enqueue();
    await notifier.runOnce();
    await t.ctx.mailer?.idle();
    const alert = t.mail.sent[t.mail.sent.length - 1];
    expect(alert?.to).toBe('friend@example.com');
    expect(alert?.from).toBe('PTR Analytics <no-reply@example.com>');
    expect(alert?.subject).toContain('is down');
    expect(alert?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const unsubUrl = /^<(.+)>$/.exec(alert?.headers?.['List-Unsubscribe'] ?? '')?.[1] as string;
    expect(unsubUrl.startsWith(`${CLOUD_URL}/api/notification-channels/unsubscribe?token=`)).toBe(true);
    const path = unsubUrl.slice(CLOUD_URL.length);

    // GET shows a confirmation form only; the one-click POST (RFC 8058, no CSRF header) unsubscribes.
    const page = await t.app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<form method="post"');
    let rcpt = t.ctx.db.prepare('SELECT unsubscribed_at FROM notify_email_recipients').get() as { unsubscribed_at: number | null };
    expect(rcpt.unsubscribed_at).toBeNull();
    const one = await t.app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://mail.example.net' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(one.statusCode).toBe(200);
    rcpt = t.ctx.db.prepare('SELECT unsubscribed_at FROM notify_email_recipients').get() as { unsubscribed_at: number | null };
    expect(rcpt.unsubscribed_at).not.toBeNull();
    const twice = await t.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(twice.statusCode).toBe(200);
    const bogus = await t.app.inject({ method: 'POST', url: `/api/notification-channels/unsubscribe?token=${'A'.repeat(43)}`, payload: '' });
    expect(bogus.statusCode).toBe(400);

    // Unsubscribed: no more mail.
    const count = t.mail.sent.length;
    enqueue();
    await notifier.runOnce();
    await t.ctx.mailer?.idle();
    expect(t.mail.sent.length).toBe(count);
    await notifier.stop();
  });

  it('expired links do not verify; resendVerification sends a new one (rate limited)', async () => {
    const t = await setup();
    const token = verifyToken(t);
    t.clock.t += 8 * 86_400_000;
    expect((await t.app.inject({ method: 'GET', url: `/api/notification-channels/verify?token=${token}` })).statusCode).toBe(400);
    const n = t.mail.sent.length;
    await api(t.app, t.member.cookie, 'PATCH', `/api/notification-channels/${t.uid}`, { resendVerification: true });
    await t.ctx.mailer?.idle();
    expect(t.mail.sent.length).toBe(n + 1);
    await api(t.app, t.member.cookie, 'PATCH', `/api/notification-channels/${t.uid}`, { resendVerification: true });
    await t.ctx.mailer?.idle();
    expect(t.mail.sent.length).toBe(n + 1); // once per 10 minutes
    const fresh = verifyToken(t);
    expect((await t.app.inject({ method: 'GET', url: `/api/notification-channels/verify?token=${fresh}` })).statusCode).toBe(200);
  });
});
