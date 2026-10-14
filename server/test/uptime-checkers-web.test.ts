// HTTP family, websocket, tcp, tls, domain and docker checkers against in-process fake servers.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHECKERS } from '../src/uptime/checkers/registry.js';
import { clearOAuthTokenCache } from '../src/uptime/checkers/http.js';
import { setRdapBootstrapUrl } from '../src/uptime/checkers/domain.js';
import { close, listen, opensslAvailable, runCheck, testCerts, testNet, uptimeConfig } from './uptime-net-fixtures.js';

const def = (t: string) => CHECKERS.get(t)!;

let port = 0;
let base = '';
let tokenCalls = 0;
let tokenValue = 'tok-1';
let lastHeaders: http.IncomingHttpHeaders = {};
let lastUrl = '';
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  lastHeaders = req.headers;
  lastUrl = req.url ?? '';
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    switch (u.pathname) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Welcome to the Private Dashboard</body></html>');
        return;
      case '/fail':
        res.writeHead(503, 'Service Unavailable').end('database password is hunter2');
        return;
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', count: 7, items: [{ name: 'a' }], secret: 'do-not-leak' }));
        return;
      case '/notjson':
        res.writeHead(200).end('<html>');
        return;
      case '/basic':
        if (req.headers.authorization === `Basic ${Buffer.from('user:pa:ss').toString('base64')}`) res.writeHead(200).end('ok');
        else res.writeHead(401).end();
        return;
      case '/bearer':
        res.writeHead(req.headers.authorization === 'Bearer static-token' && req.headers['x-api-key'] === 'k-123' ? 200 : 401).end();
        return;
      case '/token': {
        tokenCalls++;
        const form = new URLSearchParams(body);
        const okAuth = req.headers.authorization === `Basic ${Buffer.from('client:csecret').toString('base64')}` || (form.get('client_id') === 'client' && form.get('client_secret') === 'csecret');
        if (form.get('grant_type') !== 'client_credentials' || !okAuth) {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: tokenValue, token_type: 'bearer', expires_in: 3600 }));
        return;
      }
      case '/protected':
        res.writeHead(req.headers.authorization === `Bearer ${tokenValue}` ? 200 : 401).end();
        return;
      case '/post':
        res.writeHead(req.method === 'POST' && body === '{"a":1}' && req.headers['content-type'] === 'application/json' ? 201 : 400).end();
        return;
      case '/slow':
        return;
      default:
        res.writeHead(404).end();
    }
  });
});

