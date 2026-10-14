// DNS wire format (encoder, hostile-input parser + fuzzing), dnsQuery over UDP/TCP against a
// fake server, c-ares resolution through SafeNet against the same server, raw udp().
import dgram from 'node:dgram';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DnsParseError, encodeQuery, normalizeQueryName, parseMessage, reverseName, RR_TYPES } from '../src/uptime/net/dns-wire.js';
import { createSafeNet } from '../src/uptime/net/index.js';
import { TargetDeniedError } from '../src/uptime/types.js';
import { signal, uptimeConfig } from './uptime-net-fixtures.js';

/* --------------------------------------------------------- response builder */

function nameBytes(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const l of name.split('.').filter(Boolean)) parts.push(Buffer.from([l.length]), Buffer.from(l));
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
const u16 = (n: number): Buffer => Buffer.from([(n >> 8) & 255, n & 255]);
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

type Rec = { type: string; rdata: Buffer };
const ZONE: Record<string, Rec[]> = {
  'host.test': [
    { type: 'A', rdata: Buffer.from([93, 184, 216, 34]) },
    { type: 'AAAA', rdata: Buffer.from('26062800022000010000000000000001', 'hex') },
    { type: 'MX', rdata: Buffer.concat([u16(10), nameBytes('mail.host.test')]) },
    { type: 'TXT', rdata: Buffer.concat([Buffer.from([11]), Buffer.from('v=spf1 -all'), Buffer.from([3]), Buffer.from('abc')]) },
    { type: 'NS', rdata: nameBytes('ns1.host.test') },
    { type: 'SOA', rdata: Buffer.concat([nameBytes('ns1.host.test'), nameBytes('admin.host.test'), u32(2024010101), u32(3600), u32(600), u32(86400), u32(300)]) },
    { type: 'CAA', rdata: Buffer.concat([Buffer.from([0, 5]), Buffer.from('issue'), Buffer.from('letsencrypt.org')]) },
  ],
  '_sip._tcp.host.test': [{ type: 'SRV', rdata: Buffer.concat([u16(10), u16(60), u16(5060), nameBytes('sip.host.test')]) }],
  'www.host.test': [{ type: 'CNAME', rdata: nameBytes('host.test') }],
  'private.test': [{ type: 'A', rdata: Buffer.from([10, 0, 0, 1]) }],
  '4.3.2.1.in-addr.arpa': [{ type: 'PTR', rdata: nameBytes('ptr.host.test') }],
};
const BIG: Rec[] = Array.from({ length: 60 }, (_, i) => ({ type: 'TXT', rdata: Buffer.concat([Buffer.from([40]), Buffer.from(`record-${String(i).padStart(3, '0')}-`.padEnd(40, 'x'))]) }));

function respond(query: Buffer, tcp: boolean): Buffer {
  const q = parseMessage(query);
  const qname = q.question!.name.toLowerCase();
  const qtype = q.question!.type;
  const qEnd = 12 + nameBytes(qname).length + 4;
  let recs = (qname === 'big.test' ? BIG : ZONE[qname] ?? []).filter((r) => RR_TYPES[r.type] === qtype || (r.type === 'CNAME' && qtype !== RR_TYPES.CNAME));
  let tc = false;
  if (qname === 'big.test' && !tcp) {
    recs = [];
    tc = true;
  }
  const rcode = qname === 'nx.test' ? 3 : qname === 'fail.test' ? 2 : 0;
  const header = Buffer.concat([query.subarray(0, 2), u16(0x8180 | (tc ? 0x0200 : 0) | rcode), u16(1), u16(recs.length), u16(0), u16(0)]);
  const answers = recs.map((r) => Buffer.concat([Buffer.from([0xc0, 0x0c]), u16(RR_TYPES[r.type]!), u16(1), u32(300), u16(r.rdata.length), r.rdata]));
  return Buffer.concat([header, query.subarray(12, qEnd), ...answers]);
}

let dnsPort = 0;
const udpSrv = dgram.createSocket('udp4');
const tcpSrv = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
      const resp = respond(buf.subarray(2, 2 + buf.readUInt16BE(0)), true);
      sock.end(Buffer.concat([u16(resp.length), resp]));
    }
  });
  sock.on('error', () => {});
});
let echoPort = 0;
const echoSrv = dgram.createSocket('udp4');

