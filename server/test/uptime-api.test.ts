import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password.js';
import { createEngine, type Engine } from '../src/uptime/engine/index.js';
import { processorFor } from '../src/uptime/engine/processor.js';
import { setCheckers, uptimeRuntime } from '../src/uptime/runtime.js';
import type { SecretBox } from '../src/uptime/secrets.js';
import { DAY, HOUR, MIN, api, createCloudApp, login, signupMember, type CloudTestApp } from './helpers.js';
import { FakeClock, FakeResults, fakeCheckers, fakeSecretBox, nullNet } from './uptime-core-fakes.js';

let t: CloudTestApp;
let admin: string;
let viewer: string;
let a: { cookie: string; id: number };
let b: { cookie: string; id: number };
let siteA: string;
let siteB: string;
let siteOp: string;
let results: FakeResults;
let engine: Engine | null = null;

async function createSite(cookie: string, name: string, domain: string): Promise<string> {
  const res = await api(t.app, cookie, 'POST', '/api/sites', { name, domains: [domain] });
  if (res.statusCode !== 201) throw new Error(`create site: ${res.statusCode} ${res.body}`);
  return (res.json() as { site: { id: string } }).site.id;
}

interface MonitorJson {
  uid: string;
  siteId: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  secretsSet: string[];
  pushUrl: string | null;
  publicId: string | null;
  tags: Array<{ uid: string; name: string; color: string; value: string }>;
  channelUids: string[];
  parentUid: string | null;
  active: boolean;
  intervalS: number;
  timeoutMs: number;
  state: { status: number };
}

async function createMonitor(cookie: string, site: string, body: Record<string, unknown> = {}): Promise<MonitorJson> {
  const res = await api(t.app, cookie, 'POST', `/api/sites/${site}/monitors`, {
    type: 'fakehttp',
    name: 'Homepage',
    intervalS: 60,
    config: { url: 'https://example.com/' },
    ...body,
  });
  if (res.statusCode !== 201) throw new Error(`create monitor: ${res.statusCode} ${res.body}`);
  return (res.json() as { monitor: MonitorJson }).monitor;
}

beforeEach(async () => {
  t = await createCloudApp({ env: { MEMBER_SITE_LIMIT: '3', MEMBER_MONITORS_PER_SITE: '3' } });
  t.ctx.secretBox = () => fakeSecretBox as SecretBox;
  results = new FakeResults();
  setCheckers(t.ctx, fakeCheckers(results));
  admin = await login(t.app);
  t.ctx.users.create('viewer@example.com', await hashPassword('viewer password 123'), 'viewer', t.clock.t);
  viewer = await login(t.app, 'viewer@example.com', 'viewer password 123');
  a = await signupMember(t, 'alice@example.com');
  b = await signupMember(t, 'bob@example.com');
  siteA = await createSite(a.cookie, 'Alice', 'alice.example');
  siteB = await createSite(b.cookie, 'Bob', 'bob.example');
  siteOp = await createSite(admin, 'Operator', 'operator.example');
});

afterEach(async () => {
  await engine?.stop();
  engine = null;
  await t.app.close();
});

