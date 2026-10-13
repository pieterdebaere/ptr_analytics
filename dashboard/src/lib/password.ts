export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Random password from crypto.getRandomValues (rejection sampling, no modulo bias). */
export function generatePassword(length = 20): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit) out.push(ALPHABET[b % ALPHABET.length]!);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/** Returns an error message or null. */
export function validateNewPassword(password: string, confirm?: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  if (confirm !== undefined && confirm !== password) return 'The passwords do not match.';
  return null;
}
