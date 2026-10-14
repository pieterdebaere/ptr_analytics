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

export type ApiKeyScope = 'read' | 'metrics';
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['read', 'metrics'];

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
    scopes: arr(raw.scopes).filter((s): s is ApiKeyScope => s === 'read' || s === 'metrics'),
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
  mfaSetup: () =>
    request<unknown>('POST', '/auth/mfa/setup').then((r): MfaSetup => {
      const secret = isObj(r) && typeof r.secret === 'string' ? r.secret.replace(/\s+/g, '').toUpperCase() : '';
      const otpauthUrl = isObj(r) ? safeOtpauthUrl(r.otpauthUrl) : null;
      if (!TOTP_SECRET_RE.test(secret) || !otpauthUrl) throw new ApiError(500, 'Invalid response from server.');
      return { secret, otpauthUrl };
    }),
  mfaEnable: (code: string) => request<unknown>('POST', '/auth/mfa/enable', { body: { code: normalizeTotp(code) } }).then(parseCodes),
  mfaDisable: (password: string, code: string) =>
    request<void>('POST', '/auth/mfa/disable', { body: { password, code: normalizeTotp(code) } }),
  regenerateRecoveryCodes: (password: string, code: string) =>
    request<unknown>('POST', '/auth/mfa/recovery-codes', { body: { password, code: normalizeTotp(code) } }).then(parseCodes),

  listApiKeys: (signal?: AbortSignal) =>
    request<unknown>('GET', '/api-keys', { signal }).then((r) =>
      arr(isObj(r) ? (r.apiKeys ?? r.keys) : r)
        .map(parseApiKey)
        .filter((k): k is ApiKey => k !== null),
    ),
  createApiKey: (body: { name: string; scopes: ApiKeyScope[]; expiresInDays?: number }) =>
    request<unknown>('POST', '/api-keys', { body }).then((r): CreatedApiKey => {
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
