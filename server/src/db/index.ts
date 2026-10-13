import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations.js';

export type DB = Database.Database;

const JOURNAL_SIZE_LIMIT = 8 * 1024 * 1024;

/** Open (and create if needed) the SQLite database and run pending migrations. */
export function openDatabase(file: string): DB {
  if (file !== ':memory:') {
    // The database holds password hashes, session hashes and the daily salt: owner-only.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new Database(file);
  if (file !== ':memory:') {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.chmodSync(f, 0o600);
      } catch {
        // -wal/-shm may not exist yet; they inherit the process umask (set to 077 at startup).
      }
    }
  }
  db.pragma('journal_mode = WAL');
  // Zero deleted content instead of leaving it in free space (daily salts must really be
  // gone once deleted), and cap the size the WAL is left at after a checkpoint.
  db.pragma('secure_delete = ON');
  db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema version ${current} is newer than this server supports (${MIGRATIONS.length}). Upgrade PTR Analytics.`,
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    const m = MIGRATIONS[v] as Migration;
    if (typeof m === 'string') {
      db.transaction(() => {
        db.exec(m);
        db.pragma(`user_version = ${v + 1}`);
      })();
      continue;
    }
    // Table rebuild: foreign keys must be off (they cannot be toggled inside a transaction).
    const fkWasOn = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) throw new Error(`migration ${v + 1} would violate foreign keys`);
        db.pragma(`user_version = ${v + 1}`);
      })();
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }
  }
}

/** A small LRU cache of prepared statements for dynamically built (but allow-listed) SQL. */
export class StatementCache {
  private readonly cache = new Map<string, Database.Statement>();
  constructor(
    private readonly db: DB,
    private readonly max = 300,
  ) {}

  get(sql: string): Database.Statement {
    const hit = this.cache.get(sql);
    if (hit) {
      this.cache.delete(sql);
      this.cache.set(sql, hit);
      return hit;
    }
    const stmt = this.db.prepare(sql);
    this.cache.set(sql, stmt);
    if (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return stmt;
  }
}