describe('monitor tenancy', () => {
  it('members only reach monitors of their own sites (404 otherwise); viewers read only; admins everything', async () => {
    const ma = await createMonitor(a.cookie, siteA);
    const mb = await createMonitor(b.cookie, siteB);
    const mo = await createMonitor(admin, siteOp);

    // listing per site
    expect((await api(t.app, a.cookie, 'GET', `/api/sites/${siteA}/monitors`)).statusCode).toBe(200);
    expect((await api(t.app, a.cookie, 'GET', `/api/sites/${siteB}/monitors`)).statusCode).toBe(404);
    expect((await api(t.app, a.cookie, 'POST', `/api/sites/${siteB}/monitors`, { type: 'fakehttp', name: 'x', config: { url: 'https://x.com/' } })).statusCode).toBe(404);

    const missing = await api(t.app, a.cookie, 'GET', '/api/monitors/zzzzzzzzzzzz');
    expect(missing.statusCode).toBe(404);
    for (const other of [mb.uid, mo.uid]) {
      for (const path of ['', '/heartbeats', '/stats', '/events', '/outages']) {
        const res = await api(t.app, a.cookie, 'GET', `/api/monitors/${other}${path}`);
        expect(res.statusCode, path).toBe(404);
        expect(res.body).toBe(missing.body);
      }
      for (const [method, path] of [
        ['PATCH', ''],
        ['DELETE', ''],
        ['POST', '/pause'],
        ['POST', '/resume'],
        ['POST', '/clone'],
        ['POST', '/check'],
        ['POST', '/push-token'],
        ['POST', '/badges'],
      ] as const) {
        const res = await api(t.app, a.cookie, method, `/api/monitors/${other}${path}`, method === 'DELETE' ? undefined : { enabled: true, name: 'x' });
        expect(res.statusCode, `${method} ${path}`).toBe(404);
      }
    }
    for (const path of ['', '/heartbeats', '/stats', '/events', '/outages']) {
      expect((await api(t.app, a.cookie, 'GET', `/api/monitors/${ma.uid}${path}`)).statusCode, path).toBe(200);
    }

    // overview only lists accessible sites/monitors
    const ov = (await api(t.app, a.cookie, 'GET', '/api/uptime/overview')).json() as { sites: Array<{ siteId: string }>; monitors: MonitorJson[] };
    expect(ov.sites.map((s) => s.siteId)).toEqual([siteA]);
    expect(ov.monitors.map((m) => m.uid)).toEqual([ma.uid]);
    const ovAdmin = (await api(t.app, admin, 'GET', '/api/uptime/overview')).json() as { monitors: MonitorJson[] };
    expect(ovAdmin.monitors.map((m) => m.uid).sort()).toEqual([ma.uid, mb.uid, mo.uid].sort());

    // viewer: read everything, change nothing
    expect((await api(t.app, viewer, 'GET', `/api/monitors/${ma.uid}`)).statusCode).toBe(200);
    expect((await api(t.app, viewer, 'PATCH', `/api/monitors/${ma.uid}`, { name: 'x' })).statusCode).toBe(403);
    expect((await api(t.app, viewer, 'POST', `/api/monitors/${ma.uid}/pause`)).statusCode).toBe(403);
    expect((await api(t.app, viewer, 'DELETE', `/api/monitors/${ma.uid}`)).statusCode).toBe(403);
    expect((await api(t.app, viewer, 'POST', `/api/sites/${siteOp}/monitors`, { type: 'fakehttp', name: 'x', config: { url: 'https://x.com/' } })).statusCode).toBe(403);

    // admin manages member monitors too
    expect((await api(t.app, admin, 'PATCH', `/api/monitors/${mb.uid}`, { name: 'Renamed' })).statusCode).toBe(200);
  });

  it('requires authentication and the CSRF header', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/uptime/overview' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/uptime/types' })).statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: `/api/sites/${siteA}/monitors`, headers: { cookie: a.cookie }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
    const crossSite = await t.app.inject({ method: 'GET', url: '/api/uptime/overview', headers: { cookie: a.cookie, 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.statusCode).toBe(403);
  });

  it('deleted and soft-deleted sites hide their monitors', async () => {
    const m = await createMonitor(a.cookie, siteA);
    expect((await api(t.app, a.cookie, 'DELETE', `/api/sites/${siteA}`)).statusCode).toBe(204);
    expect((await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}`)).statusCode).toBe(404);
    const row = t.ctx.db.prepare('SELECT deleted_at FROM monitors WHERE uid = ?').get(m.uid) as { deleted_at: number | null } | undefined;
    // either soft-deleted or already purged together with the site
    expect(row === undefined || row.deleted_at !== null).toBe(true);
  });
});

describe('monitor validation and limits', () => {
  it('validates fields with {error, field}', async () => {
    const bad = async (body: Record<string, unknown>, field: string): Promise<void> => {
      const res = await api(t.app, a.cookie, 'POST', `/api/sites/${siteA}/monitors`, {
        type: 'fakehttp',
        name: 'x',
        intervalS: 60,
        config: { url: 'https://example.com/' },
        ...body,
      });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect((res.json() as { field?: string }).field, JSON.stringify(body)).toBe(field);
    };
    await bad({ type: 'nope' }, 'type');
    await bad({ name: '' }, 'name');
    await bad({ name: 'a‮b' }, 'name');
    await bad({ name: 'x'.repeat(101) }, 'name');
    await bad({ intervalS: 30 }, 'intervalS'); // member minimum 60
    await bad({ intervalS: 86_401 }, 'intervalS');
    await bad({ timeoutMs: 31_000, intervalS: 120 }, 'timeoutMs'); // member max 30 s
    await bad({ timeoutMs: 50_000, intervalS: 60 }, 'timeoutMs'); // > 0.8 * interval
    await bad({ maxRetries: 6 }, 'maxRetries');
    await bad({ resendEvery: -1 }, 'resendEvery');
    await bad({ upsideDown: 'yes' }, 'upsideDown');
    await bad({ config: { url: 'ftp://x' } }, 'url'); // checker ValidationError
    await bad({ config: 'x' }, 'config');
    await bad({ type: 'fakedocker' }, 'type'); // hosted: disabled for members
    await bad({ type: 'unavailable' }, 'type');
    await bad({ parentUid: 'zzzzzzzzzzzz' }, 'parentUid');
    await bad({ tags: [{ uid: 'zzzzzzzzzzzz' }] }, 'tags');
    await bad({ channelUids: ['zzzzzzzzzzzz'] }, 'channelUids');
    // admins: the global minimum applies and disabled types are allowed
    const res = await api(t.app, admin, 'POST', `/api/sites/${siteOp}/monitors`, {
      type: 'fakedocker',
      name: 'x',
      intervalS: 20,
      timeoutMs: 16_000,
      config: { url: 'https://example.com/' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('limits monitors per site for members (402 limit_reached)', async () => {
    for (let i = 0; i < 3; i++) await createMonitor(a.cookie, siteA, { name: `m${i}` });
    const res = await api(t.app, a.cookie, 'POST', `/api/sites/${siteA}/monitors`, { type: 'fakehttp', name: 'four', config: { url: 'https://example.com/' } });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: 'limit_reached' });
    const first = ((await api(t.app, a.cookie, 'GET', `/api/sites/${siteA}/monitors`)).json() as { monitors: MonitorJson[] }).monitors[0]!;
    expect((await api(t.app, a.cookie, 'POST', `/api/monitors/${first.uid}/clone`)).statusCode).toBe(402);
    // admins are not limited
    for (let i = 0; i < 4; i++) await createMonitor(admin, siteOp, { name: `op${i}` });
  });

  it('types endpoint reports availability, hosted permission and the user limits', async () => {
    const m = (await api(t.app, a.cookie, 'GET', '/api/uptime/types')).json() as {
      types: Array<{ type: string; available: boolean; hostedAllowed: boolean; fields: unknown[] }>;
      limits: Record<string, unknown>;
    };
    const byType = new Map(m.types.map((x) => [x.type, x]));
    expect(byType.get('fakehttp')).toMatchObject({ available: true, hostedAllowed: true });
    expect(byType.get('fakedocker')).toMatchObject({ hostedAllowed: false });
    expect(byType.get('unavailable')).toMatchObject({ available: false });
    expect(m.limits).toEqual({ minIntervalS: 60, maxTimeoutMs: 30_000, maxRetries: 5, monitorsPerSite: 3 });
    const adm = (await api(t.app, admin, 'GET', '/api/uptime/types')).json() as { limits: Record<string, unknown> };
    expect(adm.limits).toEqual({ minIntervalS: 20, maxTimeoutMs: 60_000, maxRetries: 10, monitorsPerSite: null });
  });

  it('groups: same site, type group, no cycles', async () => {
    const g1 = await createMonitor(admin, siteOp, { type: 'group', name: 'G1', config: {} });
    const g2 = await createMonitor(admin, siteOp, { type: 'group', name: 'G2', config: {}, parentUid: g1.uid });
    const plain = await createMonitor(admin, siteOp, { name: 'plain' });
    expect(g2.parentUid).toBe(g1.uid);
    const cyc = await api(t.app, admin, 'PATCH', `/api/monitors/${g1.uid}`, { parentUid: g2.uid });
    expect(cyc.statusCode).toBe(400);
    expect(cyc.json()).toMatchObject({ field: 'parentUid' });
    expect((await api(t.app, admin, 'PATCH', `/api/monitors/${g1.uid}`, { parentUid: g1.uid })).statusCode).toBe(400);
    expect((await api(t.app, admin, 'PATCH', `/api/monitors/${g1.uid}`, { parentUid: plain.uid })).statusCode).toBe(400);
    const memberGroup = await createMonitor(a.cookie, siteA, { type: 'group', config: {} });
    expect((await api(t.app, admin, 'PATCH', `/api/monitors/${plain.uid}`, { parentUid: memberGroup.uid })).statusCode).toBe(400);
    // deleting a group detaches its children
    expect((await api(t.app, admin, 'DELETE', `/api/monitors/${g1.uid}`)).statusCode).toBe(204);
    const after = (await api(t.app, admin, 'GET', `/api/monitors/${g2.uid}`)).json() as { monitor: MonitorJson };
    expect(after.monitor.parentUid).toBeNull();
  });
});

describe('secrets, push tokens, badges, clone, tags, channels', () => {
  it('secrets are write-only: secretsSet, "" keeps, null clears', async () => {
    const m = await createMonitor(a.cookie, siteA, { config: { url: 'https://example.com/', password: 's3cret-value' } });
    expect(m.secretsSet).toEqual(['password']);
    expect(JSON.stringify(m)).not.toContain('s3cret-value');
    const raw = t.ctx.db.prepare('SELECT config, secrets FROM monitors WHERE uid = ?').get(m.uid) as { config: string; secrets: Buffer };
    expect(raw.config).not.toContain('s3cret');
    expect(fakeSecretBox.open(raw.secrets, `monitor:${m.uid}`)).toEqual({ password: 's3cret-value' });
    let res = await api(t.app, a.cookie, 'PATCH', `/api/monitors/${m.uid}`, { config: { url: 'https://example.org/', password: '' } });
    expect((res.json() as { monitor: MonitorJson }).monitor).toMatchObject({ secretsSet: ['password'], config: { url: 'https://example.org/' } });
    res = await api(t.app, a.cookie, 'PATCH', `/api/monitors/${m.uid}`, { name: 'no config change' });
    expect((res.json() as { monitor: MonitorJson }).monitor.secretsSet).toEqual(['password']);
    res = await api(t.app, a.cookie, 'PATCH', `/api/monitors/${m.uid}`, { config: { url: 'https://example.org/', password: null } });
    expect((res.json() as { monitor: MonitorJson }).monitor.secretsSet).toEqual([]);
    // clone re-encrypts with the clone's uid
    await api(t.app, a.cookie, 'PATCH', `/api/monitors/${m.uid}`, { config: { url: 'https://example.org/', password: 'again' } });
    const clone = (await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/clone`)).json() as { monitor: MonitorJson };
    expect(clone.monitor.name).toBe('no config change (copy)');
    const cloneRow = t.ctx.db.prepare('SELECT secrets FROM monitors WHERE uid = ?').get(clone.monitor.uid) as { secrets: Buffer };
    expect(fakeSecretBox.open(cloneRow.secrets, `monitor:${clone.monitor.uid}`)).toEqual({ password: 'again' });
  });

  it('push URL shown once; regenerate invalidates the old token; only sha256 stored', async () => {
    const m = await createMonitor(a.cookie, siteA, { type: 'push', config: {} });
    expect(m.pushUrl).toMatch(/^https:\/\/analytics\.example\.com\/api\/push\/[A-Za-z0-9_-]{32}$/);
    const token = m.pushUrl!.split('/').pop()!;
    const row = t.ctx.db.prepare('SELECT push_token_hash FROM monitors WHERE uid = ?').get(m.uid) as { push_token_hash: string };
    expect(row.push_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.push_token_hash).not.toContain(token);
    const got = (await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}`)).json() as { monitor: MonitorJson };
    expect(got.monitor.pushUrl).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: `/api/push/${token}` })).statusCode).toBe(200);
    const regen = (await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/push-token`)).json() as { pushUrl: string };
    const token2 = regen.pushUrl.split('/').pop()!;
    expect(token2).not.toBe(token);
    expect((await t.app.inject({ method: 'GET', url: `/api/push/${token}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/push/${token2}` })).statusCode).toBe(200);
    // push-token on a non-push monitor
    const plain = await createMonitor(a.cookie, siteA);
    expect((await api(t.app, a.cookie, 'POST', `/api/monitors/${plain.uid}/push-token`)).statusCode).toBe(400);
  });

  it('badges toggle a public id', async () => {
    const m = await createMonitor(a.cookie, siteA);
    const on = (await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/badges`, { enabled: true })).json() as { publicId: string };
    expect(on.publicId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(((await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/badges`, { enabled: true })).json() as { publicId: string }).publicId).toBe(on.publicId);
    expect(((await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}`)).json() as { monitor: MonitorJson }).monitor.publicId).toBe(on.publicId);
    expect((await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/badges`, { enabled: false })).json()).toEqual({ publicId: null });
    expect((await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/badges`, { enabled: 'yes' })).statusCode).toBe(400);
  });

  it('tags are owner scoped and can only be linked within the same owner', async () => {
    const tagA = (await api(t.app, a.cookie, 'POST', '/api/tags', { name: 'prod', color: '#FF0000' })).json() as { tag: { uid: string; color: string } };
    expect(tagA.tag.color).toBe('#ff0000');
    expect((await api(t.app, a.cookie, 'POST', '/api/tags', { name: 'PROD', color: '#00ff00' })).statusCode).toBe(409);
    expect((await api(t.app, a.cookie, 'POST', '/api/tags', { name: 'x', color: 'red' })).statusCode).toBe(400);
    const tagB = (await api(t.app, b.cookie, 'POST', '/api/tags', { name: 'prod', color: '#00ff00' })).json() as { tag: { uid: string } };
    const opTag = (await api(t.app, admin, 'POST', '/api/tags', { name: 'infra', color: '#0000ff' })).json() as { tag: { uid: string } };
    expect(((await api(t.app, a.cookie, 'GET', '/api/tags')).json() as { tags: Array<{ uid: string }> }).tags.map((x) => x.uid)).toEqual([tagA.tag.uid]);
    expect(((await api(t.app, admin, 'GET', '/api/tags')).json() as { tags: unknown[] }).tags).toHaveLength(3);
    expect((await api(t.app, a.cookie, 'PATCH', `/api/tags/${tagB.tag.uid}`, { name: 'mine' })).statusCode).toBe(404);
    expect((await api(t.app, a.cookie, 'DELETE', `/api/tags/${opTag.tag.uid}`)).statusCode).toBe(404);
    expect((await api(t.app, viewer, 'POST', '/api/tags', { name: 'v', color: '#000000' })).statusCode).toBe(403);

    const m = await createMonitor(a.cookie, siteA, { tags: [{ uid: tagA.tag.uid, value: 'eu' }] });
    expect(m.tags).toEqual([{ uid: tagA.tag.uid, name: 'prod', color: '#ff0000', value: 'eu' }]);
    const cross = await api(t.app, a.cookie, 'PATCH', `/api/monitors/${m.uid}`, { tags: [{ uid: tagB.tag.uid }] });
    expect(cross.statusCode).toBe(400);
    // admin editing the member's monitor still cannot attach operator tags
    expect((await api(t.app, admin, 'PATCH', `/api/monitors/${m.uid}`, { tags: [{ uid: opTag.tag.uid }] })).statusCode).toBe(400);
    expect((await api(t.app, a.cookie, 'DELETE', `/api/tags/${tagA.tag.uid}`)).statusCode).toBe(204);
    expect(((await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}`)).json() as { monitor: MonitorJson }).monitor.tags).toEqual([]);
  });

  it('notification channels: same owner only; default channels are linked to new monitors', async () => {
    const now = t.clock.t;
    const ins = t.ctx.db.prepare(
      `INSERT INTO notify_channels (uid, owner_id, type, name, config, is_default, active, created_at, updated_at) VALUES (?, ?, 'webhook', 'n', '{}', ?, 1, ?, ?)`,
    );
    ins.run('chanaaaaaaaa', a.id, 1, now, now);
    ins.run('chanbbbbbbbb', b.id, 0, now, now);
    const m = await createMonitor(a.cookie, siteA);
    expect(m.channelUids).toEqual(['chanaaaaaaaa']);
    const none = await createMonitor(a.cookie, siteA, { channelUids: [] });
    expect(none.channelUids).toEqual([]);
    expect((await api(t.app, a.cookie, 'PATCH', `/api/monitors/${m.uid}`, { channelUids: ['chanbbbbbbbb'] })).statusCode).toBe(400);
    const tooMany = await api(t.app, a.cookie, 'PATCH', `/api/monitors/${m.uid}`, { channelUids: ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => x.repeat(12)) });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe('actions and history', () => {
  it('pause / resume / check-now / delete', async () => {
    const m = await createMonitor(a.cookie, siteA);
    // no engine running
    expect((await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/check`)).statusCode).toBe(503);
    const clock = new FakeClock(t.clock, 0, 12_345 - t.clock.t);
    engine = createEngine(t.ctx, { clock, netFactory: () => nullNet });
    expect(uptimeRuntime(t.ctx).engine).toBe(engine);
    const ok = await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/check`);
    expect(ok.statusCode).toBe(202);
    expect((await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/check`)).statusCode).toBe(429); // per monitor
    let res = await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/pause`);
    expect((res.json() as { monitor: MonitorJson }).monitor.active).toBe(false);
    t.clock.t += 20_000;
    expect((await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/check`)).statusCode).toBe(409);
    res = await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/resume`);
    expect((res.json() as { monitor: MonitorJson }).monitor.active).toBe(true);
    expect((await api(t.app, a.cookie, 'DELETE', `/api/monitors/${m.uid}`)).statusCode).toBe(204);
    expect((await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}`)).statusCode).toBe(404);
    expect((await api(t.app, a.cookie, 'GET', `/api/sites/${siteA}/monitors`)).json()).toEqual({ monitors: [] });
  });

  it('heartbeats, stats, events and outages from recorded results', async () => {
    const m = await createMonitor(a.cookie, siteA, { maxRetries: 0 });
    const rec = t.ctx.db.prepare('SELECT id FROM monitors WHERE uid = ?').get(m.uid) as { id: number };
    const { MonitorRepo } = await import('../src/uptime/data/monitors.js');
    const mon = new MonitorRepo(t.ctx.db).byId(rec.id)!;
    const p = processorFor(t.ctx);
    const start = t.clock.t - 3 * HOUR;
    // 3 hours of minute checks: up, then 30 min down, then up
    for (let i = 0; i < 180; i++) {
      const ts = start + i * MIN;
      const down = i >= 60 && i < 90;
      p.record(mon, { kind: 'check', ok: !down, msg: down ? 'refused' : 'OK', latencyMs: 100 + (i % 10) }, false, { ts });
    }
    p.flush();
    const hb = (await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}/heartbeats?period=24h`)).json() as {
      interval: string;
      points: Array<{ t: number; status: number; latencyMs: number | null; upRatio: number | null }>;
    };
    expect(hb.interval).toBe('raw');
    expect(hb.points).toHaveLength(180);
    const week = (await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}/heartbeats?period=7d&tz=Europe/Brussels`)).json() as {
      interval: string;
      points: Array<{ status: number; upRatio: number | null }>;
    };
    expect(week.interval).toBe('hour');
    expect(week.points.length).toBeLessThanOrEqual(500);
    expect(week.points.filter((x) => x.upRatio !== null).length).toBeGreaterThanOrEqual(3);
    const month = (await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}/heartbeats?period=90d`)).json() as { interval: string; points: unknown[] };
    expect(month.interval).toBe('day');
    expect(month.points).toHaveLength(90);
    expect((await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}/heartbeats?period=24h&tz=Not/AZone`)).statusCode).toBe(400);
    expect((await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}/heartbeats?period=5y`)).statusCode).toBe(400);

    const stats = (await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}/stats?period=24h`)).json() as {
      uptime: number;
      checks: number;
      outages: number;
      downtimeMs: number;
      mttrMs: number;
      avgLatencyMs: number;
      bars: Array<{ upRatio: number | null }>;
    };
    expect(stats.checks).toBe(180);
    expect(stats.outages).toBe(1);
    expect(stats.downtimeMs).toBe(30 * MIN);
    expect(stats.mttrMs).toBe(30 * MIN);
    expect(stats.uptime).toBeCloseTo(149 / 179, 5);
    expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(100);
    expect(stats.bars).toHaveLength(90);
    expect(stats.bars.filter((x) => x.upRatio !== null).length).toBeGreaterThanOrEqual(1);

    const ev = (await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}/events?limit=2`)).json() as { events: Array<{ id: number; from: number | null; to: number }> };
    expect(ev.events.map((e) => [e.from, e.to])).toEqual([
      [0, 1],
      [1, 0],
    ]);
    const older = (await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}/events?before=${ev.events[1]!.id}`)).json() as { events: unknown[] };
    expect(older.events).toHaveLength(1);
    expect((await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}/events?limit=0`)).statusCode).toBe(400);
    const out = (await api(t.app, a.cookie, 'GET', `/api/monitors/${m.uid}/outages`)).json() as { outages: Array<{ startedAt: number; endedAt: number }> };
    expect(out.outages).toHaveLength(1);
    expect(out.outages[0]!.endedAt - out.outages[0]!.startedAt).toBe(30 * MIN);
    const list = (await api(t.app, a.cookie, 'GET', `/api/sites/${siteA}/monitors`)).json() as { monitors: Array<{ uptime24h: number; state: { status: number } }> };
    expect(list.monitors[0]!.uptime24h).toBeCloseTo(149 / 179, 5);
    expect(list.monitors[0]!.state.status).toBe(1);
  });
});

