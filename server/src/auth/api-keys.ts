// API keys (docs/SPEC.md §8.3): `pa_<prefix>_<secret>`, prefix = 8 public chars [a-z0-9] (lookup),
// secret = 32 random bytes base64url. Only sha256(key) is stored. Scopes:
//   read    — GET/HEAD of the user's own data (sites, stats, uptime, status pages); never
//             mutations, never auth / users / billing / account / api-key / notification endpoints;
//   metrics — GET /metrics (Prometheus) only: monitors of the key owner's own sites (admins and
//             viewers: also the operator's sites, owner_id NULL);
//   metrics:all — admins only: GET /metrics over every tenant's monitors (explicit opt-in).
// Keys never create sessions and never set cookies; bearer requests are not cookie
// authenticated, so the CSRF defence is unaffected.
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { DB } from '../db/index.js';
import { toUser, type User } from '../data/users.js';
import { HttpError } from '../lib/errors.js';
import { RateLimiter } from '../lib/rate-limit.js';
import { clientIp, rateLimitKey } from '../lib/client-ip.js';
import { sha256Hex } from '../lib/ids.js';

export const API_KEY_SCOPES = ['read', 'metrics', 'metrics:all'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const API_KEYS_PER_USER = 20;
export const API_KEY_RE = /^pa_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
/** last_used_at is written at most this often per key. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface ApiKey {
  uid: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

interface Row {
  id: number;
  uid: string;
  user_id: number;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

function parseScopes(json: string): ApiKeyScope[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v.filter((s) => (API_KEY_SCOPES as readonly unknown[]).includes(s)) as ApiKeyScope[]) : [];
  } catch {
    return [];
  }
}

const toApiKey = (r: Row): ApiKey => ({
  uid: r.uid,
  name: r.name,
  prefix: r.prefix,
  scopes: parseScopes(r.scopes),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
});

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomAlnum(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[randomInt(ALNUM.length)];
  return s;
}

export class ApiKeyRepo {
  constructor(private readonly db: DB) {}

  list(userId: number): ApiKey[] {
    return (
      this.db.prepare('SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC').all(userId) as Row[]
    ).map(toApiKey);
  }

  countActive(userId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').get(userId) as { n: number }).n;
  }

  /** Create a key; returns its metadata and the raw key (shown once). */
  create(userId: number, name: string, scopes: ApiKeyScope[], expiresAt: number | null, now: number): { apiKey: ApiKey; key: string } {
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO api_keys (uid, user_id, name, prefix, key_hash, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      const prefix = randomAlnum(8);
      const key = `pa_${prefix}_${randomBytes(32).toString('base64url')}`;
      const uid = randomAlnum(12);
      const res = ins.run(uid, userId, name, prefix, sha256Hex(key), JSON.stringify(scopes), now, expiresAt);
      if (res.changes === 1) {
        return { apiKey: { uid, name, prefix, scopes, createdAt: now, expiresAt, lastUsedAt: null }, key };
      }
    }
    throw new Error('could not allocate a unique api key');
  }

  /**
   * Revoke every key of a user (password change / reset, MFA enabled / disabled / reset): a
   * key minted with a stolen session must not survive the owner's recovery steps.
   */
  deleteForUser(userId: number): number {
    return this.db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(userId).changes;
  }

  /** Revoke (delete) one of the user's keys. */
  delete(userId: number, uid: string): boolean {
    return this.db.prepare('DELETE FROM api_keys WHERE user_id = ? AND uid = ?').run(userId, uid).changes > 0;
  }

  /** Resolve a raw key to its owner, or null (unknown, wrong secret, revoked, expired). */
  resolve(raw: string, now: number): { user: User; keyId: number; scopes: ApiKeyScope[]; lastUsedAt: number | null } | null {
    const m = API_KEY_RE.exec(raw);
    if (!m) return null;
    const r = this.db
      .prepare(
        `SELECT k.*, u.email, u.role, u.created_at AS u_created_at, u.email_verified_at
         FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.prefix = ?`,
      )
      .get(m[1]) as (Row & { email: string; role: User['role']; u_created_at: number; email_verified_at: number | null }) | undefined;
    // Constant-ish work whether or not the prefix exists.
    const expected = Buffer.from(r?.key_hash ?? '0'.repeat(64), 'hex');
    const actual = Buffer.from(sha256Hex(raw), 'hex');
    const match = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!r || !match) return null;
    if (r.revoked_at !== null || (r.expires_at !== null && r.expires_at <= now)) return null;
    if (r.role === 'member' && r.email_verified_at === null) return null;
    const user = toUser({ id: r.user_id, email: r.email, role: r.role, created_at: r.u_created_at, email_verified_at: r.email_verified_at });
    return { user, keyId: r.id, scopes: parseScopes(r.scopes), lastUsedAt: r.last_used_at };
  }

  touch(keyId: number, now: number): void {
    this.db
      .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
      .run(now, keyId, now - LAST_USED_RESOLUTION_MS);
  }
}