const upgraded = new Set<Duplex>();
server.on('upgrade', (req, socket: Duplex) => {
  lastHeaders = req.headers;
  upgraded.add(socket);
  socket.on('close', () => upgraded.delete(socket));
  const key = String(req.headers['sec-websocket-key'] ?? '');
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/refuse') {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const accept = u.pathname === '/badaccept' ? 'wrong' : createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  const offered = String(req.headers['sec-websocket-protocol'] ?? '');
  const proto = u.pathname === '/proto' && offered.includes('chat.v2') ? 'Sec-WebSocket-Protocol: chat.v2\r\n' : '';
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`);
  socket.on('data', () => socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8])));
  socket.on('error', () => {});
});

beforeAll(async () => {
  port = await listen(server);
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  for (const s of upgraded) s.destroy();
  await close(server);
});
beforeEach(() => {
  clearOAuthTokenCache();
});

describe('http', () => {
  it('UP on accepted status codes, DOWN otherwise, never echoing bodies', async () => {
    const ok = await runCheck(def('http'), { url: `${base}/ok` });
    expect(ok).toMatchObject({ status: 'up', msg: '200 OK' });
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0);
    expect(ok.meta?.httpStatus).toBe(200);
    const fail = await runCheck(def('http'), { url: `${base}/fail` });
    expect(fail).toMatchObject({ status: 'down', msg: '503 Service Unavailable' });
    expect(fail.msg).not.toContain('hunter2');
    expect((await runCheck(def('http'), { url: `${base}/fail`, acceptedStatusCodes: ['500-599'] })).status).toBe('up');
    expect((await runCheck(def('http'), { url: `${base}/ok`, method: 'HEAD' })).status).toBe('up');
  });

  it('sends bodies, auth headers and secret headers', async () => {
    expect((await runCheck(def('http'), { url: `${base}/post`, method: 'POST', body: '{"a":1}', acceptedStatusCodes: ['201'] })).status).toBe('up');
    expect((await runCheck(def('http'), { url: `${base}/basic`, authMethod: 'basic', basicUser: 'user', basicPassword: 'pa:ss' })).status).toBe('up');
    expect((await runCheck(def('http'), { url: `${base}/basic`, authMethod: 'basic', basicUser: 'user', basicPassword: 'wrong' })).msg).toBe('401 Unauthorized');
    const bearer = await runCheck(def('http'), { url: `${base}/bearer`, authMethod: 'bearer', bearerToken: 'static-token', secretHeaders: [{ key: 'X-Api-Key', value: 'k-123' }], headers: [{ key: 'X-Trace', value: '1' }] });
    expect(bearer.status).toBe('up');
    expect(lastHeaders['x-trace']).toBe('1');
    expect(lastHeaders['user-agent']).toBe('PTR-Uptime/test');
  });

  it('cache buster adds a random query parameter', async () => {
    await runCheck(def('http'), { url: `${base}/ok?a=1`, cacheBuster: true });
    expect(lastUrl).toMatch(/^\/ok\?a=1&ptr_uptime_cb=[0-9a-f]{12}$/);
  });

  it('OAuth2 client credentials: token fetched once, cached, refreshed on 401', async () => {
    const input = { url: `${base}/protected`, authMethod: 'oauth2', oauthTokenUrl: `${base}/token`, oauthClientId: 'client', oauthClientSecret: 'csecret', oauthScopes: 'read' };
    tokenCalls = 0;
    tokenValue = 'tok-1';
    expect((await runCheck(def('http'), input, { uid: 'm-oauth' })).status).toBe('up');
    expect((await runCheck(def('http'), input, { uid: 'm-oauth' })).status).toBe('up');
    expect(tokenCalls).toBe(1);
    tokenValue = 'tok-2'; // server rotated the token: 401 → one refresh
    expect((await runCheck(def('http'), input, { uid: 'm-oauth' })).status).toBe('up');
    expect(tokenCalls).toBe(2);
    const post = await runCheck(def('http'), { ...input, oauthAuthMethod: 'client_secret_post' }, { uid: 'm-oauth-post' });
    expect(post.status).toBe('up');
    const bad = await runCheck(def('http'), { ...input, oauthClientSecret: 'nope' }, { uid: 'm-oauth-bad' });
    expect(bad).toMatchObject({ status: 'down', msg: 'OAuth token request failed (HTTP 401)' });
    expect(bad.msg).not.toContain('nope');
  });

  it('timeouts and denied targets', async () => {
    const t = await runCheck(def('http'), { url: `${base}/slow` }, { timeoutMs: 300 });
    expect(t).toMatchObject({ status: 'down', msg: 'Timeout after 300 ms' });
    const denied = await runCheck(def('http'), { url: `${base}/ok` }, { net: testNet({ UPTIME_PRIVATE_TARGETS: 'deny' }) });
    expect(denied).toMatchObject({ status: 'down', msg: 'target not allowed' });
  });
});

describe('keyword / json', () => {
  it('keyword: found, not found, case-insensitive, inverted — never shows the body', async () => {
    expect(await runCheck(def('keyword'), { url: `${base}/ok`, keyword: 'Private Dashboard' })).toMatchObject({ status: 'up', msg: '200 OK, keyword found' });
    const miss = await runCheck(def('keyword'), { url: `${base}/ok`, keyword: 'private dashboard' });
    expect(miss).toMatchObject({ status: 'down', msg: '200 OK, keyword not found' });
    expect(miss.msg).not.toContain('Welcome');
    expect((await runCheck(def('keyword'), { url: `${base}/ok`, keyword: 'private dashboard', caseSensitive: false })).status).toBe('up');
    expect((await runCheck(def('keyword'), { url: `${base}/ok`, keyword: 'Private', invertKeyword: true })).status).toBe('down');
    expect((await runCheck(def('keyword'), { url: `${base}/ok`, keyword: 'absent', invertKeyword: true })).status).toBe('up');
    expect((await runCheck(def('keyword'), { url: `${base}/fail`, keyword: 'hunter2' })).status).toBe('down');
  });

  it('json: path + operator, no value echo', async () => {
    expect((await runCheck(def('json'), { url: `${base}/json`, jsonPath: '$.status', expectedValue: 'ok' })).status).toBe('up');
    expect((await runCheck(def('json'), { url: `${base}/json`, jsonPath: '$.count', jsonOperator: '>=', expectedValue: '5' })).status).toBe('up');
    expect((await runCheck(def('json'), { url: `${base}/json`, jsonPath: '$.items[0].name', jsonOperator: '==', expectedValue: 'a' })).status).toBe('up');
    expect((await runCheck(def('json'), { url: `${base}/json`, jsonPath: '$.items.length()', expectedValue: '1' })).status).toBe('up');
    const fail = await runCheck(def('json'), { url: `${base}/json`, jsonPath: '$.secret', expectedValue: 'x' });
    expect(fail.status).toBe('down');
    expect(fail.msg).not.toContain('do-not-leak');
    expect((await runCheck(def('json'), { url: `${base}/json`, jsonPath: '$.missing', jsonOperator: 'exists' })).msg).toContain('path not found');
    expect((await runCheck(def('json'), { url: `${base}/notjson`, jsonPath: '$.a', expectedValue: 'x' })).msg).toContain('not valid JSON');
  });
});

describe('websocket', () => {
  it('performs the upgrade handshake and verifies the accept key and subprotocol', async () => {
    expect(await runCheck(def('websocket'), { url: `ws://127.0.0.1:${port}/socket` })).toMatchObject({ status: 'up', msg: '101 Switching Protocols' });
    expect(lastHeaders['sec-websocket-version']).toBe('13');
    expect((await runCheck(def('websocket'), { url: `ws://127.0.0.1:${port}/badaccept` })).msg).toBe('Invalid Sec-WebSocket-Accept');
    expect((await runCheck(def('websocket'), { url: `ws://127.0.0.1:${port}/badaccept`, ignoreAcceptHeader: true })).status).toBe('up');
    expect((await runCheck(def('websocket'), { url: `ws://127.0.0.1:${port}/refuse` })).msg).toBe('Upgrade refused: 403 Forbidden');
    expect((await runCheck(def('websocket'), { url: `ws://127.0.0.1:${port}/proto`, subprotocol: 'chat.v1, chat.v2' })).msg).toBe('101 Switching Protocols (chat.v2)');
    expect((await runCheck(def('websocket'), { url: `ws://127.0.0.1:${port}/socket`, subprotocol: 'chat.v1' })).status).toBe('down');
    expect((await runCheck(def('websocket'), { url: `http://127.0.0.1:${port}/socket`, authMethod: 'bearer', bearerToken: 'wstoken' })).status).toBe('up');
    expect(lastHeaders['authorization']).toBe('Bearer wstoken');
  });
});

