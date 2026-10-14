// HTTP helpers for providers. Every request goes through the SSRF-safe SafeNet (no redirects
// are followed: a notification endpoint that redirects is treated as a failure).
import type { HttpResponse, ProviderSendContext } from '../types.js';

/** A failed delivery with retry information. Messages may contain response snippets; they are redacted before storage. */
export class DeliveryError extends Error {
  override name = 'DeliveryError';
  constructor(
    message: string,
    readonly opts: { httpStatus?: number; retryable: boolean; retryAfterMs?: number } = { retryable: false },
  ) {
    super(message);
  }
}

export const RESPONSE_MAX_BYTES = 16 * 1024;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

function header(res: HttpResponse, name: string): string | undefined {
  const v = res.headers[name] ?? res.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Retry-After as delay in ms (seconds or HTTP date), capped at 1 h. */
export function parseRetryAfter(v: string | undefined, now: number): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^\d{1,7}$/.test(t)) return Math.min(Number(t) * 1000, MAX_RETRY_AFTER_MS);
  const d = Date.parse(t);
  if (Number.isFinite(d)) return Math.min(Math.max(0, d - now), MAX_RETRY_AFTER_MS);
  return undefined;
}

/** Short human-readable error from a provider's response body. */
function bodySnippet(body: Buffer): string {
  const raw = body.subarray(0, 2048).toString('utf8');
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    for (const k of ['description', 'message', 'error_description', 'error', 'errors', 'detail', 'msg']) {
      const v = j[k];
      if (typeof v === 'string' && v) return v.slice(0, 160);
      if (v && typeof v === 'object') return JSON.stringify(v).slice(0, 160);
    }
  } catch {
    /* not JSON */
  }
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export interface SendRequest {
  url: string;
  method?: 'POST' | 'PUT' | 'GET';
  headers?: Record<string, string>;
  body?: string;
}

/** Send one request; non-2xx answers throw a DeliveryError. */
export async function httpSend(ctx: ProviderSendContext<unknown, unknown>, req: SendRequest): Promise<{ httpStatus: number; body: Buffer }> {
  const headers: Record<string, string> = { 'user-agent': ctx.userAgent, accept: 'application/json, text/plain, */*' };
  for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
  if (req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body, 'utf8'));
  const res = await ctx.net.request({
    url: req.url,
    method: req.method ?? 'POST',
    headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
    maxRedirects: 0,
    maxBodyBytes: RESPONSE_MAX_BYTES,
    signal: ctx.signal,
  });
  if (res.status >= 200 && res.status < 300) return { httpStatus: res.status, body: res.body };
  const snippet = bodySnippet(res.body);
  const retryAfterMs = parseRetryAfter(header(res, 'retry-after'), Date.now());
  throw new DeliveryError(`HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, {
    httpStatus: res.status,
    retryable: isRetryableStatus(res.status),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

export function postJson(
  ctx: ProviderSendContext<unknown, unknown>,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  method: 'POST' | 'PUT' = 'POST',
): Promise<{ httpStatus: number; body: Buffer }> {
  return httpSend(ctx, { url, method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

export function formEncode(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.append(k, String(v));
  return sp.toString();
}

export function postForm(
  ctx: ProviderSendContext<unknown, unknown>,
  url: string,
  params: Record<string, string | number | undefined | null>,
  headers: Record<string, string> = {},
): Promise<{ httpStatus: number; body: Buffer }> {
  return httpSend(ctx, { url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: formEncode(params) });
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

/** Join a base URL (no trailing slash needed) and a path. */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}
