// Checker definitions: registry, field metadata, validation (incl. write-only secrets and hosted
// restrictions), pure helpers, and the "only SafeNet" import rule.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECKERS } from '../src/uptime/checkers/registry.js';
import { codeAccepted, statusCodes } from '../src/uptime/checkers/common.js';
import { compareJson, evaluateJsonPath, parseJsonPath } from '../src/uptime/checkers/jsonpath.js';
import { parsePingOutput, pingArgs } from '../src/uptime/checkers/ping.js';
import { evaluateContainerState } from '../src/uptime/checkers/docker.js';
import { expiryFromRdap, parseBootstrap, rdapBaseFor, registrableDomain } from '../src/uptime/checkers/domain.js';
import { fromNtp, ntpRequest, parseNtpReply, toNtp } from '../src/uptime/checkers/ntp.js';
import { decodeHealthResponse, encodeHealthRequest } from '../src/uptime/checkers/grpc.js';
import { decodeBsonTop } from '../src/uptime/checkers/mongodb.js';
import { parseGreeting } from '../src/uptime/checkers/mysql.js';
import { ValidationError } from '../src/uptime/types.js';
import { memberCtx, uptimeConfig, vctx } from './uptime-net-fixtures.js';

const EXPECTED_TYPES = ['http', 'keyword', 'json', 'tcp', 'tls', 'dns', 'push', 'group', 'manual', 'ping', 'websocket', 'smtp', 'ntp', 'redis', 'ssh', 'grpc_health', 'postgres', 'mysql', 'mongodb', 'mqtt', 'docker', 'domain'];

function def(type: string) {
  const d = CHECKERS.get(type);
  if (!d) throw new Error(`missing ${type}`);
  return d;
}

describe('registry', () => {
  it('contains every monitor type of SPEC §8.1 with the right hosted flags', () => {
    expect([...CHECKERS.keys()].sort()).toEqual([...EXPECTED_TYPES].sort());
    expect(def('docker').hosted).toBe('disabled');
    expect(def('ping').hosted).toBe('restricted');
    expect(def('dns').hosted).toBe('restricted');
    for (const t of EXPECTED_TYPES.filter((x) => !['docker', 'ping', 'dns'].includes(x))) expect(def(t).hosted, t).toBe('allowed');
    for (const t of ['push', 'group', 'manual']) expect(def(t).check, t).toBeUndefined();
    for (const t of EXPECTED_TYPES.filter((x) => !['push', 'group', 'manual'].includes(x))) expect(typeof def(t).check, t).toBe('function');
  });

  it('has complete, consistent field metadata', () => {
    const kinds = new Set(['text', 'url', 'host', 'number', 'boolean', 'select', 'textarea', 'password', 'list', 'keyvalue', 'statuscodes']);
    for (const d of CHECKERS.values()) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
      const keys = new Set<string>();
      for (const f of d.fields) {
        expect(kinds.has(f.kind), `${d.type}.${f.key}`).toBe(true);
        expect(keys.has(f.key), `${d.type}.${f.key} duplicate`).toBe(false);
        keys.add(f.key);
        expect(f.label.length).toBeGreaterThan(0);
        if (f.kind === 'select') expect(f.options?.length, `${d.type}.${f.key}`).toBeGreaterThan(0);
        if (f.kind === 'password') expect(f.secret, `${d.type}.${f.key}`).toBe(true);
      }
      for (const f of d.fields) if (f.showIf) expect(keys.has(f.showIf.key), `${d.type}.${f.key} showIf`).toBe(true);
    }
  });

  it('validates the documented defaults of every type (minimal input)', () => {
    const minimal: Record<string, Record<string, unknown>> = {
      http: { url: 'https://example.com' },
      keyword: { url: 'https://example.com', keyword: 'ok' },
      json: { url: 'https://example.com', jsonPath: '$.status', expectedValue: 'ok' },
      tcp: { host: 'example.com', port: 443 },
      tls: { host: 'example.com' },
      dns: { host: 'example.com' },
      ping: { host: 'example.com' },
      websocket: { url: 'wss://example.com/ws' },
      smtp: { host: 'mail.example.com' },
      ntp: { host: 'pool.ntp.org' },
      redis: { host: 'redis.example.com' },
      ssh: { host: 'example.com' },
      grpc_health: { host: 'grpc.example.com' },
      postgres: { host: 'db.example.com' },
      mysql: { host: 'db.example.com' },
      mongodb: { host: 'db.example.com' },
      mqtt: { host: 'broker.example.com' },
      docker: { container: 'web-1' },
      domain: { domain: 'www.example.co.uk' },
      push: {},
      group: {},
      manual: {},
    };
    for (const d of CHECKERS.values()) {
      const r = d.validate(minimal[d.type]!, vctx());
      expect(r.secrets, d.type).toEqual({});
      expect(typeof d.target(r.config) === 'string' || d.target(r.config) === null).toBe(true);
      // Defaults declared in the fields are applied.
      for (const f of d.fields) if (f.default !== undefined && !f.showIf && f.key in (r.config as object) && !(f.key in minimal[d.type]!)) expect((r.config as Record<string, unknown>)[f.key], `${d.type}.${f.key}`).toEqual(f.default);
    }
    expect(def('domain').validate({ domain: 'www.example.co.uk' }, vctx()).config).toEqual({ domain: 'www.example.co.uk', minDaysLeft: 14 });
    expect(def('dns').validate({ host: 'Example.COM.' }, vctx()).config).toMatchObject({ host: 'example.com', resolver: '1.1.1.1', recordType: 'A', port: 53 });
  });
});

