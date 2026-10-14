import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecretBox, loadSecretBox, SecretsError } from '../src/uptime/secrets.js';
import { uptimeConfig } from './uptime-net-fixtures.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pa-secrets-'));
}

describe('SecretBox', () => {
  const box = createSecretBox(randomBytes(32));

  it('round-trips string maps with a fresh IV per seal', () => {
    const data = { password: 'hunter2', 'secretHeaders.X-Api-Key': 'k€y', empty: '' };
    const a = box.seal(data, 'monitor:abc');
    const b = box.seal(data, 'monitor:abc');
    expect(a.equals(b)).toBe(false);
    expect(a[0]).toBe(1);
    expect(a.includes(Buffer.from('hunter2'))).toBe(false);
    expect(box.open(a, 'monitor:abc')).toEqual(data);
    expect(box.open(b, 'monitor:abc')).toEqual(data);
  });

  it('fails on wrong AAD, tampering, wrong key and bad versions', () => {
    const blob = box.seal({ token: 'x' }, 'channel:1');
    expect(() => box.open(blob, 'channel:2')).toThrow(SecretsError);
    for (const i of [0, 3, 10, 20, blob.length - 1]) {
      const t = Buffer.from(blob);
      t[i] = t[i]! ^ 0x01;
      expect(() => box.open(t, 'channel:1'), `byte ${i}`).toThrow(SecretsError);
    }
    expect(() => box.open(blob.subarray(0, 20), 'channel:1')).toThrow(SecretsError);
    expect(() => createSecretBox(randomBytes(32)).open(blob, 'channel:1')).toThrow(/different key/);
    expect(() => createSecretBox(randomBytes(16))).toThrow(SecretsError);
    expect(() => box.seal({ a: 1 as unknown as string }, 'x')).toThrow(SecretsError);
    expect(() => box.seal({}, '')).toThrow(SecretsError);
  });
});

describe('loadSecretBox', () => {
  it('uses SECRETS_KEY when set (no file is created)', () => {
    const dir = tmp();
    const key = randomBytes(32).toString('base64');
    const box = loadSecretBox(uptimeConfig({ SECRETS_KEY: key }), dir);
    const again = loadSecretBox(uptimeConfig({ SECRETS_KEY: key }), dir);
    expect(again.open(box.seal({ a: 'b' }, 'x:1'), 'x:1')).toEqual({ a: 'b' });
    expect(fs.existsSync(path.join(dir, 'secrets.key'))).toBe(false);
  });

  it('generates <dataDir>/secrets.key with mode 0600 once and reuses it', () => {
    const dir = path.join(tmp(), 'data');
    const box = loadSecretBox(uptimeConfig(), dir);
    const file = path.join(dir, 'secrets.key');
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const content = fs.readFileSync(file, 'utf8');
    expect(content.trim()).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    const blob = box.seal({ k: 'v' }, 'monitor:1');
    const box2 = loadSecretBox(uptimeConfig(), dir);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(box2.open(blob, 'monitor:1')).toEqual({ k: 'v' });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('refuses a generated key file with loose permissions', () => {
    const dir = tmp();
    loadSecretBox(uptimeConfig(), dir);
    fs.chmodSync(path.join(dir, 'secrets.key'), 0o644);
    expect(() => loadSecretBox(uptimeConfig(), dir)).toThrow(/insecure permissions/);
  });

  it('reads SECRETS_KEY_FILE (base64 or hex), never creates it, rejects writable or malformed files', () => {
    const dir = tmp();
    const file = path.join(dir, 'key');
    const key = randomBytes(32);
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o400 });
    const box = loadSecretBox(uptimeConfig({ SECRETS_KEY_FILE: file }), '/nonexistent');
    expect(createSecretBox(key).open(box.seal({ a: 'b' }, 'x:1'), 'x:1')).toEqual({ a: 'b' });
    expect(() => loadSecretBox(uptimeConfig({ SECRETS_KEY_FILE: path.join(dir, 'missing') }), dir)).toThrow(/does not exist/);
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o666);
      expect(() => loadSecretBox(uptimeConfig({ SECRETS_KEY_FILE: file }), dir)).toThrow(/insecure permissions/);
      fs.chmodSync(file, 0o600);
      expect(() => loadSecretBox(uptimeConfig({ SECRETS_KEY_FILE: file }), dir)).not.toThrow();
    }
    const bad = path.join(dir, 'bad');
    fs.writeFileSync(bad, 'too short', { mode: 0o600 });
    let msg = '';
    try {
      loadSecretBox(uptimeConfig({ SECRETS_KEY_FILE: bad }), dir);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/32 bytes/);
    expect(msg).not.toContain('too short');
  });

  it.skipIf(process.platform === 'win32')('refuses a group/other-readable SECRETS_KEY_FILE unless it is a root-owned 0400/0440 secret (L6)', () => {
    const dir = tmp();
    const file = path.join(dir, 'key');
    fs.writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    const load = (): unknown => loadSecretBox(uptimeConfig({ SECRETS_KEY_FILE: file }), dir);
    for (const mode of [0o644, 0o640, 0o604, 0o444]) {
      fs.chmodSync(file, mode);
      expect(load, mode.toString(8)).toThrow(/readable by group\/others/);
    }
    for (const mode of [0o600, 0o400]) {
      fs.chmodSync(file, mode);
      expect(load, mode.toString(8)).not.toThrow();
    }
    fs.chmodSync(file, 0o440);
    const owner = fs.statSync(file).uid;
    if (owner === 0) {
      // Root-owned 0440 (Docker secret readable by the service's group) is accepted …
      expect(load).not.toThrow();
      // … but not when owned by another user.
      fs.chownSync(file, 1000, 1000);
      expect(load).toThrow(/readable by group\/others/);
    } else {
      expect(load).toThrow(/readable by group\/others/);
    }
    // The generated key file stays strict (0600).
    const gen = tmp();
    loadSecretBox(uptimeConfig(), gen);
    fs.chmodSync(path.join(gen, 'secrets.key'), 0o400);
    expect(() => loadSecretBox(uptimeConfig(), gen)).not.toThrow();
    fs.chmodSync(path.join(gen, 'secrets.key'), 0o440);
    expect(() => loadSecretBox(uptimeConfig(), gen)).toThrow(/insecure permissions/);
  });
});