describe('tcp', () => {
  it('UP when the port accepts connections, DOWN otherwise', async () => {
    const up = await runCheck(def('tcp'), { host: '127.0.0.1', port });
    expect(up.status).toBe('up');
    expect(up.msg).toMatch(/^Connected in \d+ ms$/);
    const tmp = http.createServer();
    const p = await listen(tmp);
    await close(tmp);
    expect(await runCheck(def('tcp'), { host: 'localhost', port: p })).toMatchObject({ status: 'down', msg: 'Connection refused' });
  });
});

describe.skipIf(!opensslAvailable())('TLS based checks', () => {
  let leaf: https.Server;
  let self: https.Server;
  let mtls: https.Server;
  let leafPort = 0;
  let selfPort = 0;
  let mtlsPort = 0;
  beforeAll(async () => {
    const c = testCerts();
    leaf = https.createServer({ cert: c.cert, key: c.key }, (_q, r) => r.end('ok'));
    self = https.createServer({ cert: c.selfCert, key: c.selfKey }, (_q, r) => r.end('ok'));
    mtls = https.createServer({ cert: c.cert, key: c.key, ca: c.caCert, requestCert: true, rejectUnauthorized: true }, (_q, r) => r.end('ok'));
    leafPort = await listen(leaf);
    selfPort = await listen(self);
    mtlsPort = await listen(mtls);
  });
  afterAll(async () => {
    await close(leaf);
    await close(self);
    await close(mtls);
  });

  it('tls: invalid chain, expiry threshold, only-expiry mode', async () => {
    const untrusted = await runCheck(def('tls'), { host: 'localhost', port: leafPort });
    expect(untrusted.status).toBe('down');
    expect(untrusted.msg).toMatch(/^Certificate invalid: /);
    expect(untrusted.tls?.subject).toContain('CN=localhost');
    const soon = await runCheck(def('tls'), { host: 'localhost', port: leafPort, ignoreTls: true, minDaysLeft: 7 });
    expect(soon).toMatchObject({ status: 'down', msg: 'Certificate expires in 4 days (minimum 7)' });
    const ok = await runCheck(def('tls'), { host: 'localhost', port: leafPort, ignoreTls: true, minDaysLeft: 1 });
    expect(ok).toMatchObject({ status: 'up', msg: 'Certificate accepted, expires in 4 days' });
    expect(ok.tls?.hostnameOk).toBe(true);
    const sni = await runCheck(def('tls'), { host: '127.0.0.1', port: leafPort, servername: 'nope.example', ignoreTls: true, minDaysLeft: 0 });
    expect(sni.tls?.hostnameOk).toBe(false);
  });

  it('tcp + TLS and http on https capture the certificate', async () => {
    const t = await runCheck(def('tcp'), { host: 'localhost', port: selfPort, tls: true, ignoreTls: true });
    expect(t.status).toBe('up');
    expect(t.tls?.valid).toBe(false);
    expect(t.msg).toContain('self-signed');
    const strict = await runCheck(def('tcp'), { host: 'localhost', port: selfPort, tls: true });
    expect(strict).toMatchObject({ status: 'down', msg: 'Self-signed certificate' });
    expect(strict.tls?.subject).toContain('localhost');
    const h = await runCheck(def('http'), { url: `https://localhost:${selfPort}/` });
    expect(h.status).toBe('down');
    expect(h.tls?.valid).toBe(false);
    const hi = await runCheck(def('http'), { url: `https://localhost:${selfPort}/`, ignoreTls: true });
    expect(hi.status).toBe('up');
    expect(hi.tls?.notAfter).toBeGreaterThan(Date.now());
    expect(def('http').certHost!(def('http').validate({ url: `https://localhost:${selfPort}/` }, { hosted: false, role: 'admin', config: uptimeConfig() }).config)).toBe('localhost');
  });

  it('http with mTLS client certificate', async () => {
    const c = testCerts();
    const r = await runCheck(def('http'), { url: `https://localhost:${mtlsPort}/`, authMethod: 'mtls', tlsCert: c.clientCert, tlsKey: c.clientKey, tlsCa: c.caCert });
    expect(r).toMatchObject({ status: 'up', msg: expect.stringMatching(/^200 OK, certificate expires in \d+ days$/) });
    const without = await runCheck(def('http'), { url: `https://localhost:${mtlsPort}/`, ignoreTls: true });
    expect(without.status).toBe('down');
  });
});

