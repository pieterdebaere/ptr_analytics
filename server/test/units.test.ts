import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseTrustProxy } from '../src/config.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { openDatabase } from '../src/db/index.js';
import { domainMatches, hostnameAllowed, normalizeDomainEntry, normalizeDomainList } from '../src/lib/domains.js';
import { generatePassword, generateSiteId } from '../src/lib/ids.js';
import { RateLimiter } from '../src/lib/rate-limit.js';
import { isBot, parseUserAgent } from '../src/lib/ua.js';
import { isValidTimeZone, localDateOf, startOfLocalDay, startOfLocalHour, zonedStart } from '../src/lib/time.js';
import { resolvePeriod } from '../src/stats/period.js';

describe('config', () => {
  it('applies defaults', () => {
    const c = loadConfig({}, '/srv');
    expect(c).toMatchObject({
      port: 3000,
      host: '127.0.0.1',
      dataDir: '/srv/data',
      publicUrl: null,
      trustProxy: false,
      cookieSecure: false,
      production: false,
      retentionDays: 0,
      geoipDbPath: path.join('/srv/data', 'geoip-country.mmdb'),
      geoipAutoDownload: false,
      geoipHeader: null,
      ingestRateLimit: 600,
      logLevel: 'info',
    });
    expect(c.trackerFile.endsWith(path.join('tracker', 'dist', 'script.js'))).toBe(true);
    expect(c.dashboardDir.endsWith(path.join('dashboard', 'dist'))).toBe(true);
  });

  it('derives COOKIE_SECURE from PUBLIC_URL and normalises it', () => {
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.com/' }).cookieSecure).toBe(true);
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.com/' }).publicUrl).toBe('https://a.example.com');
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.com', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(loadConfig({ GEOIP_HEADER: 'CF-IPCountry' }).geoipHeader).toBe('cf-ipcountry');
  });

  it('fails fast on invalid values', () => {
    const bad: Array<Record<string, string>> = [
      { PORT: 'abc' },
      { PORT: '70000' },
      { PUBLIC_URL: 'analytics.example.com' },
      { PUBLIC_URL: 'ftp://x.com' },
      { PUBLIC_URL: 'https://x.com/path' },
      { TRUST_PROXY: 'maybe' },
      { TRUST_PROXY: '10.0.0.0/33' },
      { COOKIE_SECURE: 'perhaps' },
      { ADMIN_EMAIL: 'a@b.co', ADMIN_PASSWORD: 'short' },
      { ADMIN_EMAIL: 'a@b.co', ADMIN_PASSWORD: 'change-me-to-a-long-random-password' },
      { ADMIN_PASSWORD: 'change-me-to-a-long-random-password' },
      { ADMIN_EMAIL: 'nope' },
      { ADMIN_EMAIL: 'nope', ADMIN_PASSWORD: 'long enough password' },
      { RETENTION_DAYS: '-1' },
      { GEOIP_AUTO_DOWNLOAD: 'sometimes' },
      { GEOIP_HEADER: 'bad header' },
      { INGEST_RATE_LIMIT: '1.5' },
      { LOG_LEVEL: 'verbose' },
    ];
    for (const env of bad) expect(() => loadConfig(env), JSON.stringify(env)).toThrow(ConfigError);
  });

  it('accepts only one of ADMIN_EMAIL / ADMIN_PASSWORD (reported by bootstrapAdmin instead)', () => {
    expect(loadConfig({ ADMIN_EMAIL: 'a@b.co' })).toMatchObject({ adminEmail: 'a@b.co', adminPassword: null });
    expect(loadConfig({ ADMIN_PASSWORD: 'long enough password' })).toMatchObject({ adminEmail: null });
    expect(loadConfig({ HOST: '0.0.0.0', NODE_ENV: 'production' })).toMatchObject({ host: '0.0.0.0', production: true });
  });

  it('parses TRUST_PROXY', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('00')).toBe(false);
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });
});

describe('migrations', () => {
  it('sets user_version and is idempotent', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});

describe('ids', () => {
  it('generates site ids and passwords', () => {
    const ids = new Set(Array.from({ length: 200 }, generateSiteId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{12}$/);
    expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]{20}$/);
  });
});

describe('domains', () => {
  it('normalises entries', () => {
    expect(normalizeDomainEntry('Example.COM.')).toBe('example.com');
    expect(normalizeDomainEntry('https://www.example.com/path')).toBe('www.example.com');
    expect(normalizeDomainEntry('example.com:8080')).toBe('example.com');
    expect(normalizeDomainEntry('*.Example.com')).toBe('*.example.com');
    expect(normalizeDomainEntry('localhost')).toBe('localhost');
    expect(normalizeDomainEntry('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
    for (const bad of ['', 'exa mple.com', '-bad.com', '*.', '*', 'a..b', 'bücher.de', 'javascript:alert(1)', 5, null]) {
      expect(normalizeDomainEntry(bad), String(bad)).toBeNull();
    }
    expect(normalizeDomainList(['a.com', 'A.com'])).toEqual(['a.com']);
    expect(normalizeDomainList([])).toBeNull();
  });

  it('matches hostnames', () => {
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('example.com', 'www.example.com')).toBe(true);
    expect(domainMatches('example.com', 'app.example.com')).toBe(false);
    expect(domainMatches('*.example.com', 'example.com')).toBe(true);
    expect(domainMatches('*.example.com', 'a.b.example.com')).toBe(true);
    expect(domainMatches('*.example.com', 'badexample.com')).toBe(false);
    expect(hostnameAllowed(['example.com'], 'WWW.EXAMPLE.COM.')).toBe(true);
    expect(hostnameAllowed(['localhost'], 'localhost')).toBe(true);
  });
});

describe('user agents', () => {
  const cases: Array<[string, string | null, string | null, string | null]> = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0', 'Edge', 'Windows', 'desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari', 'macOS', 'desktop'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36', 'Chrome', 'Android', 'mobile'],
    ['Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 'Chrome', 'Android', 'tablet'],
    ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1', 'Chrome', 'iOS', 'tablet'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0', 'Firefox', 'Linux', 'desktop'],
    ['Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 'Samsung Internet', 'Android', 'mobile'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/113.0.0.0', 'Opera', 'Windows', 'desktop'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 'Chrome', 'Chrome OS', 'desktop'],
  ];
  it.each(cases)('%s', (ua, browser, os, device) => {
    expect(isBot(ua)).toBe(false);
    expect(parseUserAgent(ua)).toEqual({ browser, os, device });
  });

  it('detects bots', () => {
    for (const ua of ['Googlebot/2.1', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'Wget/1.21', 'Go-http-client/1.1', 'Slackbot-LinkExpanding 1.0', undefined, ' ']) {
      expect(isBot(ua), String(ua)).toBe(true);
    }
  });
});

