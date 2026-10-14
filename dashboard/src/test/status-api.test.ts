import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { notifyApi, parseChannel, parseProvider } from '../api/notify';
import { API_KEY_SCOPES, safeOtpauthUrl, securityApi, securityError } from '../api/security';
import {
  checkLogoFile,
  parsePublicStatus,
  safeAssetUrl,
  safeHttpUrl,
  safeTrackerScript,
  slugError,
  slugify,
  statusApi,
  statusUrls,
} from '../api/status';

function mockFetch(status: number, body?: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const headers = (init?: RequestInit) => init?.headers as Record<string, string>;

describe('notify API client', () => {
  it('parses providers defensively', async () => {
    mockFetch(200, {
      providers: [
        { id: 'slack', label: 'Slack', category: 'chat', fields: [{ key: 'webhookUrl', label: 'URL', kind: 'password' }, { key: 'x', kind: 'evil' }], hostedAllowed: true },
        { id: 'smtp-raw', label: 'Raw SMTP', category: 'bogus', fields: [], hostedAllowed: false, templateVars: ['title', 'x<y'] },
        { label: 'no id' },
      ],
    });
    const p = await notifyApi.providers();
    expect(p.map((x) => x.id)).toEqual(['slack', 'smtp-raw']);
    expect(p[0]!.fields.map((f) => f.key)).toEqual(['webhookUrl']);
    expect(p[0]!.fields[0]!.secret).toBe(true);
    expect(p[1]!.category).toBe('other');
    expect(p[1]!.hostedAllowed).toBe(false);
    expect(p[1]!.templateVars).toEqual(['title']);
    expect(parseProvider({ id: 'x', hosted: 'disabled' })?.hostedAllowed).toBe(false);
  });

  it('creates channels with CSRF header and JSON body', async () => {
    const fetch = mockFetch(201, { channel: { uid: 'abc123def456', type: 'webhook', name: 'Hook', config: {}, secretsSet: ['headers'], monitorCount: 2 } });
    const c = await notifyApi.createChannel({ type: 'webhook', name: 'Hook', config: { url: 'https://x.example' }, isDefault: true, applyToExisting: true });
    expect(c.secretsSet).toEqual(['headers']);
    expect(c.active).toBe(true);
    expect(c.verified).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/notification-channels');
    expect(init?.method).toBe('POST');
    expect(headers(init)['X-PA-Request']).toBe('1');
    expect(JSON.parse(String(init?.body))).toMatchObject({ applyToExisting: true, isDefault: true });
  });

  it('keeps the field of validation errors', async () => {
    mockFetch(400, { error: 'Bot token must look like 123:AA…', code: 'invalid_field', field: 'botToken' });
    const err = (await notifyApi.createChannel({ type: 'telegram', name: 't', config: {} }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.field).toBe('botToken');
    expect(err.message).toMatch(/Bot token/);
  });

  it('tests channels and reads the log', async () => {
    let fetch = mockFetch(200, { ok: false, error: 'host not found' });
    expect(await notifyApi.testChannel('abc123def456')).toEqual({ ok: false, error: 'host not found' });
    expect(fetch.mock.calls[0]![0]).toBe('/api/notification-channels/abc123def456/test');
    fetch = mockFetch(200, { ok: true });
    expect(await notifyApi.testUnsaved({ type: 'slack', config: {}, uid: 'abc123def456' })).toEqual({ ok: true });
    expect(fetch.mock.calls[0]![0]).toBe('/api/notification-channels/test');
    fetch = mockFetch(200, { entries: [{ ts: 1, event: 'down', ok: 1, httpStatus: 502, error: 'Bad', monitorUid: 'm1' }, { event: 'x' }] });
    const log = await notifyApi.log('a/b', 25);
    expect(fetch.mock.calls[0]![0]).toBe('/api/notification-channels/a%2Fb/log?limit=25');
    expect(log).toEqual([{ ts: 1, event: 'down', ok: true, httpStatus: 502, error: 'Bad', monitorUid: 'm1' }]);
  });

  it('parses channel extras', () => {
    const c = parseChannel({ uid: 'u', type: 'email', recipients: [{ address: 'a@b.c', verified: false }, { nope: 1 }], autoDisabled: true, verified: false, consecutiveFailures: -3 });
    expect(c?.recipients).toEqual([{ address: 'a@b.c', verified: false, unsubscribed: false }]);
    expect(c?.autoDisabled).toBe(true);
    expect(c?.consecutiveFailures).toBe(0);
  });
});

describe('status API client', () => {
  it('lists, creates and patches status pages', async () => {
    let fetch = mockFetch(200, { statusPages: [{ uid: 'p1', siteId: 's1', slug: 'acme', title: 'Acme', accent: 'red', logoUrl: 'javascript:alert(1)', refreshS: 5 }] });
    const [p] = await statusApi.list();
    expect(p!.accent).toBeNull();
    expect(p!.logoUrl).toBeNull();
    expect(p!.refreshS).toBe(30);
    expect(p!.showPoweredBy).toBe(true);
    fetch = mockFetch(201, { statusPage: { uid: 'p2', siteId: 's1', slug: 'x', title: 'X' } });
    await statusApi.create('s 1', { title: 'X', slug: 'x' });
    expect(fetch.mock.calls[0]![0]).toBe('/api/sites/s%201/status-pages');
    fetch = mockFetch(200, { statusPage: { uid: 'p2', siteId: 's1', slug: 'x', title: 'X', domains: [{ domain: 'status.x.io', verified: false, verifyToken: 't' }] } });
    const up = await statusApi.update('p2', { domains: ['status.x.io'] });
    expect(up.domains[0]!.txtName).toBe('_ptr-status.status.x.io');
    expect(fetch.mock.calls[0]![1]?.method).toBe('PATCH');
  });

  it('uploads logos as the raw body', async () => {
    const fetch = mockFetch(200, { statusPage: { uid: 'p1', siteId: 's', slug: 'a', title: 'A', logoUrl: '/api/public/assets/abc.png' } });
    const file = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])], { type: 'image/png' });
    const page = await statusApi.uploadLogo('p1', file);
    expect(page?.logoUrl).toBe('/api/public/assets/abc.png');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/status-pages/p1/logo');
    expect(headers(init)['Content-Type']).toBe('image/png');
    expect(headers(init)['X-PA-Request']).toBe('1');
    expect(init?.body).toBe(file);
  });

  it('validates logo files client-side', async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8])], { type: 'image/png' });
    expect(await checkLogoFile(png)).toBeNull();
    expect(await checkLogoFile(new Blob(['<svg onload=alert(1)>'], { type: 'image/svg+xml' }))).toMatch(/PNG, JPEG or WebP/);
    expect(await checkLogoFile(new Blob(['<html>xxxxxxxxxxxx'], { type: 'image/png' }))).toMatch(/not a valid/);
    expect(await checkLogoFile(new Blob([new Uint8Array(512 * 1024 + 1)], { type: 'image/png' }))).toMatch(/512 KB/);
  });

  it('manages incidents', async () => {
    let fetch = mockFetch(201, { incident: { uid: 'i1', title: 'T', body: 'B', style: 'evil', pinned: true, createdAt: 1, resolvedAt: null } });
    const i = await statusApi.createIncident('p1', { title: 'T', body: 'B', style: 'warning' });
    expect(i.style).toBe('info');
    expect(fetch.mock.calls[0]![0]).toBe('/api/status-pages/p1/incidents');
    fetch = mockFetch(200, { incident: { uid: 'i1', title: 'T', body: '', style: 'success', resolvedAt: 5 } });
    await statusApi.updateIncident('i1', { resolved: true });
    expect(fetch.mock.calls[0]![0]).toBe('/api/incidents/i1');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ resolved: true });
  });

  it('fetches the public status without redirecting on 401', async () => {
    const fetch = mockFetch(404, { error: 'not found' });
    await expect(statusApi.publicStatus('acme')).rejects.toMatchObject({ status: 404 });
    expect(fetch.mock.calls[0]![0]).toBe('/api/public/status/acme');
  });

  it('validates slugs like the server', () => {
    expect(slugError('acme-status')).toBeNull();
    expect(slugError('a')).toBeNull();
    expect(slugError('-acme')).not.toBeNull();
    expect(slugError('Acme')).not.toBeNull();
    expect(slugError('admin')).toMatch(/reserved/);
    expect(slugError('a'.repeat(65))).not.toBeNull();
    expect(slugify('  Ächme Status!! ')).toBe('achme-status');
  });

  it('only accepts safe URLs from the public JSON', () => {
    expect(safeAssetUrl('/api/public/assets/x.png')).toBe('/api/public/assets/x.png');
    expect(safeAssetUrl('//evil.example/x.png')).toBeNull();
    expect(safeAssetUrl('/a/../b')).toBeNull();
    expect(safeAssetUrl('https://evil.example/x.png')).toBeNull();
    expect(safeAssetUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('https://u:p@x.example/')).toBeNull();
    expect(safeHttpUrl('https://x.example/a')).toBe('https://x.example/a');
    expect(safeTrackerScript('/script.js')).toBe('/script.js');
    expect(safeTrackerScript(`${window.location.origin}/script.js`)).toBe('/script.js');
    expect(safeTrackerScript('https://evil.example/script.js')).toBeNull();
    expect(safeTrackerScript('/script.js?x=1')).toBeNull();
    expect(safeTrackerScript('/other.js')).toBeNull();
  });

  it('parses the public JSON defensively', () => {
    const p = parsePublicStatus({
      title: 'T',
      theme: 'neon',
      accent: '#ABCDEF',
      overall: 'exploded',
      tz: 'Not/AZone',
      analytics: { siteId: 'abc', scriptUrl: 'https://cdn.evil.example/script.js' },
      sections: [{ name: 'S', monitors: [{ id: 'x', name: 'M', status: 'paused', uptime90d: 7, bars: [{ t: 1, upRatio: 2 }, { upRatio: 1 }], url: 'javascript:alert(1)' }] }],
    });
    expect(p.theme).toBe('auto');
    expect(p.accent).toBe('#abcdef');
    expect(p.overall).toBe('unknown');
    expect(p.tz).toBeNull();
    expect(p.analytics).toBeNull();
    const m = p.sections[0]!.monitors[0]!;
    expect(m.status).toBe('paused');
    expect(m.uptime90d).toBe(1);
    expect(m.bars).toEqual([{ t: 1, upRatio: 1, maintenance: false }]);
    expect(m.url).toBeNull();
    expect(statusUrls('https://a.example/', 'acme')).toEqual({
      page: 'https://a.example/status/acme',
      badge: 'https://a.example/api/public/status/acme/badge.svg',
      rss: 'https://a.example/status/acme/feed.xml',
    });
  });
});

