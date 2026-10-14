// Shared, data-driven validation for notification providers: every provider declares its
// FieldDefs, `validateFields` normalises the input from them (types, defaults, limits, secret
// routing, write-only secret semantics, hosted-mode rules) and the provider adds its own checks.
import { isIP } from 'node:net';
import { isValidEmail } from '../../../config.js';
import { hasUnsafeChars } from '../../../lib/text.js';
import { ValidationError, type FieldDef, type ProviderDefinition, type ValidateContext } from '../../types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProvider = ProviderDefinition<any, any>;

export type Config = Record<string, unknown>;
export type Secrets = Record<string, string>;

export function isHostedMember(v: ValidateContext): boolean {
  return v.hosted && v.role === 'member';
}

const MAX_URL = 2048;

export interface UrlRules {
  /** Restrict to these hostnames (fixed-host providers with secret webhook URLs). */
  hosts?: readonly string[];
  /** Hostname suffixes, e.g. ".webhook.office.com". */
  hostSuffixes?: readonly string[];
  /** Required path prefix (e.g. "/api/webhooks/"). */
  pathPrefix?: string;
  /** https only, even for self-hosted admins. */
  httpsOnly?: boolean;
}

/**
 * Validate a user supplied endpoint URL: http(s) only, no credentials in the URL, ≤ 2048 chars,
 * no fragment. Hosted members: https only and hostnames only (no IP literals, no single-label
 * names); private destinations are additionally refused by SafeNet at send time.
 */
export function checkUrl(raw: string, v: ValidateContext, field: string, label: string, rules: UrlRules = {}): string {
  const s = raw.trim();
  if (s.length > MAX_URL || hasUnsafeChars(s) || /\s/.test(s)) throw new ValidationError(`${label} is not a valid URL`, field);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ValidationError(`${label} is not a valid URL`, field);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ValidationError(`${label} must be an http(s):// URL`, field);
  if (u.username || u.password) throw new ValidationError(`${label} must not contain credentials (use the authentication fields)`, field);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new ValidationError(`${label} must contain a host`, field);
  if ((rules.httpsOnly || isHostedMember(v)) && u.protocol !== 'https:') throw new ValidationError(`${label} must use https://`, field);
  if (isHostedMember(v)) {
    if (isIP(host) !== 0) throw new ValidationError(`${label} must use a hostname, not an IP address`, field);
    if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost')) throw new ValidationError(`${label} host is not allowed`, field);
  }
  if (rules.hosts || rules.hostSuffixes) {
    const ok = (rules.hosts ?? []).includes(host) || (rules.hostSuffixes ?? []).some((sfx) => host.endsWith(sfx));
    if (!ok) throw new ValidationError(`${label} must be a ${[...(rules.hosts ?? []), ...(rules.hostSuffixes ?? []).map((x) => `*${x}`)].join(' or ')} URL`, field);
  }
  if (rules.pathPrefix && !u.pathname.startsWith(rules.pathPrefix)) throw new ValidationError(`${label} is not a valid webhook URL`, field);
  u.hash = '';
  return u.toString();
}

function isVisible(f: FieldDef, values: Config, input: Config): boolean {
  if (!f.showIf) return true;
  const other = f.showIf.key in values ? values[f.showIf.key] : input[f.showIf.key];
  return f.showIf.equals.some((e) => e === other || String(e) === String(other));
}

function oneLine(raw: unknown, f: FieldDef, max: number): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') throw new ValidationError(`${f.label} must be text`, f.key);
  const s = String(raw).trim();
  if (s.length > max) throw new ValidationError(`${f.label} must be at most ${max} characters`, f.key);
  if (hasUnsafeChars(s)) throw new ValidationError(`${f.label} contains invalid characters`, f.key);
  return s;
}

function multiLine(raw: unknown, f: FieldDef, max: number): string {
  if (typeof raw !== 'string') throw new ValidationError(`${f.label} must be text`, f.key);
  if (raw.length > max) throw new ValidationError(`${f.label} must be at most ${max} characters`, f.key);
  // Newlines and tabs are fine, other control / bidi characters are not.
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(raw.replace(/[\n\r\t]/g, ''))) throw new ValidationError(`${f.label} contains invalid characters`, f.key);
  return raw.replace(/\r\n?/g, '\n');
}

function listValue(raw: unknown, f: FieldDef): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : null;
  if (!items) throw new ValidationError(`${f.label} must be a list`, f.key);
  const out: string[] = [];
  for (const it of items) {
    if (typeof it !== 'string') throw new ValidationError(`${f.label} must be a list of text values`, f.key);
    const s = it.trim();
    if (!s) continue;
    if (s.length > (f.maxLength ?? 200) || hasUnsafeChars(s)) throw new ValidationError(`${f.label}: invalid entry`, f.key);
    if (!out.includes(s)) out.push(s);
  }
  if (f.max !== undefined && out.length > f.max) throw new ValidationError(`${f.label}: at most ${f.max} entries`, f.key);
  return out;
}

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'expect',
  'user-agent',
  'x-ptr-signature',
  'cookie',
]);

