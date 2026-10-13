import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password.js';
import {
  MIN,
  api,
  createCloudApp,
  login,
  pageview,
  post,
  sendEvent,
  signupMember,
  type CloudTestApp,
} from './helpers.js';

let t: CloudTestApp;
let admin: string;
let viewer: string;
let a: { cookie: string; id: number };
let b: { cookie: string; id: number };
let siteA: string;
let siteB: string;
let siteOp: string;

const VIEWER_PASSWORD = 'viewer password 123';

async function createSite(cookie: string, name: string, domain: string): Promise<string> {
  const res = await api(t.app, cookie, 'POST', '/api/sites', { name, domains: [domain] });
  if (res.statusCode !== 201) throw new Error(`create site: ${res.statusCode} ${res.body}`);
  return (res.json() as { site: { id: string } }).site.id;
}

beforeEach(async () => {
  t = await createCloudApp({ env: { MEMBER_SITE_LIMIT: '3' } });
  admin = await login(t.app);
  // Hosted mode no longer creates viewers; one from before SIGNUP_ENABLED still works.
  t.ctx.users.create('viewer@example.com', await hashPassword(VIEWER_PASSWORD), 'viewer', t.clock.t);
  viewer = await login(t.app, 'viewer@example.com', VIEWER_PASSWORD);
  a = await signupMember(t, 'alice@example.com');
  b = await signupMember(t, 'bob@example.com');
  siteA = await createSite(a.cookie, 'Alice', 'alice.example');
  siteB = await createSite(b.cookie, 'Bob', 'bob.example');
  siteOp = await createSite(admin, 'Operator', 'operator.example');
});
afterEach(async () => {
  await t.app.close();
});

const READ_PATHS = (id: string): string[] => [
  `/api/sites/${id}`,
  `/api/sites/${id}/stats/summary`,
  `/api/sites/${id}/stats/timeseries`,
  `/api/sites/${id}/stats/breakdown?dimension=path`,
  `/api/sites/${id}/stats/event-props?event=Signup`,
  `/api/sites/${id}/stats/realtime`,
  `/api/sites/${id}/stats/live`,
  `/api/sites/${id}/vitals/summary`,
  `/api/sites/${id}/vitals/timeseries?metric=LCP`,
  `/api/sites/${id}/vitals/breakdown?metric=LCP&dimension=path`,
  `/api/sites/${id}/export`,
];