describe('security API client', () => {
  it('distinguishes a session from an MFA challenge on login', async () => {
    mockFetch(200, { mfaRequired: true, mfaToken: 'tok' });
    expect(await securityApi.login('a@b.c', 'pw')).toEqual({ kind: 'mfa', mfaToken: 'tok' });
    mockFetch(200, { user: { id: 1, email: 'a@b.c', role: 'admin', createdAt: 1 } });
    expect((await securityApi.login('a@b.c', 'pw')).kind).toBe('user');
  });

  it('sends the second factor', async () => {
    const fetch = mockFetch(200, { user: { id: 1, email: 'a@b.c', role: 'admin', createdAt: 1 } });
    await securityApi.loginMfa('tok', { recoveryCode: 'abcd-efgh-ijkl-mnop' });
    expect(fetch.mock.calls[0]![0]).toBe('/api/auth/login/mfa');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ mfaToken: 'tok', recoveryCode: 'abcd-efgh-ijkl-mnop' });
  });

  it('validates the MFA setup response', async () => {
    const setup = mockFetch(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/PTR:a?secret=JBSWY3DPEHPK3PXP&issuer=PTR' });
    expect((await securityApi.mfaSetup('pw')).secret).toBe('JBSWY3DPEHPK3PXP');
    expect(JSON.parse(String(setup.mock.calls[0]![1]?.body))).toEqual({ password: 'pw' });
    mockFetch(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'javascript:alert(1)' });
    await expect(securityApi.mfaSetup('pw')).rejects.toBeInstanceOf(ApiError);
    expect(safeOtpauthUrl('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP')).toBeNull();
    expect(safeOtpauthUrl('otpauth://totp/x?secret=not-base32!')).toBeNull();
  });

  it('enables MFA and returns recovery codes, normalising the code', async () => {
    const fetch = mockFetch(200, { recoveryCodes: ['aaaa-bbbb-cccc-dddd', 42, ''], apiKeysRevoked: 2 });
    expect(await securityApi.mfaEnable('pw', '123 456')).toEqual({ recoveryCodes: ['aaaa-bbbb-cccc-dddd'], apiKeysRevoked: 2 });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ password: 'pw', code: '123456' });
  });

  it('disables MFA / regenerates codes with the password and a code or recovery code', async () => {
    const off = mockFetch(204);
    await securityApi.mfaDisable('pw', { recoveryCode: ' abcd-efgh-ijkl ' });
    expect(JSON.parse(String(off.mock.calls[0]![1]?.body))).toEqual({ password: 'pw', recoveryCode: 'abcd-efgh-ijkl' });
    const regen = mockFetch(200, { recoveryCodes: ['x1x1-x1x1'] });
    expect(await securityApi.regenerateRecoveryCodes('pw', { code: '123 456' })).toEqual(['x1x1-x1x1']);
    expect(JSON.parse(String(regen.mock.calls[0]![1]?.body))).toEqual({ password: 'pw', code: '123456' });
  });

  it('maps security errors to fields and sentences', () => {
    expect(securityError(new ApiError(400, 'password is incorrect'))).toEqual({ field: 'password', message: 'The password is incorrect.' });
    expect(securityError(new ApiError(400, 'invalid code', 'invalid_code')).field).toBe('code');
    expect(securityError(new ApiError(400, 'invalid code', 'invalid_code')).message).toMatch(/^That code didn’t work/);
    expect(securityError(new ApiError(400, 'invalid code', 'invalid_code'), 'recovery').message).toBe('Invalid or already used recovery code.');
    expect(securityError(new ApiError(400, 'code is required', 'mfa_code_required')).field).toBe('code');
    expect(securityError(new ApiError(429, 'too many wrong codes, try again in 5 min', 'mfa_locked'))).toEqual({ field: 'code', message: 'Too many wrong codes. Try again in 5 minutes.' });
    expect(securityError(new ApiError(409, 'start the setup first')).message).toBe('Start the setup first.');
  });

  it('creates API keys and returns the key once', async () => {
    const fetch = mockFetch(201, { apiKey: { uid: 'k1', name: 'Prom', prefix: 'abcd1234', scopes: ['metrics', 'admin'], createdAt: 1, expiresAt: null, lastUsedAt: null }, key: 'pa_abcd1234_secretsecretsecret' });
    const r = await securityApi.createApiKey({ name: 'Prom', scopes: ['metrics'], expiresInDays: 30, password: 'pw', factor: { code: '123 456' } });
    expect(r.key).toBe('pa_abcd1234_secretsecretsecret');
    expect(r.apiKey.scopes).toEqual(['metrics']);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ name: 'Prom', scopes: ['metrics'], expiresInDays: 30, password: 'pw', code: '123456' });
    mockFetch(200, { apiKeys: [{ uid: 'k1', name: 'n', prefix: 'p', scopes: API_KEY_SCOPES }] });
    expect(await securityApi.listApiKeys()).toHaveLength(1);
    const del = mockFetch(204);
    await securityApi.revokeApiKey('k1');
    expect(del.mock.calls[0]![0]).toBe('/api/api-keys/k1');
    expect(del.mock.calls[0]![1]?.method).toBe('DELETE');
  });
});
