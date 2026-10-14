// Typed client for two-factor authentication, the MFA login step and API keys
// (docs/SPEC.md §8.3). Secrets returned here (TOTP secret, recovery codes, API keys)
// are shown once: never log, persist or put them in URLs.
import { ApiError, request } from './client';
import type { User } from './types';

export interface MfaStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
  /** The server requires 2FA for this account (REQUIRE_MFA_FOR_ADMINS). */
  required: boolean;
}

export interface MfaSetup {
  secret: string;
  otpauthUrl: string;
}

/** `metrics:all` (admins only): /metrics for every account's monitors. */
export type ApiKeyScope = 'read' | 'metrics' | 'metrics:all';
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['read', 'metrics', 'metrics:all'];
const isScope = (s: unknown): s is ApiKeyScope => s === 'read' || s === 'metrics' || s === 'metrics:all';

/** A current second factor: a 6-digit authenticator code or a recovery code. */
export type SecondFactor = { code: string } | { recoveryCode: string };

export interface MfaEnabled {
  recoveryCodes: string[];
  /** API keys revoked because 2FA was turned on (keys must be re-created). */
  apiKeysRevoked: number;
}

export interface CreateApiKeyInput {
  name: string;
  scopes: ApiKeyScope[];
  expiresInDays?: number;
  /** The account password (required). */
  password: string;
  /** A current second factor, required when 2FA is on (else 400 `mfa_code_required`). */
  factor?: SecondFactor;
}

export interface ApiKey {
  uid: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: number | null;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

export interface CreatedApiKey {
  apiKey: ApiKey;
  /** Full key `pa_<prefix>_<secret>` — shown once. */
  key: string;
}

export type LoginResult = { kind: 'user'; user: User } | { kind: 'mfa'; mfaToken: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 6 digits (spaces allowed while typing). */
export function normalizeTotp(code: string): string {
  return code.replace(/\s+/g, '');
}
export function isTotpCode(code: string): boolean {
  return /^\d{6}$/.test(normalizeTotp(code));
}
/** Recovery codes: letters/digits with optional dashes or spaces, 8–64 chars. */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().replace(/\s+/g, '');
}
export function isRecoveryCode(code: string): boolean {
  return /^[A-Za-z0-9-]{8,64}$/.test(normalizeRecoveryCode(code));
}

const TOTP_SECRET_RE = /^[A-Z2-7]{16,128}=*$/;

/** Only `otpauth://totp/…` URIs with a base32 secret are turned into a QR code / link. */
export function safeOtpauthUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 1024 || !/^otpauth:\/\/totp\//.test(v)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(v)) return null;
  try {
    const u = new URL(v);
    const secret = u.searchParams.get('secret') ?? '';
    if (u.protocol !== 'otpauth:' || !TOTP_SECRET_RE.test(secret.toUpperCase())) return null;
  } catch {
    return null;
  }
  return v;
}

export function parseApiKey(raw: unknown): ApiKey | null {
  if (!isObj(raw) || typeof raw.uid !== 'string' || !raw.uid) return null;
  return {
    uid: raw.uid,
    name: typeof raw.name === 'string' ? raw.name : '',
    prefix: typeof raw.prefix === 'string' ? raw.prefix : '',
    scopes: arr(raw.scopes).filter(isScope),
    createdAt: numOrNull(raw.createdAt),
    lastUsedAt: numOrNull(raw.lastUsedAt),
    expiresAt: numOrNull(raw.expiresAt),
  };
}

function parseCodes(raw: unknown): string[] {
  const codes = arr(isObj(raw) ? raw.recoveryCodes : null).filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= 64);
  if (codes.length === 0) throw new ApiError(500, 'Invalid response from server.');
  return codes;
}

const keyPath = (uid: string) => `/api-keys/${encodeURIComponent(uid)}`;

/** Normalised request body part for a second factor. */
function factorBody(f: SecondFactor): { code: string } | { recoveryCode: string } {
  return 'code' in f ? { code: normalizeTotp(f.code) } : { recoveryCode: normalizeRecoveryCode(f.recoveryCode) };
}

/** Client-side check of a second factor; returns a message or null. */
export function factorError(f: SecondFactor): string | null {
  if ('code' in f) return isTotpCode(f.code) ? null : 'Enter the 6-digit code from your authenticator app.';
  return isRecoveryCode(f.recoveryCode) ? null : 'Enter one of your recovery codes.';
}

export type SecurityErrorField = 'password' | 'code' | null;

/**
 * User-facing message for errors of the re-authenticated security endpoints (MFA setup /
 * enable / disable, recovery codes, API keys), with the form field it belongs to.
 */
export function securityError(err: unknown): { field: SecurityErrorField; message: string } {
  if (!(err instanceof ApiError)) return { field: null, message: err instanceof Error && err.name === 'AbortError' ? '' : 'Something went wrong.' };
  const msg = err.message.toLowerCase();
  if (err.code === 'mfa_locked') {
    const m = /try again in (\d+) ?min/.exec(msg);
    return { field: 'code', message: m ? `Too many wrong codes. Try again in ${m[1]} ${m[1] === '1' ? 'minute' : 'minutes'}.` : 'Too many wrong codes. Try again later.' };
  }
  if (err.status === 429) return { field: null, message: 'Too many attempts. Please wait a few minutes and try again.' };
  if (err.code === 'invalid_code' || msg === 'invalid code') {
    return { field: 'code', message: 'That code didn’t work. Check the time on your device and try again, or use an unused recovery code.' };
  }
  if (err.code === 'mfa_code_required' || msg === 'code is required') return { field: 'code', message: 'Enter a code from your authenticator app.' };
  if (msg === 'password is incorrect') return { field: 'password', message: 'The password is incorrect.' };
  if (msg === 'password is required') return { field: 'password', message: 'Enter your password.' };
  if (err.code === 'limit_reached') return { field: null, message: 'You have reached the maximum number of API keys. Revoke one first.' };
  const sentence = err.message.charAt(0).toUpperCase() + err.message.slice(1);
  return { field: null, message: /[.!?]$/.test(sentence) ? sentence : `${sentence}.` };
}

