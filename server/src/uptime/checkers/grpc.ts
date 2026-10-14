// `grpc_health`: standard gRPC health check (grpc.health.v1.Health/Check) over node:http2 on a
// SafeNet connection (TLS with ALPN h2, or plaintext h2c with prior knowledge). The protobuf
// request/response are encoded/decoded by hand (field 1 only) — no proto parsing of user input.
import http2 from 'node:http2';
import type { CheckerDefinition } from '../types.js';
import { tlsInfoOf } from '../net/index.js';
import { HOST_FIELD, IGNORE_TLS_FIELD, IP_FAMILY_FIELD, bool, clip, down, familyNum, guarded, host, hostPort, ipFamily, ms, port, portField, protoError, str, up } from './common.js';

export interface GrpcConfig {
  host: string;
  port: number;
  tls: boolean;
  ignoreTls: boolean;
  service: string;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

const SERVING_STATUS = ['UNKNOWN', 'SERVING', 'NOT_SERVING', 'SERVICE_UNKNOWN'];
const GRPC_CODES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];

function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

/** gRPC frame (uncompressed) of HealthCheckRequest{service = 1}. */
export function encodeHealthRequest(service: string): Buffer {
  const s = Buffer.from(service, 'utf8');
  const msg = s.length === 0 ? Buffer.alloc(0) : Buffer.concat([Buffer.from([0x0a]), varint(s.length), s]);
  const hdr = Buffer.alloc(5);
  hdr.writeUInt8(0, 0);
  hdr.writeUInt32BE(msg.length, 1);
  return Buffer.concat([hdr, msg]);
}

/** Decodes the status (field 1, varint) of the first HealthCheckResponse frame; bounds-checked. */
export function decodeHealthResponse(buf: Buffer): number {
  if (buf.length < 5) throw protoError('empty gRPC response');
  if (buf[0] !== 0) throw protoError('compressed gRPC responses are not supported');
  const len = buf.readUInt32BE(1);
  if (len > buf.length - 5 || len > 4096) throw protoError('invalid gRPC frame');
  const msg = buf.subarray(5, 5 + len);
  let i = 0;
  let status = 0;
  const readVarint = (): number => {
    let shift = 0;
    let v = 0;
    for (let n = 0; n < 10; n++) {
      if (i >= msg.length) throw protoError('truncated protobuf');
      const b = msg[i++]!;
      if (shift < 28) v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) return v >>> 0;
    }
    throw protoError('invalid varint');
  };
  while (i < msg.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const v = readVarint();
      if (field === 1) status = v;
    } else if (wire === 2) {
      const l = readVarint();
      if (l > msg.length - i) throw protoError('truncated protobuf');
      i += l;
    } else if (wire === 1) {
      if (msg.length - i < 8) throw protoError('truncated protobuf');
      i += 8;
    } else if (wire === 5) {
      if (msg.length - i < 4) throw protoError('truncated protobuf');
      i += 4;
    } else {
      throw protoError('unsupported protobuf wire type');
    }
  }
  return status;
}

