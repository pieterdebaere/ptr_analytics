// SSRF-safe HTTP/1.1 client for monitor traffic.
//
// * Every hop: WHATWG URL parsing (http/https only, no userinfo) → resolveTarget (all addresses
//   checked) → TCP connection to the checked IP literal → our own TLS handshake (certificate
//   captured, verification decided before any request byte is sent) → node:http request over
//   that socket via `createConnection`. Node therefore never resolves a name (no rebinding).
// * No agent and no proxy: HTTP(S)_PROXY / NO_PROXY / NODE_USE_ENV_PROXY are ignored on purpose
//   for monitor traffic — a proxy resolves the target itself and would bypass the guard.
// * Redirects are followed manually (each hop re-resolved and re-checked); on cross-origin hops
//   only harmless headers are kept (Authorization, Cookie and custom/secret headers are dropped)
//   and the client certificate is not presented.
// * Body capped at maxBodyBytes (compressed and decompressed separately; gzip/deflate/br only),
//   ≤ 16 KiB of headers, ≤ 100 header lines.
import http, { type IncomingMessage } from 'node:http';
import zlib from 'node:zlib';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { HttpRequestOptions, HttpResponse, TlsInfo } from '../types.js';
import { NetError, abortError } from './errors.js';
import type { TargetPolicy } from './policy.js';
import { resolveTarget, type HostResolver } from './resolve.js';
import { connectResolved, guardSocket, mapSocketError } from './socket.js';

const REDIRECT = new Set([301, 302, 303, 307, 308]);
/** Headers kept on a cross-origin redirect; everything else (credentials, custom headers) is dropped. */
const SAFE_CROSS_ORIGIN = new Set(['accept', 'accept-language', 'user-agent', 'cache-control', 'pragma', 'accept-encoding']);
const MAX_URL = 8192;

export function parseHttpUrl(input: string): URL {
  if (typeof input !== 'string' || input.length > MAX_URL) throw new NetError('EINVALIDURL', 'invalid URL');
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new NetError('EINVALIDURL', 'invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NetError('EINVALIDURL', 'only http and https URLs are supported');
  if (u.username !== '' || u.password !== '') throw new NetError('EINVALIDURL', 'credentials in URLs are not allowed');
  if (u.hostname === '') throw new NetError('EINVALIDURL', 'invalid URL');
  return u;
}

function lowerHeaders(h: Record<string, string> | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!h) return m;
  for (const [k, v] of Object.entries(h)) {
    if (typeof v !== 'string') continue;
    if (/[\r\n\0]/.test(k) || /[\r\n\0]/.test(v)) throw new NetError('EINVALIDHEADER', 'invalid header');
    m.set(k.toLowerCase(), v);
  }
  return m;
}

interface Hop {
  res: IncomingMessage;
  socket: Socket | TLSSocket;
  remoteAddress: string;
  tls?: TlsInfo;
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  ttfbMs: number;
}

/** Tiny per-request cookie jar (cookies survive the redirect chain of one check only). */
class CookieJar {
  private readonly jar = new Map<string, Map<string, string>>();
  store(host: string, setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    let m = this.jar.get(host);
    if (!m) {
      m = new Map();
      this.jar.set(host, m);
    }
    for (const sc of list.slice(0, 50)) {
      const pair = sc.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || value.length > 4096 || /[\r\n;]/.test(value)) continue;
      if (m.size < 50) m.set(name, value);
    }
  }
  header(host: string): string | null {
    const m = this.jar.get(host);
    if (!m || m.size === 0) return null;
    return [...m].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function oneHop(
  policy: TargetPolicy,
  resolver: HostResolver,
  url: URL,
  method: string,
  headers: Map<string, string>,
  body: Buffer | null,
  opts: HttpRequestOptions & { userAgent: string },
  clientCert: HttpRequestOptions['clientCert'] | undefined,
): Promise<Hop> {
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const t0 = performance.now();
  const target = await resolveTarget(policy, resolver, host, { family: opts.family ?? 0, signal: opts.signal });
  const dnsMs = performance.now() - t0;
  const https = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : https ? 443 : 80;
  const conn = await connectResolved(target, port, {
    signal: opts.signal,
    tls: https
      ? {
          servername: target.host,
          rejectUnauthorized: !opts.ignoreTls,
          alpn: ['http/1.1'],
          cert: clientCert?.cert,
          key: clientCert?.key,
          ca: clientCert?.ca,
        }
      : undefined,
  });
  const sock = conn.socket;
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of headers) outHeaders[k] = v;
  outHeaders['host'] ??= url.host;
  outHeaders['user-agent'] ??= opts.userAgent;
  outHeaders['accept'] ??= '*/*';
  outHeaders['accept-encoding'] ??= 'gzip, deflate, br';
  outHeaders['connection'] = 'close';
  if (body) outHeaders['content-length'] = String(body.length);
  else delete outHeaders['content-length'];
  delete outHeaders['transfer-encoding'];

  const reqStart = performance.now();
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const req = http.request({
      method,
      path: `${url.pathname}${url.search}`,
      headers: outHeaders,
      setHost: false,
      createConnection: () => sock as Socket,
      maxHeaderSize: 16 * 1024,
      insecureHTTPParser: false,
      joinDuplicateHeaders: false,
    });
    req.maxHeadersCount = 100;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      req.destroy();
      sock.destroy();
      reject(opts.signal.aborted ? abortError(opts.signal) : mapHttpError(err));
    };
    const onAbort = (): void => fail(abortError(opts.signal));
    opts.signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', fail);
    req.on('response', (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      guardSocket(res, opts.signal);
      resolve({
        res,
        socket: sock,
        remoteAddress: conn.remoteAddress,
        tls: conn.tls,
        dnsMs,
        connectMs: conn.connectMs,
        tlsMs: conn.tlsMs,
        ttfbMs: performance.now() - reqStart,
      });
    });
    req.end(body ?? undefined);
  });
}