export const securityApi = {
  /**
   * First login step. Accounts with 2FA answer `{mfaRequired, mfaToken}` instead of a
   * session; the code is then sent with `loginMfa`.
   */
  login: (email: string, password: string): Promise<LoginResult> =>
    request<unknown>('POST', '/auth/login', { body: { email, password }, redirectOn401: false }).then((r) => {
      if (isObj(r) && r.mfaRequired === true && typeof r.mfaToken === 'string' && r.mfaToken) return { kind: 'mfa', mfaToken: r.mfaToken };
      if (isObj(r) && isObj(r.user)) return { kind: 'user', user: r.user as unknown as User };
      throw new ApiError(500, 'Invalid response from server.');
    }),
  /** E-mail verification can also require the second factor (accounts with 2FA). */
  verifyEmail: (token: string, password: string): Promise<LoginResult> =>
    request<unknown>('POST', '/auth/verify', { body: { token, password }, redirectOn401: false }).then((r) => {
      if (isObj(r) && r.mfaRequired === true && typeof r.mfaToken === 'string' && r.mfaToken) return { kind: 'mfa', mfaToken: r.mfaToken };
      if (isObj(r) && isObj(r.user)) return { kind: 'user', user: r.user as unknown as User };
      throw new ApiError(500, 'Invalid response from server.');
    }),
  loginMfa: (mfaToken: string, second: { code: string } | { recoveryCode: string }) =>
    request<{ user: User }>('POST', '/auth/login/mfa', { body: { mfaToken, ...second }, redirectOn401: false }).then((r) => {
      if (!r || !isObj(r.user)) throw new ApiError(500, 'Invalid response from server.');
      return r.user;
    }),

  mfaStatus: (signal?: AbortSignal) =>
    request<unknown>('GET', '/auth/mfa', { signal }).then(
      (r): MfaStatus => ({
        enabled: isObj(r) && r.enabled === true,
        recoveryCodesLeft: isObj(r) && typeof r.recoveryCodesLeft === 'number' ? Math.max(0, Math.floor(r.recoveryCodesLeft)) : 0,
        required: isObj(r) && r.required === true,
      }),
    ),
  /** Starts enrolment; re-authenticates with the account password. */
  mfaSetup: (password: string) =>
    request<unknown>('POST', '/auth/mfa/setup', { body: { password } }).then((r): MfaSetup => {
      const secret = isObj(r) && typeof r.secret === 'string' ? r.secret.replace(/\s+/g, '').toUpperCase() : '';
      const otpauthUrl = isObj(r) ? safeOtpauthUrl(r.otpauthUrl) : null;
      if (!TOTP_SECRET_RE.test(secret) || !otpauthUrl) throw new ApiError(500, 'Invalid response from server.');
      return { secret, otpauthUrl };
    }),
  /** Confirms enrolment with the password and the first code from the app. */
  mfaEnable: (password: string, code: string) =>
    request<unknown>('POST', '/auth/mfa/enable', { body: { password, code: normalizeTotp(code) } }).then(
      (r): MfaEnabled => ({
        recoveryCodes: parseCodes(r),
        apiKeysRevoked: isObj(r) && typeof r.apiKeysRevoked === 'number' && r.apiKeysRevoked > 0 ? Math.floor(r.apiKeysRevoked) : 0,
      }),
    ),
  mfaDisable: (password: string, factor: SecondFactor) =>
    request<void>('POST', '/auth/mfa/disable', { body: { password, ...factorBody(factor) } }),
  regenerateRecoveryCodes: (password: string, factor: SecondFactor) =>
    request<unknown>('POST', '/auth/mfa/recovery-codes', { body: { password, ...factorBody(factor) } }).then(parseCodes),

  listApiKeys: (signal?: AbortSignal) =>
    request<unknown>('GET', '/api-keys', { signal }).then((r) =>
      arr(isObj(r) ? (r.apiKeys ?? r.keys) : r)
        .map(parseApiKey)
        .filter((k): k is ApiKey => k !== null),
    ),
  createApiKey: ({ factor, ...input }: CreateApiKeyInput) =>
    request<unknown>('POST', '/api-keys', { body: { ...input, ...(factor ? factorBody(factor) : {}) } }).then((r): CreatedApiKey => {
      const o = isObj(r) ? r : {};
      const meta = parseApiKey(o.apiKey ?? o.keyInfo ?? o.meta ?? o);
      // the secret may come as `key` (string) or `token`/`secret`
      const nested = isObj(o.apiKey) ? o.apiKey.key : undefined;
      const key = [o.key, o.token, o.secret, nested].find((v): v is string => typeof v === 'string' && /^pa_[A-Za-z0-9_-]{8,200}$/.test(v));
      if (!key || !meta) throw new ApiError(500, 'Invalid response from server.');
      return { apiKey: meta, key };
    }),
  revokeApiKey: (uid: string) => request<void>('DELETE', keyPath(uid)),
};