beforeAll(async () => {
  udpSrv.on('message', (msg, rinfo) => {
    try {
      const q = parseMessage(msg);
      if (q.question?.name === 'silent.test') return;
      udpSrv.send(respond(msg, false), rinfo.port, rinfo.address);
    } catch {
      /* ignore garbage */
    }
  });
  await new Promise<void>((r) => udpSrv.bind(0, '127.0.0.1', () => r()));
  dnsPort = udpSrv.address().port;
  await new Promise<void>((r) => tcpSrv.listen(dnsPort, '127.0.0.1', () => r()));
  echoSrv.on('message', (msg, rinfo) => echoSrv.send(Buffer.concat([Buffer.from('echo:'), msg]), rinfo.port, rinfo.address));
  await new Promise<void>((r) => echoSrv.bind(0, '127.0.0.1', () => r()));
  echoPort = echoSrv.address().port;
});
afterAll(() => {
  udpSrv.close();
  echoSrv.close();
  tcpSrv.close();
});

/* -------------------------------------------------------------------- tests */

describe('dns wire format', () => {
  it('encodes queries and reverse names', () => {
    const q = encodeQuery(0x1234, 'example.com', 'MX', { edns: 1232 });
    const m = parseMessage(q);
    expect(m.id).toBe(0x1234);
    expect(m.qr).toBe(false);
    expect(m.question).toEqual({ name: 'example.com', type: 15 });
    expect(reverseName('1.2.3.4')).toBe('4.3.2.1.in-addr.arpa');
    expect(reverseName('2001:db8::1')).toBe('1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa');
    expect(normalizeQueryName('_sip._tcp.Example.com.')).toBe('_sip._tcp.example.com');
    expect(normalizeQueryName('bad..name')).toBeNull();
    expect(normalizeQueryName('a'.repeat(64))).toBeNull();
  });

  it('rejects compression loops, forward pointers and out-of-bounds data', () => {
    const header = Buffer.from([0, 1, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0]);
    // question name is a pointer to itself
    expect(() => parseMessage(Buffer.concat([header, Buffer.from([0xc0, 12, 0, 1, 0, 1])]))).toThrow(DnsParseError);
    // forward pointer
    expect(() => parseMessage(Buffer.concat([header, Buffer.from([0xc0, 20, 0, 1, 0, 1, 0, 0, 0, 0])]))).toThrow(DnsParseError);
    // label longer than the message
    expect(() => parseMessage(Buffer.concat([header, Buffer.from([30, 97, 98])]))).toThrow(DnsParseError);
    // answer count without answers
    const hdr2 = Buffer.from([0, 1, 0x81, 0x80, 0, 0, 0, 5, 0, 0, 0, 0]);
    expect(() => parseMessage(hdr2)).toThrow(DnsParseError);
    // A record with wrong rdlength
    const bad = Buffer.concat([Buffer.from([0, 1, 0x81, 0x80, 0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from([0]), u16(1), u16(1), u32(1), u16(3), Buffer.from([1, 2, 3])]);
    expect(() => parseMessage(bad)).toThrow(DnsParseError);
    expect(() => parseMessage(Buffer.alloc(5))).toThrow(DnsParseError);
  });

  it('survives fuzzing: random bytes and mutated valid responses only throw DnsParseError', () => {
    const valid = Object.keys(ZONE).flatMap((n) => ['A', 'AAAA', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'SRV', 'CNAME', 'PTR'].map((t) => respond(encodeQuery(7, n, t), true)));
    let parsed = 0;
    for (let i = 0; i < 20_000; i++) {
      let buf: Buffer;
      if (i % 2 === 0) {
        buf = randomBytes(Math.floor(Math.random() * 300));
        if (buf.length > 4 && i % 4 === 0) buf[4] = 0; // plausible counts
      } else {
        buf = Buffer.from(valid[i % valid.length]!);
        const flips = 1 + Math.floor(Math.random() * 6);
        for (let f = 0; f < flips; f++) buf[Math.floor(Math.random() * buf.length)] = Math.floor(Math.random() * 256);
        if (i % 3 === 0) buf = buf.subarray(0, Math.floor(Math.random() * buf.length));
      }
      try {
        const m = parseMessage(buf);
        expect(m.answers.length).toBeLessThanOrEqual(512);
        for (const a of m.answers) expect(typeof a.value).toBe('string');
        parsed++;
      } catch (err) {
        if (!(err instanceof DnsParseError)) throw err;
      }
    }
    expect(parsed).toBeGreaterThan(0);
  });
});

describe('SafeNet.dnsQuery', () => {
  const sn = createSafeNet({ config: uptimeConfig() });
  const q = (name: string, type: string) => sn.dnsQuery({ server: '127.0.0.1', port: dnsPort, name, type, signal: signal() });

  it('queries every supported record type', async () => {
    expect((await q('host.test', 'A')).answers).toEqual([{ type: 'A', value: '93.184.216.34', ttl: 300 }]);
    expect((await q('host.test', 'AAAA')).answers[0]?.value).toBe('2606:2800:220:1::1');
    expect((await q('host.test', 'MX')).answers[0]?.value).toBe('10 mail.host.test');
    expect((await q('host.test', 'TXT')).answers[0]?.value).toBe('v=spf1 -allabc');
    expect((await q('host.test', 'NS')).answers[0]?.value).toBe('ns1.host.test');
    expect((await q('host.test', 'SOA')).answers[0]?.value).toBe('ns1.host.test admin.host.test 2024010101 3600 600 86400 300');
    expect((await q('host.test', 'CAA')).answers[0]?.value).toBe('0 issue "letsencrypt.org"');
    expect((await q('_sip._tcp.host.test', 'SRV')).answers[0]?.value).toBe('10 60 5060 sip.host.test');
    expect((await q('www.host.test', 'CNAME')).answers[0]?.value).toBe('host.test');
    expect((await q('1.2.3.4', 'PTR')).answers[0]?.value).toBe('ptr.host.test');
    const nx = await q('nx.test', 'A');
    expect(nx.rcode).toBe('NXDOMAIN');
    expect(nx.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('falls back to TCP when the UDP answer is truncated', async () => {
    const r = await q('big.test', 'TXT');
    expect(r.answers).toHaveLength(60);
  });

  it('times out on a silent server and checks the resolver address', async () => {
    await expect(sn.dnsQuery({ server: '127.0.0.1', port: dnsPort, name: 'silent.test', type: 'A', signal: AbortSignal.timeout(200) })).rejects.toMatchObject({ code: 'ETIMEOUT' });
    const deny = createSafeNet({ config: uptimeConfig({ UPTIME_PRIVATE_TARGETS: 'deny' }) });
    await expect(deny.dnsQuery({ server: '127.0.0.1', port: dnsPort, name: 'host.test', type: 'A', signal: signal() })).rejects.toBeInstanceOf(TargetDeniedError);
    await expect(sn.dnsQuery({ server: '127.0.0.1', port: dnsPort, name: 'host.test', type: 'HINFO', signal: signal() })).rejects.toMatchObject({ code: 'EINVAL' });
  });
});

describe('SafeNet with c-ares against a local resolver', () => {
  it('resolves through dns.Resolver and applies the policy to the answers', async () => {
    const sn = createSafeNet({ config: uptimeConfig({ UPTIME_PRIVATE_TARGETS: 'deny' }), dnsServers: [`127.0.0.1:${dnsPort}`] });
    const r = await sn.resolve('host.test', { signal: signal() });
    expect(r.addresses).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
    await expect(sn.resolve('private.test', { signal: signal() })).rejects.toBeInstanceOf(TargetDeniedError);
    await expect(sn.resolve('nx.test', { signal: signal() })).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });
});

describe('SafeNet.udp', () => {
  it('exchanges one datagram with a checked destination', async () => {
    const sn = createSafeNet({ config: uptimeConfig() });
    const r = await sn.udp({ host: '127.0.0.1', port: echoPort, payload: Buffer.from('ping'), signal: signal() });
    expect(r.data.toString()).toBe('echo:ping');
    expect(r.remoteAddress).toBe('127.0.0.1');
    const deny = createSafeNet({ config: uptimeConfig({ UPTIME_PRIVATE_TARGETS: 'deny' }) });
    await expect(deny.udp({ host: '127.0.0.1', port: echoPort, payload: Buffer.from('x'), signal: signal() })).rejects.toBeInstanceOf(TargetDeniedError);
    await expect(sn.udp({ host: '127.0.0.1', port: dnsPort + 1 === echoPort ? dnsPort + 2 : dnsPort + 1, payload: Buffer.from('x'), signal: AbortSignal.timeout(200) })).rejects.toBeDefined();
  });
});