describe('site authorization', () => {
  it('members only reach their own sites; everything else is a 404 like a missing site', async () => {
    const missing = await api(t.app, a.cookie, 'GET', '/api/sites/zzzzzzzzzzzz');
    expect(missing.statusCode).toBe(404);
    for (const [cookie, own, others] of [
      [a.cookie, siteA, [siteB, siteOp]],
      [b.cookie, siteB, [siteA, siteOp]],
    ] as const) {
      for (const path of READ_PATHS(own)) {
        expect((await api(t.app, cookie, 'GET', path)).statusCode, path).toBe(200);
      }
      expect((await api(t.app, cookie, 'HEAD', `/api/sites/${own}/export`)).statusCode).toBe(200);
      for (const other of others) {
        for (const path of READ_PATHS(other)) {
          const res = await api(t.app, cookie, 'GET', path);
          expect(res.statusCode, path).toBe(404);
          expect(res.body).toBe(missing.body);
        }
        expect((await api(t.app, cookie, 'HEAD', `/api/sites/${other}/export`)).statusCode).toBe(404);
        expect((await api(t.app, cookie, 'PATCH', `/api/sites/${other}`, { name: 'pwned' })).statusCode).toBe(404);
        expect((await api(t.app, cookie, 'DELETE', `/api/sites/${other}`)).statusCode).toBe(404);
      }
    }
    expect(t.ctx.sites.byId(siteB)?.name).toBe('Bob');
    expect(t.ctx.sites.byId(siteOp)?.name).toBe('Operator');
  });

  it('members manage their own sites', async () => {
    const patched = await api(t.app, a.cookie, 'PATCH', `/api/sites/${siteA}`, { name: 'Alice 2', domains: ['alice2.example'] });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({
      site: { id: siteA, name: 'Alice 2', domains: ['alice2.example'], createdAt: t.clock.t, suspended: false },
    });
    expect((await api(t.app, a.cookie, 'DELETE', `/api/sites/${siteA}`)).statusCode).toBe(204);
    expect(t.ctx.sites.byId(siteA)).toBeNull();
  });

  it('viewers read every site but cannot change anything', async () => {
    for (const id of [siteA, siteB, siteOp]) {
      for (const path of READ_PATHS(id)) expect((await api(t.app, viewer, 'GET', path)).statusCode, path).toBe(200);
      expect((await api(t.app, viewer, 'PATCH', `/api/sites/${id}`, { name: 'x' })).statusCode).toBe(403);
      expect((await api(t.app, viewer, 'DELETE', `/api/sites/${id}`)).statusCode).toBe(403);
    }
    expect((await api(t.app, viewer, 'POST', '/api/sites', { name: 'v', domains: ['v.example'] })).statusCode).toBe(403);
    expect((await api(t.app, viewer, 'GET', '/api/users')).statusCode).toBe(403);
  });

  it('admins manage every site and see owners', async () => {
    const list = (await api(t.app, admin, 'GET', '/api/sites')).json() as { sites: Array<{ id: string; ownerId: number | null }> };
    expect(new Map(list.sites.map((s) => [s.id, s.ownerId]))).toEqual(
      new Map<string, number | null>([
        [siteA, a.id],
        [siteB, b.id],
        [siteOp, null],
      ]),
    );
    expect((await api(t.app, admin, 'PATCH', `/api/sites/${siteB}`, { name: 'Renamed' })).statusCode).toBe(200);
    expect((await api(t.app, admin, 'DELETE', `/api/sites/${siteA}`)).statusCode).toBe(204);
  });

  it('lists and overview only contain accessible sites; ownerId only for admins', async () => {
    const mine = (await api(t.app, a.cookie, 'GET', '/api/sites')).json() as { sites: Array<Record<string, unknown>> };
    expect(mine.sites).toEqual([{ id: siteA, name: 'Alice', domains: ['alice.example'], createdAt: t.clock.t, suspended: false }]);
    const overview = (await api(t.app, a.cookie, 'GET', '/api/overview')).json() as { sites: Array<{ id: string }> };
    expect(overview.sites.map((s) => s.id)).toEqual([siteA]);
    const vs = (await api(t.app, viewer, 'GET', '/api/sites')).json() as { sites: Array<Record<string, unknown>> };
    expect(vs.sites).toHaveLength(3);
    expect(vs.sites.every((s) => !('ownerId' in s))).toBe(true);
    expect(((await api(t.app, viewer, 'GET', '/api/overview')).json() as { sites: unknown[] }).sites).toHaveLength(3);
  });

  it('members cannot manage users', async () => {
    expect((await api(t.app, a.cookie, 'GET', '/api/users')).statusCode).toBe(403);
    expect((await api(t.app, a.cookie, 'POST', '/api/users', { email: 'x@example.com', password: 'long enough password', role: 'admin' })).statusCode).toBe(403);
    expect((await api(t.app, a.cookie, 'PATCH', `/api/users/${a.id}`, { role: 'admin' })).statusCode).toBe(403);
    expect((await api(t.app, a.cookie, 'DELETE', `/api/users/${b.id}`)).statusCode).toBe(403);
    expect(t.ctx.users.byId(a.id)?.role).toBe('member');
  });

  it('hosted mode creates no new viewers (they would read every tenant)', async () => {
    const created = await api(t.app, admin, 'POST', '/api/users', { email: 'v2@example.com', password: 'viewer password 123', role: 'viewer' });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toEqual({ error: expect.stringMatching(/viewer accounts are not available in hosted mode/) });
    expect((await api(t.app, admin, 'POST', '/api/users', { email: 'v2@example.com', password: 'viewer password 123' })).statusCode).toBe(400);
    expect(t.ctx.users.byEmail('v2@example.com')).toBeNull();
    expect((await api(t.app, admin, 'PATCH', `/api/users/${a.id}`, { role: 'viewer' })).statusCode).toBe(400);
    expect(t.ctx.users.byId(a.id)?.role).toBe('member');
    // the existing viewer can still be changed / kept
    const viewerId = t.ctx.users.byEmail('viewer@example.com')!.id;
    expect((await api(t.app, admin, 'PATCH', `/api/users/${viewerId}`, { role: 'viewer' })).statusCode).toBe(200);
  });

  it('members get at most 5 domains per site and no wildcard over shared hosting suffixes', async () => {
    const six = ['a.example', 'b.example', 'c.example', 'd.example', 'e.example', 'f.example'];
    expect((await api(t.app, a.cookie, 'POST', '/api/sites', { name: 'Six', domains: six })).statusCode).toBe(400);
    expect((await api(t.app, a.cookie, 'PATCH', `/api/sites/${siteA}`, { domains: six })).statusCode).toBe(400);
    expect((await api(t.app, a.cookie, 'PATCH', `/api/sites/${siteA}`, { domains: six.slice(0, 5) })).statusCode).toBe(200);
    for (const d of ['*.github.io', '*.Vercel.app', '*.netlify.app', '*.pages.dev', '*.herokuapp.com', '*.web.app', '*.appspot.com']) {
      const res = await api(t.app, a.cookie, 'POST', '/api/sites', { name: 'W', domains: [d] });
      expect(res.statusCode, d).toBe(400);
      expect(res.json()).toEqual({ error: expect.stringMatching(/shared hosting/) });
    }
    // their own subdomain of a shared host (or a wildcard below it) is fine
    expect((await api(t.app, a.cookie, 'PATCH', `/api/sites/${siteA}`, { domains: ['alice.github.io', '*.alice.vercel.app'] })).statusCode).toBe(200);
    // admins are unaffected
    expect((await api(t.app, admin, 'POST', '/api/sites', { name: 'Op', domains: ['*.github.io', ...six] })).statusCode).toBe(201);
  });

  it('admins can create verified members; deleting a member cascades its sites', async () => {
    const res = await api(t.app, admin, 'POST', '/api/users', { email: 'carol@example.com', password: 'carol password 12', role: 'member' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ user: { role: 'member', emailVerified: true } });
    const carol = await login(t.app, 'carol@example.com', 'carol password 12');
    expect(((await api(t.app, carol, 'GET', '/api/sites')).json() as { sites: unknown[] }).sites).toEqual([]);
    expect((await api(t.app, admin, 'DELETE', `/api/users/${a.id}`)).statusCode).toBe(204);
    expect(t.ctx.sites.byId(siteA)).toBeNull();
    expect(t.ctx.sites.byId(siteB)).not.toBeNull();
  });
});

