// Regression tests for the SSRF / checker security review (audit findings M2, L1–L5).
import { promises as dnsp } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyIp, parseIp } from '../src/uptime/net/ip.js';
import { TargetPolicy } from '../src/uptime/net/policy.js';
import { createSafeNet, dnsServersFor, limitRequest, redirectAllowed, type HostResolver } from '../src/uptime/net/index.js';
import { errorMessage } from '../src/uptime/checkers/common.js';
import { UptimeConfigError } from '../src/uptime/config.js';
import { TargetDeniedError } from '../src/uptime/types.js';
import { close, listen, opensslAvailable, signal, testCerts, testNet, uptimeConfig } from './uptime-net-fixtures.js';

const ip = (s: string) => parseIp(s)!;

describe('M2: provider-internal service addresses are metadata', () => {
  it('classifies Azure WireServer, Alibaba, Tencent and link-local metadata addresses', () => {
    for (const a of ['168.63.129.16', '::ffff:168.63.129.16', '64:ff9b::a83f:8110', '100.100.100.200', '169.254.0.23', '169.254.169.254', '169.254.42.42']) {
      expect(classifyIp(ip(a)), a).toBe('metadata');
    }
    // Neighbours of the Azure address stay public.
    expect(classifyIp(ip('168.63.129.15'))).toBe('public');
    expect(classifyIp(ip('168.63.129.17'))).toBe('public');
  });

  it('denies them for members and in the self-hosted default; UPTIME_ALLOW_METADATA re-enables (self-hosted)', () => {
    const member = new TargetPolicy({ config: uptimeConfig({}, true), hostedMember: true });
    const self = new TargetPolicy({ config: uptimeConfig() });
    const meta = new TargetPolicy({ config: uptimeConfig({ UPTIME_ALLOW_METADATA: 'true' }) });
    for (const a of ['168.63.129.16', '::ffff:168.63.129.16']) {
      expect(member.checkIp(ip(a)).ok, a).toBe(false);
      expect(self.checkIp(ip(a)).ok, a).toBe(false);
      expect(meta.checkIp(ip(a)).ok, a).toBe(true);
    }
    expect(member.checkHostname('metadata.google.internal').ok).toBe(false);
    expect(member.checkHostname('metadata.tencentyun.com').ok).toBe(false);
  });

  it('an operator deny list covers further provider addresses', () => {
    const p = new TargetPolicy({ config: uptimeConfig({ UPTIME_TARGET_DENYLIST: '198.51.100.0/24,203.0.114.0/24' }) });
    expect(p.checkIp(ip('203.0.114.9')).ok).toBe(false);
  });
});

describe('L1: the allow list never applies to hosted members', () => {
  const env = { UPTIME_TARGET_ALLOWLIST: '10.1.0.0/16,intranet.example,169.254.169.254/32,127.0.0.2/32' };

  it('policy ignores allow-listed CIDRs and hostnames for members only', () => {
    const member = new TargetPolicy({ config: uptimeConfig(env, true), hostedMember: true });
    const operator = new TargetPolicy({ config: uptimeConfig(env, true) });
    for (const a of ['10.1.2.3', '127.0.0.2', '169.254.169.254', '::ffff:10.1.2.3']) {
      expect(member.checkIp(ip(a)).ok, a).toBe(false);
      expect(operator.checkIp(ip(a)).ok, a).toBe(true);
    }
    expect(member.checkHostname('intranet.example')).toEqual({ ok: true, allowlisted: false });
    expect(operator.checkHostname('intranet.example')).toEqual({ ok: true, allowlisted: true });
  });

  it('a member SafeNet refuses an allow-listed name resolving to a private address', async () => {
    const resolver: HostResolver = async (host, family) => (host === 'intranet.example' && family === 4 ? ['10.1.2.3'] : []);
    const member = createSafeNet({ config: uptimeConfig(env, true), hostedMember: true, resolver });
    await expect(member.resolve('intranet.example', { signal: signal() })).rejects.toBeInstanceOf(TargetDeniedError);
    await expect(member.resolve('127.0.0.2', { signal: signal() })).rejects.toBeInstanceOf(TargetDeniedError);
    const operator = createSafeNet({ config: uptimeConfig(env, true), resolver });
    expect((await operator.resolve('intranet.example', { signal: signal() })).addresses).toEqual([{ address: '10.1.2.3', family: 4 }]);
  });
});

