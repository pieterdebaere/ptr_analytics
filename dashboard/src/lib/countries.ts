// Country display helpers. Values are untrusted: only valid ISO codes get a flag.

const ISO_RE = /^[A-Z]{2}$/;

/** "BE" -> 🇧🇪 ; anything that is not two A-Z letters -> "" */
export function flagEmoji(code: string | null | undefined): string {
  if (typeof code !== 'string') return '';
  const c = code.toUpperCase();
  if (!ISO_RE.test(c)) return '';
  const base = 0x1f1e6 - 65;
  return String.fromCodePoint(base + c.charCodeAt(0), base + c.charCodeAt(1));
}

const namesCache = new Map<string, Intl.DisplayNames | null>();
function displayNames(locale?: string): Intl.DisplayNames | null {
  const key = locale ?? '';
  if (!namesCache.has(key)) {
    try {
      namesCache.set(key, new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'region', fallback: 'code' }));
    } catch {
      namesCache.set(key, null);
    }
  }
  return namesCache.get(key) ?? null;
}

/** Localized country name; falls back to the code; null/empty -> "Unknown". */
export function countryName(code: string | null | undefined, locale?: string): string {
  if (code === null || code === undefined || code === '') return 'Unknown';
  const c = code.toUpperCase();
  if (!ISO_RE.test(c)) return code;
  try {
    return displayNames(locale)?.of(c) ?? c;
  } catch {
    return c;
  }
}