export const grpcChecker: CheckerDefinition<GrpcConfig, Record<string, never>> = {
  type: 'grpc_health',
  label: 'gRPC health',
  description: 'Calls the standard gRPC health service (grpc.health.v1.Health/Check).',
  category: 'protocol',
  fields: [
    HOST_FIELD,
    portField(443),
    { key: 'service', label: 'Service name', kind: 'text', maxLength: 255, group: 'Target', help: 'Empty = overall server health.' },
    { key: 'tls', label: 'Use TLS', kind: 'boolean', default: true, group: 'Target', help: 'Off = plaintext HTTP/2 (h2c).' },
    { ...IGNORE_TLS_FIELD, showIf: { key: 'tls', equals: [true] } },
    IP_FAMILY_FIELD,
  ],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    const tls = bool(input, 'tls', true);
    return {
      config: {
        host: host(input, 'host', ctx),
        port: port(input, 'port', 443),
        tls,
        ignoreTls: tls && bool(input, 'ignoreTls'),
        service: str(input, 'service', { max: 255 }),
        ipFamily: ipFamily(input),
      },
      secrets: {},
    };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const c = ctx.config;
      const started = performance.now();
      const conn = await ctx.net.connect({
        host: c.host,
        port: c.port,
        family: familyNum(c.ipFamily),
        signal: ctx.signal,
        tls: c.tls ? { rejectUnauthorized: !c.ignoreTls, alpn: ['h2'] } : undefined,
      });
      const sock = conn.socket;
      const tls = c.tls ? tlsInfoOf(sock) : undefined;
      const meta = { remoteAddress: conn.remoteAddress };
      if (c.tls && (sock as { alpnProtocol?: string | false }).alpnProtocol !== 'h2') {
        sock.destroy();
        return down('Server does not support HTTP/2 (ALPN)', { tls, meta });
      }
      const authority = hostPort(c.host, c.port);
      const session = http2.connect(`${c.tls ? 'https' : 'http'}://${authority}`, {
        createConnection: () => sock,
        maxHeaderListPairs: 100,
        maxSessionMemory: 2,
        settings: { enablePush: false, maxHeaderListSize: 16 * 1024 },
      });
      session.on('error', () => {});
      const onAbort = (): void => {
        session.destroy();
        sock.destroy();
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await new Promise<{ grpcStatus: number | null; grpcMessage: string; httpStatus: number; body: Buffer }>((resolve, reject) => {
          const stream = session.request({
            ':method': 'POST',
            ':path': '/grpc.health.v1.Health/Check',
            ':authority': authority,
            'content-type': 'application/grpc',
            te: 'trailers',
            'user-agent': ctx.userAgent,
            'grpc-timeout': `${Math.max(1, ctx.timeoutMs)}m`,
          });
          let httpStatus = 0;
          let grpcStatus: number | null = null;
          let grpcMessage = '';
          const chunks: Buffer[] = [];
          let size = 0;
          const take = (h: http2.IncomingHttpHeaders): void => {
            const gs = h['grpc-status'];
            if (gs !== undefined) grpcStatus = Number(gs);
            const gm = h['grpc-message'];
            if (typeof gm === 'string') {
              try {
                grpcMessage = decodeURIComponent(gm);
              } catch {
                grpcMessage = gm;
              }
            }
          };
          stream.on('response', (h) => {
            httpStatus = Number(h[':status'] ?? 0);
            take(h);
          });
          stream.on('trailers', take);
          stream.on('data', (d: Buffer) => {
            size += d.length;
            if (size > 64 * 1024) {
              stream.destroy();
              reject(protoError('gRPC response too large'));
              return;
            }
            chunks.push(d);
          });
          stream.on('end', () => resolve({ grpcStatus, grpcMessage, httpStatus, body: Buffer.concat(chunks) }));
          stream.on('error', (e) => reject(e));
          stream.on('close', () => reject(protoError('HTTP/2 stream closed')));
          session.on('error', (e) => reject(e));
          stream.end(encodeHealthRequest(c.service));
        });
        if (ctx.signal.aborted) throw protoError('aborted');
        const latencyMs = ms(performance.now() - started);
        const extra = { latencyMs, tls, meta };
        if (result.httpStatus !== 200) return down(`HTTP/2 status ${result.httpStatus}`, extra);
        if (result.grpcStatus === null) return down('Missing grpc-status', extra);
        if (result.grpcStatus !== 0) {
          const name = GRPC_CODES[result.grpcStatus] ?? String(result.grpcStatus);
          if (result.grpcStatus === 12) return down('Health service not implemented (UNIMPLEMENTED)', extra);
          if (result.grpcStatus === 5) return down('Service unknown (NOT_FOUND)', extra);
          return down(clip(`gRPC ${name}${result.grpcMessage ? `: ${result.grpcMessage}` : ''}`, 160), extra);
        }
        const st = decodeHealthResponse(result.body);
        const name = SERVING_STATUS[st] ?? `status ${st}`;
        return st === 1 ? up(`SERVING${c.service ? ` (${clip(c.service, 60)})` : ''}`, extra) : down(name, extra);
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
        session.close();
        setTimeout(() => {
          session.destroy();
          sock.destroy();
        }, 100).unref();
      }
    });
  },
  target: (c) => `${hostPort(c.host, c.port)}${c.service ? ` (${c.service})` : ''}`,
  certHost: (c) => (c.tls ? c.host : null),
};
