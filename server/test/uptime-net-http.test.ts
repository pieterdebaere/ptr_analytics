// SafeNet HTTP client against local servers: redirects, header stripping, size caps,
// decompression bombs, timeouts, TLS capture, proxies ignored.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSafeNet, TlsCertificateError, type HostResolver } from '../src/uptime/net/index.js';
import { TargetDeniedError } from '../src/uptime/types.js';
import { close, listen, opensslAvailable, signal, testCerts, testNet, uptimeConfig } from './uptime-net-fixtures.js';

let port = 0;
let base = '';
let closed = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  req.socket.once('close', () => closed++);
  switch (u.pathname) {
    case '/ok':
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
      return;
    case '/echo':
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, headers: req.headers }));
      return;
    case '/redirect': {
      const n = Number(u.searchParams.get('n') ?? '0');
      if (n <= 0) res.writeHead(200).end('done');
      else res.writeHead(302, { location: `/redirect?n=${n - 1}` }).end();
      return;
    }
    case '/cross':
      res.writeHead(302, { location: `http://localhost:${port}/echo` }).end();
      return;
    case '/same':
      res.writeHead(307, { location: '/echo' }).end();
      return;
    case '/post303':
      res.writeHead(303, { location: '/echo' }).end();
      return;
    case '/setcookie':
      res.writeHead(302, { location: '/echo', 'set-cookie': ['sid=abc; Path=/; HttpOnly', 'bad cookie'] }).end();
      return;
    case '/to-private':
      res.writeHead(302, { location: `http://127.0.0.1:${port}/ok` }).end();
      return;
    case '/to-file':
      res.writeHead(302, { location: 'file:///etc/passwd' }).end();
      return;
    case '/big':
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(300_000, 0x61));
      return;
    case '/gzip':
      res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync('hello gzip'));
      return;
    case '/br':
      res.writeHead(200, { 'content-encoding': 'br' }).end(zlib.brotliCompressSync('hello brotli'));
      return;
    case '/deflate':
      res.writeHead(200, { 'content-encoding': 'deflate' }).end(zlib.deflateSync('hello deflate'));
      return;
    case '/bomb':
      // ~50 MB of zeros compressed to ~50 KB.
      res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024), { level: 9 }));
      return;
    case '/badgzip':
      res.writeHead(200, { 'content-encoding': 'gzip' }).end(Buffer.from('not gzip at all'));
      return;
    case '/slow':
      // never answers
      return;
    case '/trickle':
      res.writeHead(200);
      res.write('a');
      return;
    case '/manyheaders': {
      const h: Record<string, string> = {};
      for (let i = 0; i < 150; i++) h[`x-h${i}`] = 'v';
      res.writeHead(200, h).end('ok');
      return;
    }
    default:
      res.writeHead(404).end('nope');
  }
});

beforeAll(async () => {
  port = await listen(server);
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await close(server);
});

