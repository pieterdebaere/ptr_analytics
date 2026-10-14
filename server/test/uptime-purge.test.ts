import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { runCleanup } from '../src/jobs/cleanup.js';
import { purgeDeletedSites } from '../src/jobs/purge.js';
import { MonitorRepo } from '../src/uptime/data/monitors.js';
import { runUptimeCleanup } from '../src/uptime/data/purge.js';
import { processorFor } from '../src/uptime/engine/processor.js';
import { setCheckers } from '../src/uptime/runtime.js';
import type { SecretBox } from '../src/uptime/secrets.js';
import { DAY, HOUR, MIN, api, createTestApp, login, type TestApp } from './helpers.js';
import { FakeResults, fakeCheckers, fakeSecretBox } from './uptime-core-fakes.js';

let t: TestApp;
let admin: string;
let siteId: string;

beforeEach(async () => {
  t = await createTestApp({ env: { UPTIME_RETENTION_DAYS: '100', UPTIME_RAW_RETENTION_HOURS: '48' } });
  t.ctx.secretBox = () => fakeSecretBox as SecretBox;
  setCheckers(t.ctx, fakeCheckers(new FakeResults()));
  admin = await login(t.app);
  siteId = ((await api(t.app, admin, 'POST', '/api/sites', { name: 'S', domains: ['s.example'] })).json() as { site: { id: string } }).site.id;
});

afterEach(async () => {
  await t.app.close();
});

async function monitorWithHistory(name: string, spanMs: number, stepMs: number): Promise<{ uid: string; id: number }> {
  const res = await api(t.app, admin, 'POST', `/api/sites/${siteId}/monitors`, { type: 'fakehttp', name, intervalS: 3600, config: { url: 'https://s.example/' } });
  const uid = (res.json() as { monitor: { uid: string } }).monitor.uid;
  const m = new MonitorRepo(t.ctx.db).byUid(uid)!;
  const p = processorFor(t.ctx);
  const start = t.clock.t - spanMs;
  let i = 0;
  for (let ts = start; ts < t.clock.t; ts += stepMs, i++) p.record(m, { kind: 'check', ok: i % 7 !== 3, msg: 'x' }, false, { ts });
  p.flush();
  return { uid, id: m.id };
}

