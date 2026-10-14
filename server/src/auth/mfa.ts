// Two-factor authentication (docs/SPEC.md §8.3, ANALYSIS §8.7.8): TOTP enrolment, recovery
// codes, login challenges and the attempt limits that protect them.
//
// * The TOTP secret is encrypted at rest with the secret box (AAD "mfa:<userId>").
// * Replay protection: the last accepted time step is stored; a code for a step <= last_step
//   is refused, and the update is a compare-and-set so two concurrent requests cannot both win.
// * Recovery codes: 10 × 80 bits, stored as sha256, single use (compare-and-set on used_at).
// * Login challenge ("mfaToken"): 32 random bytes, only sha256 kept (in memory), 5 minutes,
//   single use, bound to the user and to the password hash it was issued for, ≤ 5 attempts.
import { randomBytes } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { DB } from '../db/index.js';
import type { User } from '../data/users.js';
import { RateLimiter } from '../lib/rate-limit.js';
import { SESSION_TOKEN_RE, generateSessionToken, sha256Hex } from '../lib/ids.js';
import { base32Decode, generateTotpSecret, normalizeTotpCode, otpauthUrl, totpStep, verifyTotp } from './totp.js';

export const RECOVERY_CODE_COUNT = 10;
export const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;
const MFA_WINDOW_MS = 15 * 60_000;
/** Second-factor attempts per account per window (all paths: login, disable, regenerate). */
const MFA_MAX_PER_USER = 10;
/** Second-factor submissions per client IP per window. */
const MFA_MAX_PER_IP = 30;
const MAX_CHALLENGES = 10_000;
const MAX_CHALLENGES_PER_USER = 5;
const ISSUER = 'PTR Analytics';

const aad = (userId: number): string => `mfa:${userId}`;

/* ------------------------------------------------------------------ limiters */

export interface MfaLimits {
  user: RateLimiter;
  ip: RateLimiter;
}

const limitsByCtx = new WeakMap<AppContext, MfaLimits>();

export function mfaLimits(ctx: AppContext): MfaLimits {
  let l = limitsByCtx.get(ctx);
  if (!l) {
    l = {
      user: new RateLimiter(MFA_MAX_PER_USER, MFA_WINDOW_MS, ctx.now, 20_000),
      ip: new RateLimiter(MFA_MAX_PER_IP, MFA_WINDOW_MS, ctx.now, 20_000),
    };
    limitsByCtx.set(ctx, l);
  }
  return l;
}

/* ------------------------------------------------------------------- storage */

interface MfaRow {
  totp_secret: Buffer;
  enabled_at: number | null;
  last_step: number;
}

function row(db: DB, userId: number): MfaRow | undefined {
  return db.prepare('SELECT totp_secret, enabled_at, last_step FROM user_mfa WHERE user_id = ?').get(userId) as MfaRow | undefined;
}

export function isMfaEnabled(db: DB, userId: number): boolean {
  return db.prepare('SELECT 1 FROM user_mfa WHERE user_id = ? AND enabled_at IS NOT NULL').get(userId) !== undefined;
}

export interface MfaStatus {
  enabled: boolean;
  /** Setup started but not confirmed with a code yet. */
  pending: boolean;
  recoveryCodesLeft: number;
}

export function mfaStatus(db: DB, userId: number): MfaStatus {
  const r = row(db, userId);
  const left = (
    db.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { n: number }
  ).n;
  return { enabled: r?.enabled_at != null, pending: r !== undefined && r.enabled_at === null, recoveryCodesLeft: r?.enabled_at != null ? left : 0 };
}

function secretKey(ctx: AppContext, userId: number, blob: Buffer): Buffer | null {
  try {
    const secret = ctx.secretBox().open(blob, aad(userId))['secret'];
    return typeof secret === 'string' ? base32Decode(secret) : null;
  } catch (err) {
    ctx.log.error({ err, userId }, 'could not decrypt TOTP secret');
    return null;
  }
}

/** Start (or restart) enrolment: a new pending secret. Refused while MFA is enabled. */
export function beginMfaSetup(ctx: AppContext, user: User): { secret: string; otpauthUrl: string } | null {
  if (isMfaEnabled(ctx.db, user.id)) return null;
  const secret = generateTotpSecret();
  const blob = ctx.secretBox().seal({ secret }, aad(user.id));
  ctx.db
    .prepare(
      `INSERT INTO user_mfa (user_id, totp_secret, enabled_at, last_step) VALUES (?, ?, NULL, 0)
       ON CONFLICT(user_id) DO UPDATE SET totp_secret = excluded.totp_secret, last_step = 0 WHERE user_mfa.enabled_at IS NULL`,
    )
    .run(user.id, blob);
  return { secret, otpauthUrl: otpauthUrl(secret, user.email, ISSUER) };
}