describe('maintenance API', () => {
  it('CRUD with computed status / next window; owner scoped links', async () => {
    const mA = await createMonitor(a.cookie, siteA);
    const mB = await createMonitor(b.cookie, siteB);
    let res = await api(t.app, a.cookie, 'POST', '/api/maintenances', {
      title: 'Weekly backup',
      strategy: 'weekly',
      tz: 'Europe/Brussels',
      weekdays: [0],
      timeStart: '02:00',
      timeEnd: '03:00',
      monitorUids: [mA.uid],
    });
    expect(res.statusCode).toBe(201);
    const mt = (res.json() as { maintenance: { uid: string; status: string; nextWindow: { start: number; end: number }; monitorUids: string[] } }).maintenance;
    expect(mt.status).toBe('scheduled');
    expect(mt.nextWindow.end - mt.nextWindow.start).toBe(HOUR);
    expect(mt.monitorUids).toEqual([mA.uid]);
    expect((await api(t.app, a.cookie, 'POST', '/api/maintenances', { title: 'x', strategy: 'manual', monitorUids: [mB.uid] })).statusCode).toBe(400);
    expect((await api(t.app, b.cookie, 'GET', `/api/maintenances/${mt.uid}`)).statusCode).toBe(404);
    expect((await api(t.app, viewer, 'GET', `/api/maintenances/${mt.uid}`)).statusCode).toBe(200);
    expect((await api(t.app, viewer, 'POST', `/api/maintenances/${mt.uid}/pause`)).statusCode).toBe(403);

    res = await api(t.app, a.cookie, 'PATCH', `/api/maintenances/${mt.uid}`, { strategy: 'single', startsAt: '2026-06-20T22:00', endsAt: '2026-06-21T02:00' });
    expect(res.statusCode).toBe(200);
    const single = (res.json() as { maintenance: { startsAt: number; endsAt: number; weekdays: number[] } }).maintenance;
    expect(single.startsAt).toBe(Date.UTC(2026, 5, 20, 20));
    expect(single.endsAt - single.startsAt).toBe(4 * HOUR);
    expect(single.weekdays).toEqual([]);

    const bad = async (body: Record<string, unknown>, field: string): Promise<void> => {
      const r = await api(t.app, a.cookie, 'POST', '/api/maintenances', { title: 'x', ...body });
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect((r.json() as { field: string }).field, JSON.stringify(body)).toBe(field);
    };
    await bad({ strategy: 'hourly' }, 'strategy');
    await bad({ strategy: 'manual', tz: 'Mars/Olympus' }, 'tz');
    await bad({ strategy: 'single', startsAt: Date.UTC(2026, 5, 2) }, 'endsAt');
    await bad({ strategy: 'single', startsAt: Date.UTC(2026, 5, 2), endsAt: Date.UTC(2026, 5, 1) }, 'endsAt');
    await bad({ strategy: 'weekly', timeStart: '25:00', timeEnd: '01:00', weekdays: [1] }, 'timeStart');
    await bad({ strategy: 'weekly', timeStart: '01:00', timeEnd: '02:00', weekdays: [] }, 'weekdays');
    await bad({ strategy: 'monthly', timeStart: '01:00', timeEnd: '02:00', daysOfMonth: [0] }, 'daysOfMonth');
    await bad({ strategy: 'interval', timeStart: '01:00', timeEnd: '02:00', intervalDays: 2 }, 'startsAt');
    await bad({ strategy: 'cron', cron: '61 * * * *', durationS: 600 }, 'cron');
    await bad({ strategy: 'cron', cron: '0 * * * *', durationS: 10 }, 'durationS');
    await bad({ strategy: 'single', startsAt: 'yesterday', endsAt: 'tomorrow' }, 'startsAt');

    const manual = (await api(t.app, a.cookie, 'POST', '/api/maintenances', { title: 'now', strategy: 'manual' })).json() as { maintenance: { uid: string; status: string } };
    expect(manual.maintenance.status).toBe('under-maintenance');
    const paused = (await api(t.app, a.cookie, 'POST', `/api/maintenances/${manual.maintenance.uid}/pause`)).json() as { maintenance: { status: string } };
    expect(paused.maintenance.status).toBe('inactive');
    const list = (await api(t.app, a.cookie, 'GET', '/api/maintenances')).json() as { maintenances: unknown[] };
    expect(list.maintenances).toHaveLength(2);
    expect(((await api(t.app, b.cookie, 'GET', '/api/maintenances')).json() as { maintenances: unknown[] }).maintenances).toHaveLength(0);
    expect((await api(t.app, a.cookie, 'DELETE', `/api/maintenances/${manual.maintenance.uid}`)).statusCode).toBe(204);
  });
});