describe('domain (RDAP)', () => {
  let rdapPort = 0;
  const rdap = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/dns.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ services: [[['test'], [`http://127.0.0.1:${rdapPort}/rdap/`]]] }));
    } else if (u.pathname === '/rdap/domain/example.test') {
      res.writeHead(200, { 'content-type': 'application/rdap+json' }).end(JSON.stringify({ events: [{ eventAction: 'expiration', eventDate: new Date(Date.now() + 100 * 86_400_000 + 3_600_000).toISOString() }] }));
    } else if (u.pathname === '/rdap/domain/soon.test') {
      res.writeHead(200).end(JSON.stringify({ events: [{ eventAction: 'expiration', eventDate: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString() }] }));
    } else if (u.pathname === '/rdap/domain/noexp.test') {
      res.writeHead(200).end(JSON.stringify({ events: [] }));
    } else {
      res.writeHead(404).end();
    }
  });
  beforeAll(async () => {
    rdapPort = await listen(rdap);
    setRdapBootstrapUrl(`http://127.0.0.1:${rdapPort}/dns.json`);
  });
  afterAll(async () => {
    setRdapBootstrapUrl('https://data.iana.org/rdap/dns.json');
    await close(rdap);
  });

  it('reports expiry dates and thresholds', async () => {
    const r = await runCheck(def('domain'), { domain: 'www.example.test' });
    expect(r.status).toBe('up');
    expect(r.msg).toMatch(/^example\.test expires in 100 days/);
    expect(r.domainExpiresAt).toBeGreaterThan(Date.now());
    expect(await runCheck(def('domain'), { domain: 'soon.test', minDaysLeft: 7 })).toMatchObject({ status: 'down', msg: expect.stringMatching(/expires in 3 days/) });
    expect(await runCheck(def('domain'), { domain: 'noexp.test' })).toMatchObject({ status: 'up', domainExpiresAt: null });
    expect(await runCheck(def('domain'), { domain: 'missing.test' })).toMatchObject({ status: 'down', msg: 'Domain not found in RDAP' });
    expect(await runCheck(def('domain'), { domain: 'example.unknowntld' })).toMatchObject({ status: 'down', msg: 'No RDAP service for .unknowntld' });
  });
});

