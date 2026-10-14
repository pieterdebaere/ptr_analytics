// STUB created by the coordinator — owner: network layer & secrets. Keep the export names.
// AES-256-GCM envelope for secrets at rest (monitor credentials, notification tokens, TOTP secrets).
import type { UptimeConfig } from './config.js';

export interface SecretBox {
  /** Encrypt a string map; `aad` binds the ciphertext to its row (e.g. "monitor:<uid>"). */
  seal(data: Record<string, string>, aad: string): Buffer;
  open(blob: Buffer, aad: string): Record<string, string>;
}

export function loadSecretBox(_config: UptimeConfig, _dataDir: string): SecretBox {
  throw new Error('secrets not implemented yet');
}