describe('L2: member DNS resolution', () => {
  it('parses UPTIME_DNS_SERVERS and defaults members to public resolvers in hosted mode', () => {
    expect(uptimeConfig({}, true)).toMatchObject({ dnsServers: [], memberDnsServers: ['1.1.1.1', '8.8.8.8'] });
    expect(uptimeConfig()).toMatchObject({ dnsServers: [], memberDnsServers: [] });
    expect(uptimeConfig({ UPTIME_DNS_SERVERS: '9.9.9.9, [2620:FE::FE]' }, true)).toMatchObject({ dnsServers: ['9.9.9.9', '2620:fe::fe'], memberDnsServers: ['9.9.9.9', '2620:fe::fe'] });
    expect(uptimeConfig({ UPTIME_DNS_SERVERS: '10.0.0.2' })).toMatchObject({ dnsServers: ['10.0.0.2'], memberDnsServers: ['10.0.0.2'] });
    expect(uptimeConfig({ UPTIME_DNS_SERVERS: 'system' }, true)).toMatchObject({ dnsServers: [], memberDnsServers: [] });
    for (const bad of ['dns.google', '1.1.1.1:53', 'fe80::1%eth0', ',']) {
      expect(() => uptimeConfig({ UPTIME_DNS_SERVERS: bad }), bad).toThrow(UptimeConfigError);
    }
    const hosted = uptimeConfig({}, true);
    expect(dnsServersFor(hosted, true)).toEqual(['1.1.1.1', '8.8.8.8']);
    expect(dnsServersFor(hosted, false)).toEqual([]);
  });

  describe('c-ares resolver servers', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('member SafeNets query the member resolvers, operator SafeNets the system resolvers', async () => {
      const servers: string[][] = [];
      vi.spyOn(dnsp.Resolver.prototype, 'setServers').mockImplementation((s: readonly string[]) => {
        servers.push([...s]);
      });
      vi.spyOn(dnsp.Resolver.prototype, 'resolve4').mockImplementation((async () => ['93.184.216.34']) as never);
      vi.spyOn(dnsp.Resolver.prototype, 'resolve6').mockImplementation((async () => {
        throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
      }) as never);
      const config = uptimeConfig({}, true);
      await createSafeNet({ config, hostedMember: true }).resolve('example.com', { signal: signal() });
      expect(servers.length).toBeGreaterThan(0);
      for (const s of servers) expect(s).toEqual(['1.1.1.1', '8.8.8.8']);
      servers.length = 0;
      await createSafeNet({ config }).resolve('example.com', { signal: signal() });
      expect(servers).toEqual([]);
    });
  });

  it('members get one identical error for denied and non-existent names; admins keep the detail', async () => {
    const resolver: HostResolver = async (host, family) => {
      if (host === 'db.internal.test' && family === 4) return ['10.0.0.5'];
      if (host === 'meta.internal.test' && family === 4) return ['169.254.169.254'];
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    };
    const member = createSafeNet({ config: uptimeConfig({}, true), hostedMember: true, resolver });
    const errors: unknown[] = [];
    for (const h of ['db.internal.test', 'meta.internal.test', 'missing.internal.test']) {
      errors.push(await member.resolve(h, { signal: signal() }).catch((e: unknown) => e));
      errors.push(await member.request({ url: `https://${h}/`, maxBodyBytes: 1024, signal: signal() }).catch((e: unknown) => e));
    }
    for (const e of errors) {
      expect(e).toBeInstanceOf(TargetDeniedError);
      expect((e as Error).message).toBe('target not allowed');
      expect(errorMessage(e, 1000)).toBe('target not allowed');
    }
    const admin = createSafeNet({ config: uptimeConfig({ UPTIME_PRIVATE_TARGETS: 'deny' }), resolver });
    const missing = await admin.resolve('missing.internal.test', { signal: signal() }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'ENOTFOUND' });
    expect(errorMessage(missing, 1000)).toBe('Host not found');
    await expect(admin.resolve('db.internal.test', { signal: signal() })).rejects.toBeInstanceOf(TargetDeniedError);
  });
});