function mapHttpError(err: unknown): Error {
  if (err instanceof NetError) return err;
  const code = (err as { code?: string } | null)?.code ?? '';
  if (code === 'HPE_HEADER_OVERFLOW') return new NetError(code, 'response headers too large');
  if (code.startsWith('HPE_')) return new NetError(code, 'invalid HTTP response');
  return mapSocketError(err);
}

/** Reads the body with separate caps for raw and decompressed bytes. */
export function readBody(res: IncomingMessage, maxBytes: number, signal: AbortSignal, decompress = true): Promise<{ body: Buffer; truncated: boolean }> {
  const enc = String(res.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase();
  let inflater: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null = null;
  if (decompress) {
    const flush = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
    if (enc === 'gzip' || enc === 'x-gzip') inflater = zlib.createGunzip(flush);
    else if (enc === 'deflate') inflater = zlib.createInflate(flush);
    else if (enc === 'br') inflater = zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let raw = 0;
    let done = false;
    const finish = (truncated: boolean): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      if (truncated) {
        res.destroy();
        inflater?.destroy();
      }
      resolve({ body: Buffer.concat(chunks, size), truncated });
    };
    const fail = (err: unknown): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      res.destroy();
      inflater?.destroy();
      reject(signal.aborted ? abortError(signal) : err);
    };
    const onAbort = (): void => fail(abortError(signal));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    const onOut = (chunk: Buffer): void => {
      if (done) return;
      const room = maxBytes - size;
      if (chunk.length > room) {
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          size += room;
        }
        finish(true);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    };
    res.on('error', (e) => fail(mapHttpError(e)));
    res.on('aborted', () => fail(new NetError('ECONNRESET', 'connection closed before the response was complete')));
    if (inflater) {
      const z = inflater;
      z.on('data', onOut);
      z.on('end', () => finish(false));
      z.on('error', () => fail(new NetError('EDECOMPRESS', 'invalid compressed response body')));
      res.on('data', (c: Buffer) => {
        if (done) return;
        raw += c.length;
        if (raw > maxBytes) {
          finish(true);
          return;
        }
        z.write(c);
      });
      res.on('end', () => {
        if (!done) z.end();
      });
    } else {
      res.on('data', onOut);
      res.on('end', () => finish(false));
    }
  });
}

export async function httpRequest(
  policy: TargetPolicy,
  resolver: HostResolver,
  opts: HttpRequestOptions & { userAgent: string },
): Promise<HttpResponse> {
  const started = performance.now();
  let url = parseHttpUrl(opts.url);
  const origin0 = url.origin;
  let method = (opts.method ?? 'GET').toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) throw new NetError('EINVAL', 'invalid HTTP method');
  let headers = lowerHeaders(opts.headers);
  let body: Buffer | null = opts.body === undefined ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
  const maxRedirects = Math.max(0, Math.min(opts.maxRedirects ?? 10, 30));
  const jar = new CookieJar();
  let redirects = 0;
  let crossOrigin = false;
  for (;;) {
    const cookie = jar.header(url.host);
    const hopHeaders = new Map(headers);
    if (cookie) hopHeaders.set('cookie', hopHeaders.has('cookie') ? `${hopHeaders.get('cookie')}; ${cookie}` : cookie);
    const hop = await oneHop(policy, resolver, url, method, hopHeaders, body, opts, crossOrigin ? undefined : opts.clientCert);
    const { res } = hop;
    const status = res.statusCode ?? 0;
    jar.store(url.host, res.headers['set-cookie']);
    const location = res.headers['location'];
    if (REDIRECT.has(status) && typeof location === 'string' && redirects < maxRedirects) {
      res.destroy();
      hop.socket.destroy();
      let next: URL;
      try {
        next = parseHttpUrl(new URL(location, url).toString());
      } catch {
        throw new NetError('EREDIRECT', 'invalid redirect location');
      }
      redirects++;
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        if (method !== 'HEAD') method = 'GET';
        body = null;
        headers.delete('content-type');
      }
      if (next.origin !== origin0) crossOrigin = true;
      if (next.origin !== url.origin) {
        const kept = new Map<string, string>();
        for (const [k, v] of headers) if (SAFE_CROSS_ORIGIN.has(k) || (k === 'content-type' && body)) kept.set(k, v);
        headers = kept;
      }
      url = next;
      continue;
    }
    const { body: data, truncated } = method === 'HEAD' ? { body: Buffer.alloc(0), truncated: false } : await readBody(res, opts.maxBodyBytes, opts.signal);
    hop.socket.destroy();
    const outHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) outHeaders[k] = v;
    const totalMs = performance.now() - started;
    return {
      status,
      statusText: (res.statusMessage ?? '').slice(0, 100),
      headers: outHeaders,
      body: data,
      truncated,
      url: url.toString(),
      redirects,
      timings: {
        dnsMs: round(hop.dnsMs),
        connectMs: round(hop.connectMs),
        tlsMs: round(hop.tlsMs),
        ttfbMs: round(hop.ttfbMs),
        totalMs: round(totalMs),
      },
      tls: hop.tls,
      remoteAddress: hop.remoteAddress,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