const count = (table: string, id: number): number => (t.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE monitor_id = ?`).get(id) as { n: number }).n;
const oldest = (table: string, col: string, id: number): number =>
  (t.ctx.db.prepare(`SELECT MIN(${col}) AS v FROM ${table} WHERE monitor_id = ?`).get(id) as { v: number }).v;

describe('uptime retention', () => {
  it('drops raw beats after 48 h, hourly stats after 90 d, daily stats / events / outages after UPTIME_RETENTION_DAYS', async () => {
    const m = await monitorWithHistory('old', 120 * DAY, 2 * HOUR);
    expect(count('heartbeats', m.id)).toBe(1440);
    const res = await runUptimeCleanup(t.ctx);
    expect(res.heartbeats).toBeGreaterThan(1000);
    expect(oldest('heartbeats', 'ts', m.id)).toBeGreaterThanOrEqual(t.clock.t - 48 * HOUR);
    expect(oldest('monitor_stats_hour', 'bucket', m.id)).toBeGreaterThanOrEqual(t.clock.t - 90 * DAY - HOUR);
    expect(oldest('monitor_stats_day', 'bucket', m.id)).toBeGreaterThanOrEqual(t.clock.t - 100 * DAY - DAY);
    expect(oldest('monitor_events', 'ts', m.id)).toBeGreaterThanOrEqual(t.clock.t - 100 * DAY);
    expect(oldest('outages', 'started_at', m.id)).toBeGreaterThanOrEqual(t.clock.t - 100 * DAY);
    expect(count('monitor_stats_day', m.id)).toBeGreaterThan(90);
  });

  it('runs as part of the hourly cleanup and purges deleted monitors completely', async () => {
    const keep = await monitorWithHistory('keep', 2 * HOUR, MIN);
    const gone = await monitorWithHistory('gone', 2 * HOUR, MIN);
    expect((await api(t.app, admin, 'DELETE', `/api/monitors/${gone.uid}`)).statusCode).toBe(204);
    await runCleanup(t.ctx);
    for (const table of ['heartbeats', 'monitor_stats_hour', 'monitor_stats_day', 'monitor_events', 'outages', 'monitor_state']) {
      expect(count(table, gone.id), table).toBe(0);
      expect(count(table, keep.id), table).toBeGreaterThan(0);
    }
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM monitors WHERE id = ?').get(gone.id)).toEqual({ n: 0 });
    // late results of a purged monitor are dropped (no orphans)
    const p = processorFor(t.ctx);
    const rec = { ...new MonitorRepo(t.ctx.db).byId(keep.id)!, id: gone.id };
    p.record(rec, { kind: 'check', ok: true, msg: 'late' }, false);
    p.flush();
    expect(count('heartbeats', gone.id)).toBe(0);
  });

  it('deleting a site soft-deletes its monitors; the site purge removes them before the site row', async () => {
    const m = await monitorWithHistory('m', HOUR, MIN);
    expect((await api(t.app, admin, 'DELETE', `/api/sites/${siteId}`)).statusCode).toBe(204);
    expect((t.ctx.db.prepare('SELECT deleted_at FROM monitors WHERE id = ?').get(m.id) as { deleted_at: number | null } | undefined)?.deleted_at ?? 1).not.toBeNull();
    await purgeDeletedSites(t.ctx);
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM sites WHERE id = ?').get(siteId)).toEqual({ n: 0 });
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM monitors WHERE id = ?').get(m.id)).toEqual({ n: 0 });
    expect(count('heartbeats', m.id)).toBe(0);
  });

  it('deleting a user with tags and maintenances works (owner cascade)', async () => {
    const { hashPassword } = await import('../src/lib/password.js');
    const u = t.ctx.users.create('m@example.com', await hashPassword('member password 1'), 'member', t.clock.t, true)!;
    t.ctx.db.prepare("INSERT INTO tags (uid, owner_id, name, color) VALUES ('tagaaaaaaaaa', ?, 'x', '#000000')").run(u.id);
    t.ctx.db
      .prepare("INSERT INTO maintenances (uid, owner_id, title, strategy, tz, created_at, updated_at) VALUES ('mntaaaaaaaaa', ?, 'x', 'manual', 'UTC', 0, 0)")
      .run(u.id);
    expect(t.ctx.users.delete(u.id, t.clock.t)).toBe(true);
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM tags').get()).toEqual({ n: 0 });
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM maintenances').get()).toEqual({ n: 0 });
  });
});

describe('cli monitors', () => {
  it('lists, pauses and resumes monitors', async () => {
    const dir = path.join(t.fixtures.root, 'cli-data');
    // the CLI opens its own database file: create one with a site and a monitor through the CLI's DB
    const { openDatabase } = await import('../src/db/index.js');
    const db = openDatabase(path.join(dir, 'analytics.db'));
    db.prepare("INSERT INTO sites (id, name, domains, created_at) VALUES ('siteaaaaaaaa', 'S', '[]', 0)").run();
    db.prepare(
      `INSERT INTO monitors (uid, site_id, type, name, interval_s, retry_interval_s, timeout_ms, config, created_at, updated_at)
       VALUES ('monaaaaaaaaa', 'siteaaaaaaaa', 'http', 'Home\u001b[31m', 60, 60, 10000, '{}', 0, 0)`,
    ).run();
    db.close();
    const out: string[] = [];
    const env = { DATA_DIR: dir };
    await runCli(['monitors', 'list'], env, (s) => out.push(s));
    expect(out.join('\n')).toContain('monaaaaaaaaa');
    expect(out.join('\n')).not.toContain('\u001b');
    await runCli(['monitors', 'pause', 'monaaaaaaaaa'], env, (s) => out.push(s));
    out.length = 0;
    await runCli(['monitors', 'list', 'siteaaaaaaaa'], env, (s) => out.push(s));
    expect(out.join('\n')).toContain('paused');
    await runCli(['monitors', 'resume', 'monaaaaaaaaa'], env, (s) => out.push(s));
    await expect(runCli(['monitors', 'pause', 'nope'], env, () => {})).rejects.toThrow(/No monitor/);
    await expect(runCli(['monitors', 'frobnicate'], env, () => {})).rejects.toThrow(/Usage/);
  });
});
