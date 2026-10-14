// TOTP (RFC 6238 / RFC 4226) with node:crypto only: HMAC-SHA1, 30 s steps, 6 digits.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
/** Accepted clock drift in steps (±1 step = ±30 s). */
export const TOTP_WINDOW = 1;
/** 160-bit secrets (RFC 4226 recommends ≥ 128 bits, 160 is the SHA-1 block-friendly size). */
export const TOTP_SECRET_BYTES = 20;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding. */
export function base32Encode(buf: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decode base32 (case-insensitive, spaces/dashes/padding ignored). Returns null when invalid. */
export function base32Decode(s: string): Buffer | null {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  if (clean.length === 0 || clean.length > 1024) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) return null;
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** RFC 4226 HOTP value for a counter, zero-padded to `digits`. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const bin =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Time step for an instant (ms epoch). */
export function totpStep(nowMs: number, period = TOTP_PERIOD_S): number {
  return Math.floor(nowMs / 1000 / period);
}

export function totp(key: Buffer, nowMs: number, digits = TOTP_DIGITS): string {
  return hotp(key, totpStep(nowMs), digits);
}

export const TOTP_CODE_RE = /^\d{6}$/;

/** Normalise user input ("123 456" → "123456"); null when it cannot be a code. */
export function normalizeTotpCode(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 16) return null;
  const c = v.replace(/[\s-]/g, '');
  return TOTP_CODE_RE.test(c) ? c : null;
}

/**
 * Verify a code within ±TOTP_WINDOW steps. Steps `<= lastStep` are never accepted (replay
 * protection: a code works at most once, and nothing older than the last accepted one).
 * Returns the matching step or null. All candidate steps are compared (constant work).
 */
export function verifyTotp(key: Buffer, code: string, nowMs: number, lastStep: number): number | null {
  if (!TOTP_CODE_RE.test(code)) return null;
  const current = totpStep(nowMs);
  const given = Buffer.from(code);
  let match: number | null = null;
  for (let s = current - TOTP_WINDOW; s <= current + TOTP_WINDOW; s++) {
    const ok = timingSafeEqual(Buffer.from(hotp(key, s)), given);
    if (ok && s > lastStep && match === null) match = s;
  }
  return match;
}

/** otpauth:// URI for authenticator apps (Key Uri Format). */
export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_S),
  });
  return `otpauth://totp/${label}?${q.toString().replace(/\+/g, '%20')}`;
}