/** Recovery code: 16 base32 chars (80 bits) shown as xxxx-xxxx-xxxx-xxxx. */
function newRecoveryCode(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(16);
  let s = '';
  for (const b of bytes) s += alphabet[b & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

const RECOVERY_RE = /^[a-z2-7]{16}$/;

export function normalizeRecoveryCode(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const c = v.replace(/[\s-]/g, '').toLowerCase();
  return RECOVERY_RE.test(c) ? c : null;
}

function replaceRecoveryCodes(db: DB, userId: number): string[] {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO user_recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)');
  for (const c of codes) ins.run(userId, sha256Hex(c.replace(/-/g, '')));
  return codes;
}

/** Atomically accept a TOTP step (compare-and-set on last_step). */
function acceptStep(db: DB, userId: number, step: number, enabledOnly: boolean): boolean {
  const sql = enabledOnly
    ? 'UPDATE user_mfa SET last_step = ? WHERE user_id = ? AND last_step < ? AND enabled_at IS NOT NULL'
    : 'UPDATE user_mfa SET last_step = ? WHERE user_id = ? AND last_step < ?';
  return db.prepare(sql).run(step, userId, step).changes === 1;
}

/**
 * Confirm enrolment with a code from the pending secret. Returns the recovery codes (shown
 * once) or null when the code is wrong / nothing is pending.
 */
export function confirmMfaSetup(ctx: AppContext, userId: number, codeRaw: unknown): string[] | null {
  const code = normalizeTotpCode(codeRaw);
  const r = row(ctx.db, userId);
  if (!code || !r || r.enabled_at !== null) return null;
  const key = secretKey(ctx, userId, r.totp_secret);
  if (!key) return null;
  const step = verifyTotp(key, code, ctx.now(), r.last_step);
  if (step === null) return null;
  return ctx.db.transaction(() => {
    if (!acceptStep(ctx.db, userId, step, false)) return null;
    const changed = ctx.db.prepare('UPDATE user_mfa SET enabled_at = ? WHERE user_id = ? AND enabled_at IS NULL').run(ctx.now(), userId);
    if (changed.changes !== 1) return null;
    return replaceRecoveryCodes(ctx.db, userId);
  })();
}

export interface SecondFactor {
  code?: unknown;
  recoveryCode?: unknown;
}

/**
 * Check (and consume) a second factor of a user with MFA enabled: a TOTP code (replay
 * protected) or an unused recovery code (marked used). Synchronous, so a caller can check
 * and act without another request interleaving.
 */
export function verifySecondFactor(ctx: AppContext, userId: number, f: SecondFactor): { ok: boolean; usedRecoveryCode: boolean } {
  const r = row(ctx.db, userId);
  if (!r || r.enabled_at === null) return { ok: false, usedRecoveryCode: false };
  if (f.recoveryCode !== undefined && f.recoveryCode !== null && f.recoveryCode !== '') {
    const rc = normalizeRecoveryCode(f.recoveryCode);
    if (!rc) return { ok: false, usedRecoveryCode: false };
    const used = ctx.db
      .prepare('UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
      .run(ctx.now(), userId, sha256Hex(rc));
    return { ok: used.changes === 1, usedRecoveryCode: used.changes === 1 };
  }
  // Recovery codes may also be typed into the code field.
  const rcInCode = normalizeRecoveryCode(f.code);
  if (rcInCode) return verifySecondFactor(ctx, userId, { recoveryCode: rcInCode });
  const code = normalizeTotpCode(f.code);
  if (!code) return { ok: false, usedRecoveryCode: false };
  const key = secretKey(ctx, userId, r.totp_secret);
  if (!key) return { ok: false, usedRecoveryCode: false };
  const step = verifyTotp(key, code, ctx.now(), r.last_step);
  if (step === null) return { ok: false, usedRecoveryCode: false };
  return { ok: acceptStep(ctx.db, userId, step, true), usedRecoveryCode: false };
}

/** Remove MFA completely (disable, CLI reset). */
export function deleteMfa(db: DB, userId: number): boolean {
  return db.transaction(() => {
    db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
    return db.prepare('DELETE FROM user_mfa WHERE user_id = ?').run(userId).changes > 0;
  })();
}

export function regenerateRecoveryCodes(ctx: AppContext, userId: number): string[] | null {
  if (!isMfaEnabled(ctx.db, userId)) return null;
  return ctx.db.transaction(() => replaceRecoveryCodes(ctx.db, userId))();
}

/** Current TOTP step (exported for tests / diagnostics). */
export const currentStep = (ctx: AppContext): number => totpStep(ctx.now());

/* ---------------------------------------------------------- login challenges */

interface Challenge {
  userId: number;
  /** Password hash the challenge was issued for: a password change/reset invalidates it. */
  passwordHash: string;
  expiresAt: number;
  attempts: number;
}

const challengesByCtx = new WeakMap<AppContext, Map<string, Challenge>>();

function challenges(ctx: AppContext): Map<string, Challenge> {
  let m = challengesByCtx.get(ctx);
  if (!m) {
    m = new Map();
    challengesByCtx.set(ctx, m);
  }
  return m;
}

function sweep(ctx: AppContext, m: Map<string, Challenge>): void {
  const now = ctx.now();
  for (const [k, c] of m) if (c.expiresAt <= now) m.delete(k);
}

/** Issue a login challenge after a correct password (no session yet). Returns the raw token. */
export function issueMfaChallenge(ctx: AppContext, userId: number, passwordHash: string): string {
  const m = challenges(ctx);
  if (m.size >= MAX_CHALLENGES) sweep(ctx, m);
  // Still full: drop the oldest (Map keeps insertion order).
  while (m.size >= MAX_CHALLENGES) {
    const first = m.keys().next();
    if (first.done) break;
    m.delete(first.value);
  }
  // At most a few outstanding challenges per user (oldest dropped).
  const mine = [...m.entries()].filter(([, c]) => c.userId === userId);
  for (let i = 0; i <= mine.length - MAX_CHALLENGES_PER_USER; i++) m.delete((mine[i] as [string, Challenge])[0]);
  const token = generateSessionToken();
  m.set(sha256Hex(token), { userId, passwordHash, expiresAt: ctx.now() + MFA_CHALLENGE_TTL_MS, attempts: 0 });
  return token;
}

export type ChallengeResult =
  | { ok: true; userId: number; usedRecoveryCode: boolean }
  | { ok: false; reason: 'invalid_token' | 'invalid_code' };

/**
 * Answer a login challenge. Unknown/expired/used tokens → invalid_token. A wrong code counts
 * one attempt; after MFA_CHALLENGE_MAX_ATTEMPTS the token is gone. A correct factor consumes
 * the token (single use). Synchronous by design: no other request can use the same token or
 * code in between.
 */
export function answerMfaChallenge(ctx: AppContext, token: unknown, factor: SecondFactor, currentPasswordHash: (userId: number) => string | null): ChallengeResult {
  if (typeof token !== 'string' || !SESSION_TOKEN_RE.test(token)) return { ok: false, reason: 'invalid_token' };
  const m = challenges(ctx);
  const key = sha256Hex(token);
  const c = m.get(key);
  if (!c) return { ok: false, reason: 'invalid_token' };
  if (c.expiresAt <= ctx.now() || currentPasswordHash(c.userId) !== c.passwordHash) {
    m.delete(key);
    return { ok: false, reason: 'invalid_token' };
  }
  c.attempts++;
  const res = verifySecondFactor(ctx, c.userId, factor);
  if (!res.ok) {
    if (c.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS) m.delete(key);
    return { ok: false, reason: 'invalid_code' };
  }
  m.delete(key);
  return { ok: true, userId: c.userId, usedRecoveryCode: res.usedRecoveryCode };
}

/** User id a challenge token belongs to (for per-account limits), without consuming it. */
export function challengeUser(ctx: AppContext, token: unknown): number | null {
  if (typeof token !== 'string' || !SESSION_TOKEN_RE.test(token)) return null;
  const c = challenges(ctx).get(sha256Hex(token));
  return c && c.expiresAt > ctx.now() ? c.userId : null;
}

/** Drop all outstanding challenges of a user (MFA disabled/reset, password changed). */
export function dropChallenges(ctx: AppContext, userId: number): void {
  const m = challenges(ctx);
  for (const [k, c] of m) if (c.userId === userId) m.delete(k);
}
