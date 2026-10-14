// Regression tests for the uptime-core findings of the security audit (tenancy/API: HIGH 1, HIGH 2,
// MEDIUM 3, LOW 5–8; SSRF: M1, M3, L3) and the list-endpoint additions (recentBeats).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { hashPassword } from '../src/lib/password.js';
import { localDateOf, addDays } from '../src/lib/time.js';
import { MaintenanceRepo } from '../src/uptime/data/maintenance.js';
import { MonitorRepo } from '../src/uptime/data/monitors.js';
import { createEngine, destinationOf, type Engine } from '../src/uptime/engine/index.js';
import { processorFor } from '../src/uptime/engine/processor.js';
import { cronDayMatches, parseCron } from '../src/uptime/maintenance/cron.js';
import { maintenanceInfo } from '../src/uptime/maintenance/index.js';
import { currentWindow, nextWindow, zonedTime, type MaintenanceDef } from '../src/uptime/maintenance/windows.js';
import type { TargetPolicyOptions } from '../src/uptime/net/index.js';
import { computeSelfAddresses, getSelfAddresses, selfAddressesReady, setCheckers, setSelfAddresses, uptimeRuntime } from '../src/uptime/runtime.js';
import type { SecretBox } from '../src/uptime/secrets.js';
import { publicState } from '../src/uptime/status/cache.js';
import { recentBeats } from '../src/uptime/stats.js';
import { ADMIN_EMAIL, DAY, MIN, api, createCloudApp, createTestApp, login, signupMember, tmpDir, type CloudTestApp, type TestApp } from './helpers.js';
import { FakeClock, FakeResults, fakeCheckers, fakeSecretBox, nullNet, settle } from './uptime-core-fakes.js';

const SEC = 1000;
const HOUR = 3_600_000;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface MonitorJson {
  uid: string;
  intervalS: number;
  retryIntervalS: number;
  maxRetries: number;
  timeoutMs: number;
  channelUids: string[];
  pushUrl: string | null;
  publicId: string | null;
  state: { status: number };
  recentBeats: Array<{ t: number; status: number; latencyMs: number | null }>;
}

// ---------------------------------------------------------------- hosted fixture

let t: CloudTestApp;
let admin: string;
let a: { cookie: string; id: number };
let b: { cookie: string; id: number };
let siteA: string;
let results: FakeResults;
let engine: Engine | null = null;

