import type { DB } from '../db/index.js';
import { SESSION_TOKEN_RE, generateSessionToken, sha256Hex } from '../lib/ids.js';

export type TokenPurpose = 'verify' | 'reset';

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  verify: 24 * 3_600_000,
  reset: 3_600_000,
};

/** Valid tokens kept per user and purpose; issuing more drops the oldest. */
export const MAX_TOKENS_PER_PURPOSE = 3;

/**
 * Single-use email tokens (verification, password reset): 32 random bytes (base64url) in the
 * link, only sha256(token) is stored. Tokens are looked up by their hash, so the raw value is
 * never compared and lookup timing reveals nothing about valid tokens.
 */
export class UserTokenRepo {
  constructor(private readonly db: DB) {}

  /**
   * Issue a token. Earlier tokens stay valid (so a third party triggering another mail cannot
   * invalidate a link the owner is about to use), up to MAX_TOKENS_PER_PURPOSE per purpose:
   * beyond that the oldest are dropped. Each is single use; a successful reset (or
   * verification) invalidates all of them.
   */
  issue(userId: number, purpose: TokenPurpose, now: number): string {
    const token = generateSessionToken();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(sha256Hex(token), userId, purpose, now + TOKEN_TTL_MS[purpose], now);
      this.db
        .prepare(
          `DELETE FROM user_tokens WHERE user_id = ? AND purpose = ? AND rowid NOT IN (
             SELECT rowid FROM user_tokens WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
           )`,
        )
        .run(userId, purpose, userId, purpose, MAX_TOKENS_PER_PURPOSE);
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
