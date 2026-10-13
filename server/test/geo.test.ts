import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { candidateMonths, downloadGeoDatabase, type FetchFn } from '../src/geo/download.js';
import { GeoService, openCountryReader } from '../src/geo/geo.js';
import { buildCountryMmdb } from './mmdb.js';
import { createTestApp, pageview, sendEvent, tmpDir } from './helpers.js';

const logs: string[] = [];
const log = {
  info: (m: string) => logs.push(`info ${m}`),
  warn: (m: string) => logs.push(`warn ${m}`),
  error: (m: string) => logs.push(`error ${m}`),
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => log,
  level: 'info',
  silent: () => undefined,
} as unknown as FastifyBaseLogger;

function fakeFetch(responses: Record<string, Buffer | number>, seen: string[] = []): FetchFn {
  return async (url: string) => {
    seen.push(url);
    const r = responses[url];
    if (r === undefined || typeof r === 'number') return new Response('nope', { status: typeof r === 'number' ? r : 404 });
    return new Response(new Uint8Array(r), { status: 200 });
  };
}

describe('GeoService', () => {
  it('looks up countries from a MaxMind database', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'geo.mmdb');
    fs.writeFileSync(file, buildCountryMmdb('DE'));
    const geo = new GeoService(file, null, log);
    expect(geo.enabled).toBe(false);
    expect(await geo.load()).toBe(true);
    expect(geo.enabled).toBe(true);
    expect(geo.lookup('10.1.2.3', {})).toBe('DE');
    expect(geo.lookup('200.1.2.3', {})).toBeNull();
  });

  it('prefers the trusted header and tolerates missing/invalid databases', async () => {
    const dir = tmpDir();
    const missing = new GeoService(path.join(dir, 'none.mmdb'), 'cf-ipcountry', log);
    expect(await missing.load()).toBe(false);
    expect(missing.lookup('10.0.0.1', { 'cf-ipcountry': 'fr' })).toBe('FR');
    expect(missing.lookup('10.0.0.1', {})).toBeNull();
    const badFile = path.join(dir, 'bad.mmdb');
    fs.writeFileSync(badFile, 'not a database');
    expect(await new GeoService(badFile, null, log).load()).toBe(false);
  });

  it('stores countries on ingest', async () => {
    const t = await createTestApp();
    fs.mkdirSync(path.dirname(t.ctx.config.geoipDbPath), { recursive: true });
    fs.writeFileSync(t.ctx.config.geoipDbPath, buildCountryMmdb('NL'));
    await t.ctx.geo.load();
    const id = t.ctx.sites.create('S', ['example.com'], t.clock.t).id;
    await sendEvent(t.app, pageview(id, 'https://example.com/'), { ip: '10.9.8.7' });
    expect(t.ctx.db.prepare('SELECT country FROM events').get()).toEqual({ country: 'NL' });
    await t.app.close();
  });
});