describe('member site allowance (billing disabled)', () => {
  it('refuses sites beyond MEMBER_SITE_LIMIT with 402 upgrade_required', async () => {
    await createSite(a.cookie, 'A2', 'a2.example');
    const third = await createSite(a.cookie, 'A3', 'a3.example');
    const res = await api(t.app, a.cookie, 'POST', '/api/sites', { name: 'A4', domains: ['a4.example'] });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: 'site limit reached', code: 'upgrade_required' });
    expect((await api(t.app, a.cookie, 'DELETE', `/api/sites/${third}`)).statusCode).toBe(204);
    expect((await api(t.app, a.cookie, 'POST', '/api/sites', { name: 'A4', domains: ['a4.example'] })).statusCode).toBe(201);
    // admins are never limited
    for (let i = 0; i < 4; i++) await createSite(admin, `Op${i}`, `op${i}.example`);
    expect((await api(t.app, a.cookie, 'GET', '/api/billing')).json()).toMatchObject({
      enabled: false,
      sitesUsed: 3,
      sitesAllowed: 3,
      status: 'none',
    });
  });

  it('suspends sites over the allowance: ingest drops them silently, role change lifts it', async () => {
    const extra = [1, 2, 3].map((i) => {
      t.clock.t += 1000;
      return t.ctx.sites.create(`X${i}`, [`x${i}.example`], t.clock.t, a.id).id;
    });
    t.ctx.billing.recompute(a.id);
    const sites = (await api(t.app, a.cookie, 'GET', '/api/sites')).json() as { sites: Array<{ id: string; suspended: boolean }> };
    const suspended = new Map(sites.sites.map((s) => [s.id, s.suspended]));
    expect(suspended.get(siteA)).toBe(false);
    expect(suspended.get(extra[0]!)).toBe(false);
    expect(suspended.get(extra[1]!)).toBe(false);
    expect(suspended.get(extra[2]!)).toBe(true);

    expect((await sendEvent(t.app, pageview(extra[2]!, 'https://x3.example/'))).statusCode).toBe(202);
    expect((await sendEvent(t.app, pageview(extra[0]!, 'https://x1.example/'))).statusCode).toBe(202);
    const counts = t.ctx.db.prepare('SELECT site_id, COUNT(*) AS n FROM events GROUP BY site_id').all();
    expect(counts).toEqual([{ site_id: extra[0], n: 1 }]);
    // invalid payloads for suspended sites are still rejected as before
    expect((await sendEvent(t.app, pageview(extra[2]!, 'https://evil.example/'))).statusCode).toBe(400);

    expect((await api(t.app, admin, 'PATCH', `/api/users/${a.id}`, { role: 'admin' })).statusCode).toBe(200);
    expect(t.ctx.sites.byId(extra[2]!)?.suspended).toBe(false);
  });
});

