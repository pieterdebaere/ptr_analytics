// `postgres`: protocol handshake only (no credentials, no queries). Optional SSLRequest + TLS,
// then a StartupMessage; an authentication request ('R') or an error ('E') proves the server is
// answering. "Starting up / shutting down" (57P03) and "too many connections" (53300) are DOWN.
import { ValidationError, type CheckerDefinition, type TlsInfo } from '../types.js';
import { SocketReader, upgradeTls, writeAll, type NetSocket } from '../net/index.js';
import { HOST_FIELD, IGNORE_TLS_FIELD, IP_FAMILY_FIELD, bool, down, familyNum, guarded, host, hostPort, ipFamily, ms, oneOf, port, portField, protoError, str, tlsSummary, up } from './common.js';

export interface PostgresConfig {
  host: string;
  port: number;
  sslMode: 'disable' | 'require';
  ignoreTls: boolean;
  username: string;
  database: string;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

export function startupMessage(user: string, database: string): Buffer {
  const params = Buffer.from(`user\0${user}\0database\0${database}\0application_name\0ptr-uptime\0\0`, 'utf8');
  const b = Buffer.alloc(8);
  b.writeInt32BE(8 + params.length, 0);
  b.writeInt32BE(196608, 4);
  return Buffer.concat([b, params]);
}

export function sslRequest(): Buffer {
  const b = Buffer.alloc(8);
  b.writeInt32BE(8, 0);
  b.writeInt32BE(80877103, 4);
  return b;
}

/** Parses the fields of an ErrorResponse body (type byte → value). */
export function parseErrorFields(body: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < body.length && out.size < 32) {
    const t = body[i++]!;
    if (t === 0) break;
    const end = body.indexOf(0, i);
    if (end < 0) break;
    out.set(String.fromCharCode(t), body.subarray(i, end).toString('utf8'));
    i = end + 1;
  }
  return out;
}

const NAME_RE = /^[A-Za-z0-9_.@-]{1,63}$/;

export const postgresChecker: CheckerDefinition<PostgresConfig, Record<string, never>> = {
  type: 'postgres',
  label: 'PostgreSQL',
  description: 'Checks that a PostgreSQL server answers the protocol handshake (no login, no queries).',
  category: 'protocol',
  fields: [
    HOST_FIELD,
    portField(5432),
    {
      key: 'sslMode',
      label: 'TLS',
      kind: 'select',
      default: 'disable',
      group: 'Target',
      options: [
        { value: 'disable', label: 'Off' },
        { value: 'require', label: 'Require (SSLRequest)' },
      ],
    },
    { ...IGNORE_TLS_FIELD, showIf: { key: 'sslMode', equals: ['require'] } },
    { key: 'username', label: 'User name sent in the handshake', kind: 'text', default: 'postgres', maxLength: 63, group: 'Advanced' },
    { key: 'database', label: 'Database', kind: 'text', default: 'postgres', maxLength: 63, group: 'Advanced' },
    IP_FAMILY_FIELD,
  ],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    const sslMode = oneOf(input, 'sslMode', ['disable', 'require'] as const, 'disable');
    const username = str(input, 'username', { max: 63, def: 'postgres' });
    const database = str(input, 'database', { max: 63, def: 'postgres' });
    for (const [k, v] of [
      ['username', username],
      ['database', database],
    ] as const) {
      if (!NAME_RE.test(v)) throw new ValidationError(`${k} may only contain letters, digits, _ . @ -`, k);
    }
    return {
      config: { host: host(input, 'host', ctx), port: port(input, 'port', 5432), sslMode, ignoreTls: sslMode === 'require' && bool(input, 'ignoreTls'), username, database, ipFamily: ipFamily(input) },
      secrets: {},
    };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const c = ctx.config;
      const started = performance.now();
      const conn = await ctx.net.connect({ host: c.host, port: c.port, family: familyNum(c.ipFamily), signal: ctx.signal });
      let sock: NetSocket = conn.socket;
      let tls: TlsInfo | undefined;
      const meta = { remoteAddress: conn.remoteAddress };
      try {
        let reader = new SocketReader(sock, ctx.signal, 64 * 1024);
        if (c.sslMode === 'require') {
          await writeAll(sock, sslRequest());
          const answer = (await reader.read(1))[0];
          if (answer === 0x4e) return down('Server does not support TLS', { meta });
          if (answer !== 0x53) throw protoError('not a PostgreSQL server');
          const rest = reader.detach();
          if (rest.length > 0) throw protoError('unexpected data before TLS handshake');
          const upd = await upgradeTls(sock, { servername: c.host, hostForCheck: c.host, rejectUnauthorized: !c.ignoreTls, signal: ctx.signal });
          sock = upd.socket;
          tls = upd.tls;
          reader = new SocketReader(sock, ctx.signal, 64 * 1024);
        }
        await writeAll(sock, startupMessage(c.username, c.database));
        for (let n = 0; n < 4; n++) {
          const head = await reader.read(5);
          const type = String.fromCharCode(head[0]!);
          const len = head.readInt32BE(1);
          if (len < 4 || len > 16 * 1024) throw protoError('not a PostgreSQL server');
          const body = await reader.read(len - 4);
          const latencyMs = ms(performance.now() - started);
          const extra = { latencyMs, tls, meta };
          if (type === 'R') {
            const code = body.length >= 4 ? body.readInt32BE(0) : -1;
            const what = code === 0 ? 'no authentication required' : code === 10 ? 'SASL authentication requested' : code === 5 ? 'MD5 authentication requested' : code === 3 ? 'password requested' : 'authentication requested';
            sock.write(Buffer.from([0x58, 0, 0, 0, 4]));
            return up(`PostgreSQL ready (${what})${tlsSummary(tls)}`, extra);
          }
          if (type === 'E') {
            const f = parseErrorFields(body);
            const code = (f.get('C') ?? '').replace(/[^0-9A-Z]/g, '').slice(0, 5);
            if (code === '57P03' || code === '53300' || code === '57P01') return down(`PostgreSQL not accepting connections (${code})`, extra);
            return up(`PostgreSQL alive (error ${code || 'unknown'})${tlsSummary(tls)}`, extra);
          }
          if (type === 'N') continue; // NoticeResponse
          throw protoError('not a PostgreSQL server');
        }
        throw protoError('unexpected PostgreSQL response');
      } finally {
        setTimeout(() => sock.destroy(), 100).unref();
      }
    });
  },
  target: (c) => hostPort(c.host, c.port),
  certHost: (c) => (c.sslMode === 'require' ? c.host : null),
};