describe('DB-IP auto download', () => {
  const NOW = Date.UTC(2026, 0, 10);

  it('computes current and previous month', () => {
    expect(candidateMonths(NOW)).toEqual(['2026-01', '2025-12']);
    expect(candidateMonths(Date.UTC(2026, 6, 31))).toEqual(['2026-07', '2026-06']);
  });

  it('downloads, verifies and atomically installs the database', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'sub', 'geoip-country.mmdb');
    const seen: string[] = [];
    const fetchFn = fakeFetch(
      { 'https://download.db-ip.com/free/dbip-country-lite-2025-12.mmdb.gz': gzipSync(buildCountryMmdb('BE')) },
      seen,
    );
    expect(await downloadGeoDatabase(dest, log, { fetchFn, now: NOW })).toBe(true);
    expect(seen).toEqual([
      'https://download.db-ip.com/free/dbip-country-lite-2026-01.mmdb.gz',
      'https://download.db-ip.com/free/dbip-country-lite-2025-12.mmdb.gz',
    ]);
    expect(openCountryReader(fs.readFileSync(dest)).get('1.2.3.4')?.country?.iso_code).toBe('BE');
    expect(fs.readdirSync(path.dirname(dest))).toEqual(['geoip-country.mmdb']);
  });

  it('never replaces a good database with a bad download and never throws', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'geoip-country.mmdb');
    fs.writeFileSync(dest, buildCountryMmdb('DE'));
    const cases: FetchFn[] = [
      fakeFetch({}),
      fakeFetch({
        'https://download.db-ip.com/free/dbip-country-lite-2026-01.mmdb.gz': Buffer.from('not gzip'),
        'https://download.db-ip.com/free/dbip-country-lite-2025-12.mmdb.gz': gzipSync(Buffer.from('gzip but not mmdb')),
      }),
      async () => {
        throw new Error('network down');
      },
    ];
    for (const fetchFn of cases) {
      expect(await downloadGeoDatabase(dest, log, { fetchFn, now: NOW })).toBe(false);
      expect(openCountryReader(fs.readFileSync(dest)).get('1.2.3.4')?.country?.iso_code).toBe('DE');
      expect(fs.readdirSync(dir)).toEqual(['geoip-country.mmdb']);
    }
  });

  it('refuses redirects, unexpected final URLs and non-country databases; logs the error cause', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'geoip-country.mmdb');
    const inits: Array<{ redirect?: string } | undefined> = [];
    const good = gzipSync(buildCountryMmdb('BE'));
    const redirected: FetchFn = async (_url, init) => {
      inits.push(init);
      const res = new Response(new Uint8Array(good), { status: 200 });
      Object.defineProperty(res, 'url', { value: 'http://mirror.example.net/db.mmdb.gz' });
      return res;
    };
    logs.length = 0;
    expect(await downloadGeoDatabase(dest, log, { fetchFn: redirected, now: NOW })).toBe(false);
    expect(inits.every((i) => i?.redirect === 'error')).toBe(true);
    expect(logs.some((l) => l.includes('unexpected final URL'))).toBe(true);

    const city: FetchFn = async () => new Response(new Uint8Array(gzipSync(buildCountryMmdb('BE', 'GeoLite2-City'))), { status: 200 });
    expect(await downloadGeoDatabase(dest, log, { fetchFn: city, now: NOW })).toBe(false);
    expect(logs.some((l) => l.includes('unexpected database type "GeoLite2-City"'))).toBe(true);

    const refused: FetchFn = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    };
    expect(await downloadGeoDatabase(dest, log, { fetchFn: refused, now: NOW })).toBe(false);
    expect(logs.some((l) => l.includes('fetch failed (ECONNREFUSED)'))).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('caps the decompressed size', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'geoip-country.mmdb');
    const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024));
    const fetchFn = fakeFetch({ 'https://download.db-ip.com/free/dbip-country-lite-2026-01.mmdb.gz': bomb });
    expect(await downloadGeoDatabase(dest, log, { fetchFn, now: NOW, maxBytes: 1024 * 1024 })).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(logs.some((l) => l.includes('exceeds'))).toBe(true);
  });

  it('runs on startup when GEOIP_AUTO_DOWNLOAD is enabled and reloads the reader', async () => {
    const fetchFn: FetchFn = async () => new Response(new Uint8Array(gzipSync(buildCountryMmdb('AT'))), { status: 200 });
    const t = await createTestApp({ env: { GEOIP_AUTO_DOWNLOAD: 'true' }, build: { backgroundJobs: true, fetchFn } });
    try {
      for (let i = 0; i < 50 && !t.ctx.geo.hasDatabase; i++) await new Promise((r) => setTimeout(r, 20));
      expect(t.ctx.geo.hasDatabase).toBe(true);
      expect(t.ctx.geo.lookup('10.0.0.1', {})).toBe('AT');
    } finally {
      await t.app.close();
    }
  });
});