describe('L3: member request limits', () => {
  it('caps the response body and the request body for members only', () => {
    const config = uptimeConfig({}, true);
    expect(config.memberMaxBodyBytes).toBe(262_144);
    const base = { url: 'https://example.com/', maxBodyBytes: 1_048_576, signal: signal() };
    expect(limitRequest(base, config, true)).toMatchObject({ maxBodyBytes: 262_144, allowDowngrade: false });
    expect(limitRequest({ ...base, maxBodyBytes: 1000 }, config, true).maxBodyBytes).toBe(1000);
    expect(limitRequest({ ...base, allowDowngrade: true }, config, false)).toMatchObject({ maxBodyBytes: 1_048_576, allowDowngrade: true });
    expect(() => limitRequest({ ...base, body: 'x'.repeat(16 * 1024 + 1) }, config, true)).toThrow(/request body too large/);
    expect(() => limitRequest({ ...base, body: Buffer.alloc(16 * 1024) }, config, true)).not.toThrow();
    expect(() => limitRequest({ ...base, body: 'x'.repeat(64 * 1024) }, config, false)).not.toThrow();
    // MEMBER_MAX_BODY_BYTES is configurable but never above UPTIME_MAX_BODY_BYTES.
    expect(uptimeConfig({ MEMBER_MAX_BODY_BYTES: '65536' }, true).memberMaxBodyBytes).toBe(65_536);
    expect(uptimeConfig({ MEMBER_MAX_BODY_BYTES: '4194304', UPTIME_MAX_BODY_BYTES: '2097152' }, true).memberMaxBodyBytes).toBe(2_097_152);
  });

  it('a member SafeNet refuses an oversized request body before resolving anything', async () => {
    let calls = 0;
    const resolver: HostResolver = async () => {
      calls++;
      return ['93.184.216.34'];
    };
    const member = createSafeNet({ config: uptimeConfig({}, true), hostedMember: true, resolver });
    await expect(member.request({ url: 'https://example.com/', method: 'POST', body: 'x'.repeat(20_000), maxBodyBytes: 1024, signal: signal() })).rejects.toMatchObject({ code: 'EBODYTOOLARGE' });
    expect(calls).toBe(0);
  });
});

/* ------------------------------------------------- L4 redirects / L5 headers */

let port = 0;
let base = '';
let connections = 0;
let lastBody = '';
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    switch (u.pathname) {
      case '/echo':
        lastBody = body;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, body }));
        return;
      case '/307-cross':
        res.writeHead(307, { location: `http://localhost:${port}/echo` }).end();
        return;
      case '/308-same':
        res.writeHead(308, { location: '/echo' }).end();
        return;
      case '/301-cross':
        res.writeHead(301, { location: `http://localhost:${port}/echo` }).end();
        return;
      default:
        res.writeHead(404).end();
    }
  });
});
server.on('connection', () => connections++);

beforeAll(async () => {
  port = await listen(server);
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await close(server);
});

