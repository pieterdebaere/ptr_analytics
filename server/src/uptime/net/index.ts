// STUB created by the coordinator — owner: network layer. Keep the export name and signature.
import type { SafeNet } from '../types.js';
import type { UptimeConfig } from '../config.js';

export interface TargetPolicyOptions {
  config: UptimeConfig;
  /** Addresses of this server / PUBLIC_URL host: always denied (no self-targeting loops). */
  selfAddresses?: readonly string[];
  /** Stricter rules for members in hosted mode (private ranges always denied, https-only URLs …). */
  hostedMember?: boolean;
}

export function createSafeNet(_opts: TargetPolicyOptions): SafeNet {
  throw new Error('uptime/net not implemented yet');
}