describe('validation', () => {
  const http = def('http');

  it('normalises and rejects bad URLs and hosts', () => {
    expect(http.validate({ url: 'https://EXAMPLE.com/a#frag' }, vctx()).config.url).toBe('https://example.com/a');
    for (const url of ['ftp://example.com', 'file:///etc/passwd', 'https://user:pw@example.com/', 'javascript:alert(1)', 'not a url', 'http://exa mple.com']) {
      expect(() => http.validate({ url }, vctx()), url).toThrow(ValidationError);
    }
    expect(() => http.validate({}, vctx())).toThrow(/url is required/);
    const tcp = def('tcp');
    for (const host of ['127.1', '0x7f000001', '2130706433', 'a..b', 'host name', '-x.com']) expect(() => tcp.validate({ host, port: 80 }, vctx()), host).toThrow(ValidationError);
    expect(() => tcp.validate({ host: 'example.com', port: 70000 }, vctx())).toThrow(/port/);
    expect(tcp.validate({ host: '[2001:DB8::1]', port: '22' }, vctx()).config).toMatchObject({ host: '2001:db8::1', port: 22 });
  });

  it('rejects private IP literals at save time for hosted members (generic message)', () => {
    for (const url of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/', 'http://2130706433/', 'http://localhost/']) {
      expect(() => http.validate({ url }, memberCtx()), url).toThrow('target not allowed');
    }
    expect(() => def('tcp').validate({ host: '192.168.1.1', port: 22 }, memberCtx())).toThrow('target not allowed');
    expect(() => def('dns').validate({ host: 'example.com', resolver: '10.0.0.53' }, memberCtx())).toThrow('target not allowed');
    expect(() => def('dns').validate({ host: 'example.com', resolver: 'dns.google' }, vctx())).toThrow(/IP address/);
    expect(() => http.validate({ url: 'http://169.254.169.254/' }, vctx())).toThrow('target not allowed');
    expect(http.validate({ url: 'http://127.0.0.1:8080/' }, vctx()).config.url).toBe('http://127.0.0.1:8080/');
    expect(() => def('docker').validate({ container: 'x' }, memberCtx())).toThrow(ValidationError);
  });

  it('applies hosted restrictions (ping size, OAuth token URL https, redirects)', () => {
    expect(() => def('ping').validate({ host: 'example.com', packetSize: 2000 }, memberCtx())).toThrow(/packetSize/);
    expect(def('ping').validate({ host: 'example.com', packetSize: 2000 }, vctx()).config.packetSize).toBe(2000);
    expect(() => def('ping').validate({ host: 'example.com', count: 6 }, vctx())).toThrow(/count/);
    const oauth = { url: 'https://api.example.com', authMethod: 'oauth2', oauthTokenUrl: 'http://auth.example.com/token', oauthClientId: 'id', oauthClientSecret: 's' };
    expect(() => http.validate(oauth, memberCtx())).toThrow(/https/);
    expect(http.validate(oauth, vctx()).secrets).toEqual({ oauthClientSecret: 's' });
    expect(() => http.validate({ url: 'https://example.com', maxRedirects: 15 }, memberCtx())).toThrow(/maxRedirects/);
  });

  it('implements write-only secret semantics (undefined/"" keep, null clears)', () => {
    const base = { url: 'https://example.com', authMethod: 'basic', basicUser: 'u' };
    expect(http.validate({ ...base, basicPassword: 'p1' }, vctx()).secrets).toEqual({ basicPassword: 'p1' });
    const existingSecrets = { basicPassword: 'old', bearerToken: 'stale' };
    expect(http.validate({ ...base }, vctx({ existingSecrets })).secrets).toEqual({ basicPassword: 'old' });
    expect(http.validate({ ...base, basicPassword: '' }, vctx({ existingSecrets })).secrets).toEqual({ basicPassword: 'old' });
    expect(http.validate({ ...base, basicPassword: null }, vctx({ existingSecrets })).secrets).toEqual({});
    expect(http.validate({ ...base, basicPassword: 'new' }, vctx({ existingSecrets })).secrets).toEqual({ basicPassword: 'new' });
    // Switching the auth method drops secrets that no longer apply.
    expect(http.validate({ url: 'https://example.com' }, vctx({ existingSecrets })).secrets).toEqual({});
    expect(() => http.validate({ url: 'https://example.com', authMethod: 'bearer' }, vctx())).toThrow(/bearerToken/);
    expect(http.validate({ url: 'https://example.com', authMethod: 'bearer' }, vctx({ existingSecrets })).secrets).toEqual({ bearerToken: 'stale' });
    // Config never contains secret values.
    const v = http.validate({ ...base, basicPassword: 'p1' }, vctx());
    expect(JSON.stringify(v.config)).not.toContain('p1');
    const r = def('redis').validate({ host: 'r.example.com', password: 'pw' }, vctx());
    expect(r.secrets).toEqual({ password: 'pw' });
    expect(def('redis').validate({ host: 'r.example.com' }, vctx({ existingSecrets: { password: 'pw' } })).secrets).toEqual({ password: 'pw' });
  });

  it('handles secret headers (names in config, values in secrets)', () => {
    const v = http.validate({ url: 'https://example.com', secretHeaders: [{ key: 'X-Api-Key', value: 'abc' }], headers: [{ key: 'Accept', value: 'application/json' }] }, vctx());
    expect(v.config.secretHeaders).toEqual(['X-Api-Key']);
    expect(v.config.headers).toEqual([{ key: 'Accept', value: 'application/json' }]);
    expect(v.secrets).toEqual({ 'secretHeaders.X-Api-Key': 'abc' });
    const existingSecrets = v.secrets;
    expect(http.validate({ url: 'https://example.com', secretHeaders: [{ key: 'X-Api-Key', value: '' }] }, vctx({ existingSecrets })).secrets).toEqual({ 'secretHeaders.X-Api-Key': 'abc' });
    expect(http.validate({ url: 'https://example.com' }, vctx({ existingSecrets })).secrets).toEqual({ 'secretHeaders.X-Api-Key': 'abc' });
    expect(http.validate({ url: 'https://example.com', secretHeaders: [] }, vctx({ existingSecrets })).secrets).toEqual({});
    expect(http.validate({ url: 'https://example.com', secretHeaders: null }, vctx({ existingSecrets })).secrets).toEqual({});
    expect(() => http.validate({ url: 'https://example.com', secretHeaders: [{ key: 'X-New', value: '' }] }, vctx())).toThrow(/required/);
    expect(() => http.validate({ url: 'https://example.com', headers: [{ key: 'X', value: 'a\r\nInjected: 1' }] }, vctx())).toThrow(/line breaks/);
    expect(() => http.validate({ url: 'https://example.com', headers: [{ key: 'Bad Name', value: 'x' }] }, vctx())).toThrow(/header name/);
    expect(() => http.validate({ url: 'https://example.com', headers: [{ key: 'Content-Length', value: '1' }] }, vctx())).toThrow(/cannot be set/);
    expect(() => http.validate({ url: 'https://example.com', headers: [{ key: 'X', value: '1' }], secretHeaders: [{ key: 'x', value: '2' }] }, vctx())).toThrow(/twice/);
  });

  it('validates bodies, status codes, mTLS PEM and JSON paths', () => {
    expect(() => http.validate({ url: 'https://example.com', method: 'POST', body: '{bad' }, vctx())).toThrow(/JSON/);
    expect(http.validate({ url: 'https://example.com', method: 'POST', bodyEncoding: 'raw', body: '<x/>' }, vctx()).config.body).toBe('<x/>');
    expect(http.validate({ url: 'https://example.com', method: 'GET', body: 'ignored' }, vctx()).config.body).toBe('');
    expect(() => http.validate({ url: 'https://example.com', method: 'TRACE' }, vctx())).toThrow(/method/);
    expect(() => http.validate({ url: 'https://example.com', authMethod: 'mtls', tlsCert: 'nope', tlsKey: 'nope' }, vctx())).toThrow(/PEM/);
    expect(() => def('json').validate({ url: 'https://example.com', jsonPath: '$..a' }, vctx())).toThrow(/jsonPath/);
    expect(() => def('json').validate({ url: 'https://example.com', jsonPath: '$.a', jsonOperator: '>', expectedValue: 'abc' }, vctx())).toThrow(/number/);
    expect(def('json').validate({ url: 'https://example.com', jsonPath: '$.a', jsonOperator: 'exists' }, vctx()).config.expectedValue).toBe('');
    expect(statusCodes({ s: ['200-299', 301, ' 404 '] }, 's', ['200-299'])).toEqual(['200-299', '301', '404']);
    expect(() => statusCodes({ s: ['abc'] }, 's', [])).toThrow(ValidationError);
    expect(() => statusCodes({ s: ['299-200'] }, 's', [])).toThrow(ValidationError);
    expect(codeAccepted(204, ['200-299'])).toBe(true);
    expect(codeAccepted(301, ['200-299', '301'])).toBe(true);
    expect(codeAccepted(500, ['200-299'])).toBe(false);
    expect(() => def('docker').validate({ container: '../../exec' }, vctx())).toThrow(ValidationError);
    expect(() => def('docker').validate({ container: 'a/b' }, vctx())).toThrow(ValidationError);
    expect(() => def('domain').validate({ domain: 'localhost' }, vctx())).toThrow(ValidationError);
    expect(() => def('domain').validate({ domain: 'co.uk' }, vctx())).toThrow(ValidationError);
  });
});

