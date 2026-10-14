// Redaction of delivery errors before they are stored (notify_log) or returned (test sends).
// Errors may contain request URLs with tokens (/bot<token>/, Slack/Discord webhook paths,
// ?token=), Authorization values or secrets echoed back by a receiver.
import { cleanText } from '../../lib/text.js';

export const MAX_ERROR_CHARS = 300;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every string worth hiding from a channel's secrets (JSON values are unpacked). */
export function secretValues(secrets: Record<string, string> | null | undefined): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.length >= 4) out.add(v);
      // URLs: also their path/query parts (tokens), in case the host is printed separately.
      try {
        const u = new URL(v);
        if (u.pathname.length > 8) out.add(u.pathname);
        for (const seg of u.pathname.split('/')) if (seg.length >= 16 || (seg.length >= 8 && /\d/.test(seg))) out.add(seg);
        if (u.search.length > 4) out.add(u.search.slice(1));
        if (u.password) out.add(decodeURIComponent(u.password));
      } catch {
        /* not a URL */
      }
    } else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(add);
  };
  for (const v of Object.values(secrets ?? {})) {
    add(v);
    if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
      try {
        add(JSON.parse(v));
      } catch {
        /* plain string */
      }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
  }
  return 'unknown error';
}

/**
 * Redacted, single-line, ≤ 300 characters. URLs are reduced to `scheme://host/…`, known secret
 * values and token-like strings are replaced by `[redacted]`.
 */
export function redactError(err: unknown, secrets: readonly string[] = []): string {
  let s = errorText(err);
  for (const v of secrets) {
    if (!v) continue;
    s = s.replace(new RegExp(escapeRe(v), 'g'), '[redacted]');
    const enc = encodeURIComponent(v);
    if (enc !== v) s = s.replace(new RegExp(escapeRe(enc), 'g'), '[redacted]');
  }
  s = s
    // URLs: keep scheme + host only (no userinfo, path or query).
    .replace(/\b([a-z][a-z0-9+.-]{1,15}):\/\/(?:[^\s/@"'<>]*@)?([^\s/?#"'<>]+)[^\s"'<>]*/gi, (_m, scheme: string, host: string) => `${scheme}://${host}/…`)
    // Telegram bot tokens, bearer/basic credentials, key=value tokens.
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/\b(Bearer|Basic|GenieKey|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]')
    .replace(/\b(token|key|apikey|api_key|access_token|secret|password|sig|signature)=([^\s&"']+)/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ');
  return cleanText(s, MAX_ERROR_CHARS).trim() || 'delivery failed';
}
