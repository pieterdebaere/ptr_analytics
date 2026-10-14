// `tcp`: TCP connect (optionally TLS with certificate capture).
import type { CheckerDefinition } from '../types.js';
import { tlsInfoOf } from '../net/index.js';
import { HOST_FIELD, IGNORE_TLS_FIELD, IP_FAMILY_FIELD, bool, familyNum, guarded, host, hostPort, ipFamily, ms, port, portField, tlsSummary, up } from './common.js';

export interface TcpConfig {
  host: string;
  port: number;
  tls: boolean;
  ignoreTls: boolean;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

export const tcpChecker: CheckerDefinition<TcpConfig, Record<string, never>> = {
  type: 'tcp',
  label: 'TCP port',
  description: 'Opens a TCP connection (optionally TLS) to host:port.',
  category: 'network',
  fields: [
    HOST_FIELD,
    portField(443),
    { key: 'tls', label: 'Use TLS', kind: 'boolean', default: false, group: 'Target', help: 'Perform a TLS handshake and record the certificate.' },
    { ...IGNORE_TLS_FIELD, showIf: { key: 'tls', equals: [true] } },
    IP_FAMILY_FIELD,
  ],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    const tls = bool(input, 'tls');
    return {
      config: { host: host(input, 'host', ctx), port: port(input, 'port', 443), tls, ignoreTls: tls && bool(input, 'ignoreTls'), ipFamily: ipFamily(input) },
      secrets: {},
    };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const c = ctx.config;
      const conn = await ctx.net.connect({
        host: c.host,
        port: c.port,
        family: familyNum(c.ipFamily),
        signal: ctx.signal,
        tls: c.tls ? { rejectUnauthorized: !c.ignoreTls } : undefined,
      });
      conn.socket.destroy();
      const tls = c.tls ? tlsInfoOf(conn.socket) : undefined;
      return up(`Connected in ${ms(conn.connectMs)} ms${c.tls ? `, TLS certificate ${tls?.valid ? 'valid' : `invalid (${tls?.error ?? 'unknown error'}; ignored)`}${tlsSummary(tls)}` : ''}`, {
        latencyMs: ms(conn.connectMs + conn.tlsMs),
        tls,
        meta: { remoteAddress: conn.remoteAddress },
      });
    });
  },
  target: (c) => hostPort(c.host, c.port),
  certHost: (c) => (c.tls ? c.host : null),
};
