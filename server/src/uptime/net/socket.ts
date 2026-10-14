// Pinned TCP connections (to an already checked IP literal), TLS upgrade with certificate capture
// and a bounded socket reader for protocol checkers.
import net, { type Socket } from 'node:net';
import tls, { type DetailedPeerCertificate, type PeerCertificate, type TLSSocket } from 'node:tls';
import type { Duplex, Readable } from 'node:stream';
import type { ResolvedTarget, TlsInfo } from '../types.js';
import { NetError, TlsCertificateError, abortError } from './errors.js';
import { parseIp } from './ip.js';
import { connectOrder } from './resolve.js';

/** Never used for IP literals; defence in depth so that Node can never resolve a name itself. */
function noLookup(_hostname: string, _opts: unknown, cb: (err: Error | null, address: string, family: number) => void): void {
  cb(new NetError('ENOLOOKUP', 'implicit DNS lookup is disabled'), '', 0);
}

const SOCKET_ERRORS: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset by peer',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed by peer',
  EADDRNOTAVAIL: 'address not available',
  EPROTO: 'protocol error',
  EAFNOSUPPORT: 'address family not supported',
};

const TLS_ERRORS: Record<string, string> = {
  CERT_HAS_EXPIRED: 'certificate has expired',
  CERT_NOT_YET_VALID: 'certificate is not yet valid',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in chain',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'unable to verify the certificate chain',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'unable to get local issuer certificate',
  UNABLE_TO_GET_ISSUER_CERT: 'unable to get issuer certificate',
  CERT_REVOKED: 'certificate revoked',
  CERT_UNTRUSTED: 'certificate not trusted',
  CERT_SIGNATURE_FAILURE: 'certificate signature failure',
  ERR_TLS_CERT_ALTNAME_INVALID: 'hostname does not match certificate',
};

function clean(s: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
}

/** Maps a Node socket/TLS error to a NetError with a short, fixed message. */
export function mapSocketError(err: unknown): Error {
  if (err instanceof NetError) return err;
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code ?? 'EUNKNOWN';
  if (SOCKET_ERRORS[code]) return new NetError(code, SOCKET_ERRORS[code]!);
  if (TLS_ERRORS[code]) return new NetError(code, TLS_ERRORS[code]!);
  if (code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS') || /ssl|tls|alert/i.test(e?.message ?? '')) {
    return new NetError(code, `TLS handshake failed: ${clean(e?.message ?? code, 100)}`);
  }
  return new NetError(code, clean(e?.message ?? 'network error'));
}

/* ------------------------------------------------------------------ TLS info */

function formatName(name: Record<string, string | string[]> | undefined | null): string | null {
  if (!name || typeof name !== 'object') return null;
  const order = ['CN', 'O', 'OU', 'L', 'ST', 'C'];
  const parts: string[] = [];
  for (const k of order) {
    const v = name[k];
    if (v === undefined) continue;
    parts.push(`${k}=${Array.isArray(v) ? v.join('+') : String(v)}`);
  }
  if (parts.length === 0) return null;
  return clean(parts.join(', '), 200);
}

