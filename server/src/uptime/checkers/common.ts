// Shared helpers of the monitor-type checkers: strict input validation, write-only secret
// handling, error → message mapping. Checkers use only SafeNet for network access.
import { TargetDeniedError, ValidationError, type CheckContext, type CheckResult, type FieldDef, type TlsInfo, type ValidateContext } from '../types.js';
import { NetError, TlsCertificateError } from '../net/errors.js';
import { TargetPolicy, normalizeHost, normalizeHostname } from '../net/policy.js';
import { parseIp } from '../net/ip.js';

export type Input = Record<string, unknown>;

export function isMember(ctx: ValidateContext): boolean {
  return ctx.hosted && ctx.role === 'member';
}

export function policyFor(ctx: ValidateContext): TargetPolicy {
  return new TargetPolicy({ config: ctx.config, hostedMember: isMember(ctx) });
}

/* --------------------------------------------------------------- primitives */

export function str(input: Input, key: string, opts: { required?: boolean; max?: number; def?: string; multiline?: boolean; trim?: boolean } = {}): string {
  const v = input[key];
  if (v === undefined || v === null || v === '') {
    if (opts.def !== undefined && opts.def !== '') return opts.def;
    if (opts.required) throw new ValidationError(`${key} is required`, key);
    return '';
  }
  if (typeof v !== 'string') throw new ValidationError(`${key} must be a string`, key);
  const s = opts.trim === false ? v : v.trim();
  if (opts.required && s === '') throw new ValidationError(`${key} is required`, key);
  const max = opts.max ?? 255;
  if (s.length > max) throw new ValidationError(`${key} must be at most ${max} characters`, key);
  // eslint-disable-next-line no-control-regex
  if (!opts.multiline && /[\u0000-\u001f\u007f]/.test(s)) throw new ValidationError(`${key} must not contain control characters`, key);
  // eslint-disable-next-line no-control-regex
  if (opts.multiline && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw new ValidationError(`${key} must not contain control characters`, key);
  return s;
}

export function int(input: Input, key: string, opts: { min: number; max: number; def: number }): number {
  const v = input[key];
  if (v === undefined || v === null || v === '') return opts.def;
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ValidationError(`${key} must be an integer`, key);
  if (n < opts.min || n > opts.max) throw new ValidationError(`${key} must be between ${opts.min} and ${opts.max}`, key);
  return n;
}

export function bool(input: Input, key: string, def = false): boolean {
  const v = input[key];
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  throw new ValidationError(`${key} must be true or false`, key);
}

export function oneOf<T extends string>(input: Input, key: string, values: readonly T[], def: T): T {
  const v = input[key];
  if (v === undefined || v === null || v === '') return def;
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !(values as readonly string[]).includes(s)) throw new ValidationError(`${key} must be one of ${values.join(', ')}`, key);
  return s as T;
}

export function list(input: Input, key: string, opts: { maxItems: number; maxLength: number }): string[] {
  const v = input[key];
  if (v === undefined || v === null || v === '') return [];
  const arr = typeof v === 'string' ? v.split(/\r?\n/) : v;
  if (!Array.isArray(arr)) throw new ValidationError(`${key} must be a list`, key);
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== 'string') throw new ValidationError(`${key} must be a list of strings`, key);
    const s = item.trim();
    if (!s) continue;
    if (s.length > opts.maxLength) throw new ValidationError(`${key}: entries must be at most ${opts.maxLength} characters`, key);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(s)) throw new ValidationError(`${key} must not contain control characters`, key);
    out.push(s);
  }
  if (out.length > opts.maxItems) throw new ValidationError(`${key}: at most ${opts.maxItems} entries`, key);
  return out;
}

export function port(input: Input, key: string, def: number): number {
  return int(input, key, { min: 1, max: 65535, def });
}