describe('live map', () => {
  it('returns visitors, countries and the newest pageviews of the last 5 minutes', async () => {
    const now = t.clock.t;
    t.clock.t = now - 10 * MIN;
    await sendEvent(t.app, pageview(siteA, 'https://alice.example/old'), { ip: '203.0.113.9' });
    for (let i = 0; i < 55; i++) {
      t.clock.t = now - 4 * MIN + i * 1000;
      await sendEvent(t.app, pageview(siteA, `https://alice.example/p${i}`), { ip: `203.0.113.${(i % 3) + 1}` });
    }
    await sendEvent(t.app, { site: siteA, type: 'event', name: 'Signup', url: 'https://alice.example/x' }, { ip: '203.0.113.1' });
    await sendEvent(t.app, pageview(siteB, 'https://bob.example/'), { ip: '203.0.113.200' });
    t.clock.t = now;

    const res = await api(t.app, a.cookie, 'GET', `/api/sites/${siteA}/stats/live`);
    expect(res.statusCode).toBe(200);
    const live = res.json() as { visitors: number; countries: Array<{ country: string | null; visitors: number }>; recent: Array<{ ts: number; path: string; country: string | null }> };
    expect(live.visitors).toBe(3);
    expect(live.countries).toEqual([{ country: null, visitors: 3 }]);
    expect(live.recent).toHaveLength(50);
    expect(live.recent[0]).toEqual({ ts: now - 4 * MIN + 54_000, country: null, path: '/p54' });
    expect(live.recent.every((r, i) => i === 0 || r.ts <= live.recent[i - 1]!.ts)).toBe(true);
    expect(live.recent.some((r) => r.path === '/old')).toBe(false);

    const all = (await api(t.app, a.cookie, 'GET', '/api/live')).json();
    expect(all).toEqual({ visitors: 3, countries: [{ country: null, visitors: 3 }], sites: [{ id: siteA, name: 'Alice', visitors: 3 }] });
    const forViewer = (await api(t.app, viewer, 'GET', '/api/live')).json() as { visitors: number; sites: Array<{ id: string }> };
    expect(forViewer.visitors).toBe(4);
    expect(forViewer.sites.map((s) => s.id)).toEqual([siteA, siteB]);
    const forB = (await api(t.app, b.cookie, 'GET', '/api/live')).json();
    expect(forB).toMatchObject({ visitors: 1, sites: [{ id: siteB, name: 'Bob', visitors: 1 }] });
  });

  it('is protected like the other stats endpoints', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/live' })).statusCode).toBe(401);
    const cross = await t.app.inject({ method: 'GET', url: '/api/live', headers: { cookie: a.cookie, 'sec-fetch-site': 'cross-site' } });
    expect(cross.statusCode).toBe(403);
    const crossSite = await t.app.inject({
      method: 'GET',
      url: `/api/sites/${siteA}/stats/live`,
      headers: { cookie: a.cookie, 'sec-fetch-site': 'same-site' },
    });
    expect(crossSite.statusCode).toBe(403);
    // never cached: a new pageview shows up immediately
    expect(((await api(t.app, a.cookie, 'GET', `/api/sites/${siteA}/stats/live`)).json() as { visitors: number }).visitors).toBe(0);
    await sendEvent(t.app, pageview(siteA, 'https://alice.example/'));
    expect(((await api(t.app, a.cookie, 'GET', `/api/sites/${siteA}/stats/live`)).json() as { visitors: number }).visitors).toBe(1);
  });

  it('an empty member gets an empty live map', async () => {
    const c = await signupMember(t, 'empty@example.com');
    expect((await api(t.app, c.cookie, 'GET', '/api/live')).json()).toEqual({ visitors: 0, countries: [], sites: [] });
    expect((await post(t.app, '/api/auth/login', { email: 'empty@example.com', password: 'member password 123' })).statusCode).toBe(200);
  });
});
