// `mongodb`: OP_MSG `{hello: 1, $db: "admin"}` (allowed without authentication) and a minimal,
// bounds-checked BSON decoder for the top-level fields of the reply (`ok`, role flags).
import { randomInt } from 'node:crypto';
import type { CheckerDefinition } from '../types.js';
import { SocketReader, tlsInfoOf, writeAll } from '../net/index.js';
import { HOST_FIELD, IGNORE_TLS_FIELD, IP_FAMILY_FIELD, bool, down, familyNum, guarded, host, hostPort, ipFamily, ms, port, portField, protoError, up } from './common.js';

export interface MongoConfig {
  host: string;
  port: number;
  tls: boolean;
  ignoreTls: boolean;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

const OP_MSG = 2013;

function cstring(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}

export function encodeHello(requestId: number): Buffer {
  const db = Buffer.from('admin', 'utf8');
  const strLen = Buffer.alloc(4);
  strLen.writeInt32LE(db.length + 1, 0);
  const one = Buffer.alloc(4);
  one.writeInt32LE(1, 0);
  const elements = Buffer.concat([Buffer.from([0x10]), cstring('hello'), one, Buffer.from([0x02]), cstring('$db'), strLen, db, Buffer.from([0])]);
  const doc = Buffer.alloc(4 + elements.length + 1);
  doc.writeInt32LE(doc.length, 0);
  elements.copy(doc, 4);
  doc[doc.length - 1] = 0;
  const header = Buffer.alloc(16 + 4 + 1);
  header.writeInt32LE(header.length + doc.length, 0);
  header.writeInt32LE(requestId, 4);
  header.writeInt32LE(0, 8);
  header.writeInt32LE(OP_MSG, 12);
  header.writeUInt32LE(0, 16); // flagBits
  header.writeUInt8(0, 20); // section kind 0 (body)
  return Buffer.concat([header, doc]);
}

export type BsonScalar = number | string | boolean | null;

/** Top-level scalar fields of a BSON document (nested documents/arrays are skipped). */
export function decodeBsonTop(buf: Buffer): Map<string, BsonScalar> {
  if (buf.length < 5) throw protoError('invalid BSON');
  const total = buf.readInt32LE(0);
  if (total < 5 || total > buf.length) throw protoError('invalid BSON length');
  const out = new Map<string, BsonScalar>();
  let i = 4;
  const need = (n: number): void => {
    if (n < 0 || i + n > total - 1) throw protoError('truncated BSON');
  };
  while (i < total - 1) {
    const type = buf[i++]!;
    const nameEnd = buf.indexOf(0, i);
    if (nameEnd < 0 || nameEnd >= total) throw protoError('invalid BSON name');
    const name = buf.subarray(i, nameEnd).toString('utf8');
    i = nameEnd + 1;
    let value: BsonScalar | undefined;
    switch (type) {
      case 0x01:
        need(8);
        value = buf.readDoubleLE(i);
        i += 8;
        break;
      case 0x02:
      case 0x0d:
      case 0x0e: {
        need(4);
        const l = buf.readInt32LE(i);
        need(4 + l);
        if (l < 1) throw protoError('invalid BSON string');
        value = buf.subarray(i + 4, i + 4 + l - 1).toString('utf8');
        i += 4 + l;
        break;
      }
      case 0x03:
      case 0x04:
      case 0x0f: {
        need(4);
        const l = buf.readInt32LE(i);
        if (l < 5) throw protoError('invalid BSON document');
        need(l);
        i += l;
        break;
      }
      case 0x05: {
        need(4);
        const l = buf.readInt32LE(i);
        if (l < 0) throw protoError('invalid BSON binary');
        need(5 + l);
        i += 5 + l;
        break;
      }
      case 0x06:
      case 0x0a:
      case 0x7f:
      case 0xff:
        value = null;
        break;
      case 0x07:
        need(12);
        i += 12;
        break;
      case 0x08:
        need(1);
        value = buf[i] === 1;
        i += 1;
        break;
      case 0x09:
      case 0x11:
        need(8);
        i += 8;
        break;
      case 0x12:
        need(8);
        value = Number(buf.readBigInt64LE(i));
        i += 8;
        break;
      case 0x10:
        need(4);
        value = buf.readInt32LE(i);
        i += 4;
        break;
      case 0x13:
        need(16);
        i += 16;
        break;
      case 0x0b: {
        for (let k = 0; k < 2; k++) {
          const e = buf.indexOf(0, i);
          if (e < 0 || e >= total) throw protoError('invalid BSON regex');
          i = e + 1;
        }
        break;
      }
      case 0x0c: {
        need(4);
        const l = buf.readInt32LE(i);
        if (l < 1) throw protoError('invalid BSON dbpointer');
        need(4 + l + 12);
        i += 4 + l + 12;
        break;
      }
      default:
        throw protoError('unsupported BSON type');
    }
    if (value !== undefined && out.size < 256) out.set(name, value);
  }
  return out;
}

/** Parses an OP_MSG reply and returns the top-level fields of its body section. */
export function parseOpMsg(msg: Buffer): Map<string, BsonScalar> {
  if (msg.length < 21) throw protoError('MongoDB reply too short');
  if (msg.readInt32LE(12) !== OP_MSG) throw protoError('not a MongoDB OP_MSG reply');
  let i = 20;
  while (i < msg.length) {
    const kind = msg[i++]!;
    if (kind === 0) return decodeBsonTop(msg.subarray(i));
    if (kind === 1) {
      if (i + 4 > msg.length) throw protoError('truncated OP_MSG');
      const l = msg.readInt32LE(i);
      if (l < 4 || i + l > msg.length) throw protoError('truncated OP_MSG');
      i += l;
      continue;
    }
    throw protoError('invalid OP_MSG section');
  }
  throw protoError('OP_MSG without body');
}

export const mongodbChecker: CheckerDefinition<MongoConfig, Record<string, never>> = {
  type: 'mongodb',
  label: 'MongoDB',
  description: 'Sends the MongoDB "hello" handshake command (no login) and checks ok: 1.',
  category: 'protocol',
  fields: [
    HOST_FIELD,
    portField(27017),
    { key: 'tls', label: 'Use TLS', kind: 'boolean', default: false, group: 'Target' },
    { ...IGNORE_TLS_FIELD, showIf: { key: 'tls', equals: [true] } },
    IP_FAMILY_FIELD,
  ],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    const tls = bool(input, 'tls');
    return { config: { host: host(input, 'host', ctx), port: port(input, 'port', 27017), tls, ignoreTls: tls && bool(input, 'ignoreTls'), ipFamily: ipFamily(input) }, secrets: {} };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const c = ctx.config;
      const started = performance.now();
      const conn = await ctx.net.connect({ host: c.host, port: c.port, family: familyNum(c.ipFamily), signal: ctx.signal, tls: c.tls ? { rejectUnauthorized: !c.ignoreTls } : undefined });
      const sock = conn.socket;
      const tls = c.tls ? tlsInfoOf(sock) : undefined;
      try {
        const reader = new SocketReader(sock, ctx.signal, 1024 * 1024);
        const reqId = randomInt(1, 0x7fffffff);
        await writeAll(sock, encodeHello(reqId));
        const head = await reader.read(16);
        const len = head.readInt32LE(0);
        if (len < 21 || len > 1024 * 1024) throw protoError('not a MongoDB server');
        if (head.readInt32LE(8) !== reqId) throw protoError('MongoDB reply does not match the request');
        const rest = await reader.read(len - 16);
        const fields = parseOpMsg(Buffer.concat([head, rest]));
        const extra = { latencyMs: ms(performance.now() - started), tls, meta: { remoteAddress: conn.remoteAddress } };
        const ok = fields.get('ok');
        if (ok !== 1 && ok !== true) return down('MongoDB hello failed (ok: 0)', extra);
        const role = fields.get('isWritablePrimary') === true || fields.get('ismaster') === true ? 'primary' : fields.get('secondary') === true ? 'secondary' : fields.get('msg') === 'isdbgrid' ? 'mongos' : fields.get('arbiterOnly') === true ? 'arbiter' : 'standalone/other';
        return up(`MongoDB ok (${role})`, extra);
      } finally {
        sock.destroy();
      }
    });
  },
  target: (c) => hostPort(c.host, c.port),
  certHost: (c) => (c.tls ? c.host : null),
};