describe('json path', () => {
  const doc = { status: 'ok', n: 5, nested: { arr: [1, { x: 'y' }, 'last'], 'weird key': true }, nil: null, list: ['a', 'b'] };
  const get = (p: string) => evaluateJsonPath(doc, parseJsonPath(p));

  it('evaluates the restricted subset', () => {
    expect(get('$')).toEqual({ found: true, value: doc });
    expect(get('$.status').value).toBe('ok');
    expect(get('status').value).toBe('ok');
    expect(get('$.nested.arr[1].x').value).toBe('y');
    expect(get('$.nested.arr[-1]').value).toBe('last');
    expect(get('$.nested["weird key"]').value).toBe(true);
    expect(get("$['nested']['arr'][0]").value).toBe(1);
    expect(get('$.list.length()').value).toBe(2);
    expect(get('$.nested.length()').value).toBe(2);
    expect(get('$.missing.x').found).toBe(false);
    expect(get('$.nested.arr[9]').found).toBe(false);
    expect(get('$.constructor').found).toBe(false);
    expect(get('$.__proto__').found).toBe(false);
    for (const bad of ['$..a', '$.a[?(@.x)]', '$.a()', '$[*]', '$.' + 'a.'.repeat(40) + 'a', '$.a.length().b', '$["unterminated']) {
      expect(() => parseJsonPath(bad), bad).toThrow();
    }
  });

  it('compares without echoing values', () => {
    expect(compareJson(true, 'ok', '==', 'ok').ok).toBe(true);
    expect(compareJson(true, 5, '==', '5.0').ok).toBe(true);
    expect(compareJson(true, true, '==', 'true').ok).toBe(true);
    expect(compareJson(true, null, '==', 'null').ok).toBe(true);
    expect(compareJson(true, 'ok', '!=', 'bad').ok).toBe(true);
    expect(compareJson(true, 5, '>', '4').ok).toBe(true);
    expect(compareJson(true, '5', '<=', '5').ok).toBe(true);
    expect(compareJson(true, 'abc', '>', '1').ok).toBe(false);
    expect(compareJson(true, 'hello world', 'contains', 'world').ok).toBe(true);
    expect(compareJson(true, ['a', 'b'], 'contains', 'b').ok).toBe(true);
    expect(compareJson(true, { a: 1 }, '==', 'x')).toEqual({ ok: false, reason: 'value is an object or array' });
    expect(compareJson(false, undefined, 'exists', '').ok).toBe(false);
    expect(compareJson(true, 'secret-value', '==', 'x').reason).not.toContain('secret-value');
  });
});

