// SSRF guard: IP parsing, classification, policy matrix, resolution (rebinding, mixed records).
import { describe, expect, it } from 'vitest';
import { classifyIp, embeddedIPv4, formatIp, normalizeIp, parseIp } from '../src/uptime/net/ip.js';
import { TargetPolicy, normalizeHost, normalizeHostname } from '../src/uptime/net/policy.js';
import { createSafeNet, type HostResolver } from '../src/uptime/net/index.js';
import { TargetDeniedError } from '../src/uptime/types.js';
import { signal, uptimeConfig } from './uptime-net-fixtures.js';

function policy(env: Record<string, string> = {}, extra: { selfAddresses?: string[]; hostedMember?: boolean } = {}): TargetPolicy {
  return new TargetPolicy({ config: uptimeConfig(env), ...extra });
}

function allowed(p: TargetPolicy, ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) throw new Error(`not an ip: ${ip}`);
  return p.checkIp(parsed).ok;
}

describe('ip parsing', () => {
  it('accepts only strict literals', () => {
    for (const s of ['127.1', '0x7f.0.0.1', '0177.0.0.1', '2130706433', '010.0.0.1', '1.2.3', '1.2.3.4.5', '256.1.1.1', 'fe80::1%eth0', '', 'localhost', '[::1', '::g']) {
      expect(parseIp(s), s).toBeNull();
    }
    expect(normalizeIp('[::1]')).toBe('::1');
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('::ffff:7f00:1');
    expect(normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(normalizeIp('1:0:0:2:0:0:0:3')).toBe('1:0:0:2::3');
    expect(formatIp(parseIp('8.8.4.4')!)).toBe('8.8.4.4');
  });

  it('extracts embedded IPv4 addresses', () => {
    const e = (s: string): string | null => {
      const r = embeddedIPv4(parseIp(s)!);
      return r ? formatIp(r) : null;
    };
    expect(e('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(e('::ffff:a01:203')).toBe('10.1.2.3');
    expect(e('::ffff:0:10.1.2.3')).toBe('10.1.2.3');
    expect(e('::10.1.2.3')).toBe('10.1.2.3');
    expect(e('64:ff9b::7f00:1')).toBe('127.0.0.1');
    expect(e('2002:a9fe:a9fe::1')).toBe('169.254.169.254');
    // Teredo: client address is the bitwise complement of the last 32 bits.
    expect(e('2001:0:4136:e378:8000:63bf:80ff:fffe')).toBe('127.0.0.1');
    expect(e('::1')).toBeNull();
    expect(e('::')).toBeNull();
    expect(e('2606:4700::1111')).toBeNull();
  });

  it('classifies address ranges', () => {
    const cases: Array<[string, string]> = [
      ['0.0.0.0', 'unspecified'],
      ['0.1.2.3', 'unspecified'],
      ['255.255.255.255', 'broadcast'],
      ['224.0.0.1', 'multicast'],
      ['239.255.255.250', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['169.254.169.254', 'metadata'],
      ['169.254.170.2', 'metadata'],
      ['100.100.100.200', 'metadata'],
      ['192.0.0.192', 'metadata'],
      ['10.0.0.1', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['172.32.0.1', 'public'],
      ['192.168.1.1', 'private'],
      ['127.0.0.1', 'private'],
      ['100.64.0.1', 'private'],
      ['192.0.2.1', 'special'],
      ['198.18.0.1', 'special'],
      ['203.0.113.9', 'special'],
      ['8.8.8.8', 'public'],
      ['::', 'unspecified'],
      ['::1', 'private'],
      ['fe80::1', 'metadata'],
      ['fd00:ec2::254', 'metadata'],
      ['fc00::1', 'private'],
      ['fd12:3456::1', 'private'],
      ['fec0::1', 'private'],
      ['ff02::1', 'multicast'],
      ['2001:db8::1', 'special'],
      ['100::1', 'special'],
      ['::ffff:169.254.169.254', 'metadata'],
      ['::ffff:8.8.8.8', 'public'],
      ['64:ff9b::a9fe:a9fe', 'metadata'],
      ['2002:0a00:0001::1', 'private'],
      ['2001:0:4136:e378:8000:63bf:80ff:fffe', 'private'],
      ['4000::1', 'reserved'],
      ['2606:4700:4700::1111', 'public'],
    ];
    for (const [ip, cat] of cases) expect(classifyIp(parseIp(ip)!), ip).toBe(cat);
  });
});

describe('hostname validation', () => {
  it('rejects numeric-looking and malformed names', () => {
    for (const s of ['127.1', '0x7f000001', '2130706433', 'a..b', '-a.com', 'a-.com', 'exa mple.com', 'a'.repeat(64) + '.com', 'x.0x1f', '']) {
      expect(normalizeHostname(s), s).toBeNull();
    }
    expect(normalizeHostname('Example.COM.')).toBe('example.com');
    expect(normalizeHostname('Bücher.example')).toBe('xn--bcher-kva.example');
    expect(normalizeHostname('_sip._tcp.example.com')).toBe('_sip._tcp.example.com');
    expect(normalizeHost('[2001:db8::1]')).toEqual({ host: '2001:db8::1', ip: expect.anything() });
    expect(normalizeHost('0177.0.0.1')).toBeNull();
  });
});

describe('target policy matrix', () => {
  it('self-hosted default (private allowed) still blocks metadata, unspecified, multicast', () => {
    const p = policy();
    expect(allowed(p, '10.0.0.5')).toBe(true);
    expect(allowed(p, '127.0.0.1')).toBe(true);
    expect(allowed(p, '::1')).toBe(true);
    expect(allowed(p, '8.8.8.8')).toBe(true);
    expect(allowed(p, '169.254.169.254')).toBe(false);
    expect(allowed(p, 'fd00:ec2::254')).toBe(false);
    expect(allowed(p, '100.100.100.200')).toBe(false);
    expect(allowed(p, '0.0.0.0')).toBe(false);
    expect(allowed(p, '224.0.0.251')).toBe(false);
    expect(allowed(p, '255.255.255.255')).toBe(false);
    expect(allowed(p, '::ffff:169.254.169.254')).toBe(false);
  });

  it('private deny mode blocks private, CGNAT, ULA, documentation and embedded forms', () => {
    const p = policy({ UPTIME_PRIVATE_TARGETS: 'deny' });
    for (const ip of ['10.0.0.1', '127.0.0.1', '127.255.0.1', '192.168.0.1', '172.20.1.1', '100.64.1.1', '::1', 'fc00::1', 'fd00::1', '192.0.2.10', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::', '2001:0:4136:e378:8000:63bf:80ff:fffe']) {
      expect(allowed(p, ip), ip).toBe(false);
    }
    expect(allowed(p, '93.184.216.34')).toBe(true);
    expect(allowed(p, '2606:4700::6810:84e5')).toBe(true);
    expect(allowed(p, '64:ff9b::808:808')).toBe(true);
  });

  it('metadata only with UPTIME_ALLOW_METADATA', () => {
    const p = policy({ UPTIME_ALLOW_METADATA: 'true' });
    expect(allowed(p, '169.254.169.254')).toBe(true);
    expect(allowed(p, 'fe80::1')).toBe(true);
    expect(p.checkHostname('metadata.google.internal').ok).toBe(true);
    expect(policy().checkHostname('metadata.google.internal').ok).toBe(false);
    expect(policy().checkHostname('METADATA.google.internal.').ok).toBe(false);
  });

  it('hosted members never reach private ranges', () => {
    const p = new TargetPolicy({ config: uptimeConfig({}, true), hostedMember: true });
    expect(allowed(p, '10.0.0.1')).toBe(false);
    expect(allowed(p, '127.0.0.1')).toBe(false);
    expect(allowed(p, '8.8.8.8')).toBe(true);
    expect(p.checkHostname('localhost').ok).toBe(false);
    expect(p.checkHostname('foo.localhost').ok).toBe(false);
  });

  it('allow and deny lists (deny wins, hostnames exact or *.domain)', () => {
    const p = policy({
      UPTIME_PRIVATE_TARGETS: 'deny',
      UPTIME_TARGET_ALLOWLIST: '10.1.0.0/16,intranet.example,*.corp.example,93.184.216.34',
      UPTIME_TARGET_DENYLIST: '10.1.2.0/24,8.8.8.8,bad.example,*.evil.example,93.184.216.34',
    });
    expect(allowed(p, '10.1.5.5')).toBe(true);
    expect(allowed(p, '10.1.2.3')).toBe(false);
    expect(allowed(p, '::ffff:10.1.2.3')).toBe(false);
    expect(allowed(p, '10.2.0.1')).toBe(false);
    expect(allowed(p, '8.8.8.8')).toBe(false);
    expect(allowed(p, '93.184.216.34')).toBe(false);
    expect(p.checkHostname('bad.example').ok).toBe(false);
    expect(p.checkHostname('x.evil.example').ok).toBe(false);
    expect(p.checkHostname('evil.example').ok).toBe(true);
    expect(p.checkHostname('intranet.example')).toEqual({ ok: true, allowlisted: true });
    expect(p.checkHostname('a.corp.example')).toEqual({ ok: true, allowlisted: true });
    expect(p.checkHostname('corp.example')).toEqual({ ok: true, allowlisted: false });
    // Allow-listed hostname may resolve to private addresses, but never to metadata.
    expect(p.checkIp(parseIp('192.168.1.1')!, { hostAllowlisted: true }).ok).toBe(true);
    expect(p.checkIp(parseIp('169.254.169.254')!, { hostAllowlisted: true }).ok).toBe(false);
    // Allow list never re-enables unspecified / multicast.
    const p2 = policy({ UPTIME_TARGET_ALLOWLIST: '0.0.0.0/0' });
    expect(allowed(p2, '0.0.0.0')).toBe(false);
    expect(allowed(p2, '224.0.0.1')).toBe(false);
  });

  it('self addresses are always denied', () => {
    const p = policy({}, { selfAddresses: ['203.0.114.7', 'analytics.example.com', '2a01:4f8::/32'] });
    expect(allowed(p, '203.0.114.7')).toBe(false);
    expect(allowed(p, '::ffff:203.0.114.7')).toBe(false);
    expect(allowed(p, '2a01:4f8::1')).toBe(false);
    expect(p.checkHostname('analytics.example.com').ok).toBe(false);
  });
});

describe('SafeNet.resolve', () => {
  const fake = (map: Record<string, { 4?: string[]; 6?: string[] }>): HostResolver => {
    return async (host, family) => {
      const r = map[host]?.[family];
      if (!r) throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
      return r;
    };
  };

  it('checks every resolved address (rebinding to private, mixed records)', async () => {
    const resolver = fake({
      'public.test': { 4: ['93.184.216.34'], 6: ['2606:2800:220:1::1'] },
      'rebind.test': { 4: ['127.0.0.1'] },
      'mixed.test': { 4: ['93.184.216.34', '10.0.0.1'] },
      'mixed6.test': { 4: ['93.184.216.34'], 6: ['::ffff:169.254.169.254'] },
      'meta.test': { 4: ['169.254.169.254'] },
    });
    const net = createSafeNet({ config: uptimeConfig({ UPTIME_PRIVATE_TARGETS: 'deny' }), resolver });
    const r = await net.resolve('Public.Test.', { signal: signal() });
    expect(r.host).toBe('public.test');
    expect(r.addresses).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
    expect((await net.resolve('public.test', { family: 6, signal: signal() })).addresses).toEqual([{ address: '2606:2800:220:1::1', family: 6 }]);
    for (const h of ['rebind.test', 'mixed.test', 'mixed6.test', 'meta.test', '127.0.0.1', '[::1]', 'localhost', 'x.localhost']) {
      await expect(net.resolve(h, { signal: signal() }), h).rejects.toBeInstanceOf(TargetDeniedError);
    }
    await expect(net.resolve('missing.test', { signal: signal() })).rejects.toMatchObject({ code: 'ENOTFOUND' });
    await expect(net.resolve('127.1', { signal: signal() })).rejects.toMatchObject({ code: 'EINVALIDHOST' });
    await expect(net.resolve('0x7f000001', { signal: signal() })).rejects.toMatchObject({ code: 'EINVALIDHOST' });
  });

  it('resolves localhost without DNS and allows it in self-hosted default mode', async () => {
    let calls = 0;
    const net = createSafeNet({
      config: uptimeConfig(),
      resolver: async () => {
        calls++;
        return [];
      },
    });
    const r = await net.resolve('localhost', { signal: signal() });
    expect(r.addresses.map((a) => a.address)).toEqual(['127.0.0.1', '::1']);
    expect(calls).toBe(0);
  });

  it('assertAllowed works on IP literals only', () => {
    const net = createSafeNet({ config: uptimeConfig({ UPTIME_PRIVATE_TARGETS: 'deny' }) });
    expect(() => net.assertAllowed('8.8.8.8')).not.toThrow();
    expect(() => net.assertAllowed('10.0.0.1')).toThrow(TargetDeniedError);
    expect(() => net.assertAllowed('example.com')).toThrow();
  });

  it('honours an aborted signal', async () => {
    const net = createSafeNet({ config: uptimeConfig(), resolver: () => new Promise(() => {}) });
    const ac = new AbortController();
    const p = net.resolve('slow.test', { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'EABORT' });
    await expect(net.resolve('slow.test', { signal: ac.signal })).rejects.toMatchObject({ code: 'EABORT' });
  });

  it('URL literal forms are normalised by the WHATWG parser and then denied', async () => {
    const net = createSafeNet({ config: uptimeConfig({ UPTIME_PRIVATE_TARGETS: 'deny' }) });
    for (const u of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::ffff:7f00:1]/', 'http://[::1]:8080/', 'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/', 'http://[fd00:ec2::254]/']) {
      await expect(net.request({ url: u, maxBodyBytes: 1024, signal: signal() }), u).rejects.toBeInstanceOf(TargetDeniedError);
    }
    await expect(net.request({ url: 'file:///etc/passwd', maxBodyBytes: 1024, signal: signal() })).rejects.toMatchObject({ code: 'EINVALIDURL' });
    await expect(net.request({ url: 'http://user:pw@example.com/', maxBodyBytes: 1024, signal: signal() })).rejects.toMatchObject({ code: 'EINVALIDURL' });
    await expect(net.request({ url: 'gopher://example.com/', maxBodyBytes: 1024, signal: signal() })).rejects.toMatchObject({ code: 'EINVALIDURL' });
  });
});