/* ---------------------------------------------------------- authentication */

interface KeyState {
  repo: ApiKeyRepo;
  /**
   * Failed bearer attempts per (client IP, key prefix). Only failures are counted and a
   * valid key is always evaluated first, so garbage tokens from one client never lock out
   * valid keys used from the same IP / NAT.
   */
  failures: RateLimiter;
  /** Failed attempts per client IP over all prefixes (coarse cap on random-prefix floods). */
  ipFailures: RateLimiter;
  /** keyId → last time last_used_at was written (coalescing). */
  touched: Map<number, number>;
}

const stateByCtx = new WeakMap<AppContext, KeyState>();

export function apiKeyState(ctx: AppContext): KeyState {
  let s = stateByCtx.get(ctx);
  if (!s) {
    s = {
      repo: new ApiKeyRepo(ctx.db),
      failures: new RateLimiter(30, 15 * 60_000, ctx.now, 20_000),
      ipFailures: new RateLimiter(300, 15 * 60_000, ctx.now, 20_000),
      touched: new Map(),
    };
    stateByCtx.set(ctx, s);
  }
  return s;
}

/** Raw bearer token of a request, if any (`Authorization: Bearer …`). */
export function bearerToken(request: FastifyRequest): string | null {
  const h = request.headers.authorization;
  if (typeof h !== 'string' || h.length > 512) return null;
  const m = /^Bearer[ ]+(\S+)[ ]*$/i.exec(h);
  return m ? (m[1] as string) : null;
}

/**
 * Routes a `read` key may call (GET/HEAD only), by matched route pattern. Default deny:
 * anything not listed (auth, users, billing, account, api-keys, notification channels, …)
 * refuses API keys.
 */
const READ_PREFIXES = [
  '/api/sites',
  '/api/overview',
  '/api/live',
  '/api/config',
  '/api/uptime/',
  '/api/monitors',
  '/api/tags',
  '/api/maintenances',
  '/api/status-pages',
  '/api/incidents',
];

export function apiKeyAllowedRoute(method: string, route: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (route === undefined) return false;
  return READ_PREFIXES.some((p) => (p.endsWith('/') ? route.startsWith(p) : route === p || route.startsWith(`${p}/`)));
}

const keyByRequest = new WeakMap<FastifyRequest, { keyId: number; scopes: ApiKeyScope[] }>();

/** The API key a request was authenticated with (null for cookie sessions). */
export function requestApiKey(request: FastifyRequest): { keyId: number; scopes: ApiKeyScope[] } | null {
  return keyByRequest.get(request) ?? null;
}

/**
 * Authenticate a bearer API key with (one of) the given scope(s). Returns null when the request
 * carries no bearer token; throws 401/403/429 for bad keys, wrong scope or too many failures.
 * A syntactically valid key is always looked up first: the failure limiter only decides
 * between 401 and 429 for keys that did not resolve.
 */
export function authenticateApiKey(ctx: AppContext, request: FastifyRequest, scope: ApiKeyScope | readonly ApiKeyScope[]): User | null {
  const token = bearerToken(request);
  if (token === null) return null;
  const st = apiKeyState(ctx);
  const now = ctx.now();
  const resolved = st.repo.resolve(token, now);
  if (!resolved) {
    const ipKey = rateLimitKey(clientIp(request));
    const prefix = API_KEY_RE.exec(token)?.[1] ?? '-';
    const pairOk = st.failures.hit(`${ipKey}\n${prefix}`);
    const ipOk = st.ipFailures.hit(ipKey);
    if (!pairOk || !ipOk) throw new HttpError(429, 'too many failed attempts, try again later');
    throw new HttpError(401, 'unauthorized');
  }
  const wanted: readonly ApiKeyScope[] = typeof scope === 'string' ? [scope] : scope;
  if (!wanted.some((w) => resolved.scopes.includes(w))) throw new HttpError(403, 'api key lacks the required scope', 'insufficient_scope');
  const last = st.touched.get(resolved.keyId) ?? resolved.lastUsedAt ?? 0;
  if (now - last >= LAST_USED_RESOLUTION_MS) {
    if (st.touched.size > 10_000) st.touched.clear();
    st.touched.set(resolved.keyId, now);
    st.repo.touch(resolved.keyId, now);
  }
  keyByRequest.set(request, { keyId: resolved.keyId, scopes: resolved.scopes });
  return resolved.user;
}
