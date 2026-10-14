// Target policy of the SSRF guard (docs/uptime/ANALYSIS.md §8.7.1). Pure and synchronous so that
// it can also be used at save time (validate) for IP literals.
import { domainToASCII } from 'node:url';
import type { UptimeConfig } from '../config.js';
import { TargetDeniedError } from '../types.js';
import { classifyIp, embeddedIPv4, inCidr, parseCidr, parseIp, type Cidr, type IpCategory, type ParsedIp } from './ip.js';

export interface PolicySettings {
  config: Pick<UptimeConfig, 'privateTargets' | 'allowMetadata' | 'targetAllowlist' | 'targetDenylist'>;
  selfAddresses?: readonly string[];
  hostedMember?: boolean;
}

/** Hostnames of cloud metadata services (denied like the metadata addresses). */
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.tencentyun.com',
  'metadata.platformequinix.com',
  'metadata.azure.internal',
]);

const HOST_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

/**
 * Normalises a DNS hostname (lower case, no trailing dot) and validates it as LDH (+ `_` for
 * service names). Rejects anything a libc resolver might interpret as a numeric address
 * (`127.1`, `0x7f000001`, `2130706433`). Returns null when invalid. IP literals are NOT
 * accepted here (use parseIp).
 */
export function normalizeHostname(input: string): string | null {
  let h = input.trim().toLowerCase();
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(h)) {
    h = domainToASCII(h); // IDN → punycode ("" when invalid)
    if (!h) return null;
  }
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.length === 0 || h.length > 253) return null;
  const labels = h.split('.');
  if (!labels.every((l) => HOST_LABEL.test(l))) return null;
  const last = labels[labels.length - 1]!;
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return null;
  return h;
}

/** Host of a non-URL monitor field: IP literal (normalised) or LDH hostname. Null when invalid. */
export function normalizeHost(input: string): { host: string; ip: ParsedIp | null } | null {
  const ip = parseIp(input.trim());
  if (ip) {
    const s = input.trim();
    return { host: s.startsWith('[') ? s.slice(1, -1).toLowerCase() : s.toLowerCase(), ip };
  }
  const h = normalizeHostname(input);
  return h ? { host: h, ip: null } : null;
}

export function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

interface HostRule {
  exact: string | null;
  suffix: string | null;
}

function hostRules(list: readonly string[]): { cidrs: Cidr[]; hosts: HostRule[] } {
  const cidrs: Cidr[] = [];
  const hosts: HostRule[] = [];
  for (const raw of list) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const c = parseCidr(entry);
    if (c) {
      cidrs.push(c);
      continue;
    }
    if (entry.startsWith('*.')) {
      const h = normalizeHostname(entry.slice(2));
      if (h) hosts.push({ exact: null, suffix: `.${h}` });
    } else {
      const h = normalizeHostname(entry);
      if (h) hosts.push({ exact: h, suffix: null });
    }
  }
  return { cidrs, hosts };
}

function hostMatches(rules: HostRule[], host: string): boolean {
  return rules.some((r) => (r.exact !== null && r.exact === host) || (r.suffix !== null && host.endsWith(r.suffix)));
}

export type PolicyDecision = { ok: true; category: IpCategory } | { ok: false; category: IpCategory | null; reason: string };

/**
 * Decision order for an address:
 *  1. deny list (CIDR, also matched against an embedded IPv4) and the server's own addresses → deny
 *  2. unspecified / broadcast / multicast / reserved → deny (always)
 *  3. allow list (CIDR) → allow
 *  4. link-local + cloud metadata → allow only with UPTIME_ALLOW_METADATA (never for hosted members)
 *  5. private / loopback / CGNAT / ULA and special-purpose ranges → hosted members: deny; a hostname
 *     on the allow list: allow; otherwise UPTIME_PRIVATE_TARGETS
 *  6. public → allow
 */
export class TargetPolicy {
  private readonly allow: { cidrs: Cidr[]; hosts: HostRule[] };
  private readonly deny: { cidrs: Cidr[]; hosts: HostRule[] };
  private readonly self: { cidrs: Cidr[]; hosts: HostRule[] };
  readonly hostedMember: boolean;
  private readonly privateAllowed: boolean;
  private readonly metadataAllowed: boolean;

  constructor(settings: PolicySettings) {
    this.hostedMember = settings.hostedMember === true;
    this.allow = hostRules(settings.config.targetAllowlist);
    this.deny = hostRules(settings.config.targetDenylist);
    this.self = hostRules(settings.selfAddresses ?? []);
    this.privateAllowed = !this.hostedMember && settings.config.privateTargets === 'allow';
    this.metadataAllowed = !this.hostedMember && settings.config.allowMetadata;
  }

  /** Checks a hostname before resolution. Returns whether it is on the allow list. */
  checkHostname(host: string): { ok: true; allowlisted: boolean } | { ok: false; reason: string } {
    const h = host.toLowerCase().replace(/\.$/, '');
    if (hostMatches(this.deny.hosts, h)) return { ok: false, reason: 'denylist' };
    if (hostMatches(this.self.hosts, h)) return { ok: false, reason: 'self' };
    const allowlisted = hostMatches(this.allow.hosts, h);
    if (METADATA_HOSTS.has(h) && !this.metadataAllowed && !allowlisted) return { ok: false, reason: 'metadata' };
    if (this.hostedMember && isLocalhostName(h) && !allowlisted) return { ok: false, reason: 'private' };
    return { ok: true, allowlisted };
  }

  checkIp(ip: ParsedIp, opts: { hostAllowlisted?: boolean } = {}): PolicyDecision {
    const embedded = embeddedIPv4(ip);
    const matchAny = (list: Cidr[]): boolean => list.some((c) => inCidr(ip, c) || (embedded !== null && inCidr(embedded, c)));
    if (matchAny(this.deny.cidrs)) return { ok: false, category: null, reason: 'denylist' };
    if (matchAny(this.self.cidrs)) return { ok: false, category: null, reason: 'self' };
    const category = classifyIp(ip);
    switch (category) {
      case 'unspecified':
      case 'broadcast':
      case 'multicast':
      case 'reserved':
        return { ok: false, category, reason: category };
      default:
        break;
    }
    if (matchAny(this.allow.cidrs)) return { ok: true, category };
    if (category === 'metadata') return this.metadataAllowed ? { ok: true, category } : { ok: false, category, reason: 'metadata' };
    if (category === 'private' || category === 'special') {
      if (this.hostedMember) return { ok: false, category, reason: 'private' };
      if (opts.hostAllowlisted || this.privateAllowed) return { ok: true, category };
      return { ok: false, category, reason: 'private' };
    }
    return { ok: true, category };
  }

  /** Throws TargetDeniedError (generic message: no oracle about the reason). */
  assertIp(address: string, opts: { hostAllowlisted?: boolean } = {}): ParsedIp {
    const ip = parseIp(address);
    if (!ip) throw new TargetDeniedError('target not allowed');
    const d = this.checkIp(ip, opts);
    if (!d.ok) throw new TargetDeniedError('target not allowed');
    return ip;
  }
}