describe('protocol helpers', () => {
  it('ping: fixed argument vector with the IP literal last; parses iputils and BusyBox', () => {
    expect(pingArgs('192.0.2.1', { count: 3, perPacketTimeoutS: 2, packetSize: 56 })).toEqual(['-n', '-c', '3', '-W', '2', '-s', '56', '192.0.2.1']);
    expect(pingArgs('2001:db8::1', { count: 1, perPacketTimeoutS: 1, packetSize: 56 })).toEqual(['-6', '-n', '-c', '1', '-W', '1', '-s', '56', '2001:db8::1']);
    expect(() => pingArgs('-f', { count: 1, perPacketTimeoutS: 1, packetSize: 56 })).toThrow();
    expect(() => pingArgs('example.com', { count: 1, perPacketTimeoutS: 1, packetSize: 56 })).toThrow();
    const iputils = 'PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.\n64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=10.2 ms\n\n--- 1.1.1.1 ping statistics ---\n3 packets transmitted, 2 received, 33.3333% packet loss, time 2003ms\nrtt min/avg/max/mdev = 10.123/11.456/12.789/1.000 ms\n';
    expect(parsePingOutput(iputils)).toEqual({ transmitted: 3, received: 2, avgMs: 11.456 });
    const busybox = 'PING 1.1.1.1 (1.1.1.1): 56 data bytes\n\n--- 1.1.1.1 ping statistics ---\n1 packets transmitted, 1 packets received, 0% packet loss\nround-trip min/avg/max = 9.1/9.2/9.3 ms\n';
    expect(parsePingOutput(busybox)).toEqual({ transmitted: 1, received: 1, avgMs: 9.2 });
    expect(parsePingOutput('3 packets transmitted, 0 received, 100% packet loss')).toEqual({ transmitted: 3, received: 0, avgMs: null });
  });

  it('docker: container state mapping', () => {
    expect(evaluateContainerState({ Status: 'running', Running: true }).status).toBe('up');
    expect(evaluateContainerState({ Status: 'running', Running: true, Health: { Status: 'healthy' } }).status).toBe('up');
    expect(evaluateContainerState({ Status: 'running', Running: true, Health: { Status: 'unhealthy' } })).toMatchObject({ status: 'down', msg: 'Container is unhealthy' });
    expect(evaluateContainerState({ Status: 'running', Running: true, Health: { Status: 'starting' } }).status).toBe('down');
    expect(evaluateContainerState({ Status: 'exited', Running: false, ExitCode: 137 })).toMatchObject({ status: 'down', msg: 'Container is exited (exit code 137)' });
    expect(evaluateContainerState({ Status: 'paused', Running: true, Paused: true }).status).toBe('down');
    expect(evaluateContainerState(undefined).status).toBe('down');
  });

  it('domain: registrable domains, bootstrap parsing, RDAP expiry', () => {
    expect(registrableDomain('www.Example.com.')).toBe('example.com');
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('example.com.au')).toBe('example.com.au');
    expect(registrableDomain('co.uk')).toBeNull();
    expect(registrableDomain('localhost')).toBeNull();
    const services = parseBootstrap({ services: [[['com', 'net'], ['http://rdap.example/', 'https://rdap.verisign.com/com/v1/']], [['uk'], ['https://rdap.nominet.uk/uk']], [['bad'], ['ftp://x']], [['old'], ['http://rdap.old/']], 'garbage'] });
    expect(rdapBaseFor(services, 'example.com')).toBe('https://rdap.verisign.com/com/v1/');
    expect(rdapBaseFor(services, 'example.co.uk')).toBe('https://rdap.nominet.uk/uk/');
    expect(rdapBaseFor(services, 'example.bad')).toBeNull();
    expect(rdapBaseFor(services, 'example.old')).toBe('http://rdap.old/');
    expect(() => parseBootstrap({})).toThrow();
    expect(expiryFromRdap({ events: [{ eventAction: 'registration', eventDate: '2000-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2030-08-13T04:00:00Z' }] })).toBe(Date.parse('2030-08-13T04:00:00Z'));
    expect(expiryFromRdap({ events: 'x' })).toBeNull();
    expect(expiryFromRdap(null)).toBeNull();
  });

  it('ntp: timestamps, request and reply validation', () => {
    const b = Buffer.alloc(8);
    toNtp(1_700_000_000_123, b, 0);
    expect(Math.abs(fromNtp(b, 0) - 1_700_000_000_123)).toBeLessThan(1);
    const req = ntpRequest(Date.now());
    expect(req.length).toBe(48);
    expect(req[0]).toBe(0x23);
    const t1 = fromNtp(req, 40);
    const res = Buffer.alloc(48);
    res[0] = (4 << 3) | 4;
    res[1] = 2;
    Buffer.from([192, 0, 2, 1]).copy(res, 12);
    req.copy(res, 24, 40, 48);
    toNtp(t1 + 15, res, 32);
    toNtp(t1 + 16, res, 40);
    const r = parseNtpReply(req, res, t1, t1 + 2);
    expect(r.stratum).toBe(2);
    expect(r.refId).toBe('192.0.2.1');
    expect(r.offsetMs).toBeCloseTo(14.5, 0);
    const spoof = Buffer.from(res);
    spoof[25] = spoof[25]! ^ 1;
    expect(() => parseNtpReply(req, spoof, t1, t1 + 2)).toThrow(/match/);
    expect(() => parseNtpReply(req, res.subarray(0, 40), t1, t1)).toThrow();
  });

  it('grpc / mongodb / mysql decoders are bounds-checked (fuzz)', () => {
    expect(encodeHealthRequest('').equals(Buffer.from([0, 0, 0, 0, 0]))).toBe(true);
    expect(encodeHealthRequest('svc').equals(Buffer.from([0, 0, 0, 0, 5, 0x0a, 3, 0x73, 0x76, 0x63]))).toBe(true);
    expect(decodeHealthResponse(Buffer.from([0, 0, 0, 0, 2, 0x08, 1]))).toBe(1);
    expect(decodeHealthResponse(Buffer.from([0, 0, 0, 0, 0]))).toBe(0);
    const doc = Buffer.from('1600000010686f6c6100010000000102000000000000f03f00', 'hex');
    doc.writeInt32LE(doc.length, 0);
    for (let i = 0; i < 5000; i++) {
      const n = Math.floor(Math.random() * 64);
      const rnd = Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256)));
      for (const fn of [() => decodeHealthResponse(rnd), () => decodeBsonTop(rnd), () => parseGreeting(rnd)]) {
        try {
          fn();
        } catch (err) {
          expect((err as { code?: string }).code, String(err)).toBe('EPROTO');
        }
      }
      const mutated = Buffer.from(doc);
      mutated[Math.floor(Math.random() * mutated.length)] = Math.floor(Math.random() * 256);
      try {
        decodeBsonTop(mutated);
      } catch (err) {
        expect((err as { code?: string }).code, String(err)).toBe('EPROTO');
      }
    }
  });
});

