// AES-256-GCM envelope for secrets at rest (monitor credentials, notification tokens, TOTP secrets).
// docs/SPEC.md §8.1, docs/uptime/ANALYSIS.md §8.7.3.
//
// Blob layout (binary, stored in BLOB columns):
//   [0]      version (1)
//   [1..4]   key id = first 4 bytes of SHA-256("ptr-secrets-key-id" || key)  (detects a wrong key)
//   [5..16]  random 96-bit IV
//   [17..32] GCM tag
//   [33..]   ciphertext of JSON {"k": "v", …}
// AAD = "ptr-secrets:v1:" + caller AAD (e.g. "monitor:<uid>") — a ciphertext moved to another row
// or table fails to open.
//
// Key: SECRETS_KEY (base64, 32 bytes) or a key file: SECRETS_KEY_FILE, else `<DATA_DIR>/secrets.key`
// which is generated (32 random bytes, base64) atomically with mode 0600 when missing. The key is
// never logged and never part of an error message.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { UptimeConfig } from './config.js';

export interface SecretBox {
  /** Encrypt a string map; `aad` binds the ciphertext to its row (e.g. "monitor:<uid>"). */
  seal(data: Record<string, string>, aad: string): Buffer;
  open(blob: Buffer, aad: string): Record<string, string>;
}

export class SecretsError extends Error {
  override name = 'SecretsError';
}

const VERSION = 1;
const HEADER = 1 + 4 + 12 + 16;
const MAX_PLAINTEXT = 1024 * 1024;

function keyId(key: Buffer): Buffer {
  return createHash('sha256').update('ptr-secrets-key-id').update(key).digest().subarray(0, 4);
}

function aadBytes(aad: string): Buffer {
  if (typeof aad !== 'string' || aad.length === 0 || aad.length > 512) throw new SecretsError('invalid AAD');
  return Buffer.from(`ptr-secrets:v${VERSION}:${aad}`, 'utf8');
}

/** SecretBox for a raw 32-byte key (exported for tests and tools). */
export function createSecretBox(key: Buffer): SecretBox {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new SecretsError('secrets key must be 32 bytes');
  const k = Buffer.from(key);
  const id = keyId(k);
  return {
    seal(data, aad) {
      const clean: Record<string, string> = {};
      for (const [name, value] of Object.entries(data)) {
        if (typeof value !== 'string') throw new SecretsError('secret values must be strings');
        clean[name] = value;
      }
      const plain = Buffer.from(JSON.stringify(clean), 'utf8');
      if (plain.length > MAX_PLAINTEXT) throw new SecretsError('secrets too large');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', k, iv, { authTagLength: 16 });
      cipher.setAAD(aadBytes(aad));
      const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), id, iv, cipher.getAuthTag(), ct]);
    },
    open(blob, aad) {
      if (!((blob as unknown) instanceof Uint8Array)) throw new SecretsError('invalid secrets blob');
      const b = Buffer.from(blob);
      if (b.length < HEADER) throw new SecretsError('invalid secrets blob');
      if (b[0] !== VERSION) throw new SecretsError('unsupported secrets blob version');
      if (!timingSafeEqual(b.subarray(1, 5), id)) throw new SecretsError('secrets were encrypted with a different key (SECRETS_KEY / secrets.key changed?)');
      const iv = b.subarray(5, 17);
      const tag = b.subarray(17, 33);
      const decipher = createDecipheriv('aes-256-gcm', k, iv, { authTagLength: 16 });
      decipher.setAAD(aadBytes(aad));
      decipher.setAuthTag(tag);
      let plain: Buffer;
      try {
        plain = Buffer.concat([decipher.update(b.subarray(HEADER)), decipher.final()]);
      } catch {
        throw new SecretsError('secrets blob failed authentication (tampered or wrong row)');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(plain.toString('utf8'));
      } catch {
        throw new SecretsError('invalid secrets payload');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SecretsError('invalid secrets payload');
      const out: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'string') throw new SecretsError('invalid secrets payload');
        out[name] = value;
      }
      return { ...out };
    },
  };
}

function decodeKeyFile(raw: Buffer, file: string): Buffer {
  const text = raw.toString('utf8').trim();
  if (/^[A-Za-z0-9+/]{43}=$/.test(text)) return Buffer.from(text, 'base64');
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (raw.length === 32) return Buffer.from(raw);
  throw new SecretsError(`${file}: secrets key file must contain 32 bytes (base64 or hex)`);
}

export function checkPermissions(file: string, strict: boolean): void {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new SecretsError(`${file}: secrets key file is not a regular file`);
  if (process.platform === 'win32') return;
  const mode = st.mode & 0o777;
  const fix = `run \`chmod 600 ${file}\``;
  // Generated files must stay 0600.
  if (strict) {
    if ((mode & 0o077) !== 0) throw new SecretsError(`${file}: insecure permissions ${mode.toString(8)} — ${fix}`);
    return;
  }
  // Operator-supplied files (SECRETS_KEY_FILE): never writable by group/others, and not readable
  // by group/others either — except a root-owned 0400/0440 file (Docker / Kubernetes secret
  // mounted read-only for the service's group).
  if ((mode & 0o022) !== 0) throw new SecretsError(`${file}: insecure permissions ${mode.toString(8)} (writable by group/others) — ${fix}`);
  if ((mode & 0o044) !== 0) {
    const dockerSecret = st.uid === 0 && (mode === 0o400 || mode === 0o440);
    if (!dockerSecret) {
      throw new SecretsError(
        `${file}: secrets key file is readable by group/others (mode ${mode.toString(8)}) — ${fix} ` +
          '(Docker secrets: mount root-owned with mode 0400, or 0440 with the server in the group)',
      );
    }
  }
}

/** Creates the key file atomically (write temp file 0600 + link; never overwrites an existing key). */
function createKeyFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${randomBytes(32).toString('base64')}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    // Another process created it first: use theirs.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function loadSecretBox(config: UptimeConfig, dataDir: string): SecretBox {
  if (config.secretsKey) return createSecretBox(config.secretsKey);
  const explicit = config.secretsKeyFile !== null && config.secretsKeyFile !== undefined;
  const file = path.resolve(explicit ? config.secretsKeyFile! : path.join(dataDir, 'secrets.key'));
  if (!fs.existsSync(file)) {
    if (explicit) throw new SecretsError(`SECRETS_KEY_FILE ${file} does not exist`);
    createKeyFile(file);
  }
  checkPermissions(file, !explicit);
  return createSecretBox(decodeKeyFile(fs.readFileSync(file), file));
}
