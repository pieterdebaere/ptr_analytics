import type { DB } from '../db/index.js';
import { SESSION_TOKEN_RE, generateSessionToken, sha256Hex } from '../lib/ids.js';

export type TokenPurpose = 'verify' | 'reset';

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  verify: 24 * 3_600_000,
  reset: 3_600_000,
};

/**
 * Single-use email tokens (verification, password reset): 32 random bytes (base64url) in the
 * link, only sha256(token) is stored. Tokens are looked up by their hash, so the raw value is
 * never compared and lookup timing reveals nothing about valid tokens.
 */
export class UserTokenRepo {
  constructor(private readonly db: DB) {}

  /** Issue a token; earlier tokens of the same purpose for that user stop working. */
  issue(userId: number, purpose: TokenPurpose, now: number): string {
    const token = generateSessionToken();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM user_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
      this.db
        .prepare('INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(sha256Hex(token), userId, purpose, now + TOKEN_TTL_MS[purpose], now);
    })();
    return token;
  }

  /** The user id a valid token belongs to, without consuming it. */
  peek(token: unknown, purpose: TokenPurpose, now: number): number | null {
    if (typeof token !== 'string' || !SESSION_TOKEN_RE.test(token)) return null;
    const r = this.db
      .prepare('SELECT user_id FROM user_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?')
      .get(sha256Hex(token), purpose, now) as { user_id: number } | undefined;
    return r?.user_id ?? null;
  }

  /** Atomically consume a valid token; returns its user id, or null (unknown, used or expired). */
  consume(token: unknown, purpose: TokenPurpose, now: number): number | null {
    if (typeof token !== 'string' || !SESSION_TOKEN_RE.test(token)) return null;
    const r = this.db
      .prepare('DELETE FROM user_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ? RETURNING user_id')
      .get(sha256Hex(token), purpose, now) as { user_id: number } | undefined;
    return r?.user_id ?? null;
  }

  deleteForUser(userId: number, purpose?: TokenPurpose): void {
    if (purpose === undefined) this.db.prepare('DELETE FROM user_tokens WHERE user_id = ?').run(userId);
    else this.db.prepare('DELETE FROM user_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  }

  purgeExpired(now: number): number {
    return this.db.prepare('DELETE FROM user_tokens WHERE expires_at <= ?').run(now).changes;
  }
}
