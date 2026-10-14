import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/ids.js';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, DAY, api, cookieFrom, createTestApp, login, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.app.close();
});

const loginReq = (email: string, password: string, ip = '192.0.2.10') =>
  t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-pa-request': '1' },
    remoteAddress: ip,
    payload: { email, password },
  });

describe('password hashing', () => {
  it('uses scrypt with the documented format', async () => {
    const h = await hashPassword('a very long password');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{88}$/);
    expect(await verifyPassword('a very long password', h)).toBe(true);
    expect(await verifyPassword('a very long passworD', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$99999999$8$1$AAAA$AAAA')).toBe(false);
  });
});

describe('bootstrap', () => {
  it('creates the admin from ADMIN_EMAIL / ADMIN_PASSWORD on an empty database', () => {
    const users = t.ctx.users.list();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: ADMIN_EMAIL, role: 'admin' });
  });
});

describe('login / logout / me', () => {
  it('logs in, sets a hardened cookie and stores only the token hash', async () => {
    const res = await loginReq(ADMIN_EMAIL.toUpperCase(), ADMIN_PASSWORD);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: Record<string, unknown> };
    expect(body.user).toEqual({ id: 1, email: ADMIN_EMAIL, role: 'admin', createdAt: t.clock.t, emailVerified: true });
    expect(JSON.stringify(body)).not.toContain('password');

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^pa_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=2592000');
    expect(setCookie).not.toContain('Secure');

    const token = cookieFrom(res).split('=')[1] as string;
    const rows = t.ctx.db.prepare('SELECT token_hash, expires_at FROM auth_sessions').all() as Array<{ token_hash: string; expires_at: number }>;
    expect(rows).toEqual([{ token_hash: sha256Hex(token), expires_at: t.clock.t + 30 * DAY }]);

    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieFrom(res) } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { email: string } }).user.email).toBe(ADMIN_EMAIL);
  });

  it('sets Secure cookies and HSTS when COOKIE_SECURE', async () => {
    await t.app.close();
    t = await createTestApp({ env: { PUBLIC_URL: 'https://analytics.example.com' } });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-pa-request': '1', origin: 'https://analytics.example.com' },
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('Secure');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
  });

  it('rejects wrong passwords and unknown users identically', async () => {
    const wrong = await loginReq(ADMIN_EMAIL, 'wrong password!!');
    const unknown = await loginReq('nobody@example.com', 'wrong password!!');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect((await loginReq('', '')).statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-pa-request': '1' }, payload: { email: 1 } });
    expect(bad.statusCode).toBe(400);
  });

  it('rate limits failed logins per IP and per email', async () => {
    for (let i = 0; i < 10; i++) expect((await loginReq(ADMIN_EMAIL, `wrong password ${i}`, '192.0.2.50')).statusCode).toBe(401);
    // even the correct password is refused now from that IP...
    expect((await loginReq(ADMIN_EMAIL, ADMIN_PASSWORD, '192.0.2.50')).statusCode).toBe(429);
    // ...but the real owner on another IP is not locked out
    expect((await loginReq(ADMIN_EMAIL, ADMIN_PASSWORD, '192.0.2.51')).statusCode).toBe(200);
    // different email from a fresh IP is fine
    expect((await loginReq('other@example.com', 'whatever whatever', '192.0.2.52')).statusCode).toBe(401);
    // per-IP: 30 attempts (any email) from one IP
    for (let i = 0; i < 29; i++) await loginReq(`u${i}@example.com`, 'wrong password!!', '192.0.2.60');
    expect((await loginReq('fresh@example.com', 'wrong password!!', '192.0.2.60')).statusCode).toBe(401);
    expect((await loginReq('fresh2@example.com', 'wrong password!!', '192.0.2.60')).statusCode).toBe(429);
    // window expires after 15 minutes
    t.clock.t += 15 * 60_000 + 1;
    expect((await loginReq(ADMIN_EMAIL, ADMIN_PASSWORD, '192.0.2.50')).statusCode).toBe(200);
  });

  it('limits a distributed brute force per email across IPs', async () => {
    for (let i = 0; i < 100; i++) await loginReq(ADMIN_EMAIL, 'wrong password!!', `198.51.100.${i}`);
    expect((await loginReq(ADMIN_EMAIL, ADMIN_PASSWORD, '203.0.113.9')).statusCode).toBe(429);
  });

  it('counts concurrent login attempts before verifying (no race past the limit)', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => loginReq(ADMIN_EMAIL, `wrong password ${i}`, '192.0.2.70')),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(15);
  });

  it('logs out and invalidates the session', async () => {
    const cookie = await login(t.app);
    const out = await api(t.app, cookie, 'POST', '/api/auth/logout');
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/pa_session=;/);
    expect((await api(t.app, cookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 });
  });

  it('expires sessions after 30 days', async () => {
    const cookie = await login(t.app);
    t.clock.t += 30 * DAY;
    expect((await api(t.app, cookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('rejects forged / malformed cookies', async () => {
    for (const cookie of ['pa_session=abc', `pa_session=${'A'.repeat(43)}`, 'pa_session=../../etc']) {
      expect((await api(t.app, cookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
    }
  });

  it('changes the password and revokes other sessions', async () => {
    const a = await login(t.app);
    const b = await login(t.app);
    const bad = await api(t.app, a, 'POST', '/api/auth/password', { currentPassword: 'nope nope nope', newPassword: 'another long password' });
    expect(bad.statusCode).toBe(400);
    const short = await api(t.app, a, 'POST', '/api/auth/password', { currentPassword: ADMIN_PASSWORD, newPassword: 'short' });
    expect(short.statusCode).toBe(400);
    const ok = await api(t.app, a, 'POST', '/api/auth/password', { currentPassword: ADMIN_PASSWORD, newPassword: 'another long password' });
    expect(ok.statusCode).toBe(204);
    expect((await api(t.app, a, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await api(t.app, b, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await loginReq(ADMIN_EMAIL, 'another long password')).statusCode).toBe(200);
  });
});

describe('CSRF', () => {
  it('requires X-PA-Request on mutating API requests', async () => {
    const cookie = await login(t.app);
    const res = await t.app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'x', domains: ['x.com'] } });
    expect(res.statusCode).toBe(403);
    const login403 = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    expect(login403.statusCode).toBe(403);
    const del = await t.app.inject({ method: 'DELETE', url: '/api/users/2', headers: { cookie, 'x-pa-request': '0' } });
    expect(del.statusCode).toBe(403);
  });

  it('cannot be bypassed with encoded or non-canonical API paths', async () => {
    const cookie = await login(t.app);
    for (const url of ['/%61pi/sites', '/api%2Fsites', '/API/sites', '//api/sites', '/api/sites/', '/api/./sites']) {
      const res = await t.app.inject({ method: 'POST', url, headers: { cookie }, payload: { name: 'x', domains: ['x.com'] } });
      expect([403, 404]).toContain(res.statusCode);
    }
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM sites').get()).toEqual({ n: 0 });
  });

  it('checks Origin against the request host when PUBLIC_URL is unset', async () => {
    const cookie = await login(t.app);
    const mk = (origin: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/sites',
        headers: { cookie, 'x-pa-request': '1', origin, host: 'analytics.local:3000' },
        payload: { name: 'Site', domains: ['example.com'] },
      });
    expect((await mk('https://evil.com')).statusCode).toBe(403);
    expect((await mk('null')).statusCode).toBe(403);
    expect((await mk('http://analytics.local:3000')).statusCode).toBe(201);
  });

  it('checks Origin against PUBLIC_URL when set', async () => {
    await t.app.close();
    t = await createTestApp({ env: { PUBLIC_URL: 'https://analytics.example.com/', COOKIE_SECURE: 'false' } });
    const mk = (origin?: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-pa-request': '1', host: 'analytics.example.com', ...(origin ? { origin } : {}) },
        payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
    expect((await mk('https://evil.example.com')).statusCode).toBe(403);
    expect((await mk('http://analytics.example.com')).statusCode).toBe(403);
    expect((await mk('https://analytics.example.com')).statusCode).toBe(200);
    expect((await mk()).statusCode).toBe(200);
  });

  it('does not require the header on GET or on /api/event', async () => {
    const cookie = await login(t.app);
    expect((await t.app.inject({ method: 'GET', url: '/api/sites', headers: { cookie } })).statusCode).toBe(200);
    const ev = await t.app.inject({ method: 'POST', url: '/api/event', headers: { 'content-type': 'text/plain' }, payload: '{}' });
    expect(ev.statusCode).toBe(400);
  });
});

describe('authorization and user management', () => {
  async function setupViewer(): Promise<{ admin: string; viewer: string; viewerId: number }> {
    const admin = await login(t.app);
    const created = await api(t.app, admin, 'POST', '/api/users', { email: 'Viewer@Example.com', password: 'viewer password 1', role: 'viewer' });
    expect(created.statusCode).toBe(201);
    const user = (created.json() as { user: { id: number; email: string; role: string } }).user;
    expect(user).toMatchObject({ email: 'viewer@example.com', role: 'viewer' });
    const viewer = await login(t.app, 'viewer@example.com', 'viewer password 1');
    return { admin, viewer, viewerId: user.id };
  }

  it('lets viewers read but not mutate', async () => {
    const { admin, viewer } = await setupViewer();
    const site = (await api(t.app, admin, 'POST', '/api/sites', { name: 'Blog', domains: ['blog.example.com'] })).json() as { site: { id: string } };
    expect((await api(t.app, viewer, 'GET', '/api/sites')).statusCode).toBe(200);
    expect((await api(t.app, viewer, 'GET', `/api/sites/${site.site.id}`)).statusCode).toBe(200);
    expect((await api(t.app, viewer, 'GET', `/api/sites/${site.site.id}/stats/summary`)).statusCode).toBe(200);
    expect((await api(t.app, viewer, 'GET', '/api/config')).statusCode).toBe(200);
    expect((await api(t.app, viewer, 'POST', '/api/sites', { name: 'X', domains: ['x.com'] })).statusCode).toBe(403);
    expect((await api(t.app, viewer, 'PATCH', `/api/sites/${site.site.id}`, { name: 'Y' })).statusCode).toBe(403);
    expect((await api(t.app, viewer, 'DELETE', `/api/sites/${site.site.id}`)).statusCode).toBe(403);
    expect((await api(t.app, viewer, 'GET', '/api/users')).statusCode).toBe(403);
    expect((await api(t.app, viewer, 'POST', '/api/users', { email: 'a@b.co', password: 'xxxxxxxxxxxxxxx', role: 'admin' })).statusCode).toBe(403);
    expect((await api(t.app, viewer, 'PATCH', '/api/users/1', { role: 'viewer' })).statusCode).toBe(403);
  });

  it('validates user input and rejects duplicates', async () => {
    const admin = await login(t.app);
    const bad = [
      { email: 'not-an-email', password: 'long enough password', role: 'viewer' },
      { email: 'a@b.co', password: 'short', role: 'viewer' },
      { email: 'a@b.co', password: 'x'.repeat(257), role: 'viewer' },
      { email: 'a@b.co', password: 'long enough password', role: 'root' },
    ];
    for (const b of bad) expect((await api(t.app, admin, 'POST', '/api/users', b)).statusCode).toBe(400);
    expect((await api(t.app, admin, 'POST', '/api/users', { email: ADMIN_EMAIL.toUpperCase(), password: 'long enough password', role: 'viewer' })).statusCode).toBe(409);
  });

  it('protects the last admin and self-deletion', async () => {
    const { admin, viewerId } = await setupViewer();
    const demote = await api(t.app, admin, 'PATCH', '/api/users/1', { role: 'viewer' });
    expect(demote.statusCode).toBe(409);
    expect((await api(t.app, admin, 'DELETE', '/api/users/1')).statusCode).toBe(400);
    // promote viewer, then demoting the first admin works
    expect((await api(t.app, admin, 'PATCH', `/api/users/${viewerId}`, { role: 'admin' })).json()).toMatchObject({ user: { role: 'admin' } });
    expect((await api(t.app, admin, 'PATCH', '/api/users/1', { role: 'viewer' })).statusCode).toBe(200);
    expect(t.ctx.users.list().map((u) => u.role)).toEqual(['viewer', 'admin']);
    // the demoted user lost admin rights immediately: a role change revokes the user's sessions
    expect((await api(t.app, admin, 'GET', '/api/users')).statusCode).toBe(401);
    const again = await login(t.app);
    expect((await api(t.app, again, 'GET', '/api/users')).statusCode).toBe(403);
  });

  it('a role change signs the user out everywhere', async () => {
    const { admin, viewer, viewerId } = await setupViewer();
    expect((await api(t.app, viewer, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await api(t.app, admin, 'PATCH', `/api/users/${viewerId}`, { role: 'admin' })).statusCode).toBe(200);
    expect((await api(t.app, viewer, 'GET', '/api/auth/me')).statusCode).toBe(401);
    // an unchanged role keeps the sessions
    const fresh = await login(t.app, 'viewer@example.com', 'viewer password 1');
    expect((await api(t.app, admin, 'PATCH', `/api/users/${viewerId}`, { role: 'admin' })).statusCode).toBe(200);
    expect((await api(t.app, fresh, 'GET', '/api/auth/me')).statusCode).toBe(200);
  });

  it('admin password reset revokes the target sessions and deletion cascades', async () => {
    const { admin, viewer, viewerId } = await setupViewer();
    expect((await api(t.app, admin, 'PATCH', `/api/users/${viewerId}`, { password: 'brand new password' })).statusCode).toBe(200);
    expect((await api(t.app, viewer, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await api(t.app, admin, 'PATCH', `/api/users/${viewerId}`, { password: 'short' })).statusCode).toBe(400);
    expect((await api(t.app, admin, 'DELETE', `/api/users/${viewerId}`)).statusCode).toBe(204);
    expect((await api(t.app, admin, 'DELETE', `/api/users/${viewerId}`)).statusCode).toBe(404);
    expect((await api(t.app, admin, 'PATCH', '/api/users/abc', { role: 'admin' })).statusCode).toBe(404);
  });
});

describe('sites API', () => {
  it('creates, reads, updates and deletes sites with normalised domains', async () => {
    const admin = await login(t.app);
    const created = await api(t.app, admin, 'POST', '/api/sites', {
      name: '  My Site ',
      domains: ['Example.COM', 'https://www.example.com/', '*.Example.org', 'localhost', 'example.com'],
    });
    expect(created.statusCode).toBe(201);
    const site = (created.json() as { site: { id: string; name: string; domains: string[]; createdAt: number } }).site;
    expect(site.id).toMatch(/^[a-z0-9]{12}$/);
    expect(site).toEqual({
      id: site.id,
      name: 'My Site',
      domains: ['example.com', 'www.example.com', '*.example.org', 'localhost'],
      createdAt: t.clock.t,
      suspended: false,
      ownerId: null,
    });

    const patched = await api(t.app, admin, 'PATCH', `/api/sites/${site.id}`, { domains: ['new.example'] });
    expect(patched.json()).toMatchObject({ site: { name: 'My Site', domains: ['new.example'] } });
    expect((await api(t.app, admin, 'GET', '/api/sites')).json()).toMatchObject({ sites: [{ id: site.id }] });

    for (const body of [
      { name: '', domains: ['x.com'] },
      { name: 'x'.repeat(101), domains: ['x.com'] },
      { name: 'ok', domains: [] },
      { name: 'ok', domains: ['bad domain'] },
      { name: 'ok', domains: ['*.'] },
      { name: 'ok', domains: Array.from({ length: 21 }, (_, i) => `d${i}.com`) },
      { name: 'ok', domains: 'x.com' },
      { name: 'ok' },
    ]) {
      expect((await api(t.app, admin, 'POST', '/api/sites', body)).statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
    }

    expect((await api(t.app, admin, 'DELETE', `/api/sites/${site.id}`)).statusCode).toBe(204);
    expect((await api(t.app, admin, 'GET', `/api/sites/${site.id}`)).statusCode).toBe(404);
  });

  it('returns config', async () => {
    const admin = await login(t.app);
    const res = await api(t.app, admin, 'GET', '/api/config');
    expect(res.json()).toMatchObject({ publicUrl: null, geoip: false });
    expect(typeof (res.json() as { version: unknown }).version).toBe('string');
  });
});

describe('API errors', () => {
  it('returns JSON 404 for unknown API routes and never leaks internals', async () => {
    const cookie = await login(t.app);
    const res = await api(t.app, cookie, 'GET', '/api/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
    const post = await api(t.app, cookie, 'POST', '/api/does-not-exist', {});
    expect(post.statusCode).toBe(404);
    const badJson = await t.app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie, 'x-pa-request': '1', 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.body).not.toMatch(/at |\.ts|\.js|SQL|stack/i);
    const textPlain = await t.app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie, 'x-pa-request': '1', 'content-type': 'text/plain' },
      payload: '{"name":"x","domains":["x.com"]}',
    });
    expect(textPlain.statusCode).toBe(415);
    const big = await api(t.app, cookie, 'POST', '/api/sites', { name: 'x', domains: ['x.com'], pad: 'x'.repeat(70_000) });
    expect(big.statusCode).toBe(413);
  });

  it('turns internal errors into a generic 500', async () => {
    const cookie = await login(t.app);
    t.ctx.db.exec('DROP TABLE vitals');
    const id = t.ctx.sites.create('S', ['s.com'], t.clock.t).id;
    const res = await api(t.app, cookie, 'GET', `/api/sites/${id}/vitals/summary`);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal error' });
  });
});

describe('hardening', () => {
  it('uses a __Host- prefixed cookie when Secure and ignores duplicated session cookies', async () => {
    await t.app.close();
    t = await createTestApp({ env: { PUBLIC_URL: 'https://analytics.example.com' } });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-pa-request': '1' },
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(String(res.headers['set-cookie'])).toMatch(/^__Host-pa_session=[A-Za-z0-9_-]{43};.*Secure/);
    const cookie = cookieFrom(res);
    expect((await api(t.app, cookie, 'GET', '/api/auth/me')).statusCode).toBe(200);
    const dup = `${cookie}; ${cookie.replace(/=.*/, '=' + 'A'.repeat(43))}`;
    expect((await api(t.app, dup, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('refuses changing your own password via the users API (needs current password)', async () => {
    const cookie = await login(t.app);
    const me = (await api(t.app, cookie, 'GET', '/api/auth/me')).json() as { user: { id: number } };
    const res = await api(t.app, cookie, 'PATCH', `/api/users/${me.user.id}`, { password: 'a brand new password' });
    expect(res.statusCode).toBe(400);
  });

  it('marks API responses no-store and handles malformed URLs with headers', async () => {
    const cookie = await login(t.app);
    expect((await api(t.app, cookie, 'GET', '/api/sites')).headers['cache-control']).toBe('no-store');
    const bad = await t.app.inject({ method: 'GET', url: '/%zz' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'bad request' });
    expect(bad.headers['content-security-policy']).toBeDefined();
  });

  it('rejects emails with control or bidi characters', async () => {
    const cookie = await login(t.app);
    for (const email of ['\u001b[31mevil@x.com', 'a\u202e@x.com', 'a@x']) {
      const res = await api(t.app, cookie, 'POST', '/api/users', { email, password: 'long enough password', role: 'viewer' });
      expect(res.statusCode).toBe(400);
    }
  });
});
