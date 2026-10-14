/**
 * Site domain entries (spec 4.4): a lowercase hostname (punycode), `localhost`, or a
 * wildcard `*.example.com`. Bare IP addresses and wildcards over a single label
 * (`*.com`, which would accept every site on a TLD) are rejected.
 */

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const MAX_DOMAINS = 20;

/** Lower-case, strip trailing dot and port. Returns '' for unusable input. */
export function normalizeHostname(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * A last label that is numeric (decimal or 0x-hex) makes the WHATWG URL parser treat the
 * whole host as an IPv4 address (`127.0.0.1`, `0x7f.1`, `2130706433`), so such entries are
 * not domain names.
 */
const NUMERIC_LABEL_RE = /^(?:\d+|0x[0-9a-f]*)$/;

function isValidHostname(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false;
  const labels = h.split('.');
  if (!labels.every((label) => LABEL_RE.test(label))) return false;
  return !NUMERIC_LABEL_RE.test(labels[labels.length - 1] as string);
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
    const m = /^([^/:]+)(?::\d{1,5})?(?:\/.*)?$/.exec(s);
    if (!m) return null;
    s = m[1] as string;
  }
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s === 'localhost') return s;
  if (s.startsWith('*.')) {
    const base = s.slice(2);
    // At least two labels: `*.com` / `*.localhost` would match far too much.
    return isValidHostname(base) && base.includes('.') ? `*.${base}` : null;
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

/** Domain entries per site for self-service members (hosted mode). */
export const MEMBER_MAX_DOMAINS = 5;

/**
 * Shared hosting suffixes where every subdomain belongs to a different customer: a wildcard
 * over one of them would let a member collect (or spoof) analytics for everybody's sites.
 */
export const SHARED_HOSTING_SUFFIXES: ReadonlySet<string> = new Set([
  'github.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'herokuapp.com',
  'web.app',
  'firebaseapp.com',
  'onrender.com',
  'fly.dev',
  'azurewebsites.net',
  'cloudfront.net',
  'appspot.com',
]);

/**
 * Extra rules for domains entered by members (admins are unaffected): at most
 * MEMBER_MAX_DOMAINS entries and no wildcard directly over a shared hosting suffix.
 * Returns an error message, or null when the (normalised) list is acceptable.
 */
export function memberDomainProblem(domains: readonly string[]): string | null {
  if (domains.length > MEMBER_MAX_DOMAINS) return `a site can have at most ${MEMBER_MAX_DOMAINS} domains`;
  for (const d of domains) {
    if (d.startsWith('*.') && SHARED_HOSTING_SUFFIXES.has(d.slice(2))) {
      return `wildcards over shared hosting domains (${d}) are not allowed; add your own subdomain instead`;
    }
  }
  return null;
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
