// `mysql`: reads the server's initial handshake packet (protocol 10 + version string). No login.
// Error packets: 1129/1130 (host blocked / not allowed) still prove the server answers → UP;
// 1040 (too many connections) and others → DOWN.
import type { CheckerDefinition } from '../types.js';
import { SocketReader } from '../net/index.js';
import { HOST_FIELD, IP_FAMILY_FIELD, clip, down, familyNum, guarded, host, hostPort, ipFamily, ms, port, portField, protoError, up } from './common.js';

export interface MysqlConfig {
  host: string;
  port: number;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

export type MysqlGreeting = { kind: 'handshake'; version: string; protocol: number } | { kind: 'error'; code: number };

/** Parses the payload of the first packet (bounds-checked). */
export function parseGreeting(payload: Buffer): MysqlGreeting {
  if (payload.length < 1) throw protoError('empty MySQL packet');
  if (payload[0] === 0xff) {
    if (payload.length < 3) throw protoError('truncated MySQL error packet');
    return { kind: 'error', code: payload.readUInt16LE(1) };
  }
  if (payload[0] !== 10 && payload[0] !== 9) throw protoError('not a MySQL server');
  const end = payload.indexOf(0, 1);
  if (end < 0 || end > 81) throw protoError('invalid MySQL handshake');
  return { kind: 'handshake', protocol: payload[0]!, version: clip(payload.subarray(1, end).toString('latin1'), 60) };
}

export const mysqlChecker: CheckerDefinition<MysqlConfig, Record<string, never>> = {
  type: 'mysql',
  label: 'MySQL / MariaDB',
  description: 'Reads the MySQL/MariaDB server greeting (no login, no queries).',
  category: 'protocol',
  fields: [HOST_FIELD, portField(3306), IP_FAMILY_FIELD],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    return { config: { host: host(input, 'host', ctx), port: port(input, 'port', 3306), ipFamily: ipFamily(input) }, secrets: {} };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const c = ctx.config;
      const started = performance.now();
      const conn = await ctx.net.connect({ host: c.host, port: c.port, family: familyNum(c.ipFamily), signal: ctx.signal });
      const sock = conn.socket;
      try {
        const reader = new SocketReader(sock, ctx.signal, 64 * 1024);
        const head = await reader.read(4);
        const len = head[0]! | (head[1]! << 8) | (head[2]! << 16);
        if (len === 0 || len > 16 * 1024) throw protoError('not a MySQL server');
        const g = parseGreeting(await reader.read(len));
        const extra = { latencyMs: ms(performance.now() - started), meta: { remoteAddress: conn.remoteAddress } };
        if (g.kind === 'handshake') return up(`MySQL ${g.version}`, extra);
        if (g.code === 1129 || g.code === 1130) return up(`Server alive (error ${g.code}: host not allowed)`, extra);
        if (g.code === 1040) return down('Too many connections (1040)', extra);
        return down(`MySQL error ${g.code}`, extra);
      } finally {
        sock.destroy();
      }
    });
  },
  target: (c) => hostPort(c.host, c.port),
};