describe('push endpoint', () => {
  it('records pushes, validates parameters, CORS, rate limits, unknown token 404', async () => {
    const m = await createMonitor(a.cookie, siteA, { type: 'push', config: {} });
    const url = new URL(m.pushUrl!).pathname;
    let res = await t.app.inject({ method: 'GET', url: `${url}?status=down&msg=${encodeURIComponent('disk \u0007full\nnow')}&ping=abc` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    processorFor(t.ctx).flush();
    const id = (t.ctx.db.prepare('SELECT id FROM monitors WHERE uid = ?').get(m.uid) as { id: number }).id;
    const beat = t.ctx.db.prepare('SELECT status, msg, latency_ms FROM heartbeats WHERE monitor_id = ? ORDER BY ts DESC').get(id);
    expect(beat).toEqual({ status: 0, msg: 'disk fullnow', latency_ms: null });

    expect((await t.app.inject({ method: 'HEAD', url })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url, payload: { any: 'body' } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'OPTIONS', url })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: `${url}?status=maybe` })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: `${url}?msg=${'x'.repeat(2001)}` })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/push/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/push/short' })).statusCode).toBe(404);
    // paused monitors refuse pushes like unknown tokens
    await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/pause`);
    res = await t.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/resume`);
    // per token rate limit
    let limited = 0;
    for (let i = 0; i < 70; i++) if ((await t.app.inject({ method: 'GET', url })).statusCode === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    t.clock.t += DAY;
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });
});