function parseDate(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function sansOf(cert: PeerCertificate): string[] {
  const raw = cert.subjectaltname;
  if (typeof raw !== 'string' || raw === '') return [];
  return raw
    .split(/,\s*/)
    .slice(0, 100)
    .map((s) => clean(s.replace(/^(DNS|IP Address|email|URI):/, ''), 253));
}

const tlsInfos = new WeakMap<object, TlsInfo>();

/** TLS info captured when the socket was created through SafeNet (undefined for plain sockets). */
export function tlsInfoOf(socket: Duplex): TlsInfo | undefined {
  return tlsInfos.get(socket);
}

export function buildTlsInfo(sock: TLSSocket, hostForCheck: string | null): TlsInfo {
  const peer = sock.getPeerCertificate(true) as DetailedPeerCertificate | null;
  if (!peer || Object.keys(peer).length === 0) {
    return { valid: false, hostnameOk: false, subject: null, issuer: null, sans: [], notBefore: null, notAfter: null, fingerprint256: null, chain: [], error: 'no certificate presented' };
  }
  const chain: TlsInfo['chain'] = [];
  const seen = new Set<string>();
  let c: DetailedPeerCertificate | undefined = peer;
  while (c && chain.length < 10) {
    const fp = c.fingerprint256 ?? '';
    if (seen.has(fp)) break;
    seen.add(fp);
    chain.push({ subject: formatName(c.subject as never), issuer: formatName(c.issuer as never), notAfter: parseDate(c.valid_to), fingerprint256: c.fingerprint256 ?? null });
    c = c.issuerCertificate;
  }
  let hostnameOk = false;
  if (hostForCheck) {
    try {
      hostnameOk = tls.checkServerIdentity(hostForCheck, peer) === undefined;
    } catch {
      hostnameOk = false;
    }
  }
  const authErr = sock.authorized ? null : String(sock.authorizationError ?? 'UNKNOWN');
  const chainErr = authErr && authErr !== 'ERR_TLS_CERT_ALTNAME_INVALID' ? authErr : null;
  const notAfter = parseDate(peer.valid_to);
  let error: string | undefined;
  if (chainErr) error = TLS_ERRORS[chainErr] ?? clean(chainErr.toLowerCase().replace(/_/g, ' '), 100);
  else if (!hostnameOk) error = TLS_ERRORS.ERR_TLS_CERT_ALTNAME_INVALID;
  const info: TlsInfo = {
    valid: !chainErr && hostnameOk,
    hostnameOk,
    subject: formatName(peer.subject as never),
    issuer: formatName(peer.issuer as never),
    sans: sansOf(peer),
    notBefore: parseDate(peer.valid_from),
    notAfter,
    fingerprint256: peer.fingerprint256 ?? null,
    chain,
  };
  if (error) info.error = error;
  return info;
}

/* -------------------------------------------------------------- connections */

/** Destroys the socket when `signal` aborts; swallows late 'error' events (no process crash). */
export function guardSocket(sock: Readable, signal: AbortSignal): void {
  sock.on('error', () => {});
  if (signal.aborted) {
    sock.destroy();
    return;
  }
  const onAbort = (): void => {
    sock.destroy();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  sock.once('close', () => signal.removeEventListener('abort', onAbort));
}

export function tcpConnect(address: string, family: 4 | 6, port: number, signal: AbortSignal): Promise<Socket> {
  if (!parseIp(address)) return Promise.reject(new NetError('EINVAL', 'not an IP literal'));
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<Socket>((resolve, reject) => {
    const sock = net.connect({ host: address, port, family, lookup: noLookup as never, noDelay: true, autoSelectFamily: false });
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      sock.removeListener('error', onError);
      sock.removeListener('connect', onConnect);
    };
    const onAbort = (): void => {
      cleanup();
      sock.destroy();
      reject(abortError(signal));
    };
    const onError = (err: unknown): void => {
      cleanup();
      sock.destroy();
      reject(mapSocketError(err));
    };
    const onConnect = (): void => {
      cleanup();
      resolve(sock);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    sock.once('error', onError);
    sock.once('connect', onConnect);
  });
}

export interface TlsOptions {
  /** SNI + hostname verification. IP literals are not sent as SNI but still verified against IP SANs. */
  servername?: string | null;
  rejectUnauthorized: boolean;
  alpn?: string[];
  cert?: string;
  key?: string;
  ca?: string;
}

/**
 * TLS handshake on an established socket (also used for STARTTLS). The handshake always runs with
 * rejectUnauthorized=false so that the certificate is captured; when the caller asked for
 * verification and the certificate is invalid the socket is destroyed before any application
 * data is sent and a TlsCertificateError (with the captured info) is thrown.
 */
export function upgradeTls(sock: Duplex, opts: TlsOptions & { hostForCheck: string | null; signal: AbortSignal }): Promise<{ socket: TLSSocket; tlsMs: number; tls: TlsInfo }> {
  if (opts.signal.aborted) {
    sock.destroy();
    return Promise.reject(abortError(opts.signal));
  }
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const sni = opts.servername && !parseIp(opts.servername) ? opts.servername : undefined;
    const tsock = tls.connect({
      socket: sock,
      servername: sni,
      rejectUnauthorized: false,
      ALPNProtocols: opts.alpn,
      cert: opts.cert,
      key: opts.key,
      ca: opts.ca,
    });
    const cleanup = (): void => {
      opts.signal.removeEventListener('abort', onAbort);
      tsock.removeListener('error', onError);
      tsock.removeListener('secureConnect', onSecure);
    };
    const onAbort = (): void => {
      cleanup();
      tsock.destroy();
      sock.destroy();
      reject(abortError(opts.signal));
    };
    const onError = (err: unknown): void => {
      cleanup();
      tsock.destroy();
      sock.destroy();
      reject(mapSocketError(err));
    };
    const onSecure = (): void => {
      cleanup();
      const info = buildTlsInfo(tsock, opts.hostForCheck ?? opts.servername ?? null);
      if (opts.rejectUnauthorized && !info.valid) {
        tsock.destroy();
        sock.destroy();
        reject(new TlsCertificateError(info.error ?? 'certificate invalid', info));
        return;
      }
      tlsInfos.set(tsock, info);
      guardSocket(tsock, opts.signal);
      resolve({ socket: tsock, tlsMs: performance.now() - started, tls: info });
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    tsock.once('error', onError);
    tsock.once('secureConnect', onSecure);
  });
}

const RETRYABLE = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ECONNRESET', 'EAFNOSUPPORT']);

/** Connects to the checked addresses in order (max 3 attempts) and optionally upgrades to TLS. */
export async function connectResolved(
  target: ResolvedTarget,
  port: number,
  opts: { signal: AbortSignal; tls?: TlsOptions; hostForCheck?: string },
): Promise<{ socket: Socket | TLSSocket; remoteAddress: string; connectMs: number; tlsMs: number; tls?: TlsInfo }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NetError('EINVAL', 'invalid port');
  const order = connectOrder(target.addresses).slice(0, 3);
  let firstErr: unknown = null;
  for (const a of order) {
    const started = performance.now();
    let sock: Socket;
    try {
      sock = await tcpConnect(a.address, a.family, port, opts.signal);
    } catch (err) {
      firstErr ??= err;
      if (err instanceof NetError && RETRYABLE.has(err.code) && !opts.signal.aborted) continue;
      throw err;
    }
    const connectMs = performance.now() - started;
    guardSocket(sock, opts.signal);
    if (!opts.tls) return { socket: sock, remoteAddress: a.address, connectMs, tlsMs: 0 };
    const servername = opts.tls.servername ?? target.host;
    const up = await upgradeTls(sock, { ...opts.tls, servername, hostForCheck: opts.hostForCheck ?? servername, signal: opts.signal });
    return { socket: up.socket, remoteAddress: a.address, connectMs, tlsMs: up.tlsMs, tls: up.tls };
  }
  throw firstErr ?? new NetError('ENOTFOUND', 'host not found');
}

