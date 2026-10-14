// Helpers that guard against open redirects and unsafe links built from
// attacker-controlled analytics values.

/**
 * Validates a post-login redirect target. Only same-origin relative paths are
 * accepted: must start with a single "/", no "//" or "/\" prefix, no
 * backslashes, no control characters or whitespace. The path part (before
 * "?" / "#") must not contain dot segments or encoded ".", "/" or "\"
 * (`%2e`, `%2f`, `%5c`), because URL normalisation could otherwise turn e.g.
 * "/.//evil.example" into the protocol-relative "//evil.example". The
 * normalised output is validated again. Returns null if unsafe.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (typeof next !== 'string' || next.length === 0 || next.length > 2048) return null;
  if (!isSingleSlashPath(next)) return null;
  if (next.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(next)) return null;
  const rawPath = next.split(/[?#]/, 1)[0] ?? '';
  if (/%(?:2e|2f|5c)/i.test(rawPath)) return null;
  if (rawPath.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  try {
    const base = 'https://dashboard.invalid';
    const url = new URL(next, base);
    if (url.origin !== base) return null;
    if (!isSingleSlashPath(url.pathname)) return null;
    if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return '/';
    const path = url.pathname + url.search + url.hash;
    if (!isSingleSlashPath(path)) return null;
    return path;
  } catch {
    return null;
  }
}

/** Starts with exactly one "/" that is not followed by another "/" or "\". */
function isSingleSlashPath(p: string): boolean {
  return p[0] === '/' && p[1] !== '/' && p[1] !== '\\';
}

/** URL of the login page that returns to `currentPath` afterwards. */
export function loginUrl(currentPath: string | null | undefined): string {
  const next = safeNextPath(currentPath);
  if (!next || next === '/') return '/login';
  return `/login?next=${encodeURIComponent(next)}`;
}

const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const TLD = '(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})';
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+${TLD}$`);

/**
 * Strict public hostname check (lowercase ASCII / punycode labels, at least
 * two labels, alphabetic or punycode TLD). IP literals, localhost, ports and
 * anything with other characters are rejected.
 */
export function isSafeHostname(value: unknown): value is string {
  return typeof value === 'string' && HOSTNAME_RE.test(value);
}

/** https://<host> for a referrer hostname, or null when the value is not safe. */
export function referrerHref(host: string | null | undefined): string | null {
  if (!isSafeHostname(host)) return null;
  return `https://${host}/`;
}

/**
 * https://<hostname><path> for a page, or null when either part is not safe.
 * The path must start with a single "/" and contain no whitespace, control
 * characters or backslashes.
 */
export function pageHref(hostname: string | null | undefined, path: string | null | undefined): string | null {
  if (!isSafeHostname(hostname)) return null;
  if (typeof path !== 'string' || path.length > 2048) return null;
  if (path[0] !== '/' || path[1] === '/' || path.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(path)) return null;
  try {
    const url = new URL(`https://${hostname}${path}`);
    if (url.protocol !== 'https:' || url.hostname !== hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * True when `host` is a safe public hostname that belongs to one of the site's
 * configured domains: an exact match, the `www.` variant of a domain (either
 * way round), or for a wildcard `*.base` the base itself or any subdomain of it.
 */
export function hostMatchesDomains(host: string | null | undefined, domains: readonly string[]): host is string {
  if (!isSafeHostname(host)) return false;
  for (const raw of domains) {
    if (typeof raw !== 'string') continue;
    const d = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!d) continue;
    if (d.startsWith('*.')) {
      const base = d.slice(2);
      if (base && (host === base || host.endsWith(`.${base}`))) return true;
      continue;
    }
    if (host === d || host === `www.${d}` || (d.startsWith('www.') && host === d.slice(4))) return true;
  }
  return false;
}

// C0 controls, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// Explicit bidi embeddings/overrides/isolates (LRE, RLE, PDF, LRO, RLO, LRI,
// RLI, FSI, PDI): they can reorder the surrounding text (Trojan-Source style).
const BIDI_CONTROL_RE = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * Makes an untrusted string safe to display: control characters and explicit
 * bidi formatting characters are replaced by U+FFFD so that they are visible
 * and cannot reorder neighbouring text. Rendered elements should additionally
 * be bidi-isolated (`<bdi>` / `unicode-bidi: isolate`).
 */
export function displayText(value: string): string {
  return value.replace(CONTROL_RE, '\ufffd').replace(BIDI_CONTROL_RE, '\ufffd');
}

/**
 * Normalises user input for a site domain: lowercases, strips scheme, path,
 * port and trailing dot. Returns null when the result is not an allowed entry
 * (hostname, `localhost`, or wildcard `*.example.com`).
 */
export function normalizeDomain(input: string): string | null {
  let v = input.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.split(/[/?#]/, 1)[0] ?? '';
  v = v.replace(/:\d+$/, '').replace(/\.$/, '');
  if (v === 'localhost') return v;
  const wildcard = v.startsWith('*.');
  const host = wildcard ? v.slice(2) : v;
  const re = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+${LABEL}$`);
  if (!re.test(host)) return null;
  return wildcard ? `*.${host}` : host;
}

// Characters that never appear in a plain address but do in display-name forms
// ("Name <a@b.c>", comments, quoted local parts, lists).
const EMAIL_FORBIDDEN = /[\s<>()",;:[\]\\]/;

/**
 * Plain e-mail address check for sign-up / reset forms: exactly one "@", a
 * dotted domain, no whitespace or display-name syntax, at most 254 chars.
 */
export function isPlainEmail(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 254) return false;
  if (EMAIL_FORBIDDEN.test(value)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  return /^[^.]+(\.[^.]+)+$/.test(domain);
}
