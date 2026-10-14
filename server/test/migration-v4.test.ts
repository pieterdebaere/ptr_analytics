import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/index.js';
import { MIGRATIONS, type RebuildMigration } from '../src/db/migrations.js';
import { tmpDir } from './helpers.js';

/** A database created and filled by the v3 server. */
function v3Database(file: string): void {
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  for (const m of MIGRATIONS.slice(0, 3)) raw.exec(m as string);
  raw.pragma('user_version = 3');
  raw.exec(`
    INSERT INTO users (id, email, password_hash, role, created_at) VALUES
      (1, 'admin@example.com', 'scrypt$hash1', 'admin', 1000),
      (2, 'viewer@example.com', 'scrypt$hash2', 'viewer', 2000);
    INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES
      ('h1', 1, 1, 9999999999999), ('h2', 2, 1, 9999999999999);
    INSERT INTO sites (id, name, domains, created_at) VALUES ('aaaaaaaaaaaa', 'A', '["a.com"]', 5);
    INSERT INTO sessions (id, site_id, visitor_id, started_at, last_seen_at, pageviews) VALUES ('s1', 'aaaaaaaaaaaa', 'v', 1, 1, 1);
    INSERT INTO events (site_id, ts, type, visitor_id, session_id, hostname, path) VALUES ('aaaaaaaaaaaa', 1, 'pageview', 'v', 's1', 'a.com', '/');
    INSERT INTO vitals (site_id, ts, metric, value, hostname, path) VALUES ('aaaaaaaaaaaa', 1, 'LCP', 1200, 'a.com', '/');
  `);
  raw.close();
}

describe('migration v4 (hosted mode)', () => {
  it('rebuilds users without losing data or foreign keys', () => {
    const file = path.join(tmpDir(), 'v3.db');
    v3Database(file);
    const db = openDatabase(file);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare('SELECT id, email, password_hash, role, created_at, email_verified_at, subscription_status, paid_sites FROM users ORDER BY id').all()).toEqual([
        { id: 1, email: 'admin@example.com', password_hash: 'scrypt$hash1', role: 'admin', created_at: 1000, email_verified_at: 1000, subscription_status: 'none', paid_sites: 0 },
        { id: 2, email: 'viewer@example.com', password_hash: 'scrypt$hash2', role: 'viewer', created_at: 2000, email_verified_at: 2000, subscription_status: 'none', paid_sites: 0 },
      ]);
      expect(db.prepare('SELECT id, owner_id, suspended FROM sites').all()).toEqual([{ id: 'aaaaaaaaaaaa', owner_id: null, suspended: 0 }]);
      for (const table of ['auth_sessions', 'events', 'sessions', 'vitals']) {
        expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBeGreaterThan(0);
      }
      // the new CHECK accepts members, still rejects unknown roles
      db.prepare(`INSERT INTO users (email, password_hash, role, created_at) VALUES ('m@example.com', 'x', 'member', 1)`).run();
      expect(() => db.prepare(`INSERT INTO users (email, password_hash, role, created_at) VALUES ('o@example.com', 'x', 'owner', 1)`).run()).toThrow(/CHECK/);
      // email stays case-insensitive unique
      expect(() => db.prepare(`INSERT INTO users (email, password_hash, role, created_at) VALUES ('ADMIN@example.com', 'x', 'admin', 1)`).run()).toThrow(/UNIQUE/);
      // foreign keys still point at the rebuilt table and cascade
      const fk = db.pragma('foreign_key_list(auth_sessions)') as Array<{ table: string; on_delete: string }>;
      expect(fk).toEqual([expect.objectContaining({ table: 'users', on_delete: 'CASCADE' })]);
      db.prepare('DELETE FROM users WHERE id = 2').run();
      expect(db.prepare('SELECT token_hash FROM auth_sessions').all()).toEqual([{ token_hash: 'h1' }]);
      // sites.owner_id cascades from users; user_tokens too
      const member = (db.prepare(`SELECT id FROM users WHERE email = 'm@example.com'`).get() as { id: number }).id;
      db.prepare(`UPDATE sites SET owner_id = ? WHERE id = 'aaaaaaaaaaaa'`).run(member);
      db.prepare(`INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES ('t', ?, 'verify', 1, 1)`).run(member);
      expect(() => db.prepare(`INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES ('t2', ?, 'login', 1, 1)`).run(member)).toThrow(/CHECK/);
      db.prepare('DELETE FROM users WHERE id = ?').run(member);
      for (const table of ['sites', 'events', 'sessions', 'vitals', 'user_tokens']) {
        expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
      }
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('upgrades despite pre-existing, unrelated foreign-key orphans and reports them', () => {
    const file = path.join(tmpDir(), 'orphans.db');
    v3Database(file);
    const raw = new Database(file);
    raw.pragma('foreign_keys = OFF');
    // left over from an old crash / manual edit: an event of a deleted site, a session of a deleted user
    raw.exec(`
      INSERT INTO events (site_id, ts, type, visitor_id, session_id, hostname, path) VALUES ('zzzzzzzzzzzz', 2, 'pageview', 'v', 's9', 'z.com', '/');
      INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES ('orphan', 99, 1, 2);
    `);
    raw.close();
    const warnings: string[] = [];
    const db = openDatabase(file, { warn: (m) => warnings.push(m) });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE site_id = 'zzzzzzzzzzzz'`).get()).toEqual({ n: 1 });
      // reported by every users rebuild (v4, v7), never fatal
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      for (const w of warnings) expect(w).toMatch(/pre-existing row\(s\) in auth_sessions/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  it('still refuses a rebuild that would create new orphans', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER REFERENCES p(id)); INSERT INTO p VALUES (1); INSERT INTO c VALUES (1);`);
    const rebuild: RebuildMigration = { foreignKeysOff: true, rebuilds: ['p'], sql: 'CREATE TABLE p2 (id INTEGER PRIMARY KEY); DROP TABLE p; ALTER TABLE p2 RENAME TO p;' };
    expect(() => migrate(db, { warn: () => {} }, [rebuild])).toThrow(/violate foreign keys/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM p').get()).toEqual({ n: 1 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('rolls back and keeps foreign keys on when the migration fails', () => {
    const file = path.join(tmpDir(), 'broken.db');
    v3Database(file);
    const raw = new Database(file);
    // a table name the migration needs is taken: the migration must fail atomically
    raw.exec('CREATE TABLE stripe_events (x INTEGER)');
    raw.close();
    expect(() => openDatabase(file)).toThrow();
    const db = new Database(file);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'users'`).get()).toMatchObject({ sql: expect.stringContaining("'admin', 'viewer')") });
    expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(2);
    db.close();
  });
});