/* ------------------------------------------------------------------ reader */

/**
 * Bounded, abort-aware reader over a socket for line/length based protocols. Every read fails
 * once more than `maxBytes` arrived in total, the peer closed, or the signal aborted.
 */
export class SocketReader {
  private buf: Buffer = Buffer.alloc(0);
  private total = 0;
  private ended = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;
  private attached = true;

  constructor(
    private readonly sock: Duplex,
    private readonly signal: AbortSignal,
    private readonly maxBytes = 1 << 20,
  ) {
    sock.on('data', this.onData);
    sock.on('end', this.onEnd);
    sock.on('close', this.onEnd);
    sock.on('error', this.onError);
    signal.addEventListener('abort', this.notify, { once: true });
  }

  private notify = (): void => {
    const w = this.wake;
    this.wake = null;
    w?.();
  };

  private onData = (chunk: Buffer): void => {
    this.total += chunk.length;
    if (this.total > this.maxBytes) {
      this.error = new NetError('ETOOLARGE', 'response too large');
      this.sock.destroy();
    } else {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    }
    this.notify();
  };

  private onEnd = (): void => {
    this.ended = true;
    this.notify();
  };

  private onError = (err: unknown): void => {
    this.error ??= mapSocketError(err);
    this.notify();
  };

  private async waitFor<T>(take: () => T | undefined): Promise<T> {
    for (;;) {
      const v = take();
      if (v !== undefined) return v;
      if (this.signal.aborted) {
        this.sock.destroy();
        throw abortError(this.signal);
      }
      if (this.error) throw this.error;
      if (this.ended || !this.attached) throw new NetError('ECLOSED', 'connection closed by peer');
      await new Promise<void>((r) => {
        this.wake = r;
      });
    }
  }

  /** Exactly n bytes. */
  read(n: number): Promise<Buffer> {
    if (n > this.maxBytes) return Promise.reject(new NetError('ETOOLARGE', 'response too large'));
    return this.waitFor(() => {
      if (this.buf.length < n) return undefined;
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      return out;
    });
  }

  /** Whatever is buffered (at least one byte). */
  readSome(): Promise<Buffer> {
    return this.waitFor(() => {
      if (this.buf.length === 0) return undefined;
      const out = this.buf;
      this.buf = Buffer.alloc(0);
      return out;
    });
  }

  /** One line terminated by LF (CR stripped), at most maxLen bytes, decoded as latin1. */
  readLine(maxLen = 1024): Promise<string> {
    return this.waitFor(() => {
      const i = this.buf.indexOf(0x0a);
      if (i < 0) {
        if (this.buf.length > maxLen) throw new NetError('ETOOLARGE', 'line too long');
        return undefined;
      }
      if (i > maxLen) throw new NetError('ETOOLARGE', 'line too long');
      let line = this.buf.subarray(0, i);
      this.buf = this.buf.subarray(i + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      return line.toString('latin1');
    });
  }

  /** Stops reading (before a STARTTLS upgrade); returns bytes buffered but not consumed. */
  detach(): Buffer {
    this.attached = false;
    this.sock.removeListener('data', this.onData);
    this.sock.removeListener('end', this.onEnd);
    this.sock.removeListener('close', this.onEnd);
    this.sock.removeListener('error', this.onError);
    this.signal.removeEventListener('abort', this.notify);
    this.notify();
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

export function writeAll(sock: Duplex, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.write(data, (err) => (err ? reject(mapSocketError(err)) : resolve()));
  });
}
