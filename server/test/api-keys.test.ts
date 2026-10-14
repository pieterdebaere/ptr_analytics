import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { promLabel } from '../src/routes/security.js';
import { ADMIN_PASSWORD, api, createCloudApp, createTestApp, DAY, HOUR, login, signupMember, type TestApp } from './helpers.js';
import { insertHour, insertMonitor, insertTag, insertTls } from './uptime-status-fixtures.js';

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const MEMBER_PASSWORD = 'member password 123';

async function createKey(app: FastifyInstance, cookie: string, scopes: string[], extra: Record<string, unknown> = {}) {
  const res = await api(app, cookie, 'POST', '/api/api-keys', { name: 'ci', scopes, password: ADMIN_PASSWORD, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json() as { apiKey: { uid: string; prefix: string; scopes: string[] }; key: string };
}

function bearer(app: FastifyInstance, key: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, ip = '203.0.113.20') {
  return app.inject({
    method,
    url,
    remoteAddress: ip,
    headers: { authorization: `Bearer ${key}`, ...(method === 'GET' ? {} : { 'x-pa-request': '1' }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

describe('API key management', () => {
  it('creates, lists and deletes keys; only the hash is stored', async () => {
    t = await createTestApp();
    const cookie = await login(t.app);
    const { apiKey, key } = await createKey(t.app, cookie, ['read', 'metrics'], { expiresInDays: 30 });
    expect(key).toMatch(/^pa_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(`pa_${apiKey.prefix}_`)).toBe(true);
    const rows = t.ctx.db.prepare('SELECT * FROM api_keys').all() as Array<Record<string, unknown>>;
    expect(JSON.stringify(rows)).not.toContain(key.slice(12));
    const list = await api(t.app, cookie, 'GET', '/api/api-keys');
    const keys = (list.json() as { apiKeys: Array<Record<string, unknown>> }).apiKeys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ uid: apiKey.uid, name: 'ci', scopes: ['read', 'metrics'], expiresAt: t.clock.t + 30 * DAY, lastUsedAt: null });
    expect(JSON.stringify(keys)).not.toContain(key);
    expect((await api(t.app, cookie, 'DELETE', `/api/api-keys/${apiKey.uid}`)).statusCode).toBe(204);
    expect((await bearer(t.app, key, 'GET', '/api/sites')).statusCode).toBe(401);
    expect((await api(t.app, cookie, 'DELETE', `/api/api-keys/${apiKey.uid}`)).statusCode).toBe(404);
  });

  it('validates input and limits keys per user', async () => {
    t = await createTestApp();
    const cookie = await login(t.app);
    for (const body of [
      { name: 'x', scopes: [] },
      { name: 'x', scopes: ['write'] },
      { name: 'x', scopes: ['read', 'read'] },
      { name: '', scopes: ['read'] },
      { name: 'x', scopes: ['read'], expiresInDays: 0 },
      { name: 'x', scopes: ['read'], expiresInDays: 1.5 },
    ]) {
      expect((await api(t.app, cookie, 'POST', '/api/api-keys', { ...body, password: ADMIN_PASSWORD })).statusCode).toBe(400);
    }
    for (let i = 0; i < 20; i++) await createKey(t.app, cookie, ['read']);
    const over = await api(t.app, cookie, 'POST', '/api/api-keys', { name: 'x', scopes: ['read'], password: ADMIN_PASSWORD });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ code: 'limit_reached' });
  });
});

describe('bearer authentication', () => {
  it('read keys reach GET endpoints of the user data only', async () => {
    t = await createTestApp();
    const cookie = await login(t.app);
    const site = (await api(t.app, cookie, 'POST', '/api/sites', { name: 'S', domains: ['s.example'] })).json() as { site: { id: string } };
    const { key } = await createKey(t.app, cookie, ['read']);
    const ok = await bearer(t.app, key, 'GET', '/api/sites');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['set-cookie']).toBeUndefined();
    expect((await bearer(t.app, key, 'GET', `/api/sites/${site.site.id}/stats/summary`)).statusCode).toBe(200);
    // never auth, users, key management, notification channels
    for (const url of ['/api/auth/me', '/api/users', '/api/api-keys', '/api/auth/mfa', '/api/billing']) {
      const r = await bearer(t.app, key, 'GET', url);
      expect(r.statusCode, url).toBe(403);
    }
    // (404 while the notification routes do not exist)
    expect([403, 404]).toContain((await bearer(t.app, key, 'GET', '/api/notification-channels')).statusCode);
    // never mutations
    expect((await bearer(t.app, key, 'POST', '/api/sites', { name: 'x', domains: ['x.example'] })).statusCode).toBe(403);
    expect((await bearer(t.app, key, 'PATCH', `/api/sites/${site.site.id}`, { name: 'y' })).statusCode).toBe(403);
    expect((await bearer(t.app, key, 'DELETE', `/api/sites/${site.site.id}`)).statusCode).toBe(403);
    expect((await bearer(t.app, key, 'POST', '/api/api-keys', { name: 'x', scopes: ['read'] })).statusCode).toBe(403);
    expect((await bearer(t.app, key, 'POST', '/api/auth/mfa/setup')).statusCode).toBe(403);
    // still there
    expect((await api(t.app, cookie, 'GET', `/api/sites/${site.site.id}`)).json()).toMatchObject({ site: { name: 'S' } });
    // keys do not satisfy the CSRF check either
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/sites', headers: { authorization: `Bearer ${key}` }, payload: { name: 'x', domains: ['x.example'] } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('enforces scopes, expiry and the secret', async () => {
    t = await createTestApp();
    const cookie = await login(t.app);
    const metricsOnly = await createKey(t.app, cookie, ['metrics']);
    const readOnly = await createKey(t.app, cookie, ['read'], { expiresInDays: 1 });
    const sites = await bearer(t.app, metricsOnly.key, 'GET', '/api/sites');
    expect(sites.statusCode).toBe(403);
    expect(sites.json()).toMatchObject({ code: 'insufficient_scope' });
    expect((await bearer(t.app, readOnly.key, 'GET', '/metrics')).statusCode).toBe(403);
    expect((await bearer(t.app, metricsOnly.key, 'GET', '/metrics')).statusCode).toBe(200);
    // wrong secret with a valid prefix
    const forged = `${readOnly.key.slice(0, 12)}${'A'.repeat(43)}`;
    expect((await bearer(t.app, forged, 'GET', '/api/sites')).statusCode).toBe(401);
    const noKey = await t.app.inject({ method: 'GET', url: '/metrics' });
    expect(noKey.statusCode).toBe(401);
    expect(noKey.headers['www-authenticate']).toBe('Bearer');
    expect((await bearer(t.app, readOnly.key, 'GET', '/api/sites')).statusCode).toBe(200);
    t.clock.t += DAY + 1;
    expect((await bearer(t.app, readOnly.key, 'GET', '/api/sites')).statusCode).toBe(401);
  });

  it('coalesces last_used_at updates', async () => {
    t = await createTestApp();
    const cookie = await login(t.app);
    const { key, apiKey } = await createKey(t.app, cookie, ['read']);
    const lastUsed = (): number | null =>
      (t.ctx.db.prepare('SELECT last_used_at FROM api_keys WHERE uid = ?').get(apiKey.uid) as { last_used_at: number | null }).last_used_at;
    const start = t.clock.t;
    await bearer(t.app, key, 'GET', '/api/sites');
    expect(lastUsed()).toBe(start);
    t.clock.t += 10_000;
    await bearer(t.app, key, 'GET', '/api/sites');
    expect(lastUsed()).toBe(start);
    t.clock.t += 60_000;
    await bearer(t.app, key, 'GET', '/api/sites');
    expect(lastUsed()).toBe(t.clock.t);
  });

  it('rate limits failed key attempts per IP and prefix, never valid keys', async () => {
    t = await createTestApp();
    const cookie = await login(t.app);
    const { key } = await createKey(t.app, cookie, ['read']);
    const bad = `pa_abcdefgh_${'x'.repeat(43)}`;
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await bearer(t.app, bad, 'GET', '/api/sites', undefined, '192.0.2.77')).statusCode;
    expect(last).toBe(429);
    expect((await bearer(t.app, bad, 'GET', '/api/sites', undefined, '192.0.2.78')).statusCode).toBe(401);
    // the same client (or everyone behind the same NAT) can still use a valid key
    expect((await bearer(t.app, key, 'GET', '/api/sites', undefined, '192.0.2.77')).statusCode).toBe(200);
    // another prefix from that IP has its own budget
    expect((await bearer(t.app, `pa_zzzzzzzz_${'x'.repeat(43)}`, 'GET', '/api/sites', undefined, '192.0.2.77')).statusCode).toBe(401);
    // a forged secret for the valid key's prefix is counted, the real key keeps working
    const forged = `${key.slice(0, 12)}${'A'.repeat(43)}`;
    for (let i = 0; i < 31; i++) last = (await bearer(t.app, forged, 'GET', '/api/sites', undefined, '192.0.2.77')).statusCode;
    expect(last).toBe(429);
    expect((await bearer(t.app, key, 'GET', '/api/sites', undefined, '192.0.2.77')).statusCode).toBe(200);
  });

  it('member keys only see the member data', async () => {
    const c = await createCloudApp();
    t = c;
    const a = await signupMember(c, 'a@example.org');
    const b = await signupMember(c, 'b@example.org');
    const siteA = ((await api(c.app, a.cookie, 'POST', '/api/sites', { name: 'A', domains: ['a.example'] })).json() as { site: { id: string } }).site.id;
    const siteB = ((await api(c.app, b.cookie, 'POST', '/api/sites', { name: 'B', domains: ['b.example'] })).json() as { site: { id: string } }).site.id;
    insertMonitor(c.ctx, siteA, { name: 'mine' });
    insertMonitor(c.ctx, siteB, { name: 'theirs' });
    const { key } = await createKey(c.app, a.cookie, ['read', 'metrics'], { password: MEMBER_PASSWORD });
    expect((await bearer(c.app, key, 'GET', `/api/sites/${siteA}`)).statusCode).toBe(200);
    expect((await bearer(c.app, key, 'GET', `/api/sites/${siteB}`)).statusCode).toBe(404);
    const metrics = (await bearer(c.app, key, 'GET', '/metrics')).body;
    expect(metrics).toContain('monitor_name="mine"');
    expect(metrics).not.toContain('theirs');
  });
});

describe('/metrics scope', () => {
  it('exports only the key owner\'s monitors; admins the operator sites; metrics:all is explicit', async () => {
    const c = await createCloudApp();
    t = c;
    const admin = await login(c.app);
    const a = await signupMember(c, 'a@example.org');
    const opSite = ((await api(c.app, admin, 'POST', '/api/sites', { name: 'Op', domains: ['op.example'] })).json() as { site: { id: string } }).site.id;
    const siteA = ((await api(c.app, a.cookie, 'POST', '/api/sites', { name: 'A', domains: ['a.example'] })).json() as { site: { id: string } }).site.id;
    insertMonitor(c.ctx, opSite, { name: 'operator-mon' });
    insertMonitor(c.ctx, siteA, { name: 'tenant-mon' });
    const metrics = async (key: string): Promise<string> => (await bearer(c.app, key, 'GET', '/metrics')).body;
    const adminKey = (await createKey(c.app, admin, ['metrics'])).key;
    const adminBody = await metrics(adminKey);
    expect(adminBody).toContain('operator-mon');
    expect(adminBody).not.toContain('tenant-mon');
    const allKey = (await createKey(c.app, admin, ['metrics:all'])).key;
    const allBody = await metrics(allKey);
    expect(allBody).toContain('operator-mon');
    expect(allBody).toContain('tenant-mon');
    // members cannot ask for every tenant, and their keys only see their own monitors
    const refused = await api(c.app, a.cookie, 'POST', '/api/api-keys', { name: 'x', scopes: ['metrics:all'], password: MEMBER_PASSWORD });
    expect(refused.statusCode).toBe(403);
    const memberKey = (await createKey(c.app, a.cookie, ['metrics'], { password: MEMBER_PASSWORD })).key;
    const memberBody = await metrics(memberKey);
    expect(memberBody).toContain('tenant-mon');
    expect(memberBody).not.toContain('operator-mon');
    // metrics:all never grants API reads
    expect((await bearer(c.app, allKey, 'GET', '/api/sites')).statusCode).toBe(403);
  });
});

describe('/metrics', () => {
  it('escapes label values', () => {
    expect(promLabel('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(promLabel('x\ry\u0000z')).toBe('xyz');
  });

  it('renders gauges for accessible monitors with escaped labels', async () => {
    t = await createTestApp();
    const cookie = await login(t.app);
    const site = ((await api(t.app, cookie, 'POST', '/api/sites', { name: 'Site "1"', domains: ['s.example'] })).json() as { site: { id: string } }).site.id;
    const evil = 'evil"} 1\nmonitor_status{injected="1';
    const m = insertMonitor(t.ctx, site, { name: evil, status: 1, latencyMs: 42 });
    insertTag(t.ctx, m.id, 'env\\"x', 'prod\n');
    const hour = Math.floor(t.clock.t / HOUR) * HOUR;
    insertHour(t.ctx, m.id, hour - HOUR, { up: 3_000_000, down: 600_000 });
    insertTls(t.ctx, m.id, t.clock.t + 10 * DAY + 5000);
    const { key } = await createKey(t.app, cookie, ['metrics']);
    const res = await bearer(t.app, key, 'GET', '/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
    // every sample line is well-formed: name{labels} value — the injection stays inside a label
    const labelRe = /[a-z_]+="(?:[^"\\\n]|\\["\\n])*"/;
    const sampleRe = new RegExp(`^[a-z_]+\\{${labelRe.source}(?:,${labelRe.source})*\\} -?[0-9.e+-]+$`);
    for (const l of lines) expect(l).toMatch(sampleRe);
    expect(lines.some((l) => l.startsWith('monitor_status{injected'))).toBe(false);
    expect(res.body).toContain('monitor_name="evil\\"} 1\\nmonitor_status{injected=\\"1"');
    expect(res.body).toContain('tags="env\\\\\\"x:prod\\n"');
    expect(lines.find((l) => l.startsWith('monitor_status{'))?.endsWith(' 1')).toBe(true);
    expect(lines.find((l) => l.startsWith('monitor_response_time_ms{'))?.endsWith(' 42')).toBe(true);
    expect(lines.find((l) => l.includes('window="24h"'))?.endsWith(` ${3_000_000 / 3_600_000}`)).toBe(true);
    expect(lines.find((l) => l.startsWith('monitor_cert_days_remaining{'))?.endsWith(' 10')).toBe(true);
    expect(res.body).not.toContain('internal.example.com');
    expect(res.body).not.toContain('secret check message');
  });
});
