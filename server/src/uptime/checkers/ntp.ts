// `ntp`: one SNTPv4 client request over UDP (RFC 4330). Validates mode, version and the
// originate timestamp (anti-spoofing), reports stratum, offset and delay.
import { randomBytes } from 'node:crypto';
import type { CheckerDefinition } from '../types.js';
import { HOST_FIELD, IP_FAMILY_FIELD, down, familyNum, guarded, host, hostPort, int, ipFamily, port, portField, up } from './common.js';

export interface NtpConfig {
  host: string;
  port: number;
  maxStratum: number;
  maxOffsetMs: number;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

const NTP_EPOCH_OFFSET = 2_208_988_800; // seconds 1900 → 1970

export function toNtp(ms: number, buf: Buffer, off: number): void {
  const secs = Math.floor(ms / 1000) + NTP_EPOCH_OFFSET;
  const frac = Math.floor(((ms % 1000) / 1000) * 0x1_0000_0000);
  buf.writeUInt32BE(secs >>> 0, off);
  buf.writeUInt32BE(frac >>> 0, off + 4);
}

export function fromNtp(buf: Buffer, off: number): number {
  const secs = buf.readUInt32BE(off);
  const frac = buf.readUInt32BE(off + 4);
  return (secs - NTP_EPOCH_OFFSET) * 1000 + (frac / 0x1_0000_0000) * 1000;
}

export interface NtpReply {
  stratum: number;
  refId: string;
  offsetMs: number;
  delayMs: number;
  kissCode: string | null;
}

/** Builds the 48-byte request; the transmit timestamp carries random low bits (nonce). */
export function ntpRequest(nowMs: number): Buffer {
  const b = Buffer.alloc(48);
  b[0] = (0 << 6) | (4 << 3) | 3; // LI 0, VN 4, mode 3 (client)
  toNtp(nowMs, b, 40);
  randomBytes(2).copy(b, 46); // low fraction bits as nonce
  return b;
}

/** Parses and validates a reply to `req` received at t4. Throws on invalid packets. */
export function parseNtpReply(req: Buffer, res: Buffer, t1: number, t4: number): NtpReply {
  if (res.length < 48) throw new Error('NTP reply too short');
  const mode = res[0]! & 7;
  const vn = (res[0]! >> 3) & 7;
  if (mode !== 4 && mode !== 5) throw new Error('not an NTP server reply');
  if (vn < 3 || vn > 4) throw new Error('unsupported NTP version');
  if (!res.subarray(24, 32).equals(req.subarray(40, 48))) throw new Error('NTP reply does not match the request');
  const stratum = res[1]!;
  const refRaw = res.subarray(12, 16);
  const kissCode = stratum === 0 ? refRaw.toString('latin1').replace(/[^\x20-\x7e]/g, '') : null;
  const refId = stratum <= 1 ? refRaw.toString('latin1').replace(/[^\x20-\x7e]/g, '') : [...refRaw].join('.');
  const t2 = fromNtp(res, 32);
  const t3 = fromNtp(res, 40);
  return {
    stratum,
    refId,
    offsetMs: (t2 - t1 + (t3 - t4)) / 2,
    delayMs: t4 - t1 - (t3 - t2),
    kissCode,
  };
}

export const ntpChecker: CheckerDefinition<NtpConfig, Record<string, never>> = {
  type: 'ntp',
  label: 'NTP server',
  description: 'Queries an NTP server (SNTP) and checks stratum and clock offset.',
  category: 'protocol',
  fields: [
    HOST_FIELD,
    portField(123),
    { key: 'maxStratum', label: 'Maximum stratum', kind: 'number', default: 5, min: 1, max: 15, group: 'Thresholds' },
    { key: 'maxOffsetMs', label: 'Maximum offset (ms)', kind: 'number', default: 1000, min: 1, max: 3_600_000, group: 'Thresholds', help: 'Offset between the server clock and ours.' },
    IP_FAMILY_FIELD,
  ],
  defaults: { intervalS: 300, timeoutMs: 5_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    return {
      config: {
        host: host(input, 'host', ctx),
        port: port(input, 'port', 123),
        maxStratum: int(input, 'maxStratum', { min: 1, max: 15, def: 5 }),
        maxOffsetMs: int(input, 'maxOffsetMs', { min: 1, max: 3_600_000, def: 1000 }),
        ipFamily: ipFamily(input),
      },
      secrets: {},
    };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const c = ctx.config;
      const req = ntpRequest(Date.now());
      const r = await ctx.net.udp({ host: c.host, port: c.port, payload: req, signal: ctx.signal, family: familyNum(c.ipFamily) });
      const t4 = Date.now();
      let reply: NtpReply;
      try {
        reply = parseNtpReply(req, r.data, fromNtp(req, 40), t4);
      } catch (err) {
        return down((err as Error).message, { latencyMs: Math.round(r.latencyMs) });
      }
      const extra = { latencyMs: Math.round(r.latencyMs), meta: { stratum: reply.stratum, offsetMs: Math.round(reply.offsetMs * 10) / 10, remoteAddress: r.remoteAddress } };
      if (reply.kissCode !== null) return down(`Kiss-o'-Death: ${reply.kissCode || 'unknown'}`, extra);
      if (reply.stratum >= 16) return down('Server is unsynchronised (stratum 16)', extra);
      const desc = `Stratum ${reply.stratum}, offset ${reply.offsetMs.toFixed(1)} ms, delay ${Math.max(0, reply.delayMs).toFixed(1)} ms`;
      if (reply.stratum > c.maxStratum) return down(`${desc} (stratum above ${c.maxStratum})`, extra);
      if (Math.abs(reply.offsetMs) > c.maxOffsetMs) return down(`${desc} (offset above ${c.maxOffsetMs} ms)`, extra);
      return up(desc, extra);
    });
  },
  target: (c) => hostPort(c.host, c.port),
};
