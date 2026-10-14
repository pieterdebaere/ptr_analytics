// `smtp`: greeting (220) + EHLO, optional STARTTLS (certificate captured) or implicit TLS (465),
// then QUIT. Never sends MAIL FROM / RCPT TO (no relay probing) and never authenticates.
import type { CheckerDefinition, TlsInfo } from '../types.js';
import { SocketReader, tlsInfoOf, upgradeTls, writeAll, type NetSocket } from '../net/index.js';
import { HOST_FIELD, IGNORE_TLS_FIELD, IP_FAMILY_FIELD, bool, down, familyNum, guarded, host, hostPort, ipFamily, ms, oneOf, port, portField, protoError, tlsSummary, up } from './common.js';

export interface SmtpConfig {
  host: string;
  port: number;
  security: 'plain' | 'starttls' | 'tls';
  ignoreTls: boolean;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

const EHLO_NAME = 'ptr-uptime.invalid';

/** Reads one (multi-line) SMTP reply: code + lines. */
export async function readReply(reader: SocketReader): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  for (;;) {
    const line = await reader.readLine(1000);
    const m = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!m) throw protoError('invalid SMTP reply');
    lines.push(m[3] ?? '');
    if (m[2] === ' ') return { code: Number(m[1]), lines };
    if (lines.length > 100) throw protoError('SMTP reply too long');
  }
}

export const smtpChecker: CheckerDefinition<SmtpConfig, Record<string, never>> = {
  type: 'smtp',
  label: 'SMTP server',
  description: 'Checks the SMTP greeting and EHLO, optionally STARTTLS or implicit TLS with certificate capture.',
  category: 'protocol',
  fields: [
    HOST_FIELD,
    portField(25),
    {
      key: 'security',
      label: 'Security',
      kind: 'select',
      default: 'starttls',
      group: 'Target',
      options: [
        { value: 'starttls', label: 'STARTTLS (required)' },
        { value: 'tls', label: 'Implicit TLS (SMTPS, port 465)' },
        { value: 'plain', label: 'None' },
      ],
    },
    { ...IGNORE_TLS_FIELD, showIf: { key: 'security', equals: ['starttls', 'tls'] } },
    IP_FAMILY_FIELD,
  ],
  defaults: { intervalS: 300, timeoutMs: 15_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    const security = oneOf(input, 'security', ['plain', 'starttls', 'tls'] as const, 'starttls');
    return {
      config: {
        host: host(input, 'host', ctx),
        port: port(input, 'port', security === 'tls' ? 465 : 25),
        security,
        ignoreTls: security !== 'plain' && bool(input, 'ignoreTls'),
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
        tls: c.security === 'tls' ? { rejectUnauthorized: !c.ignoreTls } : undefined,
      });
      let sock: NetSocket = conn.socket;
      let tls: TlsInfo | undefined = c.security === 'tls' ? tlsInfoOf(sock) : undefined;
      const meta = { remoteAddress: conn.remoteAddress };
      try {
        let reader = new SocketReader(sock, ctx.signal, 64 * 1024);
        const greet = await readReply(reader);
        if (greet.code !== 220) return down(`Unexpected greeting ${greet.code}`, { tls, meta });
        await writeAll(sock, `EHLO ${EHLO_NAME}\r\n`);
        let ehlo = await readReply(reader);
        if (ehlo.code !== 250) return down(`EHLO rejected (${ehlo.code})`, { tls, meta });
        if (c.security === 'starttls') {
          if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) return down('Server does not offer STARTTLS', { meta });
          await writeAll(sock, 'STARTTLS\r\n');
          const r = await readReply(reader);
          if (r.code !== 220) return down(`STARTTLS refused (${r.code})`, { meta });
          reader.detach();
          const upd = await upgradeTls(sock, { servername: c.host, hostForCheck: c.host, rejectUnauthorized: !c.ignoreTls, signal: ctx.signal });
          sock = upd.socket;
          tls = upd.tls;
          reader = new SocketReader(sock, ctx.signal, 64 * 1024);
          await writeAll(sock, `EHLO ${EHLO_NAME}\r\n`);
          ehlo = await readReply(reader);
          if (ehlo.code !== 250) return down(`EHLO after STARTTLS rejected (${ehlo.code})`, { tls, meta });
        }
        const latencyMs = ms(performance.now() - started);
        sock.write('QUIT\r\n');
        const mode = c.security === 'plain' ? '' : c.security === 'tls' ? ', TLS' : ', STARTTLS';
        return up(`SMTP ready${mode}${tlsSummary(tls)}`, { latencyMs, tls, meta });
      } finally {
        setTimeout(() => sock.destroy(), 200).unref();
        conn.socket.on('error', () => {});
      }
    });
  },
  target: (c) => hostPort(c.host, c.port),
  certHost: (c) => (c.security === 'plain' ? null : c.host),
};
