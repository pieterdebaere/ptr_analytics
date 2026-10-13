import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { migrate, openDatabase } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { runCleanup } from '../src/jobs/cleanup.js';
import { verifyPassword } from '../src/lib/password.js';
import { DAY, api, createTestApp, login, pageview, sendEvent, tmpDir } from './helpers.js';

describe('cleanup job', () => {
  it('purges expired auth sessions, old salts and data beyond RETENTION_DAYS', async () => {
    const t = await createTestApp({ env: { RETENTION_DAYS: '30' } });
    try {
      const cookie = await login(t.app);
      const id = t.ctx.sites.create('S', ['example.com'], t.clock.t).id;
      const start = t.clock.t;
      await sendEvent(t.app, pageview(id, 'https://example.com/old'));
      await sendEvent(t.app, { site: id, type: 'vitals', url: 'https://example.com/old', metrics: [{ name: 'LCP', value: 1 }] });
      t.clock.t = start + 20 * DAY;
      await sendEvent(t.app, pageview(id, 'https://example.com/new'));
      t.ctx.db.prepare(`INSERT INTO salts (day, salt) VALUES ('2000-01-01', x'00')`).run();

      t.clock.t = start + 31 * DAY;
      const r = runCleanup(t.ctx);
      expect(r).toMatchObject({ authSessions: 1, events: 1, vitals: 1, sessions: 1 });
      expect(t.ctx.db.prepare('SELECT path FROM events').all()).toEqual([{ path: '/new' }]);
      expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
      expect(t.ctx.db.prepare(`SELECT COUNT(*) AS n FROM salts WHERE day = '2000-01-01'`).get()).toEqual({ n: 0 });
      expect((await api(t.app, cookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
    } finally {
      await t.app.close();
    }
  });

  it('keeps analytics data forever when RETENTION_DAYS=0', async () => {
    const t = await createTestApp();
    try {
      const id = t.ctx.sites.create('S', ['example.com'], t.clock.t).id;
      await sendEvent(t.app, pageview(id, 'https://example.com/'));
      t.clock.t += 5000 * DAY;
      expect(runCleanup(t.ctx)).toMatchObject({ events: 0, sessions: 0 });
      expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    } finally {
      await t.app.close();
    }
  });

  it('deleting a site cascades to all its data', async () => {
    const t = await createTestApp();
    try {
      const cookie = await login(t.app);
      const id = t.ctx.sites.create('S', ['example.com'], t.clock.t).id;
      await sendEvent(t.app, pageview(id, 'https://example.com/'));
      await sendEvent(t.app, { site: id, type: 'vitals', url: 'https://example.com/', metrics: [{ name: 'LCP', value: 1 }] });
      expect((await api(t.app, cookie, 'DELETE', `/api/sites/${id}`)).statusCode).toBe(204);
      for (const table of ['events', 'sessions', 'vitals']) {
        expect(t.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally {
      await t.app.close();
    }
  });
});

describe('migrations', () => {
  it('upgrades an older schema in place', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'old.db');
    const raw = new Database(file);
    raw.exec(MIGRATIONS[0] as string);
    raw.pragma('user_version = 1');
    raw.close();
    const db = openDatabase(file);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_site_started'`).get();
    expect(idx).toEqual({ name: 'sessions_site_started' });
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });

  it('refuses a newer schema', () => {
    const db = new Database(':memory:');
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer/);
    db.close();
  });
});

describe('CLI', () => {
  it('creates users, resets passwords, lists and deletes', async () => {
    const dir = tmpDir();
    const env = { DATA_DIR: dir };
    const out: string[] = [];
    const run = (...args: string[]) => runCli(args, env, (s) => out.push(s));

    await run('create-user', 'Boss@Example.com');
    const pw1 = /Password \(shown only once\): (\S+)/.exec(out.join('\n'))?.[1] as string;
    expect(pw1).toMatch(/^[A-Za-z0-9_-]{20}$/);
    await run('create-user', 'viewer@example.com', 'viewer');
    await expect(run('create-user', 'boss@example.com')).rejects.toThrow(/already exists/);
    await expect(run('create-user', 'x@example.com', 'root')).rejects.toThrow(/Role/);
    await expect(run('create-user', 'not-an-email')).rejects.toThrow(/email/);

    out.length = 0;
    await run('list-users');
    expect(out.join('\n')).toMatch(/admin\s+boss@example.com/);
    expect(out.join('\n')).toMatch(/viewer\s+viewer@example.com/);

    out.length = 0;
    await run('reset-password', 'boss@example.com');
    const pw2 = /: (\S+)$/.exec(out[0] ?? '')?.[1] as string;
    expect(pw2).not.toBe(pw1);
    const db = openDatabase(path.join(dir, 'analytics.db'));
    const hash = (db.prepare(`SELECT password_hash FROM users WHERE email = 'boss@example.com'`).get() as { password_hash: string }).password_hash;
    expect(await verifyPassword(pw2, hash)).toBe(true);
    db.close();

    await expect(run('delete-user', 'boss@example.com')).rejects.toThrow(/last admin/);
    await run('delete-user', 'viewer@example.com');
    await expect(run('frobnicate')).rejects.toThrow(/Unknown command/);
    out.length = 0;
    await run('--help');
    expect(out[0]).toContain('Usage');
    expect(fs.existsSync(path.join(dir, 'analytics.db'))).toBe(true);
  });
});