/** Hostname or IP literal (strict); IP literals are checked against the target policy at save time. */
export function host(input: Input, key: string, ctx: ValidateContext, opts: { allowIp?: boolean } = {}): string {
  const raw = str(input, key, { required: true, max: 255 });
  const h = normalizeHost(raw);
  if (!h) throw new ValidationError(`${key} must be a valid hostname or IP address`, key);
  if (h.ip) {
    if (opts.allowIp === false) throw new ValidationError(`${key} must be a domain name`, key);
    if (!policyFor(ctx).checkIp(h.ip).ok) throw new ValidationError('target not allowed', key);
  } else {
    const hc = policyFor(ctx).checkHostname(h.host);
    if (!hc.ok) throw new ValidationError('target not allowed', key);
  }
  return h.host;
}

export function hostAndIp(hostValue: string): { isIp: boolean } {
  return { isIp: parseIp(hostValue) !== null };
}

/** http(s) URL (ws/wss mapped when `ws`), no credentials, IP literal hosts checked at save time. */
export function url(input: Input, key: string, ctx: ValidateContext, opts: { required?: boolean; ws?: boolean; httpsOnly?: boolean } = {}): string {
  const raw = str(input, key, { required: opts.required ?? true, max: 2048 });
  if (!raw) return '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ValidationError(`${key} must be a valid URL`, key);
  }
  const schemes = opts.ws ? ['ws:', 'wss:', 'http:', 'https:'] : ['http:', 'https:'];
  if (!schemes.includes(u.protocol)) throw new ValidationError(`${key} must start with ${opts.ws ? 'ws://, wss://, ' : ''}http:// or https://`, key);
  if (opts.httpsOnly && u.protocol !== 'https:' && u.protocol !== 'wss:') throw new ValidationError(`${key} must use https`, key);
  if (u.username || u.password) throw new ValidationError(`${key} must not contain credentials (use the authentication fields)`, key);
  const hostname = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
  const ip = parseIp(hostname);
  if (ip) {
    if (!policyFor(ctx).checkIp(ip).ok) throw new ValidationError('target not allowed', key);
  } else {
    if (!normalizeHostname(hostname)) throw new ValidationError(`${key} has an invalid hostname`, key);
    if (!policyFor(ctx).checkHostname(hostname).ok) throw new ValidationError('target not allowed', key);
  }
  u.hash = '';
  return u.toString();
}

/* -------------------------------------------------------------- statuscodes */

export function statusCodes(input: Input, key: string, def: string[], range: [number, number] = [100, 999]): string[] {
  const v = input[key];
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) return [...def];
  if (!Array.isArray(v)) throw new ValidationError(`${key} must be a list`, key);
  if (v.length > 20) throw new ValidationError(`${key}: at most 20 entries`, key);
  const out: string[] = [];
  for (const item of v) {
    const s = typeof item === 'number' ? String(item) : item;
    if (typeof s !== 'string') throw new ValidationError(`${key}: invalid entry`, key);
    const m = /^\s*(\d{3,4})\s*(?:-\s*(\d{3,4})\s*)?$/.exec(s);
    if (!m) throw new ValidationError(`${key}: "${s.slice(0, 20)}" is not a status code or range (e.g. 200-299)`, key);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < range[0] || b > range[1] || a > b) throw new ValidationError(`${key}: codes must be between ${range[0]} and ${range[1]}`, key);
    out.push(a === b ? String(a) : `${a}-${b}`);
  }
  return [...new Set(out)];
}