/** Custom headers as {key, value}[] → validated list (≤ 20, no hop-by-hop / reserved names, single-line values). */
export function headerList(raw: unknown, f: FieldDef): Array<{ key: string; value: string }> {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) throw new ValidationError(`${f.label} must be a list of name/value pairs`, f.key);
  if (raw.length > 20) throw new ValidationError(`${f.label}: at most 20 headers`, f.key);
  const out: Array<{ key: string; value: string }> = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new ValidationError(`${f.label} must be a list of name/value pairs`, f.key);
    const { key, value } = it as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || typeof value !== 'string') throw new ValidationError(`${f.label}: invalid header`, f.key);
    const k = key.trim();
    if (!k && !value) continue;
    if (!HEADER_NAME_RE.test(k)) throw new ValidationError(`${f.label}: invalid header name "${k.slice(0, 64)}"`, f.key);
    if (FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new ValidationError(`${f.label}: the header ${k} cannot be set`, f.key);
    if (value.length > 2048 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new ValidationError(`${f.label}: invalid value for ${k}`, f.key);
    out.push({ key: k, value: value.trim() });
  }
  return out;
}

function fieldValue(raw: unknown, f: FieldDef, v: ValidateContext): unknown {
  switch (f.kind) {
    case 'text':
    case 'host':
    case 'password':
      return oneLine(raw, f, f.maxLength ?? (f.kind === 'password' ? 1024 : 200));
    case 'url':
      return checkUrl(oneLine(raw, f, MAX_URL), v, f.key, f.label);
    case 'textarea':
      return multiLine(raw, f, f.maxLength ?? 4096);
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d{1,15}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
      if (!Number.isInteger(n)) throw new ValidationError(`${f.label} must be a whole number`, f.key);
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
        throw new ValidationError(`${f.label} must be between ${f.min ?? '-∞'} and ${f.max ?? '∞'}`, f.key);
      }
      return n;
    }
    case 'boolean':
      if (typeof raw !== 'boolean') throw new ValidationError(`${f.label} must be true or false`, f.key);
      return raw;
    case 'select': {
      const s = String(raw);
      if (!(f.options ?? []).some((o) => o.value === s)) throw new ValidationError(`${f.label}: invalid choice`, f.key);
      return s;
    }
    case 'list':
      return listValue(raw, f);
    case 'keyvalue':
      return headerList(raw, f);
    case 'statuscodes':
      return listValue(raw, f);
  }
}

function isEmpty(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
}

/**
 * Normalise `input` from field definitions. Non-secret fields → `config`, secret fields →
 * `secrets` (strings; list/keyvalue secrets JSON-encoded). Secret semantics (SPEC §8.1):
 * omitted or "" keeps the stored value (`ctx.existingSecrets`), `null` clears it.
 * Fields hidden by `showIf` are dropped; `selfHostedOnly` fields are refused for hosted members.
 */
export function validateFields(fields: readonly FieldDef[], input: Config, v: ValidateContext): { config: Config; secrets: Secrets } {
  const config: Config = {};
  const secrets: Secrets = {};
  const member = isHostedMember(v);
  for (const f of fields) {
    const raw = Object.prototype.hasOwnProperty.call(input, f.key) ? input[f.key] : undefined;
    if (!isVisible(f, config, input)) continue;
    if (f.selfHostedOnly && member) {
      if (!isEmpty(raw)) throw new ValidationError(`${f.label} is not available on this server`, f.key);
      continue;
    }
    if (f.secret) {
      let value: string | undefined;
      if (raw === null) value = undefined;
      else if (raw === undefined || raw === '') value = v.existingSecrets?.[f.key];
      else {
        const n = fieldValue(raw, f, v);
        value = typeof n === 'string' ? n : JSON.stringify(n);
        if (Array.isArray(n) && n.length === 0) value = undefined;
      }
      if (value !== undefined && value !== '') secrets[f.key] = value;
      else if (f.required) throw new ValidationError(`${f.label} is required`, f.key);
      continue;
    }
    if (isEmpty(raw)) {
      if (f.default !== undefined) config[f.key] = f.default;
      else if (f.required) throw new ValidationError(`${f.label} is required`, f.key);
      continue;
    }
    config[f.key] = fieldValue(raw, f, v);
  }
  return { config, secrets };
}

/* ------------------------------------------------------------ field helpers */

export const str = (c: Config, k: string): string => (typeof c[k] === 'string' ? (c[k] as string) : '');
export const optStr = (c: Config, k: string): string | undefined => (typeof c[k] === 'string' && c[k] !== '' ? (c[k] as string) : undefined);
export const bool = (c: Config, k: string): boolean => c[k] === true;
export const int = (c: Config, k: string, d: number): number => (typeof c[k] === 'number' ? (c[k] as number) : d);
export const list = (c: Config, k: string): string[] => (Array.isArray(c[k]) ? (c[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);

export function requirePattern(value: string | undefined, re: RegExp, field: string, message: string): void {
  if (value !== undefined && value !== '' && !re.test(value)) throw new ValidationError(message, field);
}

export const E164_RE = /^\+[1-9]\d{6,14}$/;

export function checkEmails(addresses: string[], field: string, label: string): string[] {
  return addresses.map((a) => {
    if (!isValidEmail(a)) throw new ValidationError(`${label}: "${a.slice(0, 80)}" is not a plain e-mail address`, field);
    return a.toLowerCase();
  });
}

export const TEMPLATE_HELP =
  'Placeholders: {{title}}, {{text}}, {{event}}, {{status}}, {{message}}, {{monitor.name}}, {{monitor.url}}, ' +
  '{{site.name}}, {{latency_ms}}, {{down_duration}}, {{time_iso}}, {{dashboard_url}} … (no expressions)';

/** Event → severity helper for incident providers. */
export function isProblem(event: string): boolean {
  return event === 'down' || event === 'resend';
}
