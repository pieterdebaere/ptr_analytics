import type { DB } from '../db/index.js';
import type { User } from '../data/users.js';
import { SESSION_TOKEN_RE, generateSessionToken, sha256Hex } from '../lib/ids.js';

const SESSION_COOKIE_BASE = 'pa_session';

/**
 * With `Secure` cookies we use the `__Host-` prefix: browsers then refuse the cookie unless
 * it is Secure, host-only (no Domain) and Path=/, so a sibling subdomain cannot plant or
 * shadow a session cookie (session fixation / login CSRF).
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? `__Host-${SESSION_COOKIE_BASE}` : SESSION_COOKIE_BASE;
}
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface Row {
  id: number;
  email: string;
  role: User['role'];
  created_at: number;
}

/** Login sessions. Only sha256(token) is stored. */
export class AuthSessionRepo {
  constructor(private readonly db: DB) {}

  create(userId: number, now: number): { token: string; tokenHash: string } {
    const token = generateSessionToken();
    const tokenHash = sha256Hex(token);
    this.db
      .prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, now, now + SESSION_TTL_MS);
    return { token, tokenHash };
  }

  /** Resolve a raw cookie token to its user, or null. */
  resolve(token: string | undefined, now: number): { user: User; tokenHash: string } | null {
    if (token === undefined || !SESSION_TOKEN_RE.test(token)) return null;
    const tokenHash = sha256Hex(token);
    const r = this.db
      .prepare(
        `SELECT u.id, u.email, u.role, u.created_at FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, now) as Row | undefined;
    if (!r) return null;
    return { user: { id: r.id, email: r.email, role: r.role, createdAt: r.created_at }, tokenHash };
  }

  deleteByHash(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteToken(token: string): void {
    if (SESSION_TOKEN_RE.test(token)) this.deleteByHash(sha256Hex(token));
  }

  /** Delete all sessions of a user, optionally keeping one. */
  deleteForUser(userId: number, exceptHash?: string): void {
    if (exceptHash === undefined) this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
    else this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?').run(userId, exceptHash);
  }

  purgeExpired(now: number): number {
    return this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now).changes;
  }
}
