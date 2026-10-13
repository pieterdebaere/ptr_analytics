/**
 * Control (Cc), format (Cf, e.g. bidi overrides and zero-width characters) and lone
 * surrogate (Cs) code points. They are never legitimate in names/keys and can be used to
 * spoof what the dashboard or an exported CSV displays.
 */
export const UNSAFE_CHARS_RE = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const UNSAFE_CHARS_GLOBAL_RE = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

export function hasUnsafeChars(s: string): boolean {
  return UNSAFE_CHARS_RE.test(s);
}

export function stripUnsafeChars(s: string): string {
  return s.replace(UNSAFE_CHARS_GLOBAL_RE, '');
}

/** Truncate to at most `max` UTF-16 code units without splitting a surrogate pair. */
export function truncateCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return s.slice(0, end);
}

/** Strip unsafe characters, then truncate on a code point boundary. */
export function cleanText(s: string, max: number): string {
  return truncateCodePoints(stripUnsafeChars(s), max);
}
