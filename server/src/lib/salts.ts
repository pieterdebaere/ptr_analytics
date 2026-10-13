import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/index.js';
import { utcDay } from './time.js';

/**
 * Daily rotating salt (spec section 2). One 32-byte random salt per UTC day; salts of
 * previous days are deleted as soon as a new day starts, so visitor ids can neither be
 * linked across days nor reversed.
 */
export class SaltStore {
  private cached: { day: string; salt: Buffer } | null = null;

  constructor(private readonly db: DB) {}

  current(now: number): Buffer {
    const day = utcDay(now);
    if (this.cached?.day === day) return this.cached.salt;
    const salt = this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)').run(day, randomBytes(32));
      const row = this.db.prepare('SELECT salt FROM salts WHERE day = ?').get(day) as { salt: Buffer };
      this.db.prepare('DELETE FROM salts WHERE day <> ?').run(day);
      return row.salt;
    })();
    this.cached = { day, salt };
    return salt;
  }

  /** Remove salts of past days (also done lazily by current()). */
  purgeOld(now: number): void {
    const day = utcDay(now);
    this.db.prepare('DELETE FROM salts WHERE day < ?').run(day);
    if (this.cached && this.cached.day < day) this.cached = null;
  }
}

/** visitor id = first 16 bytes (hex) of sha256(daily_salt || site_id || client_ip || user_agent). */
export function visitorId(salt: Buffer, siteId: string, ip: string, userAgent: string): string {
  return createHash('sha256').update(salt).update(siteId).update(ip).update(userAgent).digest('hex').slice(0, 32);
}
