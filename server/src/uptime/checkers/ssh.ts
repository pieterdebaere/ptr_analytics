// `ssh`: reads the SSH identification string (RFC 4253 §4.2, `SSH-2.0-…`), optionally requires a
// substring, sends our own identification and closes. No key exchange, no login.
import type { CheckerDefinition } from '../types.js';
import { SocketReader, writeAll } from '../net/index.js';
import { HOST_FIELD, IP_FAMILY_FIELD, clip, down, familyNum, guarded, host, hostPort, ipFamily, ms, port, portField, str, up } from './common.js';

export interface SshConfig {
  host: string;
  port: number;
  expectedBanner: string;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

export const sshChecker: CheckerDefinition<SshConfig, Record<string, never>> = {
  type: 'ssh',
  label: 'SSH banner',
  description: 'Connects to an SSH server and checks its identification banner (no login).',
  category: 'protocol',
  fields: [
    HOST_FIELD,
    portField(22),
    { key: 'expectedBanner', label: 'Banner contains', kind: 'text', maxLength: 100, group: 'Expectation', placeholder: 'OpenSSH', help: 'Optional case-sensitive substring of the banner.' },
    IP_FAMILY_FIELD,
  ],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    return {
      config: { host: host(input, 'host', ctx), port: port(input, 'port', 22), expectedBanner: str(input, 'expectedBanner', { max: 100 }), ipFamily: ipFamily(input) },
      secrets: {},
    };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const c = ctx.config;
      const started = performance.now();
      const conn = await ctx.net.connect({ host: c.host, port: c.port, family: familyNum(c.ipFamily), signal: ctx.signal });
      const sock = conn.socket;
      try {
        const reader = new SocketReader(sock, ctx.signal, 16 * 1024);
        let banner: string | null = null;
        // Servers may send other lines before the identification string.
        for (let i = 0; i < 20; i++) {
          const line = await reader.readLine(255);
          if (line.startsWith('SSH-')) {
            banner = line;
            break;
          }
        }
        const latencyMs = ms(performance.now() - started);
        const meta = { remoteAddress: conn.remoteAddress };
        if (!banner) return down('No SSH identification string', { latencyMs, meta });
        const shown = clip(banner, 100);
        if (!/^SSH-(2\.0|1\.99)-/.test(banner)) return down(`Unsupported SSH protocol: ${shown}`, { latencyMs, meta });
        await writeAll(sock, 'SSH-2.0-PTR_Uptime\r\n').catch(() => undefined);
        if (c.expectedBanner && !banner.includes(c.expectedBanner)) return down(`Banner does not contain the expected text: ${shown}`, { latencyMs, meta });
        return up(shown, { latencyMs, meta });
      } finally {
        setTimeout(() => sock.destroy(), 100).unref();
      }
    });
  },
  target: (c) => hostPort(c.host, c.port),
};
