import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/** Used when no valid client address can be determined (all such requests share one bucket). */
export const UNKNOWN_IP = 'unknown';

/** Expand an IPv6 address (optionally with an embedded IPv4 tail) to 8 16-bit groups. */
function expandIPv6(ip: string): number[] | null {
  let s = ip;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // Embedded dotted IPv4 tail (e.g. ::ffff:1.2.3.4, 64:ff9b::1.2.3.4) -> two groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const o = tail.split('.').map(Number) as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const head = parse(halves[0] as string);
  let groups: number[];
  if (halves.length === 2) {
    const rest = parse(halves[1] as string);
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/**
 * Normalise a textual IP address: IPv4 as-is, IPv4-mapped IPv6 (`::ffff:1.2.3.4`) to IPv4,
 * other IPv6 to a canonical lowercase, fully expanded form (no zone id) so different
 * spellings of the same address are treated identically. Returns null when invalid.
 */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const version = isIP(raw);
  if (version === 4) return raw;
  if (version !== 6) return null;
  const g = expandIPv6(raw);
  if (!g) return null;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const hi = g[6] as number;
    const lo = g[7] as number;
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return g.map((x) => x.toString(16)).join(':');
}

/**
 * The client address for a request: `request.ip` (which honours TRUST_PROXY) when it is a
 * syntactically valid IP, otherwise the socket peer address. Never parse X-Forwarded-For here.
 * Use the full address for the visitor hash / GeoIP; use `rateLimitKey()` for rate limits.
 */
export function clientIp(request: FastifyRequest): string {
  const fromProxy = normalizeIp(request.ip);
  if (fromProxy !== null) return fromProxy;
  return normalizeIp(request.socket?.remoteAddress) ?? UNKNOWN_IP;
}

/**
 * Rate-limit bucket for a normalised client IP: IPv4 as-is, IPv6 by /64 prefix (a single
 * subscriber usually controls a whole /64, so per-address limits would be trivial to evade).
 */
export function rateLimitKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const g = expandIPv6(ip);
  if (!g) return ip;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * Wider bucket for abuse-prone endpoints (sign-up): the IPv6 /48 a site or small ISP
 * customer typically gets, so rotating through /64s does not multiply the limit. Null for
 * IPv4 (the per-address bucket of `rateLimitKey()` already applies).
 */
export function rateLimitKey48(ip: string): string | null {
  if (isIP(ip) !== 6) return null;
  const g = expandIPv6(ip);
  if (!g) return null;
  return `${g.slice(0, 3).map((x) => x.toString(16)).join(':')}::/48`;
}