describe('SafeNet.request', () => {
  const net = testNet();

  it('performs a request and reports timings', async () => {
    const r = await net.request({ url: `${base}/ok`, maxBodyBytes: 1024, signal: signal() });
    expect(r.status).toBe(200);
    expect(r.statusText).toBe('OK');
    expect(r.body.toString()).toBe('hello');
    expect(r.truncated).toBe(false);
    expect(r.remoteAddress).toBe('127.0.0.1');
    expect(r.redirects).toBe(0);
    expect(r.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(r.tls).toBeUndefined();
  });

  it('sends the User-Agent and a Host header', async () => {
    const r = await testNet({}, { userAgent: 'UA-Test/1' }).request({ url: `${base}/echo`, maxBodyBytes: 4096, signal: signal() });
    const j = JSON.parse(r.body.toString()) as { headers: Record<string, string> };
    expect(j.headers['user-agent']).toBe('UA-Test/1');
    expect(j.headers['host']).toBe(`127.0.0.1:${port}`);
  });

  it('follows redirects up to maxRedirects and returns the 3xx beyond', async () => {
    const r = await net.request({ url: `${base}/redirect?n=3`, maxBodyBytes: 1024, maxRedirects: 5, signal: signal() });
    expect(r.status).toBe(200);
    expect(r.redirects).toBe(3);
    expect(r.url).toBe(`${base}/redirect?n=0`);
    const r2 = await net.request({ url: `${base}/redirect?n=3`, maxBodyBytes: 1024, maxRedirects: 2, signal: signal() });
    expect(r2.status).toBe(302);
    expect(r2.redirects).toBe(2);
    const r3 = await net.request({ url: `${base}/redirect?n=1`, maxBodyBytes: 1024, maxRedirects: 0, signal: signal() });
    expect(r3.status).toBe(302);
  });

  it('strips credentials and custom headers on cross-origin redirects, keeps them same-origin', async () => {
    const headers = { authorization: 'Bearer s3cret', cookie: 'a=b', 'x-api-key': 'k', accept: 'application/json' };
    const cross = await net.request({ url: `${base}/cross`, headers, maxBodyBytes: 4096, signal: signal() });
    const cj = JSON.parse(cross.body.toString()) as { headers: Record<string, string> };
    expect(cj.headers['authorization']).toBeUndefined();
    expect(cj.headers['cookie']).toBeUndefined();
    expect(cj.headers['x-api-key']).toBeUndefined();
    expect(cj.headers['accept']).toBe('application/json');
    expect(cj.headers['host']).toBe(`localhost:${port}`);
    const same = await net.request({ url: `${base}/same`, headers, maxBodyBytes: 4096, signal: signal() });
    const sj = JSON.parse(same.body.toString()) as { headers: Record<string, string> };
    expect(sj.headers['authorization']).toBe('Bearer s3cret');
    expect(sj.headers['x-api-key']).toBe('k');
  });

  it('303 turns POST into GET without body; cookies survive the redirect chain', async () => {
    const r = await net.request({ url: `${base}/post303`, method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' }, maxBodyBytes: 4096, signal: signal() });
    const j = JSON.parse(r.body.toString()) as { method: string; headers: Record<string, string> };
    expect(j.method).toBe('GET');
    expect(j.headers['content-length']).toBeUndefined();
    const c = await net.request({ url: `${base}/setcookie`, maxBodyBytes: 4096, signal: signal() });
    expect((JSON.parse(c.body.toString()) as { headers: Record<string, string> }).headers['cookie']).toBe('sid=abc');
  });

  it('re-checks every redirect hop (redirect to a private address is denied)', async () => {
    const resolver: HostResolver = async (host, family) => (host === 'start.test' && family === 4 ? ['127.0.0.1'] : []);
    const guarded = createSafeNet({
      config: uptimeConfig({ UPTIME_PRIVATE_TARGETS: 'deny', UPTIME_TARGET_ALLOWLIST: 'start.test' }),
      resolver,
    });
    const ok = await guarded.request({ url: `http://start.test:${port}/ok`, maxBodyBytes: 1024, signal: signal() });
    expect(ok.status).toBe(200);
    await expect(guarded.request({ url: `http://start.test:${port}/to-private`, maxBodyBytes: 1024, signal: signal() })).rejects.toBeInstanceOf(TargetDeniedError);
    await expect(net.request({ url: `${base}/to-file`, maxBodyBytes: 1024, signal: signal() })).rejects.toMatchObject({ code: 'EREDIRECT' });
  });

  it('caps the body size', async () => {
    const r = await net.request({ url: `${base}/big`, maxBodyBytes: 10_000, signal: signal() });
    expect(r.body.length).toBe(10_000);
    expect(r.truncated).toBe(true);
    const full = await net.request({ url: `${base}/big`, maxBodyBytes: 300_000, signal: signal() });
    expect(full.body.length).toBe(300_000);
    expect(full.truncated).toBe(false);
  });

  it('decompresses gzip, deflate and br; caps decompression bombs', async () => {
    expect((await net.request({ url: `${base}/gzip`, maxBodyBytes: 1024, signal: signal() })).body.toString()).toBe('hello gzip');
    expect((await net.request({ url: `${base}/br`, maxBodyBytes: 1024, signal: signal() })).body.toString()).toBe('hello brotli');
    expect((await net.request({ url: `${base}/deflate`, maxBodyBytes: 1024, signal: signal() })).body.toString()).toBe('hello deflate');
    const before = process.memoryUsage().rss;
    const bomb = await net.request({ url: `${base}/bomb`, maxBodyBytes: 64 * 1024, signal: signal(10_000) });
    expect(bomb.body.length).toBe(64 * 1024);
    expect(bomb.truncated).toBe(true);
    expect(process.memoryUsage().rss - before).toBeLessThan(40 * 1024 * 1024);
    await expect(net.request({ url: `${base}/badgzip`, maxBodyBytes: 1024, signal: signal() })).rejects.toMatchObject({ code: 'EDECOMPRESS' });
  });

  it('aborts on the deadline and destroys the socket', async () => {
    const before = closed;
    const t0 = Date.now();
    await expect(net.request({ url: `${base}/slow`, maxBodyBytes: 1024, signal: AbortSignal.timeout(300) })).rejects.toMatchObject({ code: 'ETIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(2000);
    await expect(net.request({ url: `${base}/trickle`, maxBodyBytes: 1024, signal: AbortSignal.timeout(300) })).rejects.toMatchObject({ code: 'ETIMEOUT' });
    await new Promise((r) => setTimeout(r, 100));
    expect(closed - before).toBeGreaterThanOrEqual(2);
  });

  it('limits the number of response headers', async () => {
    const r = await net.request({ url: `${base}/manyheaders`, maxBodyBytes: 1024, signal: signal() });
    expect(Object.keys(r.headers).length).toBeLessThanOrEqual(100);
  });

  it('ignores HTTP(S)_PROXY / NODE_USE_ENV_PROXY', async () => {
    const saved = { ...process.env };
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    process.env.http_proxy = 'http://127.0.0.1:9';
    process.env.NODE_USE_ENV_PROXY = '1';
    try {
      const r = await net.request({ url: `${base}/ok`, maxBodyBytes: 1024, signal: signal() });
      expect(r.status).toBe(200);
    } finally {
      process.env = saved;
    }
  });

  it('reports connection refused', async () => {
    const tmp = http.createServer();
    const p = await listen(tmp);
    await close(tmp);
    await expect(net.request({ url: `http://127.0.0.1:${p}/`, maxBodyBytes: 1024, signal: signal() })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

describe.skipIf(!opensslAvailable())('SafeNet TLS', () => {
  let selfSrv: https.Server;
  let leafSrv: https.Server;
  let mtlsSrv: https.Server;
  let selfPort = 0;
  let leafPort = 0;
  let mtlsPort = 0;
  let selfHits = 0;

  beforeAll(async () => {
    const c = testCerts();
    selfSrv = https.createServer({ cert: c.selfCert, key: c.selfKey }, (_req, res) => {
      selfHits++;
      res.end('secret area');
    });
    leafSrv = https.createServer({ cert: c.cert, key: c.key }, (_req, res) => res.end('leaf'));
    mtlsSrv = https.createServer({ cert: c.cert, key: c.key, ca: c.caCert, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      const peer = (req.socket as import('node:tls').TLSSocket).getPeerCertificate();
      res.end(`client=${peer.subject?.CN}`);
    });
    selfPort = await listen(selfSrv);
    leafPort = await listen(leafSrv);
    mtlsPort = await listen(mtlsSrv);
  });
  afterAll(async () => {
    await close(selfSrv);
    await close(leafSrv);
    await close(mtlsSrv);
  });

  it('rejects an invalid certificate before sending the request, but captures it', async () => {
    const net = testNet();
    const err = await net
      .request({ url: `https://localhost:${selfPort}/`, headers: { authorization: 'Bearer secret' }, maxBodyBytes: 1024, signal: signal() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TlsCertificateError);
    const tls = (err as TlsCertificateError).tls;
    expect(tls.valid).toBe(false);
    expect(tls.hostnameOk).toBe(true);
    expect(tls.subject).toContain('CN=localhost');
    expect(tls.notAfter).toBeGreaterThan(Date.now());
    expect(tls.fingerprint256).toMatch(/^[0-9A-F:]+$/);
    expect(tls.error).toMatch(/self-signed/);
    expect(selfHits).toBe(0);
  });

  it('ignoreTls accepts the certificate and still returns it', async () => {
    const r = await testNet().request({ url: `https://localhost:${selfPort}/`, ignoreTls: true, maxBodyBytes: 1024, signal: signal() });
    expect(r.status).toBe(200);
    expect(r.tls?.valid).toBe(false);
    expect(r.tls?.sans).toEqual(['localhost', '127.0.0.1']);
    expect(r.timings.tlsMs).toBeGreaterThan(0);
  });

  it('captures the chain and verifies hostnames (valid with the CA, mismatch otherwise)', async () => {
    const c = testCerts();
    const net = testNet();
    const ok = await net.connect({ host: 'localhost', port: leafPort, signal: signal(), tls: { rejectUnauthorized: true, ca: c.caCert } });
    ok.socket.destroy();
    const { tlsInfoOf } = await import('../src/uptime/net/index.js');
    const info = tlsInfoOf(ok.socket)!;
    expect(info.valid).toBe(true);
    expect(info.chain.length).toBeGreaterThanOrEqual(1);
    expect(info.issuer).toContain('PTR Test CA');
    const ip = await net.connect({ host: '127.0.0.1', port: leafPort, signal: signal(), tls: { rejectUnauthorized: true, ca: c.caCert } });
    ip.socket.destroy();
    expect(tlsInfoOf(ip.socket)?.valid).toBe(true);
    const wrong = await net
      .connect({ host: '127.0.0.1', port: leafPort, signal: signal(), tls: { servername: 'other.example', rejectUnauthorized: true, ca: c.caCert } })
      .catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(TlsCertificateError);
    expect((wrong as TlsCertificateError).tls.hostnameOk).toBe(false);
    expect((wrong as TlsCertificateError).message).toMatch(/hostname/);
  });

  it('presents a client certificate (mTLS)', async () => {
    const c = testCerts();
    const r = await testNet().request({
      url: `https://localhost:${mtlsPort}/`,
      maxBodyBytes: 1024,
      signal: signal(),
      clientCert: { cert: c.clientCert, key: c.clientKey, ca: c.caCert },
    });
    expect(r.body.toString()).toBe('client=client');
    expect(r.tls?.valid).toBe(true);
  });
});
