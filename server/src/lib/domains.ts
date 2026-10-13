/**
 * Site domain entries (spec 4.4): a lowercase hostname (punycode), `localhost`, or a
 * wildcard `*.example.com`.
 */

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const MAX_DOMAINS = 20;

/** Lower-case, strip trailing dot and port. Returns '' for unusable input. */
export function normalizeHostname(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

function isValidHostname(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false;
  return h.split('.').every((label) => LABEL_RE.test(label));
}

/**
 * Normalise a domain entry entered by an admin. Accepts pasted URLs
 * (`https://www.example.com/`) for convenience. Returns null when invalid.
 */
export function normalizeDomainEntry(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (s.length === 0 || s.length > 300) return null;
  if (s.includes('://')) {
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      s = u.hostname;
    } catch {
      return null;
    }
  } else {
    // allow "example.com:8080" / "example.com/" style input
    s = s.replace(/[/:].*$/, '');
  }
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s === 'localhost') return s;
  if (s.startsWith('*.')) {
    const base = s.slice(2);
    return isValidHostname(base) ? `*.${base}` : null;
  }
  return isValidHostname(s) ? s : null;
}

/** Validate & normalise a list of domain entries (1..20, deduplicated). */
export function normalizeDomainList(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_DOMAINS) return null;
  const out: string[] = [];
  for (const d of input) {
    const n = normalizeDomainEntry(d);
    if (n === null) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Does `hostname` (already normalised) match one domain entry? */
export function domainMatches(entry: string, hostname: string): boolean {
  if (entry.startsWith('*.')) {
    const base = entry.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === entry || hostname === `www.${entry}`;
}

export function hostnameAllowed(domains: readonly string[], rawHostname: string): boolean {
  const h = normalizeHostname(rawHostname);
  if (h === '') return false;
  return domains.some((d) => domainMatches(d, h));
}
