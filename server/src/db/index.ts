import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations.js';

export type DB = Database.Database;

const JOURNAL_SIZE_LIMIT = 8 * 1024 * 1024;

export interface MigrationLog {
  warn(msg: string): void;
}

const consoleLog: MigrationLog = { warn: (msg) => console.warn(msg) };

/** Open (and create if needed) the SQLite database and run pending migrations. */
export function openDatabase(file: string, log: MigrationLog = consoleLog): DB {
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
  migrate(db, log);
  return db;
}

interface FkViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

/**
 * Foreign-key violations of rows that reference one of `parents` (only the child tables
 * that point at them are scanned, so huge unrelated tables such as events are never read).
 */
function fkViolations(db: DB, parents: readonly string[]): FkViolation[] {
  const wanted = new Set(parents.map((p) => p.toLowerCase()));
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
  const out: FkViolation[] = [];
  for (const table of tables) {
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const fks = db.pragma(`foreign_key_list(${quoted})`) as Array<{ table: string }>;
    if (!fks.some((fk) => wanted.has(fk.table.toLowerCase()))) continue;
    for (const v of db.pragma(`foreign_key_check(${quoted})`) as FkViolation[]) {
      if (wanted.has(v.parent.toLowerCase())) out.push(v);
    }
  }
  return out;
}

const violationKey = (v: FkViolation): string => `${v.table}\n${v.rowid}\n${v.parent}\n${v.fkid}`;

export function migrate(db: DB, log: MigrationLog = consoleLog, migrations: readonly Migration[] = MIGRATIONS): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this server supports (${migrations.length}). Upgrade PTR Analytics.`,
    );
  }
  for (let v = current; v < migrations.length; v++) {
    const m = migrations[v] as Migration;
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
        // Rows that were already orphaned before the migration are not its fault.
        const before = new Set(fkViolations(db, m.rebuilds).map(violationKey));
        db.exec(m.sql);
        const after = fkViolations(db, m.rebuilds);
        const added = after.filter((x) => !before.has(violationKey(x)));
        if (added.length > 0) throw new Error(`migration ${v + 1} would violate foreign keys`);
        if (after.length > 0) {
          const tables = [...new Set(after.map((x) => x.table))].join(', ');
          log.warn(
            `Database migration ${v + 1}: ${after.length} pre-existing row(s) in ${tables} reference missing ` +
              `${m.rebuilds.join('/')} rows (left over from before this upgrade). They were kept unchanged; ` +
              'run `PRAGMA foreign_key_check` on a copy of the database to inspect them.',
          );
        }
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
