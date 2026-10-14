// `mqtt`: MQTT 3.1.1 CONNECT / CONNACK (optionally with username/password, optionally over TLS),
// then DISCONNECT. No subscriptions, no publishing.
import { randomBytes } from 'node:crypto';
import type { CheckerDefinition } from '../types.js';
import { SocketReader, tlsInfoOf, writeAll } from '../net/index.js';
import { HOST_FIELD, IGNORE_TLS_FIELD, IP_FAMILY_FIELD, bool, down, familyNum, guarded, host, hostPort, ipFamily, ms, port, portField, protoError, secret, str, up } from './common.js';

export interface MqttConfig {
  host: string;
  port: number;
  tls: boolean;
  ignoreTls: boolean;
  username: string;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

const CONNACK_CODES = ['accepted', 'unacceptable protocol version', 'client identifier rejected', 'server unavailable', 'bad user name or password', 'not authorized'];

function mqttString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length, 0);
  return Buffer.concat([l, b]);
}

function remainingLength(n: number): Buffer {
  const out: number[] = [];
  let x = n;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    out.push(byte);
  } while (x > 0);
  return Buffer.from(out);
}

export function encodeConnect(clientId: string, username?: string, password?: string): Buffer {
  let flags = 0x02; // clean session
  if (username !== undefined && username !== '') flags |= 0x80;
  if (password !== undefined && password !== '') flags |= 0x40;
  const parts = [mqttString('MQTT'), Buffer.from([4, flags, 0, 30]), mqttString(clientId)];
  if (flags & 0x80) parts.push(mqttString(username!));
  if (flags & 0x40) parts.push(mqttString(password!));
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x10]), remainingLength(body.length), body]);
}

export const mqttChecker: CheckerDefinition<MqttConfig, { password?: string }> = {
  type: 'mqtt',
  label: 'MQTT broker',
  description: 'Connects to an MQTT 3.1.1 broker (CONNECT/CONNACK) and disconnects.',
  category: 'protocol',
  fields: [
    HOST_FIELD,
    portField(1883),
    { key: 'tls', label: 'Use TLS', kind: 'boolean', default: false, group: 'Target', help: 'Usually port 8883.' },
    { ...IGNORE_TLS_FIELD, showIf: { key: 'tls', equals: [true] } },
    { key: 'username', label: 'Username', kind: 'text', maxLength: 255, group: 'Authentication' },
    { key: 'password', label: 'Password', kind: 'password', secret: true, maxLength: 1024, group: 'Authentication' },
    IP_FAMILY_FIELD,
  ],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    const tls = bool(input, 'tls');
    const password = secret(input, 'password', ctx, { max: 1024 });
    return {
      config: {
        host: host(input, 'host', ctx),
        port: port(input, 'port', tls ? 8883 : 1883),
        tls,
        ignoreTls: tls && bool(input, 'ignoreTls'),
        username: str(input, 'username', { max: 255 }),
        ipFamily: ipFamily(input),
      },
      secrets: password !== undefined ? { password } : {},
    };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const c = ctx.config;
      const started = performance.now();
      const conn = await ctx.net.connect({ host: c.host, port: c.port, family: familyNum(c.ipFamily), signal: ctx.signal, tls: c.tls ? { rejectUnauthorized: !c.ignoreTls } : undefined });
      const sock = conn.socket;
      const tls = c.tls ? tlsInfoOf(sock) : undefined;
      try {
        const reader = new SocketReader(sock, ctx.signal, 16 * 1024);
        await writeAll(sock, encodeConnect(`ptr-uptime-${randomBytes(6).toString('hex')}`, c.username || undefined, ctx.secrets.password));
        const pkt = await reader.read(4);
        if (pkt[0] !== 0x20 || pkt[1] !== 0x02) throw protoError('not an MQTT broker (no CONNACK)');
        const rc = pkt[3]!;
        const extra = { latencyMs: ms(performance.now() - started), tls, meta: { remoteAddress: conn.remoteAddress } };
        if (rc !== 0) return down(`Connection refused: ${CONNACK_CODES[rc] ?? `code ${rc}`}`, extra);
        sock.write(Buffer.from([0xe0, 0x00]));
        return up('CONNACK accepted', extra);
      } finally {
        setTimeout(() => sock.destroy(), 100).unref();
      }
    });
  },
  target: (c) => hostPort(c.host, c.port),
  certHost: (c) => (c.tls ? c.host : null),
};