async function createSite(cookie: string, name: string, domain: string): Promise<string> {
  const res = await api(t.app, cookie, 'POST', '/api/sites', { name, domains: [domain] });
  if (res.statusCode !== 201) throw new Error(`create site: ${res.statusCode} ${res.body}`);
  return (res.json() as { site: { id: string } }).site.id;
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

const idOf = (uid: string): number => (t.ctx.db.prepare('SELECT id FROM monitors WHERE uid = ?').get(uid) as { id: number }).id;

function addChannel(ownerId: number | null, isDefault = false): { id: number; uid: string } {
  const uid = `ch${Math.random().toString(36).slice(2, 12)}`.slice(0, 12).padEnd(12, '0');
  const res = t.ctx.db
    .prepare(
      `INSERT INTO notify_channels (uid, owner_id, type, name, config, is_default, active, created_at, updated_at)
       VALUES (?, ?, 'webhook', 'Hook', '{}', ?, 1, ?, ?)`,
    )
    .run(uid, ownerId, isDefault ? 1 : 0, t.ctx.now(), t.ctx.now());
  return { id: Number(res.lastInsertRowid), uid };
}

function startEngine(opts: Parameters<typeof createEngine>[1] = {}): Engine {
  const clock = new FakeClock(t.clock, 0, 12_345 - t.clock.t);
  engine = createEngine(t.ctx, { clock, netFactory: () => nullNet, selfAddresses: [], startupSpreadMs: 1000, ...opts });
  return engine;
}

async function hosted(): Promise<void> {
  t = await createCloudApp({ env: { MEMBER_SITE_LIMIT: '3', MEMBER_MONITORS_PER_SITE: '10' } });
  t.ctx.secretBox = () => fakeSecretBox as SecretBox;
  results = new FakeResults();
  setCheckers(t.ctx, fakeCheckers(results));
  setSelfAddresses(t.ctx, []);
  admin = await login(t.app);
  a = await signupMember(t, 'alice@example.com');
  b = await signupMember(t, 'bob@example.com');
  siteA = await createSite(a.cookie, 'Alice', 'alice.example');
}

async function cleanup(): Promise<void> {
  await engine?.stop();
  engine = null;
  await t.app.close();
}

// ---------------------------------------------------------------- HIGH 1

describe('HIGH 1: ids are never reused', () => {
  beforeEach(hosted);
  afterEach(cleanup);

  it('monitors, tags, maintenances and users are AUTOINCREMENT tables', async () => {
    for (const table of ['monitors', 'tags', 'maintenances', 'users']) {
      const row = t.ctx.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string };
      expect(row.sql, table).toMatch(/INTEGER PRIMARY KEY AUTOINCREMENT/);
    }
    const m1 = await createMonitor(a.cookie, siteA);
    const id1 = idOf(m1.uid);
    // the highest id is deleted and purged: the next monitor still gets a fresh id
    expect((await api(t.app, a.cookie, 'DELETE', `/api/monitors/${m1.uid}`)).statusCode).toBe(204);
    const { purgeDeletedMonitors } = await import('../src/uptime/data/purge.js');
    await purgeDeletedMonitors(t.ctx);
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM monitors').get()).toEqual({ n: 0 });
    const m2 = await createMonitor(a.cookie, siteA);
    expect(idOf(m2.uid)).toBeGreaterThan(id1);
  });

  it("deleting a user removes its channels' queued notifications, delivery log and links; a new user gets a new id", async () => {
    const m = await createMonitor(a.cookie, siteA);
    const ch = addChannel(a.id);
    const other = addChannel(b.id);
    const db = t.ctx.db;
    db.prepare('INSERT INTO monitor_channels (monitor_id, channel_id) VALUES (?, ?)').run(idOf(m.uid), ch.id);
    for (const c of [ch.id, other.id]) {
      db.prepare(`INSERT INTO notify_outbox (channel_id, monitor_id, event, payload, attempts, next_attempt_at, created_at) VALUES (?, NULL, 'down', '{"secret":"VICTIM"}', 1, 0, 0)`).run(c);
      db.prepare(`INSERT INTO notify_log (channel_id, monitor_id, ts, event, ok, http_status, error) VALUES (?, NULL, 1, 'down', 0, 500, 'VICTIM')`).run(c);
    }
    const res = await api(t.app, admin, 'DELETE', `/api/users/${a.id}`);
    expect(res.statusCode).toBe(204);
    const count = (sql: string, ...p: unknown[]): number => (db.prepare(sql).get(...p) as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM notify_outbox WHERE channel_id = ?', ch.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM notify_log WHERE channel_id = ?', ch.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM monitor_channels WHERE channel_id = ?', ch.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM notify_channels WHERE id = ?', ch.id)).toBe(0);
    // other tenants are untouched
    expect(count('SELECT COUNT(*) AS n FROM notify_outbox WHERE channel_id = ?', other.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM notify_log WHERE channel_id = ?', other.id)).toBe(1);
    // the deleted account's monitors are gone for everyone at once
    expect((await api(t.app, admin, 'GET', `/api/monitors/${m.uid}`)).statusCode).toBe(404);
    // the highest user id was deleted: a new account still gets a new one
    const maxBefore = (db.prepare('SELECT MAX(id) AS n FROM users').get() as { n: number }).n;
    expect(maxBefore).toBe(b.id);
    const c = await signupMember(t, 'carol@example.com');
    expect(c.id).toBeGreaterThan(Math.max(a.id, b.id));
    // and the new account's first channel never sees the old rows
    const fresh = addChannel(c.id);
    expect(fresh.id).toBeGreaterThan(other.id);
    expect(count('SELECT COUNT(*) AS n FROM notify_log WHERE channel_id = ?', fresh.id)).toBe(0);
  });

  it('the batch writer drops late writes for a monitor whose uid does not match (no write to a reused id)', async () => {
    const m = await createMonitor(a.cookie, siteA);
    const repo = new MonitorRepo(t.ctx.db);
    const rec = repo.byUid(m.uid)!;
    const p = processorFor(t.ctx);
    p.record({ ...rec, uid: 'zzzzzzzzzzzz' }, { kind: 'check', ok: false, msg: 'late write of a purged monitor' }, false);
    p.flush();
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM heartbeats WHERE monitor_id = ?').get(rec.id)).toEqual({ n: 0 });
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM monitor_stats_hour WHERE monitor_id = ?').get(rec.id)).toEqual({ n: 0 });
    p.forget(rec.id);
    p.record(rec, { kind: 'check', ok: true, msg: 'OK' }, false);
    p.flush();
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM heartbeats WHERE monitor_id = ?').get(rec.id)).toEqual({ n: 1 });
  });
});

describe('migration v7 (users AUTOINCREMENT)', () => {
  it('rebuilds users keeping every row, column and foreign key; ids are not reused afterwards', () => {
    const file = path.join(tmpDir(), 'v6.db');
    const raw = new Database(file);
    raw.pragma('foreign_keys = ON');
    migrate(raw, { warn: () => {} }, MIGRATIONS.slice(0, 6));
    raw.exec(`
      INSERT INTO users (id, email, password_hash, role, created_at, email_verified_at, stripe_customer_id, subscription_status, paid_sites)
        VALUES (1, 'admin@example.com', 'h1', 'admin', 1, 1, NULL, 'none', 0),
               (2, 'm2@example.com', 'h2', 'member', 2, 2, 'cus_2', 'active', 3),
               (3, 'm3@example.com', 'h3', 'member', 3, NULL, NULL, 'none', 0);
      INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES ('s2', 2, 1, 9999999999999);
      INSERT INTO sites (id, name, domains, created_at, owner_id) VALUES ('aaaaaaaaaaaa', 'A', '[]', 1, 2);
      INSERT INTO tags (uid, owner_id, name, color) VALUES ('tagaaaaaaaaa', 2, 'prod', '#112233');
    `);
    const columnsBefore = raw.pragma('table_info(users)');
    raw.close();
    const db = openDatabase(file, { warn: () => {} });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      expect(db.pragma('table_info(users)')).toEqual(columnsBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare('SELECT id, email, role, stripe_customer_id, subscription_status, paid_sites FROM users ORDER BY id').all()).toEqual([
        { id: 1, email: 'admin@example.com', role: 'admin', stripe_customer_id: null, subscription_status: 'none', paid_sites: 0 },
        { id: 2, email: 'm2@example.com', role: 'member', stripe_customer_id: 'cus_2', subscription_status: 'active', paid_sites: 3 },
        { id: 3, email: 'm3@example.com', role: 'member', stripe_customer_id: null, subscription_status: 'none', paid_sites: 0 },
      ]);
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()).toEqual([
        { name: 'users_stripe_subscription' },
        { name: 'users_unverified' },
      ]);
      // unique e-mail (case-insensitive) and the foreign keys into users still work
      expect(() => db.prepare(`INSERT INTO users (email, password_hash, role, created_at) VALUES ('M2@example.com', 'x', 'member', 1)`).run()).toThrow(/UNIQUE/);
      db.prepare('DELETE FROM users WHERE id = 3').run();
      const id = Number(db.prepare(`INSERT INTO users (email, password_hash, role, created_at) VALUES ('new@example.com', 'x', 'member', 9)`).run().lastInsertRowid);
      expect(id).toBe(4);
      // cascades still reach the rebuilt table
      db.prepare('DELETE FROM users WHERE id = 2').run();
      expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM tags').get()).toEqual({ n: 0 });
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------- HIGH 2

const def = (d: Partial<MaintenanceDef>): MaintenanceDef => ({
  strategy: 'manual',
  active: true,
  tz: 'UTC',
  startsAt: null,
  endsAt: null,
  timeStart: null,
  timeEnd: null,
  weekdays: [],
  daysOfMonth: [],
  intervalDays: null,
  cron: null,
  durationS: null,
  ...d,
});

/** The previous (exhaustive) evaluation: every hour×minute of every day, through zonedTime. */
function referenceStarts(d: MaintenanceDef, day: { y: number; m: number; d: number }): number[] {
  const spec = parseCron(d.cron as string);
  if (!cronDayMatches(spec, day.y, day.m, day.d)) return [];
  const out: number[] = [];
  for (const h of spec.hours) for (const mi of spec.minutes) out.push(zonedTime(day.y, day.m, day.d, h, mi, d.tz));
  return out.sort((x, y) => x - y);
}

function referenceCurrent(d: MaintenanceDef, now: number): { start: number; end: number } | null {
  const dur = (d.durationS as number) * 1000;
  const today = localDateOf(now, d.tz);
  for (let back = 0; back <= Math.ceil(dur / DAY) + 1; back++) {
    const starts = referenceStarts(d, addDays(today, -back)).filter((x) => x <= now);
    const latest = starts[starts.length - 1];
    if (latest === undefined) continue;
    const ok = now < latest + dur && (d.startsAt === null || latest >= d.startsAt) && (d.endsAt === null || latest < d.endsAt);
    return ok ? { start: latest, end: latest + dur } : null;
  }
  return null;
}

function referenceNext(d: MaintenanceDef, now: number): { start: number; end: number } | null {
  const dur = (d.durationS as number) * 1000;
  let day = localDateOf(Math.max(now, d.startsAt ?? now), d.tz);
  for (let i = 0; i < 1500; i++, day = addDays(day, 1)) {
    for (const s of referenceStarts(d, day)) {
      if (s <= now) continue;
      if (d.endsAt !== null && s >= d.endsAt) return null;
      if (d.startsAt !== null && s < d.startsAt) continue;
      return { start: s, end: s + dur };
    }
  }
  return null;
}

describe('HIGH 2: cron maintenance windows are cheap to evaluate', () => {
  it('matches the exhaustive evaluation around DST transitions and validity bounds', () => {
    const crons = ['* * * * *', '*/7 1-3 * * *', '30 2 * * *', '0,15,30,45 0-4 * * 0', '59 23 L * *', '0 1 29 2 *', '5 */2 * * 1-5'];
    const zones = ['America/New_York', 'Europe/Brussels', 'Australia/Lord_Howe', 'UTC'];
    // instants around the 2026 transitions (US: Mar 8 / Nov 1, EU: Mar 29 / Oct 25, Lord Howe: Apr 5 / Oct 4)
    const centers = [Date.UTC(2026, 2, 8, 7), Date.UTC(2026, 10, 1, 6), Date.UTC(2026, 2, 29, 1), Date.UTC(2026, 9, 25, 1), Date.UTC(2026, 3, 4, 15), Date.UTC(2026, 9, 3, 15)];
    let rnd = 42;
    const random = (): number => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let compared = 0;
    for (const cron of crons) {
      for (const tz of zones) {
        for (const durationS of [60, 1800, 90 * 60]) {
          for (let i = 0; i < 3; i++) {
            const center = centers[Math.floor(random() * centers.length)] as number;
            const now = center + Math.floor((random() - 0.5) * 6 * HOUR);
            const bounds = random() < 0.3 ? { startsAt: now - Math.floor(random() * 3 * HOUR), endsAt: now + Math.floor(random() * 3 * HOUR) } : {};
            const m = def({ strategy: 'cron', cron, tz, durationS, ...bounds });
            expect(currentWindow(m, now), `${cron} ${tz} ${durationS} ${now}`).toEqual(referenceCurrent(m, now));
            const cur = currentWindow(m, now);
            expect(nextWindow(m, now), `${cron} ${tz} ${durationS} ${now}`).toEqual(cur ?? referenceNext(m, now));
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(crons.length * zones.length * 3 * 3);
  });

  it('memoises maintenanceInfo per definition until its answer can change', () => {
    const m = { ...def({ strategy: 'single', startsAt: Date.UTC(2026, 5, 15, 12, 0, 30), endsAt: Date.UTC(2026, 5, 15, 13) }), id: 1, updatedAt: 1 };
    const before = Date.UTC(2026, 5, 15, 12, 0, 10);
    expect(maintenanceInfo(m, before).status).toBe('scheduled');
    // the window starts mid-minute: the memo must not hide it
    expect(maintenanceInfo(m, Date.UTC(2026, 5, 15, 12, 0, 31)).status).toBe('under-maintenance');
    // a changed definition (same id / updatedAt) is never served from the memo
    expect(maintenanceInfo({ ...m, active: false }, Date.UTC(2026, 5, 15, 12, 0, 32)).status).toBe('inactive');
  });

  describe('API and engine', () => {
    beforeEach(hosted);
    afterEach(cleanup);

    function hostile(n: number, startsAt: number | null): void {
      const repo = new MaintenanceRepo(t.ctx.db);
      const mon = new MonitorRepo(t.ctx.db);
      const ids = mon.list([siteA]).map((x) => x.id);
      // rows as an attacker could have stored them before the cardinality cap existed
      for (let i = 0; i < n; i++) {
        const created = repo.create(
          a.id,
          {
            title: `hostile ${i}`,
            description: null,
            active: true,
            strategy: 'cron',
            tz: 'America/New_York',
            startsAt,
            endsAt: null,
            timeStart: null,
            timeEnd: null,
            weekdays: [],
            daysOfMonth: [],
            intervalDays: null,
            cron: '* * * * *',
            durationS: 60,
          },
          t.ctx.now(),
        );
        repo.setMonitors(created.id, ids);
      }
    }

    /** Median of `n` runs, each in a new minute (memoised answers never help); robust to GC / CI noise. */
    async function median(n: number, fn: () => Promise<void> | void): Promise<number> {
      const times: number[] = [];
      for (let i = 0; i < n; i++) {
        t.clock.t += 61 * SEC;
        const start = performance.now();
        await fn();
        times.push(performance.now() - start);
      }
      return times.sort((x, y) => x - y)[Math.floor(n / 2)] as number;
    }

    it('100 hostile cron windows: GET /api/maintenances < 50 ms, engine tick < 20 ms', async () => {
      await createMonitor(a.cookie, siteA);
      const e = startEngine();
      for (const startsAt of [Date.UTC(2099, 11, 31, 23, 59), Date.UTC(2020, 0, 1)]) {
        t.ctx.db.prepare('DELETE FROM maintenances').run();
        hostile(100, startsAt);
        e.maintenanceChanged();
        // before the fix: 210–300 ms for ONE such window, 12 s for 57 (audit HIGH 2)
        const list = async (): Promise<void> => {
          const res = await api(t.app, a.cookie, 'GET', '/api/maintenances');
          expect(res.statusCode).toBe(200);
          const items = (res.json() as { maintenances: Array<{ status: string; nextWindow: unknown }> }).maintenances;
          expect(items).toHaveLength(100);
          // far future: scheduled with a next window; past start: every window is open right now
          expect(items.every((x) => x.status === (startsAt > t.ctx.now() ? 'scheduled' : 'under-maintenance'))).toBe(true);
          expect(items.every((x) => x.nextWindow !== null)).toBe(true);
        };
        await list(); // warm-up (JIT, time-zone data)
        expect(await median(5, list)).toBeLessThan(50); // measured ≈ 4–5 ms
        expect(await median(5, () => e.maintenanceTick())).toBeLessThan(20); // measured ≈ 0.2–4 ms
      }
    });

    it('caps cron cardinality and cron windows per member; rate-limits the endpoints', async () => {
      const post = (body: Record<string, unknown>) => api(t.app, a.cookie, 'POST', '/api/maintenances', { title: 'w', strategy: 'cron', durationS: 600, ...body });
      for (const cron of ['* * * * *', '*/5 * * * *', '0-59 0,1 * * *', '0,20,40 * * * 1']) {
        const res = await post({ cron });
        expect(res.statusCode, cron).toBe(400);
        expect(res.json()).toMatchObject({ field: 'cron' });
      }
      expect((await post({ cron: '*/15 9-17 * * 1-5' })).statusCode).toBe(201); // 36 per day
      expect((await post({ cron: '0-59 0 * * *' })).statusCode).toBe(201); // exactly 60
      expect((await post({ cron: '0 * * * *' })).statusCode).toBe(201); // 24 per day
      for (let i = 3; i < 20; i++) expect((await post({ cron: `${i} 3 * * *` })).statusCode).toBe(201);
      expect((await post({ cron: '0 4 * * *' })).statusCode).toBe(409); // 20 cron windows per member
      // other strategies are not affected by the cron cap
      expect((await api(t.app, a.cookie, 'POST', '/api/maintenances', { title: 'm', strategy: 'manual' })).statusCode).toBe(201);
      // per-user request budget
      let limited = 0;
      for (let i = 0; i < 130; i++) if ((await api(t.app, b.cookie, 'GET', '/api/maintenances')).statusCode === 429) limited++;
      expect(limited).toBeGreaterThan(0);
      expect((await api(t.app, a.cookie, 'GET', '/api/maintenances')).statusCode).toBe(200); // other users unaffected
    });
  });
});

// ---------------------------------------------------------------- MEDIUM 3

describe('MEDIUM 3: the live stream follows the current role and ownership', () => {
  beforeEach(hosted);
  afterEach(cleanup);

  it('a demoted admin stops receiving other tenants’ events at once and the stream closes', async () => {
    const mA = await createMonitor(a.cookie, siteA);
    t.ctx.users.create('admin2@example.com', await hashPassword('second admin password'), 'admin', t.clock.t);
    const x = await login(t.app, 'admin2@example.com', 'second admin password');
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;
    const chunks: string[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/uptime/stream', headers: { cookie: x } });
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve);
      req.on('error', reject);
    });
    expect(res.statusCode).toBe(200);
    res.setEncoding('utf8');
    res.on('data', (c: string) => chunks.push(c));
    let ended = false;
    res.on('end', () => (ended = true));
    res.on('close', () => (ended = true));
    const repo = new MonitorRepo(t.ctx.db);
    const p = processorFor(t.ctx);
    p.record(repo.byUid(mA.uid)!, { kind: 'check', ok: true, msg: 'before demotion' }, false);
    for (let i = 0; i < 50 && !chunks.join('').includes('before demotion'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(chunks.join('')).toContain(mA.uid);
    const xid = (t.ctx.users.byEmail('admin2@example.com') as { id: number }).id;
    expect((await api(t.app, admin, 'PATCH', `/api/users/${xid}`, { role: 'member' })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 1100)); // the per-stream account cache lives ≤ 1 s
    p.record(repo.byUid(mA.uid)!, { kind: 'check', ok: false, msg: 'A-PRIVATE-MSG' }, false);
    for (let i = 0; i < 100 && !ended; i++) await new Promise((r) => setTimeout(r, 10));
    expect(chunks.join('')).not.toContain('A-PRIVATE-MSG');
    expect(ended).toBe(true);
    req.destroy();
  });

  it('events of a site that changed hands are filtered with the current owner', async () => {
    const mA = await createMonitor(a.cookie, siteA);
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;
    const chunks: string[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/uptime/stream', headers: { cookie: a.cookie } });
    const res = await new Promise<http.IncomingMessage>((resolve) => req.on('response', resolve));
    res.setEncoding('utf8');
    res.on('data', (c: string) => chunks.push(c));
    // the site moves to another owner (e.g. an operator transfer): Alice must not see it any more
    t.ctx.db.prepare('UPDATE sites SET owner_id = ? WHERE id = ?').run(b.id, siteA);
    await new Promise((r) => setTimeout(r, 1100));
    const repo = new MonitorRepo(t.ctx.db);
    processorFor(t.ctx).record({ ...repo.byUid(mA.uid)!, ownerId: a.id }, { kind: 'check', ok: false, msg: 'NOW-BOBS' }, false);
    await new Promise((r) => setTimeout(r, 100));
    expect(chunks.join('')).not.toContain('NOW-BOBS');
    req.destroy();
  });
});

// ---------------------------------------------------------------- LOW 5 / LOW 6

describe('LOW 5/6: limits follow the site owner; clone is validated; default channels are capped', () => {
  beforeEach(hosted);
  afterEach(cleanup);

  it('an admin acting on a member site gets the member limits and type rules', async () => {
    const res = await api(t.app, admin, 'POST', `/api/sites/${siteA}/monitors`, { type: 'fakehttp', name: 'x', intervalS: 20, config: { url: 'https://example.com/' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ field: 'intervalS' });
    const docker = await api(t.app, admin, 'POST', `/api/sites/${siteA}/monitors`, { type: 'fakedocker', name: 'x', config: { url: 'https://example.com/' } });
    expect(docker.statusCode).toBe(400);
    const m = await createMonitor(admin, siteA, { maxRetries: 5 });
    expect((await api(t.app, admin, 'PATCH', `/api/monitors/${m.uid}`, { maxRetries: 10 })).statusCode).toBe(400);
    // operator sites keep the operator limits
    const siteOp = await createSite(admin, 'Operator', 'operator.example');
    expect((await createMonitor(admin, siteOp, { intervalS: 20, maxRetries: 10 })).intervalS).toBe(20);
  });

  it('clone clamps stored values to the owner limits and re-checks the type', async () => {
    const m = await createMonitor(a.cookie, siteA);
    // stored above the member limits (e.g. before the fix, or by an admin with the old rules)
    new MonitorRepo(t.ctx.db).update(idOf(m.uid), { intervalS: 20, retryIntervalS: 20, maxRetries: 10, timeoutMs: 60_000 }, t.ctx.now());
    for (const cookie of [a.cookie, admin]) {
      const res = await api(t.app, cookie, 'POST', `/api/monitors/${m.uid}/clone`);
      expect(res.statusCode).toBe(201);
      const c = (res.json() as { monitor: MonitorJson }).monitor;
      expect(c).toMatchObject({ intervalS: 60, retryIntervalS: 60, maxRetries: 5 });
      expect(c.timeoutMs).toBeLessThanOrEqual(30_000);
    }
    // a type the owner may not use cannot be cloned
    new MonitorRepo(t.ctx.db).update(idOf(m.uid), { type: 'fakedocker' }, t.ctx.now());
    const res = await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/clone`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ field: 'type' });
  });

  it('clone keeps secrets (re-encrypted), tags and channels', async () => {
    const ch = addChannel(a.id);
    const tag = (await api(t.app, a.cookie, 'POST', '/api/tags', { name: 'prod', color: '#112233' })).json() as { tag: { uid: string } };
    const m = await createMonitor(a.cookie, siteA, { config: { url: 'https://example.com/', password: 'hunter22' }, channelUids: [ch.uid], tags: [{ uid: tag.tag.uid, value: 'eu' }] });
    const res = await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/clone`);
    expect(res.statusCode).toBe(201);
    const c = (res.json() as { monitor: MonitorJson & { secretsSet: string[]; tags: Array<{ uid: string; value: string }> } }).monitor;
    expect(c.secretsSet).toEqual(['password']);
    expect(c.channelUids).toEqual([ch.uid]);
    expect(c.tags).toMatchObject([{ uid: tag.tag.uid, value: 'eu' }]);
    const rec = new MonitorRepo(t.ctx.db).byUid(c.uid)!;
    expect(fakeSecretBox.open(rec.secrets!, `monitor:${c.uid}`)).toEqual({ password: 'hunter22' });
  });

  it('default channels are capped at the per-monitor maximum (create and clone)', async () => {
    for (let i = 0; i < 7; i++) addChannel(a.id, true);
    const m = await createMonitor(a.cookie, siteA);
    expect(m.channelUids).toHaveLength(5);
    const c = (await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/clone`)).json() as { monitor: MonitorJson };
    expect(c.monitor.channelUids).toHaveLength(5);
  });
});

// ---------------------------------------------------------------- LOW 7

describe('LOW 7: push rate, coalescing, HEAD and the X-Push-Token header', () => {
  beforeEach(hosted);
  afterEach(cleanup);

  it('token bucket 1/s with bursts of 10; at most one stored beat per second; HEAD records nothing', async () => {
    const m = await createMonitor(a.cookie, siteA, { type: 'push', config: {} });
    const url = new URL(m.pushUrl!).pathname;
    const id = idOf(m.uid);
    const beats = (): Array<{ status: number; msg: string }> => {
      processorFor(t.ctx).flush();
      return t.ctx.db.prepare('SELECT status, msg FROM heartbeats WHERE monitor_id = ? ORDER BY ts').all(id) as never;
    };
    expect((await t.app.inject({ method: 'HEAD', url })).statusCode).toBe(200);
    expect(beats()).toEqual([]);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await t.app.inject({ method: 'GET', url: `${url}?status=${i % 2 ? 'down' : 'up'}&msg=n${i}` })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    // 10 accepted pushes within the same second: one beat now, the latest one a second later
    expect(beats()).toEqual([{ status: 1, msg: 'n0' }]);
    await new Promise((r) => setTimeout(r, 1100));
    expect(beats()).toEqual([
      { status: 1, msg: 'n0' },
      { status: 0, msg: 'n9' },
    ]);
    // refill: one push per second
    t.clock.t += 2 * SEC;
    expect((await t.app.inject({ method: 'GET', url: `${url}?msg=later` })).statusCode).toBe(200);
    expect(beats().map((x) => x.msg)).toEqual(['n0', 'n9', 'later']);
  });

  it('accepts the token in an X-Push-Token header (GET and POST without the CSRF header)', async () => {
    const m = await createMonitor(a.cookie, siteA, { type: 'push', config: {} });
    const token = m.pushUrl!.split('/').pop()!;
    let res = await t.app.inject({ method: 'GET', url: '/api/push?msg=via-header', headers: { 'x-push-token': token } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    t.clock.t += 2 * SEC;
    res = await t.app.inject({ method: 'POST', url: '/api/push?status=down', headers: { 'x-push-token': token }, payload: 'x' });
    expect(res.statusCode).toBe(200);
    processorFor(t.ctx).flush();
    expect((t.ctx.db.prepare('SELECT msg FROM heartbeats WHERE monitor_id = ? ORDER BY ts').all(idOf(m.uid)) as Array<{ msg: string }>).map((x) => x.msg)).toEqual([
      'via-header',
      'Down',
    ]);
    expect((await t.app.inject({ method: 'GET', url: '/api/push', headers: { 'x-push-token': 'A'.repeat(32) } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/push' })).statusCode).toBe(404);
    const pre = await t.app.inject({ method: 'OPTIONS', url: '/api/push' });
    expect(pre.statusCode).toBe(204);
    expect(String(pre.headers['access-control-allow-headers'])).toMatch(/X-Push-Token/i);
  });
});

// ---------------------------------------------------------------- LOW 8

describe('LOW 8: suspension, site and account deletion take effect at once', () => {
  beforeEach(hosted);
  afterEach(cleanup);

  it('the engine stops checking at once after a suspension, a site deletion and an account deletion', async () => {
    const e = startEngine();
    await createMonitor(a.cookie, siteA);
    const siteB = await createSite(b.cookie, 'Bob', 'bob.example');
    await createMonitor(b.cookie, siteB);
    const siteA2 = await createSite(a.cookie, 'Alice 2', 'alice2.example');
    await createMonitor(a.cookie, siteA2);
    expect(e.stats().monitors).toBe(3);
    // billing allowance recomputed: the newest site of Alice is suspended
    expect(t.ctx.sites.applyAllowance(a.id, 1)).toBe(true);
    await settle();
    expect(e.stats().monitors).toBe(2);
    expect(t.ctx.sites.applyAllowance(a.id, 1)).toBe(false); // nothing changed, no event
    // site deletion
    expect((await api(t.app, b.cookie, 'DELETE', `/api/sites/${siteB}`)).statusCode).toBe(204);
    await settle();
    expect(e.stats().monitors).toBe(1);
    // account deletion
    expect((await api(t.app, admin, 'DELETE', `/api/users/${a.id}`)).statusCode).toBe(204);
    await settle();
    expect(e.stats().monitors).toBe(0);
  });

  it('public status / badge caches are dropped on badge disable, monitor rename / delete and site deletion', async () => {
    const m = await createMonitor(a.cookie, siteA);
    const caches = publicState(t.ctx);
    const fill = (): void => caches.badges.set('k', { value: '<svg/>', fingerprint: 'f', checkedAt: t.ctx.now() });
    const cached = (): boolean => caches.badges.get('k') !== undefined;
    fill();
    await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/badges`, { enabled: true });
    expect(cached()).toBe(true);
    await api(t.app, a.cookie, 'POST', `/api/monitors/${m.uid}/badges`, { enabled: false });
    expect(cached()).toBe(false);
    fill();
    await api(t.app, a.cookie, 'PATCH', `/api/monitors/${m.uid}`, { name: 'Renamed' });
    expect(cached()).toBe(false);
    fill();
    await api(t.app, a.cookie, 'DELETE', `/api/monitors/${m.uid}`);
    expect(cached()).toBe(false);
    fill();
    await api(t.app, a.cookie, 'DELETE', `/api/sites/${siteA}`);
    await tick();
    expect(cached()).toBe(false);
  });
});

// ---------------------------------------------------------------- SSRF M1

describe('SSRF M1: the server’s own addresses', () => {
  it('hosted: interfaces + PUBLIC_URL addresses, awaited before checks run and passed to every SafeNet', async () => {
    t = await createCloudApp({ env: { PUBLIC_URL: 'https://203.0.113.77' } });
    try {
      t.ctx.secretBox = () => fakeSecretBox as SecretBox;
      results = new FakeResults();
      setCheckers(t.ctx, fakeCheckers(results));
      await selfAddressesReady(t.ctx);
      const self = getSelfAddresses(t.ctx);
      expect(self).toContain('203.0.113.77');
      expect(self).toContain('127.0.0.1');
      expect(Object.isFrozen(self)).toBe(true);
      expect(getSelfAddresses(t.ctx)).toBe(self); // cached
      const seen: TargetPolicyOptions[] = [];
      const clock = new FakeClock(t.clock, 0, 12_345 - t.clock.t);
      admin = await login(t.app);
      const member = t.ctx.users.create('alice@example.com', await hashPassword('member password 123'), 'member', t.clock.t)!;
      a = { id: member.id, cookie: await login(t.app, 'alice@example.com', 'member password 123') };
      siteA = await createSite(a.cookie, 'Alice', 'alice.example');
      const site = siteA;
      engine = createEngine(t.ctx, {
        clock,
        startupSpreadMs: 1000,
        netFactory: (o) => {
          seen.push(o);
          return nullNet;
        },
      });
      await engine.ready();
      await createMonitor(a.cookie, site);
      await clock.advance(1);
      await settle();
      expect(results.calls).toHaveLength(1);
      expect(seen.length).toBeGreaterThan(0);
      for (const o of seen) expect(o.selfAddresses).toContain('203.0.113.77');
      expect(seen.some((o) => o.hostedMember === true)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('self-hosted: no self addresses (documented); computeSelfAddresses resolves the PUBLIC_URL host', async () => {
    const st: TestApp = await createTestApp({ env: { PUBLIC_URL: 'https://203.0.113.78' } });
    try {
      await selfAddressesReady(st.ctx);
      expect(getSelfAddresses(st.ctx)).toEqual([]);
    } finally {
      await st.app.close();
    }
    const list = await computeSelfAddresses('https://status.example.org./', {
      resolve4: async (h: string) => (h === 'status.example.org' ? ['198.51.100.4'] : []),
      resolve6: async () => {
        throw Object.assign(new Error('no AAAA'), { code: 'ENODATA' });
      },
    } as never);
    expect(list).toContain('198.51.100.4');
  });
});

// ---------------------------------------------------------------- SSRF M3 / L3 (engine side)

describe('SSRF M3/L3: destination keys', () => {
  it('normalises spellings of one destination', () => {
    expect(destinationOf('https://Victim.Example./x')).toBe('victim.example');
    expect(destinationOf('victim.example.:443')).toBe('victim.example');
    expect(destinationOf('http://[::ffff:5db8:d70e]/')).toBe('93.184.215.14');
    expect(destinationOf('[::ffff:93.184.215.14]:80')).toBe('93.184.215.14');
    expect(destinationOf('2001:DB8::1')).toBe('2001:db8::1');
    expect(destinationOf('[2001:db8:0::1]:53')).toBe('2001:db8::1');
    expect(destinationOf('93.184.215.14:8080')).toBe('93.184.215.14');
  });

  describe('engine', () => {
    beforeEach(hosted);
    afterEach(cleanup);

    it('keys member checks by the resolved address (aliases share the per-destination budget)', async () => {
      const resolved: string[] = [];
      const net = {
        ...nullNet,
        resolve: async (host: string) => {
          resolved.push(host);
          return { host, addresses: [{ address: '93.184.215.14', family: 4 as const }] };
        },
      };
      const e = startEngine({ netFactory: () => net, destMaxPerMin: 2 });
      const siteB = await createSite(b.cookie, 'Bob', 'bob.example');
      await createMonitor(a.cookie, siteA, { config: { url: 'https://alias-one.example/' } });
      await createMonitor(b.cookie, siteB, { config: { url: 'https://alias-two.example/' } });
      await createMonitor(b.cookie, siteB, { config: { url: 'https://alias-three.example/' } });
      const clock = (e as unknown as { clock: FakeClock }).clock;
      await clock.advance(1);
      await settle();
      expect(resolved.sort()).toEqual(['alias-one.example', 'alias-three.example', 'alias-two.example']);
      // budget of 2 per minute for the shared address: the third check is deferred, not dropped
      expect(results.calls).toHaveLength(2);
      expect(e.stats().queued).toBe(1);
      await clock.advance(31 * SEC);
      await settle();
      expect(results.calls).toHaveLength(3);
    });
  });
});

// ---------------------------------------------------------------- item 7: e2e scheduling

describe('a monitor created on a running server is checked at once (no restart)', () => {
  for (const mode of ['self-hosted', 'hosted'] as const) {
    it(mode, async () => {
      const env: Record<string, string> = mode === 'hosted' ? { SIGNUP_ENABLED: 'true', PUBLIC_URL: 'https://203.0.113.79', SMTP_URL: 'smtp://127.0.0.1:2525', MAIL_FROM: 'x <no-reply@example.com>' } : {};
      const app: TestApp = await createTestApp({ env, build: { backgroundJobs: true } });
      try {
        app.ctx.secretBox = () => fakeSecretBox as SecretBox;
        const res = new FakeResults();
        setCheckers(app.ctx, fakeCheckers(res));
        expect(uptimeRuntime(app.ctx).engine).not.toBeNull();
        const cookie = await login(app.app);
        const site = (await api(app.app, cookie, 'POST', '/api/sites', { name: 'S', domains: ['s.example'] })).json() as { site: { id: string } };
        const created = await api(app.app, cookie, 'POST', `/api/sites/${site.site.id}/monitors`, {
          type: 'fakehttp',
          name: 'New',
          intervalS: 3600,
          config: { url: 'https://example.com/' },
        });
        expect(created.statusCode).toBe(201);
        const uid = (created.json() as { monitor: { uid: string } }).monitor.uid;
        let status = -1;
        for (let i = 0; i < 100 && status !== 1; i++) {
          await new Promise((r) => setTimeout(r, 50));
          processorFor(app.ctx).flush();
          status = ((await api(app.app, cookie, 'GET', `/api/monitors/${uid}`)).json() as { monitor: MonitorJson }).monitor.state.status;
        }
        expect(res.calls.map((c) => c.uid)).toContain(uid);
        expect(status).toBe(1);
      } finally {
        await app.app.close();
      }
    });
  }
});

// ---------------------------------------------------------------- item 8: recentBeats

describe('recentBeats in monitor lists', () => {
  beforeEach(hosted);
  afterEach(cleanup);

  it('lists and the overview carry the last 50 beats (oldest first) from one query', async () => {
    const m1 = await createMonitor(a.cookie, siteA);
    const m2 = await createMonitor(a.cookie, siteA, { name: 'Quiet' });
    const repo = new MonitorRepo(t.ctx.db);
    const p = processorFor(t.ctx);
    const rec = repo.byUid(m1.uid)!;
    const start = t.clock.t - 60 * MIN;
    for (let i = 0; i < 60; i++) p.record(rec, { kind: 'check', ok: i % 10 !== 0, msg: 'x', latencyMs: i }, false, { ts: start + i * MIN });
    p.flush();
    for (const url of [`/api/sites/${siteA}/monitors`, '/api/uptime/overview']) {
      const list = ((await api(t.app, a.cookie, 'GET', url)).json() as { monitors: MonitorJson[] }).monitors;
      const one = list.find((x) => x.uid === m1.uid)!;
      expect(one.recentBeats).toHaveLength(50);
      expect(one.recentBeats[0]).toMatchObject({ t: start + 10 * MIN, status: 0 });
      expect(one.recentBeats[49]).toEqual({ t: start + 59 * MIN, status: 1, latencyMs: 59 });
      expect(list.find((x) => x.uid === m2.uid)!.recentBeats).toEqual([]);
    }
    // the cut-off lookup and the range read use the primary key (no scan of all heartbeats)
    const plan = t.ctx.db
      .prepare(
        `EXPLAIN QUERY PLAN WITH ids(id) AS (VALUES (?)), cut AS (SELECT id, COALESCE((SELECT ts FROM heartbeats WHERE monitor_id = ids.id ORDER BY ts DESC LIMIT 1 OFFSET 49), 0) AS c FROM ids)
         SELECT h.monitor_id, h.ts FROM cut JOIN heartbeats h ON h.monitor_id = cut.id AND h.ts >= cut.c ORDER BY h.monitor_id, h.ts`,
      )
      .all(idOf(m1.uid)) as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join('\n')).not.toMatch(/SCAN (h|heartbeats)\b(?! USING)/);
    expect(recentBeats(t.ctx.db, [idOf(m1.uid)], 5).get(idOf(m1.uid))).toHaveLength(5);
  });
});

void ADMIN_EMAIL;
