// Strict IP address parsing, formatting, CIDR matching and classification for the SSRF guard
// (docs/uptime/ANALYSIS.md §8.7.1). Pure functions, no I/O.
import { isIPv4, isIPv6 } from 'node:net';

export interface ParsedIp {
  family: 4 | 6;
  /** 32-bit (IPv4) or 128-bit (IPv6) value. */
  value: bigint;
}

export interface Cidr {
  family: 4 | 6;
  base: bigint;
  bits: number;
}

/**
 * Parses an IP literal strictly: dotted-quad decimal IPv4 without leading zeros (no `127.1`,
 * `0x7f.0.0.1`, `0177.0.0.1`, `2130706433`) or an IPv6 address without zone id. Brackets
 * (`[::1]`) are accepted for IPv6. Returns null for anything else.
 */
export function parseIp(input: string): ParsedIp | null {
  let s = input;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.length === 0 || s.length > 45) return null;
  if (isIPv4(s)) {
    const parts = s.split('.');
    let v = 0n;
    for (const p of parts) v = (v << 8n) | BigInt(Number(p));
    return { family: 4, value: v };
  }
  if (s.includes('%') || !isIPv6(s)) return null;
  return { family: 6, value: parseIPv6(s) };
}

function parseIPv6(s: string): bigint {
  // Validated by isIPv6 already. Replace a trailing dotted IPv4 by two hex groups, expand '::'.
  let str = s.toLowerCase();
  const lastColon = str.lastIndexOf(':');
  const after = str.slice(lastColon + 1);
  if (after.includes('.')) {
    const p = after.split('.').map(Number);
    const hi = (((p[0] ?? 0) << 8) | (p[1] ?? 0)).toString(16);
    const lo = (((p[2] ?? 0) << 8) | (p[3] ?? 0)).toString(16);
    str = `${str.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const parseGroup = (g: string): number[] => (g === '' ? [] : g.split(':').map((h) => parseInt(h, 16)));
  let words: number[];
  const dbl = str.indexOf('::');
  if (dbl >= 0) {
    const head = parseGroup(str.slice(0, dbl));
    const rest = parseGroup(str.slice(dbl + 2));
    const fill = Math.max(0, 8 - head.length - rest.length);
    words = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    words = parseGroup(str);
  }
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 16n) | BigInt(words[i] ?? 0);
  return v;
}

export function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) {
    const v = Number(ip.value);
    return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
  }
  const words: number[] = [];
  for (let i = 7; i >= 0; i--) words.push(Number((ip.value >> BigInt(i * 16)) & 0xffffn));
  // RFC 5952: compress the longest run (≥ 2) of zero words.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = words.map((w) => w.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/** Canonical text of an IP literal, or null when it is not a strict IP literal. */
export function normalizeIp(input: string): string | null {
  const p = parseIp(input);
  return p ? formatIp(p) : null;
}

export function ipFromBytes(buf: Uint8Array): ParsedIp | null {
  if (buf.length !== 4 && buf.length !== 16) return null;
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  return { family: buf.length === 4 ? 4 : 6, value: v };
}

export function parseCidr(input: string): Cidr | null {
  const [addr, bitsRaw, extra] = input.split('/');
  if (addr === undefined || extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  let bits = max;
  if (bitsRaw !== undefined) {
    if (!/^\d{1,3}$/.test(bitsRaw)) return null;
    bits = Number(bitsRaw);
    if (bits > max) return null;
  }
  const shift = BigInt(max - bits);
  return { family: ip.family, base: (ip.value >> shift) << shift, bits };
}

export function inCidr(ip: ParsedIp, c: Cidr): boolean {
  if (ip.family !== c.family) return false;
  const shift = BigInt((ip.family === 4 ? 32 : 128) - c.bits);
  return ip.value >> shift === c.base >> shift;
}

function cidrs(list: string[]): Cidr[] {
  return list.map((s) => {
    const c = parseCidr(s);
    if (!c) throw new Error(`invalid built-in CIDR ${s}`);
    return c;
  });
}

/**
 * Address categories:
 *  - unspecified, broadcast, multicast, reserved: never a valid destination
 *  - metadata: link-local and cloud metadata endpoints (UPTIME_ALLOW_METADATA)
 *  - private: RFC 1918, loopback, CGNAT, ULA, site-local (UPTIME_PRIVATE_TARGETS)
 *  - special: documentation / benchmarking / protocol assignments (denied with the private ranges)
 *  - public
 */
export type IpCategory = 'unspecified' | 'broadcast' | 'multicast' | 'reserved' | 'metadata' | 'private' | 'special' | 'public';

const V4: Array<[IpCategory, Cidr[]]> = [
  ['unspecified', cidrs(['0.0.0.0/8'])],
  ['broadcast', cidrs(['255.255.255.255/32'])],
  ['multicast', cidrs(['224.0.0.0/4'])],
  ['reserved', cidrs(['240.0.0.0/4'])],
  // AWS/GCP/Azure/OpenStack 169.254.169.254, ECS 169.254.170.2, Alibaba 100.100.100.200, Oracle 192.0.0.192
  ['metadata', cidrs(['169.254.0.0/16', '100.100.100.200/32', '192.0.0.192/32'])],
  ['private', cidrs(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '100.64.0.0/10'])],
  ['special', cidrs(['192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24'])],
];

const V6: Array<[IpCategory, Cidr[]]> = [
  ['unspecified', cidrs(['::/128'])],
  ['private', cidrs(['::1/128'])],
  ['multicast', cidrs(['ff00::/8'])],
  ['metadata', cidrs(['fd00:ec2::254/128', 'fe80::/10'])],
  ['private', cidrs(['fc00::/7', 'fec0::/10'])],
  ['special', cidrs(['64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32', '3fff::/20', '5f00::/16'])],
];

const V6_GLOBAL = cidrs(['2000::/3'])[0]!;
const MAPPED = cidrs(['::ffff:0:0/96'])[0]!;
const TRANSLATED = cidrs(['::ffff:0:0:0/96'])[0]!;
const COMPAT = cidrs(['::/96'])[0]!;
const NAT64 = cidrs(['64:ff9b::/96'])[0]!;
const SIX_TO_FOUR = cidrs(['2002::/16'])[0]!;
const TEREDO = cidrs(['2001::/32'])[0]!;

/**
 * IPv4 address embedded in an IPv6 address: IPv4-mapped (`::ffff:a.b.c.d`), IPv4-translated,
 * IPv4-compatible (`::a.b.c.d`, deprecated), NAT64 (`64:ff9b::/96`), 6to4 (`2002:AABB:CCDD::/48`)
 * and Teredo (`2001:0::/32`, client address obfuscated in the last 32 bits).
 */
export function embeddedIPv4(ip: ParsedIp): ParsedIp | null {
  if (ip.family !== 6) return null;
  const low32 = ip.value & 0xffffffffn;
  if (inCidr(ip, MAPPED) || inCidr(ip, TRANSLATED) || inCidr(ip, NAT64)) return { family: 4, value: low32 };
  if (inCidr(ip, COMPAT)) {
    // :: and ::1 are not embeddings.
    if (ip.value <= 1n) return null;
    return { family: 4, value: low32 };
  }
  if (inCidr(ip, SIX_TO_FOUR)) return { family: 4, value: (ip.value >> 80n) & 0xffffffffn };
  if (inCidr(ip, TEREDO)) return { family: 4, value: low32 ^ 0xffffffffn };
  return null;
}

export function classifyIp(ip: ParsedIp): IpCategory {
  const embedded = embeddedIPv4(ip);
  if (embedded) return classifyIp(embedded);
  if (ip.family === 4) {
    for (const [cat, list] of V4) if (list.some((c) => inCidr(ip, c))) return cat;
    return 'public';
  }
  for (const [cat, list] of V6) if (list.some((c) => inCidr(ip, c))) return cat;
  if (!inCidr(ip, V6_GLOBAL)) return 'reserved';
  return 'public';
}
