// `redis`: RESP `PING` (optionally `AUTH [user] password` first, optionally over TLS).
// `+PONG` → UP; `-NOAUTH` without configured password → UP (server alive, auth required).
import type { CheckerDefinition } from '../types.js';
import { SocketReader, tlsInfoOf, writeAll } from '../net/index.js';
import { HOST_FIELD, IGNORE_TLS_FIELD, IP_FAMILY_FIELD, bool, down, familyNum, guarded, host, hostPort, ipFamily, ms, port, portField, secret, str, up } from './common.js';

export interface RedisConfig {
  host: string;
  port: number;
  tls: boolean;
  ignoreTls: boolean;
  username: string;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

export function respCommand(...args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.from(a, 'utf8');
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

function errCode(line: string): string {
  return (/^-([A-Z][A-Z0-9_]{0,31})/.exec(line)?.[1] ?? 'ERR').slice(0, 32);
}

export const redisChecker: CheckerDefinition<RedisConfig, { password?: string }> = {
  type: 'redis',
  label: 'Redis',
  description: 'Sends PING (and AUTH when configured) to a Redis server.',
  category: 'protocol',
  fields: [
    HOST_FIELD,
    portField(6379),
    { key: 'tls', label: 'Use TLS', kind: 'boolean', default: false, group: 'Target' },
    { ...IGNORE_TLS_FIELD, showIf: { key: 'tls', equals: [true] } },
    { key: 'username', label: 'Username (ACL)', kind: 'text', maxLength: 255, group: 'Authentication' },
    { key: 'password', label: 'Password', kind: 'password', secret: true, maxLength: 1024, group: 'Authentication' },
    IP_FAMILY_FIELD,
  ],
  defaults: { intervalS: 60, timeoutMs: 5_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    const tls = bool(input, 'tls');
    const password = secret(input, 'password', ctx, { max: 1024 });
    return {
      config: {
        host: host(input, 'host', ctx),
        port: port(input, 'port', 6379),
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
      const meta = { remoteAddress: conn.remoteAddress };
      try {
        const reader = new SocketReader(sock, ctx.signal, 64 * 1024);
        const pw = ctx.secrets.password;
        if (pw) await writeAll(sock, c.username ? respCommand('AUTH', c.username, pw) : respCommand('AUTH', pw));
        await writeAll(sock, respCommand('PING'));
        if (pw) {
          const auth = await reader.readLine(4096);
          if (!auth.startsWith('+')) return down(`Authentication failed (${errCode(auth)})`, { tls, meta });
        }
        const line = await reader.readLine(4096);
        const latencyMs = ms(performance.now() - started);
        sock.write(respCommand('QUIT'));
        if (line === '+PONG') return up('PONG', { latencyMs, tls, meta });
        if (line.startsWith('-NOAUTH') && !pw) return up('Server alive (authentication required)', { latencyMs, tls, meta });
        if (line.startsWith('-LOADING')) return down('Redis is loading the dataset', { latencyMs, tls, meta });
        if (line.startsWith('-')) return down(`Redis error ${errCode(line)}`, { latencyMs, tls, meta });
        return down('Unexpected reply to PING', { latencyMs, tls, meta });
      } finally {
        setTimeout(() => sock.destroy(), 100).unref();
      }
    });
  },
  target: (c) => hostPort(c.host, c.port),
  certHost: (c) => (c.tls ? c.host : null),
};
