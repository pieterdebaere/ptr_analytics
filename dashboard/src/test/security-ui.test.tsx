import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { prometheusExample } from '../components/security/ApiKeysCard';
import { groupSecret, recoveryCodesText } from '../components/security/secrets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADMIN = { id: 1, email: 'admin@example.com', role: 'admin', createdAt: 1, emailVerified: true };
let me: Record<string, unknown> | null = null;
let routes: Record<string, (init?: RequestInit) => [number, unknown]> = {};
const calls: Array<{ path: string; init?: RequestInit }> = [];

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const path = new URL(url, 'http://localhost').pathname;
  calls.push({ path, init });
  const key = `${init?.method ?? 'GET'} ${path}`;
  if (routes[key]) {
    const [status, body] = routes[key]!(init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }
  if (path === '/api/auth/me') return me ? new Response(JSON.stringify({ user: me })) : new Response('{"error":"unauthorized"}', { status: 401 });
  if (path === '/api/public-config') return new Response('{}');
  if (path === '/api/config') return new Response(JSON.stringify({ publicUrl: 'https://analytics.example.com', version: '1', geoip: false }));
  return new Response('{"error":"not found"}', { status: 404 });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  calls.length = 0;
  routes = {};
  me = null;
});

const tick = () => act(async () => new Promise((r) => setTimeout(r, 10)));
async function until(cond: () => boolean) {
  for (let i = 0; i < 150 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}
async function renderAt(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
}
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const body = (path: string) =>
  JSON.parse(String(calls.filter((c) => c.path === path && c.init?.method && c.init.method !== 'GET').at(-1)?.init?.body ?? '{}')) as Record<string, unknown>;
const button = (name: RegExp) => Array.from(document.querySelectorAll('button')).find((b) => name.test(b.textContent ?? ''));

describe('login with two-factor authentication', () => {
  async function toMfaStep() {
    routes['POST /api/auth/login'] = () => [200, { mfaRequired: true, mfaToken: 'challenge-token' }];
    await renderAt('/login');
    await until(() => !!container.querySelector('input[type=email]'));
    setInput(container.querySelector('input[type=email]')!, 'admin@example.com');
    setInput(container.querySelector('input[type=password]')!, 'secret');
    await act(async () => container.querySelector('form')!.requestSubmit());
    await until(() => (container.textContent ?? '').includes('Two-factor authentication'));
  }

  it('asks for the 6-digit code and logs in', async () => {
    await toMfaStep();
    routes['POST /api/auth/login/mfa'] = () => [200, { user: ADMIN }];
    const input = container.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
    expect(input.getAttribute('inputmode')).toBe('numeric');
    setInput(input, '12a3 456');
    expect(input.value).toBe('123 456');
    await act(async () => container.querySelector('form')!.requestSubmit());
    await tick();
    expect(body('/api/auth/login/mfa')).toEqual({ mfaToken: 'challenge-token', code: '123456' });
  });

  it('supports recovery codes and shows invalid-code errors', async () => {
    await toMfaStep();
    routes['POST /api/auth/login/mfa'] = () => [401, { error: 'invalid code', code: 'invalid_code' }];
    act(() => button(/Use a recovery code/)!.click());
    const input = container.querySelector<HTMLInputElement>('input[name="recovery-code"]')!;
    setInput(input, ' abcd-efgh-ijkl-mnop ');
    await act(async () => container.querySelector('form')!.requestSubmit());
    await until(() => (container.textContent ?? '').includes('Invalid or already used recovery code'));
    expect(body('/api/auth/login/mfa')).toEqual({ mfaToken: 'challenge-token', recoveryCode: 'abcd-efgh-ijkl-mnop' });
  });

  it('returns to the password step when the challenge expired', async () => {
    await toMfaStep();
    routes['POST /api/auth/login/mfa'] = () => [401, { error: 'expired', code: 'mfa_expired' }];
    setInput(container.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!, '123456');
    await act(async () => container.querySelector('form')!.requestSubmit());
    await until(() => (container.textContent ?? '').includes('Your login attempt expired'));
    expect(container.querySelector('input[type=email]')).not.toBeNull();
  });

  it('rejects malformed codes client-side', async () => {
    await toMfaStep();
    setInput(container.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!, '12');
    await act(async () => container.querySelector('form')!.requestSubmit());
    expect(container.textContent).toContain('Enter the 6-digit code');
    expect(calls.some((c) => c.path === '/api/auth/login/mfa')).toBe(false);
  });
});

describe('security page', () => {
  it('enables MFA with a client-side QR code and shows recovery codes once', async () => {
    me = ADMIN;
    routes['GET /api/auth/mfa'] = () => [200, { enabled: false, recoveryCodesLeft: 0, required: false }];
    routes['GET /api/api-keys'] = () => [200, { apiKeys: [] }];
    routes['POST /api/auth/mfa/setup'] = () => [200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/PTR%20Analytics:admin%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=PTR%20Analytics' }];
    let enableCalls = 0;
    routes['POST /api/auth/mfa/enable'] = () =>
      ++enableCalls === 1 ? [400, { error: 'invalid code', code: 'invalid_code' }] : [200, { recoveryCodes: ['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh'], apiKeysRevoked: 2 }];
    await renderAt('/settings/security');
    await until(() => !!button(/^Turn on$/));
    act(() => button(/^Turn on$/)!.click());
    // step 1: the password (re-authentication)
    await until(() => !!document.querySelector('[role=dialog] input[type="password"]'));
    routes['POST /api/auth/mfa/setup'] = () => [400, { error: 'password is incorrect' }];
    setInput(document.querySelector<HTMLInputElement>('[role=dialog] input[type="password"]')!, 'wrong');
    await act(async () => document.querySelector<HTMLFormElement>('[role=dialog] form')!.requestSubmit());
    await until(() => (document.querySelector('[role=dialog]')?.textContent ?? '').includes('The password is incorrect.'));
    routes['POST /api/auth/mfa/setup'] = () => [200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/PTR%20Analytics:admin%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=PTR%20Analytics' }];
    setInput(document.querySelector<HTMLInputElement>('[role=dialog] input[type="password"]')!, 'hunter22');
    await act(async () => document.querySelector<HTMLFormElement>('[role=dialog] form')!.requestSubmit());
    expect(body('/api/auth/mfa/setup')).toEqual({ password: 'hunter22' });
    await until(() => !!document.querySelector('svg[role=img][data-qr-version]'));
    const qr = document.querySelector('svg[role=img][data-qr-version]')!;
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d/);
    expect(document.querySelector('img[src^="data:"]')).toBeNull();
    expect(document.body.textContent).toContain('JBSW Y3DP EHPK 3PXP');
    // a wrong code: a sentence under the code field, not the raw server message
    setInput(document.querySelector<HTMLInputElement>('[role=dialog] input[autocomplete="one-time-code"]')!, '111111');
    await act(async () => document.querySelector<HTMLFormElement>('[role=dialog] form')!.requestSubmit());
    await until(() => (document.querySelector('[role=dialog]')?.textContent ?? '').includes('That code didn’t work'));
    expect(document.querySelector('[role=dialog]')!.textContent).not.toContain('invalid code');
    setInput(document.querySelector<HTMLInputElement>('[role=dialog] input[autocomplete="one-time-code"]')!, '654321');
    await act(async () => document.querySelector<HTMLFormElement>('[role=dialog] form')!.requestSubmit());
    await until(() => !!document.querySelector('[data-slot="recovery-codes"]'));
    expect(document.querySelector('[data-slot="recovery-codes"]')!.textContent).toContain('eeee-ffff-gggg-hhhh');
    expect(body('/api/auth/mfa/enable')).toEqual({ password: 'hunter22', code: '654321' });
    expect(document.querySelector('[data-slot="keys-revoked"]')?.textContent).toContain('2 API keys were revoked');
    expect(button(/^Done$/)?.disabled).toBe(true);
    // the codes cannot be dismissed (Escape) before "I have stored these codes"
    act(() => {
      document.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await tick();
    expect(document.querySelector('[data-slot="recovery-codes"]')).not.toBeNull();
    expect(document.querySelector('[role=dialog] [data-slot="dialog-close"]')).toBeNull();
  });

  it('lists API keys and creates one with a Prometheus example', async () => {
    me = ADMIN;
    routes['GET /api/auth/mfa'] = () => [200, { enabled: true, recoveryCodesLeft: 2, required: false }];
    routes['GET /api/api-keys'] = () => [200, { apiKeys: [{ uid: 'k1', name: 'Old <b>key</b>', prefix: 'abcd1234', scopes: ['read'], createdAt: 1, expiresAt: 2, lastUsedAt: null }] }];
    routes['POST /api/api-keys'] = () => [201, { apiKey: { uid: 'k2', name: 'Prom', prefix: 'zzzz9999', scopes: ['metrics', 'read'], createdAt: 3, expiresAt: null, lastUsedAt: null }, key: 'pa_zzzz9999_supersecretvalue' }];
    await renderAt('/settings/security');
    await until(() => (container.textContent ?? '').includes('Old <b>key</b>'));
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('Expired');
    expect(container.querySelector('[data-slot="codes-left"]')?.textContent).toContain('2 unused codes');
    act(() => button(/New key/)!.click());
    await until(() => !!document.querySelector('[role=dialog] input'));
    setInput(document.querySelector<HTMLInputElement>('[role=dialog] input')!, 'Prom');
    // admins are offered the metrics:all scope
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('Metrics (all accounts)');
    // 2FA is on: password and a code are required
    await act(async () => document.querySelector<HTMLFormElement>('[role=dialog] form')!.requestSubmit());
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('Enter your password.');
    expect(calls.some((c) => c.path === '/api/api-keys' && c.init?.method === 'POST')).toBe(false);
    setInput(document.querySelector<HTMLInputElement>('[role=dialog] input[type="password"]')!, 'hunter22');
    setInput(document.querySelector<HTMLInputElement>('[role=dialog] input[autocomplete="one-time-code"]')!, '123 456');
    await act(async () => document.querySelector<HTMLFormElement>('[role=dialog] form')!.requestSubmit());
    await until(() => (document.body.textContent ?? '').includes('pa_zzzz9999_supersecretvalue'));
    expect(body('/api/api-keys')).toEqual({ name: 'Prom', scopes: ['metrics'], expiresInDays: 365, password: 'hunter22', code: '123456' });
    expect(document.body.textContent).toContain('scrape_configs:');
    expect(document.querySelector('[data-slot="key-warning"]')?.textContent).toContain(
      'Anyone with this key can scrape your uptime metrics and read your sites, statistics and monitors on your behalf.',
    );
  });
});

describe('security page without 2FA', () => {
  it('asks for a code when the server says 2FA is on (mfa_code_required)', async () => {
    me = { ...ADMIN, role: 'member' };
    routes['GET /api/auth/mfa'] = () => [200, { enabled: false, recoveryCodesLeft: 0, required: false }];
    routes['GET /api/api-keys'] = () => [200, { apiKeys: [] }];
    routes['POST /api/api-keys'] = () => [400, { error: 'code is required', code: 'mfa_code_required' }];
    await renderAt('/settings/security');
    await until(() => !!button(/New key/));
    act(() => button(/New key/)!.click());
    await until(() => !!document.querySelector('[role=dialog] input'));
    expect(document.querySelector('[role=dialog]')!.textContent).not.toContain('Metrics (all accounts)');
    expect(document.querySelector('[role=dialog] input[autocomplete="one-time-code"]')).toBeNull();
    setInput(document.querySelector<HTMLInputElement>('[role=dialog] input')!, 'Script');
    setInput(document.querySelector<HTMLInputElement>('[role=dialog] input[type="password"]')!, 'hunter22');
    await act(async () => document.querySelector<HTMLFormElement>('[role=dialog] form')!.requestSubmit());
    await until(() => !!document.querySelector('[role=dialog] input[autocomplete="one-time-code"]'));
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('enter a code from your authenticator app');
  });
});

describe('security helpers', () => {
  it('formats secrets and the scrape config', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(recoveryCodesText(['a', 'b'], 'me@x.io', 'https://x.io')).toContain('\na\nb\n');
    const y = prometheusExample('https://analytics.example.com', 'pa_x_y');
    expect(y).toContain('scheme: https');
    expect(y).toContain("targets: ['analytics.example.com']");
    expect(y).toContain('credentials: pa_x_y');
  });
});
