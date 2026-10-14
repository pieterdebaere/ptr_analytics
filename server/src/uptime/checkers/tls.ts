// `tls`: certificate check of host:port — DOWN when the certificate is invalid (untrusted chain,
// hostname mismatch, expired) or expires in fewer than `minDaysLeft` days.
import { ValidationError, type CheckerDefinition } from '../types.js';
import { tlsInfoOf } from '../net/index.js';
import { normalizeHostname } from '../net/policy.js';
import { HOST_FIELD, IP_FAMILY_FIELD, bool, daysLeft, down, familyNum, guarded, host, hostPort, int, ipFamily, ms, port, portField, str, up } from './common.js';

export interface TlsConfig {
  host: string;
  port: number;
  /** SNI / name to verify when it differs from host (e.g. host is an IP). */
  servername: string;
  minDaysLeft: number;
  ignoreTls: boolean;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

export const tlsChecker: CheckerDefinition<TlsConfig, Record<string, never>> = {
  type: 'tls',
  label: 'TLS certificate',
  description: 'Connects to host:port with TLS and checks validity, hostname and remaining lifetime of the certificate.',
  category: 'network',
  fields: [
    HOST_FIELD,
    portField(443),
    { key: 'minDaysLeft', label: 'Minimum days left', kind: 'number', default: 7, min: 0, max: 365, group: 'Certificate', help: 'DOWN when the certificate expires in fewer days.' },
    { key: 'servername', label: 'Server name (SNI)', kind: 'text', maxLength: 253, group: 'Advanced', help: 'Name to send and verify; defaults to the hostname.' },
    {
      key: 'ignoreTls',
      label: 'Only check expiry',
      kind: 'boolean',
      default: false,
      group: 'Certificate',
      help: 'Do not require a trusted chain or a matching hostname (self-signed certificates).',
    },
    IP_FAMILY_FIELD,
  ],
  defaults: { intervalS: 3600, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    const sn = str(input, 'servername', { max: 253 });
    let servername = '';
    if (sn) {
      const n = normalizeHostname(sn.replace(/^\*\./, ''));
      if (!n) throw new ValidationError('servername must be a hostname', 'servername');
      servername = n;
    }
    return {
      config: {
        host: host(input, 'host', ctx),
        port: port(input, 'port', 443),
        servername,
        minDaysLeft: int(input, 'minDaysLeft', { min: 0, max: 365, def: 7 }),
        ignoreTls: bool(input, 'ignoreTls'),
        ipFamily: ipFamily(input),
      },
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
        tls: { servername: c.servername || undefined, rejectUnauthorized: false },
      });
      conn.socket.destroy();
      const info = tlsInfoOf(conn.socket);
      const extra = { latencyMs: ms(conn.connectMs + conn.tlsMs), tls: info, meta: { remoteAddress: conn.remoteAddress } };
      if (!info) return down('No TLS certificate', extra);
      const left = daysLeft(info.notAfter);
      if (info.notAfter !== null && info.notAfter < Date.now()) return down('Certificate has expired', extra);
      if (info.notBefore !== null && info.notBefore > Date.now()) return down('Certificate is not yet valid', extra);
      if (!info.valid && !c.ignoreTls) return down(`Certificate invalid: ${info.error ?? 'unknown error'}`, extra);
      if (left === null) return down('Certificate has no expiry date', extra);
      if (left < c.minDaysLeft) return down(`Certificate expires in ${left} days (minimum ${c.minDaysLeft})`, extra);
      return up(`Certificate ${info.valid ? 'valid' : 'accepted'}, expires in ${left} days`, extra);
    });
  },
  target: (c) => hostPort(c.host, c.port),
  certHost: (c) => c.servername || c.host,
};
