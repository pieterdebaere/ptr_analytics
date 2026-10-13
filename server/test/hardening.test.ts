import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  clientErrorHandler,
  startupMessages,
} from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { normalizeIp, rateLimitKey } from '../src/lib/client-ip.js';
import { normalizeDomainEntry } from '../src/lib/domains.js';
import { RateLimiter } from '../src/lib/rate-limit.js';
import { SaltStore, visitorId } from '../src/lib/salts.js';
import { stripUnsafeChars, truncateCodePoints } from '../src/lib/text.js';
import { isBot, parseUserAgent } from '../src/lib/ua.js';
import { ADMIN_EMAIL, DAY, createTestApp, makeFixtures, tmpDir } from './helpers.js';

describe('rate limiter (O(1) amortised)', () => {
  it('stays fast when flooded with distinct keys while full', () => {
    const now = 0;
    const rl = new RateLimiter(5, 60_000, () => now, 50_000);
    for (let i = 0; i < 50_000; i++) rl.hit(`fill${i}`);
    const start = performance.now();
    // The old implementation ran a full O(n) sweep per new key here (~2.5e9 steps).
    for (let i = 0; i < 100_000; i++) rl.hit(`flood${i}`);
    const elapsed = performance.now() - start;
    expect(rl.size).toBe(50_000);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('keeps its internal queue bounded under reset churn', () => {
    const rl = new RateLimiter(5, 60_000, () => 0, 100);
    for (let i = 0; i < 100_000; i++) {
      rl.hit('k');
      rl.reset('k');
    }
    const internal = rl as unknown as { queue: unknown[]; head: number };
    expect(internal.queue.length - internal.head).toBeLessThanOrEqual(2 * 100 + 1024 + 1);
  });

  it('evicts only the oldest entry when full and keeps other counters', () => {
    let now = 0;
    const rl = new RateLimiter(1, 1000, () => now, 3);
    expect(rl.hit('a')).toBe(true);
    now = 10;
    expect(rl.hit('b')).toBe(true);
    now = 20;
    expect(rl.hit('c')).toBe(true);
    expect(rl.hit('d')).toBe(true); // evicts only 'a'
    expect(rl.size).toBe(3);
    expect(rl.isLimited('b')).toBe(true);
    expect(rl.isLimited('c')).toBe(true);
    expect(rl.isLimited('a')).toBe(false);
  });

  it('sweeps expired entries from the head (re-inserted keys move to the tail)', () => {
    let now = 0;
    const rl = new RateLimiter(10, 100, () => now, 10);
    rl.hit('a');
    now = 50;
    rl.hit('b');
    now = 100;
    rl.hit('a'); // expired -> deleted and re-inserted with a new window
    now = 120;
    rl.sweep();
    expect(rl.size).toBe(2); // 'b' expires at 150, 'a' (re-inserted) at 200
    now = 160;
    rl.sweep();
    expect(rl.size).toBe(1);
    expect(rl.isLimited('a')).toBe(false);
    now = 200;
    rl.sweep();
    expect(rl.size).toBe(0);
  });
});

describe('client IP normalisation', () => {
  it('normalises and validates addresses', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::FFFF:cb00:7107')).toBe('203.0.113.7');
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8:0:0:0:0:0:1');
    expect(normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8:0:0:0:0:0:1');
    expect(normalizeIp('::1')).toBe('0:0:0:0:0:0:0:1');
    expect(normalizeIp('::')).toBe('0:0:0:0:0:0:0:0');
    expect(normalizeIp('64:ff9b::1.2.3.4')).toBe('64:ff9b:0:0:0:0:102:304');
    for (const bad of ['', 'unknown', '1.2.3', '1.2.3.4.5', '2001:db8::1::2', '::ffff:1.2.3', '<script>', undefined, null]) {
      expect(normalizeIp(bad), String(bad)).toBeNull();
    }
  });

  it('derives rate-limit keys (IPv6 by /64)', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('2001:db8:1:2:0:0:0:1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8:1:2::ffff')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
  });

  it('keys the login rate limit by IPv6 /64', async () => {
    const t = await createTestApp();
    try {
      const attempt = (ip: string) =>
        t.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-pa-request': '1' },
          remoteAddress: ip,
          payload: { email: ADMIN_EMAIL, password: 'wrong password!!' },
        });
      // 10 failures per (email, client) - spread over 10 addresses of one /64.
      for (let i = 1; i <= 10; i++) expect((await attempt(`2001:db8:aa:bb::${i.toString(16)}`)).statusCode).toBe(401);
      expect((await attempt('2001:db8:aa:bb:1:2:3:4')).statusCode).toBe(429);
      expect((await attempt('2001:db8:aa:cc::1')).statusCode).toBe(401);
    } finally {
      await t.app.close();
    }
  });
});