describe('L4: redirect policy', () => {
  it('redirectAllowed: downgrade only with allowDowngrade (never for members); body never re-sent cross-origin', () => {
    const u = (s: string) => new URL(s);
    expect(redirectAllowed(u('https://a.example/'), u('http://a.example/'), { hasBody: false })).toMatch(/https to http/);
    expect(redirectAllowed(u('https://a.example/'), u('http://a.example/'), { hasBody: false, allowDowngrade: true })).toBeNull();
    expect(redirectAllowed(u('https://a.example/'), u('http://a.example/'), { hasBody: false, allowDowngrade: true, hostedMember: true })).toMatch(/https to http/);
    expect(redirectAllowed(u('http://a.example/'), u('https://b.example/'), { hasBody: false })).toBeNull();
    expect(redirectAllowed(u('https://a.example/x'), u('https://a.example/y'), { hasBody: true })).toBeNull();
    expect(redirectAllowed(u('https://a.example/'), u('https://b.example/'), { hasBody: true })).toMatch(/re-send the request body/);
    expect(redirectAllowed(u('https://a.example/'), u('https://a.example:8443/'), { hasBody: true })).toMatch(/re-send the request body/);
  });

  it('refuses a cross-origin 307 (or 301 of a PUT) that would re-send the body; same-origin 308 keeps it', async () => {
    const net = testNet();
    lastBody = '';
    await expect(net.request({ url: `${base}/307-cross`, method: 'POST', body: 'token=s3cret', maxBodyBytes: 4096, signal: signal() })).rejects.toMatchObject({ code: 'EREDIRECT' });
    await expect(net.request({ url: `${base}/301-cross`, method: 'PUT', body: 'token=s3cret', maxBodyBytes: 4096, signal: signal() })).rejects.toMatchObject({ code: 'EREDIRECT' });
    expect(lastBody).toBe('');
    // Without a body the cross-origin 307 is followed.
    expect((await net.request({ url: `${base}/307-cross`, maxBodyBytes: 4096, signal: signal() })).status).toBe(200);
    const same = await net.request({ url: `${base}/308-same`, method: 'POST', body: 'a=1', maxBodyBytes: 4096, signal: signal() });
    expect(JSON.parse(same.body.toString())).toEqual({ method: 'POST', body: 'a=1' });
  });

  describe.skipIf(!opensslAvailable())('https → http', () => {
    let tlsSrv: https.Server;
    let tlsPort = 0;
    beforeAll(async () => {
      const c = testCerts();
      tlsSrv = https.createServer({ cert: c.selfCert, key: c.selfKey }, (_req, res) => {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/echo` }).end();
      });
      tlsPort = await listen(tlsSrv);
    });
    afterAll(async () => {
      await close(tlsSrv);
    });

    it('is refused by default and followed with allowDowngrade', async () => {
      const net = testNet();
      const o = { url: `https://localhost:${tlsPort}/`, ignoreTls: true, maxBodyBytes: 4096 };
      await expect(net.request({ ...o, signal: signal() })).rejects.toMatchObject({ code: 'EREDIRECT', message: expect.stringMatching(/https to http/) });
      const r = await net.request({ ...o, allowDowngrade: true, signal: signal() });
      expect(r.status).toBe(200);
      expect(r.url).toBe(`http://127.0.0.1:${port}/echo`);
    });
  });
});

describe('L5: header validation before connecting', () => {
  it('rejects invalid header names and values without opening a connection', async () => {
    const net = testNet();
    const before = connections;
    for (const headers of [{ 'x-a': 'a\u0001b' }, { 'x-a': 'a\u007fb' }, { 'x-a': '€' }, { 'bad name': 'x' }, { 'x(y)': 'x' }]) {
      await expect(net.request({ url: `${base}/echo`, headers, maxBodyBytes: 1024, signal: signal() }), JSON.stringify(headers)).rejects.toMatchObject({ code: 'EINVALIDHEADER' });
    }
    expect(connections).toBe(before);
    // Tabs and Latin-1 are fine (node:http rule).
    const ok = await net.request({ url: `${base}/echo`, headers: { 'x-a': 'a\tbé' }, maxBodyBytes: 1024, signal: signal() });
    expect(ok.status).toBe(200);
  });
});
