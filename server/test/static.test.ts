import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSP } from '../src/security.js';
import { createTestApp, makeFixtures, type TestApp } from './helpers.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

const html = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };

describe('/script.js', () => {
  it('serves the tracker with CORS/CORP and caching headers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/script.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.body).toContain('window.pa');
    const etag = res.headers['etag'] as string;
    const again = await t.app.inject({ method: 'GET', url: '/script.js', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    const head = await t.app.inject({ method: 'HEAD', url: '/script.js' });
    expect(head.statusCode).toBe(200);
  });

  it('returns 404 when the tracker build is missing', async () => {
    const fx = makeFixtures();
    fs.rmSync(fx.trackerFile);
    const other = await createTestApp({ fixtures: fx });
    try {
      expect((await other.app.inject({ method: 'GET', url: '/script.js' })).statusCode).toBe(404);
    } finally {
      await other.app.close();
    }
  });
});

describe('security headers', () => {
  it('are set on dashboard and API responses', async () => {
    for (const url of ['/', '/api/auth/me', '/healthz', '/assets/app-abc123.js']) {
      const res = await t.app.inject({ method: 'GET', url, headers: html });
      expect(res.headers['content-security-policy'], url).toBe(CSP);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['permissions-policy']).toContain('camera=()');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    }
  });
});

describe('dashboard SPA', () => {
  it('serves index.html with no-cache for / and client-side routes', async () => {
    for (const url of ['/', '/sites/abc/settings', '/login?next=%2F']) {
      const res = await t.app.inject({ method: 'GET', url, headers: html });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('<div id="root">');
    }
  });

  it('serves hashed assets immutable and other files no-cache', async () => {
    const asset = await t.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['content-type']).toContain('javascript');
    const icon = await t.app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('returns 404 (not index.html) for missing non-HTML resources', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/assets/missing.js', headers: { accept: '*/*' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="root">');
  });

  it('never falls back to index.html for /api routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope', headers: html });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('does not serve dotfiles or directory listings', async () => {
    for (const url of ['/.env', '/assets/', '/assets', '/%2eenv']) {
      const res = await t.app.inject({ method: 'GET', url, headers: { accept: '*/*' } });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toContain('SECRET=hunter2');
      expect(res.body).not.toContain('app-abc123.js');
    }
  });

  it('blocks path traversal', async () => {
    const attempts = [
      '/..%2f..%2fetc/passwd',
      '/..%2fsecret.txt',
      '/assets/../../package.json',
      '/assets/..%2f..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/..\\secret.txt',
      '/assets/..%5c..%5csecret.txt',
      '//etc/passwd',
      '/./secret.txt',
      '/assets/%00.js',
    ];
    for (const url of attempts) {
      for (const accept of ['*/*', html.accept]) {
        const res = await t.app.inject({ method: 'GET', url, headers: { accept } });
        expect(res.body, url).not.toContain('TOP-SECRET-OUTSIDE-ROOT');
        expect(res.body, url).not.toContain('root:x:0');
        expect(res.body, url).not.toContain('"name"');
        if (res.statusCode === 200) expect(res.body).toContain('<div id="root">');
      }
    }
  });

  it('serves a plain-text placeholder when the dashboard is not built', async () => {
    const fx = makeFixtures();
    fs.rmSync(fx.dashboardDir, { recursive: true });
    const other = await createTestApp({ fixtures: fx });
    try {
      const res = await other.app.inject({ method: 'GET', url: '/', headers: html });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('dashboard has not been built');
      expect((await other.app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true });
    } finally {
      await other.app.close();
    }
  });

  it('healthz', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('fixture sanity: the secret files exist outside/inside the root', () => {
    expect(fs.existsSync(path.join(t.fixtures.root, 'secret.txt'))).toBe(true);
    expect(fs.existsSync(path.join(t.fixtures.dashboardDir, '.env'))).toBe(true);
  });
});