describe('docker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-docker-'));
  const sock = path.join(dir, 'docker.sock');
  let paths: string[] = [];
  const docker = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    const m = /^\/containers\/([^/]+)\/json$/.exec(req.url ?? '');
    const states: Record<string, unknown> = {
      web: { Status: 'running', Running: true, Health: { Status: 'healthy' } },
      worker: { Status: 'running', Running: true },
      dead: { Status: 'exited', Running: false, ExitCode: 1 },
    };
    if (!m || !states[m[1]!]) {
      res.writeHead(404).end('{"message":"No such container"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Id: 'x', State: states[m[1]!] }));
  });
  beforeAll(async () => {
    await new Promise<void>((r) => docker.listen(sock, () => r()));
  });
  afterAll(async () => {
    await close(docker);
  });

  it('queries the configured socket only', async () => {
    const uptime = uptimeConfig({ UPTIME_DOCKER_ENABLED: 'true', UPTIME_DOCKER_HOST: sock });
    paths = [];
    expect(await runCheck(def('docker'), { container: 'web' }, { uptime })).toMatchObject({ status: 'up', msg: 'Container is running and healthy' });
    expect(await runCheck(def('docker'), { container: 'worker' }, { uptime })).toMatchObject({ status: 'up' });
    expect(await runCheck(def('docker'), { container: 'dead' }, { uptime })).toMatchObject({ status: 'down', msg: 'Container is exited (exit code 1)' });
    expect(await runCheck(def('docker'), { container: 'nope' }, { uptime })).toMatchObject({ status: 'down', msg: 'Container not found' });
    expect(paths).toEqual(['/containers/web/json', '/containers/worker/json', '/containers/dead/json', '/containers/nope/json']);
    expect(await runCheck(def('docker'), { container: 'web' }, { uptime: uptimeConfig() })).toMatchObject({ status: 'down', msg: 'Docker monitoring is disabled on this server' });
  });
});