export function codeAccepted(code: number, accepted: readonly string[]): boolean {
  for (const r of accepted) {
    const [a, b] = r.split('-').map(Number);
    if (a === undefined) continue;
    if (code >= a && code <= (b ?? a)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ headers */

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const FORBIDDEN_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect', 'proxy-authorization', 'proxy-connection', 'http2-settings']);

export function headerList(input: Input, key: string, opts: { forbid?: readonly string[] } = {}): Array<{ key: string; value: string }> {
  const v = input[key];
  if (v === undefined || v === null || v === '') return [];
  let arr: unknown = v;
  if (!Array.isArray(v) && typeof v === 'object') arr = Object.entries(v as Record<string, unknown>).map(([k, val]) => ({ key: k, value: val }));
  if (!Array.isArray(arr)) throw new ValidationError(`${key} must be a list of {key, value}`, key);
  if (arr.length > 50) throw new ValidationError(`${key}: at most 50 headers`, key);
  const out: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') throw new ValidationError(`${key} must be a list of {key, value}`, key);
    const k = (item as { key?: unknown }).key;
    const val = (item as { value?: unknown }).value;
    if (typeof k !== 'string' || !HEADER_NAME.test(k.trim())) throw new ValidationError(`${key}: invalid header name`, key);
    const name = k.trim();
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower) || opts.forbid?.includes(lower)) throw new ValidationError(`${key}: header ${name} cannot be set`, key);
    if (seen.has(lower)) throw new ValidationError(`${key}: duplicate header ${name}`, key);
    seen.add(lower);
    const value = val === undefined || val === null ? '' : val;
    if (typeof value !== 'string') throw new ValidationError(`${key}: header values must be strings`, key);
    if (value.length > 4096) throw new ValidationError(`${key}: header values must be at most 4096 characters`, key);
    // eslint-disable-next-line no-control-regex
    if (/[\r\n\u0000]/.test(value)) throw new ValidationError(`${key}: header values must not contain line breaks`, key);
    out.push({ key: name, value: value.trim() });
  }
  return out;
}

/* ------------------------------------------------------------------ secrets */

/**
 * Write-only secret semantics: `undefined` / `""` keeps the stored value, `null` clears it,
 * a string replaces it. Returns the resulting value (undefined = not set).
 */
export function secret(input: Input, key: string, ctx: ValidateContext, opts: { max?: number; multiline?: boolean } = {}): string | undefined {
  const v = input[key];
  if (v === null) return undefined;
  if (v === undefined || v === '') return ctx.existingSecrets?.[key];
  if (typeof v !== 'string') throw new ValidationError(`${key} must be a string`, key);
  const max = opts.max ?? 1024;
  if (v.length > max) throw new ValidationError(`${key} must be at most ${max} characters`, key);
  // eslint-disable-next-line no-control-regex
  if (!opts.multiline && /[\u0000-\u001f\u007f]/.test(v)) throw new ValidationError(`${key} must not contain control characters`, key);
  return v;
}

/**
 * Secret key/value list (e.g. headers carrying API keys). The names are stored in the config
 * (`config[key]` = names), values in secrets under `<key>.<name>`. Entries sent with an empty
 * value keep the stored value; names not sent are removed; `null` clears all.
 */
export function secretHeaderList(input: Input, key: string, ctx: ValidateContext, opts: { forbid?: readonly string[] } = {}): { names: string[]; secrets: Record<string, string> } {
  const v = input[key];
  const existing = ctx.existingSecrets ?? {};
  const secrets: Record<string, string> = {};
  if (v === null) return { names: [], secrets };
  if (v === undefined) {
    // Keep everything that is stored.
    const names: string[] = [];
    for (const [k, val] of Object.entries(existing)) {
      if (k.startsWith(`${key}.`)) {
        names.push(k.slice(key.length + 1));
        secrets[k] = val;
      }
    }
    return { names, secrets };
  }
  const items = headerList(input, key, opts);
  for (const it of items) {
    const sk = `${key}.${it.key}`;
    let val: string | undefined = it.value;
    if (val === '') val = existing[sk] ?? Object.entries(existing).find(([k]) => k.toLowerCase() === sk.toLowerCase())?.[1];
    if (val === undefined || val === '') throw new ValidationError(`${key}: value for ${it.key} is required`, key);
    secrets[sk] = val;
  }
  return { names: items.map((i) => i.key), secrets };
}

/** PEM block(s) of the given kinds. */
export function pem(value: string, key: string, kinds: RegExp): string {
  const s = value.trim();
  if (!/^-----BEGIN [A-Z0-9 ]+-----[\s\S]+-----END [A-Z0-9 ]+-----$/.test(s) || !kinds.test(s)) throw new ValidationError(`${key} must be a PEM block`, key);
  return `${s}\n`;
}

