// `ping`: ICMP echo via the system ping binary (UPTIME_PING_BINARY). Only this module may run a
// process: execFile (never a shell), fixed argument vector, LC_ALL=C, the already resolved and
// policy-checked IP literal as the last argument (never the user's hostname → no option
// injection, no second resolution), timeout + kill.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { CheckerDefinition } from '../types.js';
import type { UptimeConfig } from '../config.js';
import { NetError } from '../net/errors.js';
import { parseIp } from '../net/ip.js';
import { HOST_FIELD, IP_FAMILY_FIELD, down, familyNum, guarded, host, int, ipFamily, isMember, up } from './common.js';

export interface PingConfig {
  host: string;
  count: number;
  perPacketTimeoutS: number;
  packetSize: number;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

const availability = new Map<string, { ok: boolean; at: number }>();

export function pingAvailable(bin: string | null): boolean {
  if (!bin || !bin.startsWith('/')) return false;
  const cached = availability.get(bin);
  if (cached && Date.now() - cached.at < 60_000) return cached.ok;
  let ok = false;
  try {
    ok = fs.statSync(bin).isFile();
    fs.accessSync(bin, fs.constants.X_OK);
  } catch {
    ok = false;
  }
  availability.set(bin, { ok, at: Date.now() });
  return ok;
}

/** Parses iputils / BusyBox output: received count and average RTT (ms). */
export function parsePingOutput(out: string): { transmitted: number | null; received: number | null; avgMs: number | null } {
  const stats = /(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets\s+)?received/.exec(out);
  const rtt = /(?:rtt|round-trip)\s+min\/avg\/max(?:\/(?:mdev|stddev))?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(out);
  return {
    transmitted: stats ? Number(stats[1]) : null,
    received: stats ? Number(stats[2]) : null,
    avgMs: rtt ? Number(rtt[2]) : null,
  };
}

/** Argument vector (exported for tests). The address must be a checked IP literal. */
export function pingArgs(address: string, c: Pick<PingConfig, 'count' | 'perPacketTimeoutS' | 'packetSize'>): string[] {
  const ip = parseIp(address);
  if (!ip) throw new NetError('EINVAL', 'not an IP literal');
  const args = ['-n', '-c', String(c.count), '-W', String(c.perPacketTimeoutS), '-s', String(c.packetSize)];
  if (ip.family === 6) args.unshift('-6');
  args.push(address);
  return args;
}

function run(bin: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env: { LC_ALL: 'C', LANG: 'C', PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, signal, windowsHide: true, shell: false },
      (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
        resolve({ code, out: String(stdout ?? '') });
      },
    );
  });
}

export const pingChecker: CheckerDefinition<PingConfig, Record<string, never>> = {
  type: 'ping',
  label: 'Ping (ICMP)',
  description: 'Sends ICMP echo requests with the system ping binary.',
  category: 'network',
  fields: [
    HOST_FIELD,
    { key: 'count', label: 'Packets', kind: 'number', default: 3, min: 1, max: 5, group: 'Ping' },
    { key: 'perPacketTimeoutS', label: 'Timeout per packet (s)', kind: 'number', default: 2, min: 1, max: 10, group: 'Ping' },
    { key: 'packetSize', label: 'Payload size (bytes)', kind: 'number', default: 56, min: 1, max: 1472, group: 'Advanced', help: 'Hosted members: max. 1472 (no fragmentation).' },
    IP_FAMILY_FIELD,
  ],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'restricted',
  available: (cfg: UptimeConfig) => pingAvailable(cfg.pingBinary),
  validate(input, ctx) {
    return {
      config: {
        host: host(input, 'host', ctx),
        count: int(input, 'count', { min: 1, max: 5, def: 3 }),
        perPacketTimeoutS: int(input, 'perPacketTimeoutS', { min: 1, max: 10, def: 2 }),
        packetSize: int(input, 'packetSize', { min: 1, max: isMember(ctx) ? 1472 : 65_500, def: 56 }),
        ipFamily: ipFamily(input),
      },
      secrets: {},
    };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const bin = ctx.uptime.pingBinary;
      if (!bin || !pingAvailable(bin)) return down('Ping is not available on this server');
      const c = ctx.config;
      const target = await ctx.net.resolve(c.host, { family: familyNum(c.ipFamily), signal: ctx.signal });
      const addr = target.addresses.find((a) => a.family === 4) ?? target.addresses[0]!;
      ctx.net.assertAllowed(addr.address);
      const r = await run(bin, pingArgs(addr.address, c), ctx.timeoutMs, ctx.signal);
      if (ctx.signal.aborted) return down(`Timeout after ${ctx.timeoutMs} ms`);
      const p = parsePingOutput(r.out);
      if (p.received !== null && p.received > 0) {
        const loss = p.transmitted ? Math.round(((p.transmitted - p.received) / p.transmitted) * 100) : 0;
        return up(`${p.received}/${p.transmitted ?? '?'} replies${loss ? ` (${loss}% loss)` : ''}${p.avgMs !== null ? `, avg ${p.avgMs} ms` : ''}`, {
          latencyMs: p.avgMs !== null ? Math.round(p.avgMs) : undefined,
          meta: { remoteAddress: addr.address, loss },
        });
      }
      if (p.transmitted !== null) return down(`No reply (${p.transmitted} packets sent)`, { meta: { remoteAddress: addr.address } });
      return down(r.code === null ? 'Ping could not be executed' : `Ping failed (exit code ${r.code})`);
    });
  },
  target: (c) => c.host,
};
