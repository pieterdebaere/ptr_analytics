import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildOptions } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'correct horse battery';

export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
export const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
export const FIREFOX_MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:129.0) Gecko/20100101 Firefox/129.0';

export function tmpDir(prefix = 'pa-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Fixtures {
  root: string;
  trackerFile: string;
  dashboardDir: string;
}

/** A fake tracker build and dashboard build (with a dotfile that must never be served). */
export function makeFixtures(): Fixtures {
  const root = tmpDir();
  const trackerFile = path.join(root, 'tracker', 'script.js');
  fs.mkdirSync(path.dirname(trackerFile), { recursive: true });
  fs.writeFileSync(trackerFile, '(function(){window.pa=function(){}})();\n');
  const dashboardDir = path.join(root, 'dashboard');
  fs.mkdirSync(path.join(dashboardDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'index.html'), '<!doctype html><title>PTR</title><div id="root"></div>');
  fs.writeFileSync(path.join(dashboardDir, 'assets', 'app-abc123.js'), 'console.log("app");');
  fs.writeFileSync(path.join(dashboardDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dashboardDir, '.env'), 'SECRET=hunter2');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP-SECRET-OUTSIDE-ROOT');
  return { root, trackerFile, dashboardDir };
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  clock: { t: number };
  fixtures: Fixtures;
}

export async function createTestApp(
  opts: { env?: Record<string, string>; now?: number; build?: BuildOptions; fixtures?: Fixtures } = {},
): Promise<TestApp> {
  const fixtures = opts.fixtures ?? makeFixtures();
  const config = loadConfig({
    DATA_DIR: path.join(fixtures.root, 'data'),
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    TRACKER_FILE: fixtures.trackerFile,
    DASHBOARD_DIR: fixtures.dashboardDir,
    ...opts.env,
  });
  const clock = { t: opts.now ?? Date.UTC(2026, 5, 15, 12, 0, 0) };
  const app = await buildApp(config, { dbPath: ':memory:', logger: false, now: () => clock.t, ...opts.build });
  return { app, ctx: app.ctx, clock, fixtures };
}

export function cookieFrom(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first) throw new Error('no set-cookie header');
  return first.split(';')[0] as string;
}

export async function login(app: FastifyInstance, email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-pa-request': '1' },
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return cookieFrom(res);
}

/** Authenticated API call with the CSRF header. */
export function api(
  app: FastifyInstance,
  cookie: string,
  method: InjectOptions['method'],
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const req: InjectOptions = { method, url, headers: { cookie, 'x-pa-request': '1' } };
  if (payload !== undefined) req.payload = payload as InjectOptions['payload'];
  return app.inject(req);
}

export interface SendOptions {
  ua?: string;
  ip?: string;
  origin?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

/** POST /api/event as a tracker would (text/plain JSON). */
export function sendEvent(app: FastifyInstance, body: unknown, o: SendOptions = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {
    'content-type': o.contentType ?? 'text/plain;charset=UTF-8',
    'user-agent': o.ua ?? CHROME_UA,
    ...o.headers,
  };
  if (o.origin) headers['origin'] = o.origin;
  return app.inject({
    method: 'POST',
    url: '/api/event',
    headers,
    remoteAddress: o.ip ?? '203.0.113.1',
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function pageview(site: string, url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { site, type: 'pageview', url, ...extra };
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