describe('text sanitising', () => {
  it('strips Cc/Cf/Cs and truncates on code point boundaries', () => {
    expect(stripUnsafeChars('a\u0000b‮c​d\uD800e\u0085f')).toBe('abcdef');
    expect(stripUnsafeChars('😀 ok')).toBe('😀 ok');
    expect(truncateCodePoints('ab😀', 3)).toBe('ab');
    expect(truncateCodePoints('ab😀', 4)).toBe('ab😀');
    expect(truncateCodePoints('abc', 5)).toBe('abc');
  });
});

describe('server timeouts', () => {
  it('bounds slow requests and idle connections', async () => {
    const t = await createTestApp();
    try {
      expect(REQUEST_TIMEOUT_MS).toBe(15_000);
      expect(CONNECTION_TIMEOUT_MS).toBe(30_000);
      expect(t.app.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
      expect(t.app.server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
      expect(t.app.server.headersTimeout).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
      expect(t.app.server.timeout).toBe(CONNECTION_TIMEOUT_MS);
      expect(t.app.server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    } finally {
      await t.app.close();
    }
  });
});

describe('daily salts', () => {
  const D1 = Date.UTC(2026, 5, 15, 12);

  function fileContains(file: string, needle: Buffer): boolean {
    if (!fs.existsSync(file)) return false;
    return fs.readFileSync(file).includes(needle);
  }

  it('leaves no trace of deleted salts in the database file or WAL', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'analytics.db');
    const db = openDatabase(file);
    try {
      expect(db.pragma('secure_delete', { simple: true })).toBe(1);
      const store = new SaltStore(db);
      const s1 = Buffer.from(store.current(D1));
      // s1 is only in the WAL at this point.
      expect(fileContains(`${file}-wal`, s1) || fileContains(file, s1)).toBe(true);

      const s2 = Buffer.from(store.current(D1 + DAY));
      for (const f of [file, `${file}-wal`]) expect(fileContains(f, s1), f).toBe(false);
      expect(fileContains(file, s2) || fileContains(`${file}-wal`, s2)).toBe(true);

      // s2 now lives in the main database file (checkpointed); rotate again.
      const s3 = Buffer.from(store.current(D1 + 2 * DAY));
      for (const f of [file, `${file}-wal`]) expect(fileContains(f, s2), f).toBe(false);

      // purgeOld (cleanup job) scrubs too.
      store.purgeOld(D1 + 3 * DAY);
      for (const f of [file, `${file}-wal`]) expect(fileContains(f, s3), f).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS n FROM salts').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('keeps a "future" salt when the clock steps back across midnight', () => {
    const db = openDatabase(':memory:');
    const store = new SaltStore(db);
    const today = Buffer.from(store.current(D1));
    const yesterday = Buffer.from(store.current(D1 - DAY));
    expect(yesterday.equals(today)).toBe(false);
    // Clock back to normal: the same salt as before is used (ids stay consistent).
    expect(Buffer.from(store.current(D1)).equals(today)).toBe(true);
    expect(db.prepare('SELECT day FROM salts').all()).toEqual([{ day: '2026-06-15' }]);
    db.close();
  });

  it('hashes visitor id components unambiguously', () => {
    const salt = Buffer.alloc(32, 7);
    const ua = 'Mozilla/5.0';
    expect(visitorId(salt, 'site', '1.2.3.4', ua)).toMatch(/^[0-9a-f]{32}$/);
    expect(visitorId(salt, 'ab', 'c', ua)).not.toBe(visitorId(salt, 'a', 'bc', ua));
    expect(visitorId(salt, 'site', '1.2.3.4', 'x')).not.toBe(visitorId(salt, 'site', '1.2.3.4x', ''));
  });
});

describe('user agent parsing', () => {
  it('stays linear on hostile user agents and keeps detection', () => {
    const hostile = [
      'Version/1 '.repeat(2000),
      'iPhone '.repeat(2000),
      'Android '.repeat(2000),
      `Mozilla/5.0 ${'Version/1.1.1.1.1.1.1.1'.repeat(1000)}`,
    ];
    const start = performance.now();
    for (let i = 0; i < 50; i++) for (const ua of hostile) parseUserAgent(ua);
    expect(performance.now() - start).toBeLessThan(1_000);

    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36').device).toBe('tablet');
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36').device).toBe('mobile');
    expect(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148').browser).toBe('Safari');
    // Only the first 512 characters are parsed.
    expect(parseUserAgent(`${'x'.repeat(600)} Firefox/129.0`).browser).toBeNull();
    expect(isBot(`${'x'.repeat(600)} Googlebot/2.1`)).toBe(true);
  });
});

describe('domain entries', () => {
  it('rejects single-label wildcards and IP addresses, keeps IDN punycode', () => {
    for (const bad of ['*.com', '*.localhost', '*.xn--p1ai', '127.0.0.1', '10.0.0.1:8080', 'http://192.168.1.1/', '0x7f.1', '2130706433', '[::1]', 'http://[::1]/', '*.1.2.3.4']) {
      expect(normalizeDomainEntry(bad), bad).toBeNull();
    }
    expect(normalizeDomainEntry('localhost')).toBe('localhost');
    expect(normalizeDomainEntry('*.example.co.uk')).toBe('*.example.co.uk');
    expect(normalizeDomainEntry('*.xn--bcher-kva.example')).toBe('*.xn--bcher-kva.example');
    expect(normalizeDomainEntry('https://xn--bcher-kva.example/')).toBe('xn--bcher-kva.example');
    expect(normalizeDomainEntry('1password.com')).toBe('1password.com');
    expect(normalizeDomainEntry('a.b.example.com')).toBe('a.b.example.com');
  });
});

describe('startup configuration checks', () => {
  it('warns about an ignored GEOIP_HEADER, insecure cookies in production and hop-count TRUST_PROXY', () => {
    const geo = startupMessages(loadConfig({ GEOIP_HEADER: 'CF-IPCountry', PUBLIC_URL: 'https://a.example.com' }));
    expect(geo.warn.some((m) => m.includes('GEOIP_HEADER') && m.includes('ignored'))).toBe(true);
    const geoOk = startupMessages(loadConfig({ GEOIP_HEADER: 'CF-IPCountry', TRUST_PROXY: '10.0.0.1', PUBLIC_URL: 'https://a.example.com' }));
    expect(geoOk.warn).toEqual([]);

    const prod = startupMessages(loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'http://a.example.com' }));
    expect(prod.warn.some((m) => m.includes('Secure'))).toBe(true);
    expect(startupMessages(loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://a.example.com' })).warn).toEqual([]);
    expect(startupMessages(loadConfig({ PUBLIC_URL: 'http://a.example.com' })).warn).toEqual([]);

    const hops = startupMessages(loadConfig({ TRUST_PROXY: '1', PUBLIC_URL: 'https://a.example.com' }));
    expect(hops.info.some((m) => m.includes('only be reachable through the proxy') && m.includes('CIDR'))).toBe(true);
    expect(startupMessages(loadConfig({ TRUST_PROXY: '10.0.0.0/8', PUBLIC_URL: 'https://a.example.com' })).info).toEqual([]);
  });

  it('starts (without creating a user) when only one of ADMIN_EMAIL / ADMIN_PASSWORD is set', async () => {
    const fixtures = makeFixtures();
    const envs: Array<Record<string, string>> = [{ ADMIN_PASSWORD: '' }, { ADMIN_EMAIL: '' }];
    for (const env of envs) {
      const t = await createTestApp({ fixtures, env });
      try {
        expect(t.ctx.users.count()).toBe(0);
      } finally {
        await t.app.close();
      }
    }
  });
});

describe('client error handler', () => {
  it('answers malformed requests with 400 and logs nothing about them, even at trace level', async () => {
    const lines: string[] = [];
    const t = await createTestApp({
      env: { LOG_LEVEL: 'trace' },
      build: { logger: true, logStream: { write: (m: string) => void lines.push(m) } },
    });
    try {
      await t.app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = t.app.server.address() as net.AddressInfo;
      const before = lines.length;
      const response = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        let data = '';
        sock.on('data', (d) => (data += d.toString('latin1')));
        sock.on('close', () => resolve(data));
        sock.on('error', reject);
        sock.write('GET / HTTP/1.1\r\nHost: x\r\nCookie: __Host-pa_session=SECRET-TOKEN-VALUE\r\nBad Header Line\r\n\r\n');
      });
      expect(response.startsWith('HTTP/1.1 400 Bad Request\r\n')).toBe(true);
      const logged = lines.slice(before).join('');
      expect(logged).not.toContain('SECRET-TOKEN-VALUE');
      expect(logged).not.toContain('rawPacket');
      expect(logged).not.toContain('client error');
    } finally {
      await t.app.close();
    }
  });

  it('does nothing for reset or destroyed sockets', () => {
    const calls: string[] = [];
    const sock = {
      destroyed: false,
      writable: true,
      write: (m: string) => calls.push(`write ${m.split('\r\n')[0]}`),
      destroy: () => calls.push('destroy'),
    } as unknown as net.Socket;
    clientErrorHandler(Object.assign(new Error('x'), { code: 'ECONNRESET' }), sock);
    expect(calls).toEqual([]);
    clientErrorHandler(Object.assign(new Error('x'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' }), sock);
    expect(calls).toEqual(['write HTTP/1.1 408 Request Timeout', 'destroy']);
  });
});