describe('only SafeNet', () => {
  it('checkers do not import node:net/http/https/dns/dgram/tls or child_process (except ping/docker)', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'uptime', 'checkers');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(15);
    const forbidden = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(net|http|https|dns|dns\/promises|dgram|tls|child_process)['"]/g;
    const exceptions: Record<string, string[]> = { 'ping.ts': ['child_process'], 'docker.ts': ['http', 'https'] };
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(forbidden)) {
        expect(exceptions[f]?.includes(m[1]!), `${f} imports ${m[1]}`).toBe(true);
      }
      if (f !== 'ping.ts') expect(src, f).not.toMatch(/(?<![.\w])(exec|execFile|execSync|spawn|fork)\s*\(/);
      expect(src, f).not.toMatch(/\bdns\.lookup\b|\beval\s*\(|new Function\s*\(/);
    }
  });

  it('available(): ping depends on the binary, docker on the opt-in', () => {
    expect(def('ping').available!(uptimeConfig({ UPTIME_PING_BINARY: '' }))).toBe(false);
    expect(def('ping').available!(uptimeConfig({ UPTIME_PING_BINARY: '/nonexistent/ping' }))).toBe(false);
    expect(def('docker').available!(uptimeConfig())).toBe(false);
    expect(def('docker').available!(uptimeConfig({ UPTIME_DOCKER_ENABLED: 'true' }))).toBe(true);
  });
});