describe('rate limiter', () => {
  it('is bounded in memory', () => {
    let now = 0;
    const rl = new RateLimiter(2, 1000, () => now, 100);
    for (let i = 0; i < 1000; i++) rl.hit(`k${i}`);
    expect(rl.size).toBeLessThanOrEqual(100);
    expect(rl.hit('a')).toBe(true);
    expect(rl.hit('a')).toBe(true);
    expect(rl.hit('a')).toBe(false);
    now = 1000;
    expect(rl.hit('a')).toBe(true);
    rl.sweep();
    expect(rl.size).toBe(1);
  });
});

describe('time zones', () => {
  it('validates zones', () => {
    expect(isValidTimeZone('Europe/Brussels')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Nowhere/Land')).toBe(false);
    expect(isValidTimeZone('../../etc')).toBe(false);
  });

  it('finds local midnights across DST', () => {
    expect(startOfLocalDay({ y: 2026, m: 3, d: 29 }, 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 28, 23));
    expect(startOfLocalDay({ y: 2026, m: 3, d: 30 }, 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 29, 22));
    expect(startOfLocalDay({ y: 2026, m: 11, d: 1 }, 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 4));
    expect(startOfLocalDay({ y: 2026, m: 11, d: 2 }, 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 5));
    expect(startOfLocalDay({ y: 2026, m: 6, d: 1 }, 'Asia/Kolkata')).toBe(Date.UTC(2026, 4, 31, 18, 30));
    expect(startOfLocalDay({ y: 2026, m: 6, d: 1 }, 'Pacific/Chatham')).toBe(Date.UTC(2026, 4, 31, 11, 15));
  });

  it('handles midnight DST gaps (day starts at 01:00)', () => {
    // America/Santiago springs forward at 00:00 on 2026-09-06
    const start = startOfLocalDay({ y: 2026, m: 9, d: 6 }, 'America/Santiago');
    expect(localDateOf(start, 'America/Santiago')).toEqual({ y: 2026, m: 9, d: 6 });
    expect(localDateOf(start - 1, 'America/Santiago')).toEqual({ y: 2026, m: 9, d: 5 });
    // ambiguous local times resolve to the first occurrence
    const amb = zonedStart(2026, 11, 1, 1, 'America/New_York');
    expect(amb).toBe(Date.UTC(2026, 10, 1, 5));
  });

  it('floors to local hours (incl. half-hour zones)', () => {
    expect(startOfLocalHour(Date.UTC(2026, 0, 1, 10, 45), 'Asia/Kolkata')).toBe(Date.UTC(2026, 0, 1, 10, 30));
    expect(startOfLocalHour(Date.UTC(2026, 0, 1, 10, 15), 'Asia/Kolkata')).toBe(Date.UTC(2026, 0, 1, 9, 30));
    expect(startOfLocalHour(Date.UTC(2026, 0, 1, 10, 15), 'UTC')).toBe(Date.UTC(2026, 0, 1, 10));
  });

  it('resolves periods', () => {
    const now = Date.UTC(2026, 2, 31, 10); // after the Berlin DST change on 03-29
    const r = resolvePeriod({ period: '7d', tz: 'Europe/Berlin' }, now);
    expect(r.buckets).toHaveLength(7);
    const lengths = r.buckets.map((b) => (b.end - b.start) / 3_600_000);
    expect(lengths).toEqual([24, 24, 24, 24, 23, 24, 24]);
    expect(r.previous.to).toBe(r.from);
    expect(r.previous.from).toBe(Date.UTC(2026, 2, 17, 23));
    const y = resolvePeriod({ period: '12m' }, Date.UTC(2026, 0, 15));
    expect(y.buckets[0]?.start).toBe(Date.UTC(2025, 1, 1));
    expect(y.previous.from).toBe(Date.UTC(2024, 1, 1));
    const c = resolvePeriod({ period: 'custom', from: '2026-03-29', to: '2026-03-29', tz: 'Europe/Berlin' }, now);
    expect(c.interval).toBe('hour');
    expect(c.buckets).toHaveLength(23);
    expect(resolvePeriod({ period: 'custom', from: '2023-01-01', to: '2025-12-31' }, now).interval).toBe('month');
  });
});
