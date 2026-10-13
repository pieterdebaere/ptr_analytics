// Helpers that guard against open redirects and unsafe links built from
// attacker-controlled analytics values.

/**
 * Validates a post-login redirect target. Only same-origin relative paths are
 * accepted: must start with a single "/", no "//" or "/\" prefix, no
 * backslashes, no control characters or whitespace. Returns null if unsafe.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (typeof next !== 'string' || next.length === 0 || next.length > 2048) return null;
  if (next[0] !== '/') return null;
  if (next[1] === '/' || next[1] === '\\') return null;
  if (next.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(next)) return null;
  try {
    const base = 'https://dashboard.invalid';
    const url = new URL(next, base);
    if (url.origin !== base) return null;
    const path = url.pathname + url.search + url.hash;
    if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return '/';
    return path;
  } catch {
    return null;
  }
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
