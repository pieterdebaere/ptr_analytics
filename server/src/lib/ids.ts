import { createHash, randomBytes, randomInt } from 'node:crypto';

const SITE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const SITE_ID_RE = /^[a-z0-9]{12}$/;

/** 12 random chars from [a-z0-9] using crypto.randomInt (no modulo bias). */
export function generateSiteId(): string {
  let id = '';
  for (let i = 0; i < 12; i++) id += SITE_ID_ALPHABET[randomInt(SITE_ID_ALPHABET.length)];
  return id;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 32 random bytes, base64url (43 chars). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Strong random password: 15 bytes -> 20 base64url chars. */
export function generatePassword(): string {
  return randomBytes(15).toString('base64url');
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
