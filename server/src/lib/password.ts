import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function maxmem(n: number, r: number, p: number): number {
  return 128 * n * r * p + 32 * 1024 * 1024;
}

/** Hash a password as `scrypt$N$r$p$saltB64$hashB64`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N, R, P) });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Verify a password against a stored hash in constant time. Malformed hashes never match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Guard against absurd parameters (DoS) in a tampered/corrupted hash.
  if (!Number.isInteger(n) || n < 2 || n > 2 ** 20 || (n & (n - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || expected.length < 16 || expected.length > 128) return false;
  const actual = await scryptAsync(password, salt, expected.length, { N: n, r, p, maxmem: maxmem(n, r, p) });
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | null = null;

/** Burn the same amount of time as a real verification (prevents user enumeration). */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
}
