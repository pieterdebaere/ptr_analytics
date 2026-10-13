import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/index.js';
import { utcDay } from './time.js';

/**
 * Daily rotating salt (spec section 2). One 32-byte random salt per UTC day; salts of
 * previous days are deleted as soon as a new day starts, so visitor ids can neither be
 * linked across days nor reversed.
 *
 * Deleting the row is not enough on its own: the old bytes would survive in free space of
 * the database file and in old WAL frames. openDatabase() enables `secure_delete` (deleted
 * content is zeroed) and after every deletion the WAL is checkpointed and truncated here.
 */
export class SaltStore {
  private cached: { day: string; salt: Buffer } | null = null;

  constructor(private readonly db: DB) {}

  current(now: number): Buffer {
    const day = utcDay(now);
    if (this.cached?.day === day) return this.cached.salt;
    const { salt, deleted } = this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)').run(day, randomBytes(32));
      const row = this.db.prepare('SELECT salt FROM salts WHERE day = ?').get(day) as { salt: Buffer };
      // Only past days: if the clock stepped backwards across midnight, the salt of the
      // "future" day is kept (and reused once that day comes) instead of being replaced.
      const res = this.db.prepare('DELETE FROM salts WHERE day < ?').run(day);
      return { salt: row.salt, deleted: res.changes };
    })();
    this.cached = { day, salt };
    if (deleted > 0) this.scrubWal();
    return salt;
  }

  /** Remove salts of past days (also done lazily by current()). */
  purgeOld(now: number): void {
    const day = utcDay(now);
    const deleted = this.db.prepare('DELETE FROM salts WHERE day < ?').run(day).changes;
    if (this.cached && this.cached.day < day) this.cached = null;
    if (deleted > 0) this.scrubWal();
  }

  /**
   * Copy the WAL into the database file and truncate it to zero bytes, so WAL frames that
   * still contain a deleted salt do not linger on disk. Best effort: with concurrent
   * readers (e.g. the CLI) the checkpoint may be partial; the next rotation retries.
   */
  private scrubWal(): void {
    if (this.db.memory) return;
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }
}

/**
 * visitor id = first 16 bytes (hex) of sha256 over daily_salt, site_id, client_ip and
 * user_agent, each prefixed with its 4-byte big-endian length so that the encoding is
 * unambiguous (e.g. ("ab", "c") and ("a", "bc") hash differently).
 */
export function visitorId(salt: Buffer, siteId: string, ip: string, userAgent: string): string {
  const h = createHash('sha256');
  for (const part of [salt, Buffer.from(siteId, 'utf8'), Buffer.from(ip, 'utf8'), Buffer.from(userAgent, 'utf8')]) {
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(part.length, 0);
    h.update(len).update(part);
  }
  return h.digest('hex').slice(0, 32);
}