describe('SSE stream', () => {
  it('streams beats of accessible monitors only, with security headers', async () => {
    const mA = await createMonitor(a.cookie, siteA);
    const mB = await createMonitor(b.cookie, siteB);
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;
    const chunks: string[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/uptime/stream', headers: { cookie: a.cookie, 'sec-fetch-site': 'same-origin' } });
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve);
      req.on('error', reject);
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    res.setEncoding('utf8');
    res.on('data', (c: string) => chunks.push(c));
    const { MonitorRepo } = await import('../src/uptime/data/monitors.js');
    const repo = new MonitorRepo(t.ctx.db);
    const p = processorFor(t.ctx);
    p.record(repo.byUid(mB.uid)!, { kind: 'check', ok: true, msg: 'B secret', latencyMs: 1 }, false);
    p.record(repo.byUid(mA.uid)!, { kind: 'check', ok: false, msg: 'A down' }, false);
    for (let i = 0; i < 50 && !chunks.join('').includes('event: state'); i++) await new Promise((r) => setTimeout(r, 10));
    const text = chunks.join('');
    expect(text).toContain('retry: 5000');
    expect(text).toContain('event: beat');
    expect(text).toContain(`"uid":"${mA.uid}"`);
    expect(text).toContain('A down');
    expect(text).toContain('event: state');
    expect(text).not.toContain(mB.uid);
    expect(text).not.toContain('B secret');
    expect(uptimeRuntime(t.ctx).bus.listenerCount('beat')).toBe(1);
    req.destroy();
    for (let i = 0; i < 50 && uptimeRuntime(t.ctx).bus.listenerCount('beat') > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(uptimeRuntime(t.ctx).bus.listenerCount('beat')).toBe(0);
  });

  it('limits connections per user and requires auth', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/uptime/stream' })).statusCode).toBe(401);
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;
    const open: http.ClientRequest[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/uptime/stream', headers: { cookie: a.cookie } });
      open.push(req);
      statuses.push(await new Promise<number>((resolve) => req.on('response', (r) => resolve(r.statusCode ?? 0))));
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    for (const r of open) r.destroy();
  });
});