/* ------------------------------------------------------------------ results */

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Message for the beat: control characters stripped, ≤ 200 chars. */
export function clip(msg: string, max = 200): string {
  const s = msg.replace(CTRL, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function up(msg: string, extra: Partial<CheckResult> = {}): CheckResult {
  return { ...extra, status: 'up', msg: clip(msg) };
}

export function down(msg: string, extra: Partial<CheckResult> = {}): CheckResult {
  return { ...extra, status: 'down', msg: clip(msg) };
}

/** Short message for an error thrown during a check (no secrets: our errors never include them). */
export function errorMessage(err: unknown, timeoutMs: number): string {
  if (err instanceof TargetDeniedError) return 'target not allowed';
  if (err instanceof NetError) {
    if (err.code === 'ETIMEOUT' || err.code === 'EABORT') return `Timeout after ${timeoutMs} ms`;
    if (err.code === 'ENOTFOUND') return 'Host not found';
    return err.message.length > 0 ? err.message.charAt(0).toUpperCase() + err.message.slice(1) : 'Network error';
  }
  if (err instanceof ValidationError) return err.message;
  const e = err as { name?: string; code?: string; message?: string } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `Timeout after ${timeoutMs} ms`;
  return 'Check failed';
}

/** Wraps a check: exceptions become DOWN results (with TLS info for certificate errors). */
export async function guarded<C, S>(ctx: CheckContext<C, S>, fn: () => Promise<CheckResult>): Promise<CheckResult> {
  const started = performance.now();
  try {
    return await fn();
  } catch (err) {
    const extra: Partial<CheckResult> = {};
    if (err instanceof TlsCertificateError) extra.tls = err.tls;
    const msg = ctx.signal.aborted ? `Timeout after ${ctx.timeoutMs} ms` : errorMessage(err, ctx.timeoutMs);
    if (!(err instanceof TargetDeniedError)) extra.latencyMs = Math.round(performance.now() - started);
    return down(msg, extra);
  }
}

export function ms(n: number): number {
  return Math.round(n);
}

export function daysLeft(notAfter: number | null, now = Date.now()): number | null {
  if (notAfter === null) return null;
  return Math.floor((notAfter - now) / 86_400_000);
}

export function tlsSummary(info: TlsInfo | undefined): string {
  if (!info) return '';
  const d = daysLeft(info.notAfter);
  return d === null ? '' : `, certificate expires in ${d} days`;
}

/* ------------------------------------------------------------ field helpers */

export const IP_FAMILY_FIELD: FieldDef = {
  key: 'ipFamily',
  label: 'IP version',
  kind: 'select',
  default: 'auto',
  options: [
    { value: 'auto', label: 'Automatic' },
    { value: 'ipv4', label: 'IPv4 only' },
    { value: 'ipv6', label: 'IPv6 only' },
  ],
  group: 'Advanced',
};

export function ipFamily(input: Input): 'auto' | 'ipv4' | 'ipv6' {
  return oneOf(input, 'ipFamily', ['auto', 'ipv4', 'ipv6'] as const, 'auto');
}

export function familyNum(f: 'auto' | 'ipv4' | 'ipv6' | undefined): 0 | 4 | 6 {
  return f === 'ipv4' ? 4 : f === 'ipv6' ? 6 : 0;
}

export function hostPort(h: string, p: number): string {
  return parseIp(h)?.family === 6 ? `[${h}]:${p}` : `${h}:${p}`;
}

export const HOST_FIELD: FieldDef = { key: 'host', label: 'Hostname or IP address', kind: 'host', required: true, maxLength: 255, placeholder: 'example.com', group: 'Target' };

export function portField(def: number): FieldDef {
  return { key: 'port', label: 'Port', kind: 'number', required: true, default: def, min: 1, max: 65535, group: 'Target' };
}

export const IGNORE_TLS_FIELD: FieldDef = {
  key: 'ignoreTls',
  label: 'Ignore TLS/SSL errors',
  kind: 'boolean',
  default: false,
  help: 'Accept expired, self-signed or mismatching certificates. The certificate is still recorded for expiry warnings.',
  group: 'Advanced',
};

/** Protocol violation by the peer (message shown in the beat). */
export function protoError(msg: string): NetError {
  return new NetError('EPROTO', msg);
}
