import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADMIN = { id: 1, email: 'admin@example.com', role: 'admin', createdAt: 1, emailVerified: true };
const PROVIDERS = [
  {
    id: 'webhook',
    label: 'Webhook',
    category: 'webhook',
    hostedAllowed: true,
    fields: [
      { key: 'url', label: 'Webhook URL', kind: 'url', required: true },
      { key: 'bodyTemplate', label: 'Body', kind: 'textarea' },
    ],
    templateVars: ['title', 'monitor.name'],
    presets: [{ id: 'p1', label: 'Grafana OnCall', help: 'Use the formatted webhook URL.', config: { bodyTemplate: '{"t":"{{title}}"}' } }],
  },
  { id: 'telegram', label: 'Telegram', category: 'chat', hostedAllowed: true, fields: [{ key: 'botToken', label: 'Bot token', kind: 'password', required: true, secret: true }] },
  { id: 'smtp-raw', label: 'Raw relay', category: 'other', hostedAllowed: false, fields: [] },
];
const CHANNELS = [
  { uid: 'c1aaaaaaaaaa', type: 'webhook', name: 'Hook <img src=x onerror=alert(1)>', config: { url: 'https://h.example' }, secretsSet: [], isDefault: true, active: true, verified: true, consecutiveFailures: 4, monitorCount: 3 },
  { uid: 'c2aaaaaaaaaa', type: 'email', name: 'Team inbox', config: {}, secretsSet: [], isDefault: false, active: false, verified: false, consecutiveFailures: 10, autoDisabled: true, monitorCount: 1, recipients: [{ address: 'a@x.io', verified: true }, { address: 'b@x.io', verified: false }] },
];

let publicConfig: Record<string, unknown> = {};
let me: Record<string, unknown> = ADMIN;
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
  if (path === '/api/auth/me') return new Response(JSON.stringify({ user: me }));
  if (path === '/api/public-config') return new Response(JSON.stringify(publicConfig));
  if (path === '/api/config') return new Response(JSON.stringify({ publicUrl: null, version: '1', geoip: false }));
  if (path === '/api/notification-providers') return new Response(JSON.stringify({ providers: PROVIDERS }));
  if (path === '/api/notification-channels') return new Response(JSON.stringify({ channels: CHANNELS }));
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
  publicConfig = {};
  me = ADMIN;
});

const tick = () => act(async () => new Promise((r) => setTimeout(r, 10)));
async function until(cond: () => boolean) {
  for (let i = 0; i < 150 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const button = (name: RegExp) => Array.from(document.querySelectorAll('button')).find((b) => name.test(b.textContent ?? ''));
const posted = (path: string) => JSON.parse(String(calls.filter((c) => c.path === path && c.init?.method === 'POST').at(-1)?.init?.body ?? 'null')) as Record<string, unknown> | null;

async function open() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/notifications']}>
        <App />
      </MemoryRouter>,
    );
  });
  await until(() => !!container.querySelector('[data-channel="c1aaaaaaaaaa"]'));
}

describe('notifications page', () => {
  it('lists channels with safe names and status badges', async () => {
    await open();
    const row = container.querySelector('[data-channel="c1aaaaaaaaaa"]')!;
    expect(row.textContent).toContain('Hook <img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(row.textContent).toContain('Default');
    expect(row.textContent).toContain('4 failed in a row');
    expect(row.textContent).toContain('3 monitors');
    const mail = container.querySelector('[data-channel="c2aaaaaaaaaa"]')!;
    expect(mail.textContent).toContain('1 of 2 confirmed');
    expect(mail.textContent).toContain('Disabled after 10 failures');
    expect(mail.textContent).toContain('Paused');
  });

  it('adds a webhook channel through the provider picker and the shared form', async () => {
    routes['POST /api/notification-channels'] = () => [201, { channel: { ...CHANNELS[0], uid: 'c3aaaaaaaaaa', name: 'My hook' } }];
    routes['POST /api/notification-channels/test'] = () => [200, { ok: false, error: 'host not found (ENOTFOUND)' }];
    await open();
    act(() => button(/Add channel/)!.click());
    await until(() => !!document.querySelector('[data-slot="provider-grid"]'));
    expect(button(/Raw relay/)?.disabled).toBe(false);
    act(() => button(/^Webhook/)!.click());
    await until(() => !!document.querySelector('[data-slot="channel-dialog"] form'));
    const dialog = document.querySelector('[data-slot="channel-dialog"]')!;
    // the name defaults to the provider label
    const inputs = dialog.querySelectorAll<HTMLInputElement>('input');
    expect(inputs[0]!.value).toBe('Webhook');
    // required URL is validated client-side before anything is sent
    act(() => button(/Send test/)!.click());
    expect(dialog.textContent).toMatch(/required/i);
    const url = Array.from(inputs).find((i) => i.type === 'url' || i.placeholder.includes('http') || i.name === 'url') ?? inputs[1]!;
    setValue(url, 'https://hooks.example/x');
    act(() => button(/Grafana OnCall/)!.click());
    expect((dialog.querySelector('textarea') as HTMLTextAreaElement).value).toBe('{"t":"{{title}}"}');
    act(() => (Array.from(dialog.querySelectorAll('[data-slot="template-vars"] button')).find((b) => b.textContent === '{{monitor.name}}') as HTMLButtonElement).click());
    expect((dialog.querySelector('textarea') as HTMLTextAreaElement).value).toBe('{"t":"{{title}}"}{{monitor.name}}');
    await act(async () => button(/Send test/)!.click());
    await until(() => !!document.querySelector('[data-slot="test-result"]'));
    expect(document.querySelector('[data-slot="test-result"]')!.textContent).toContain('ENOTFOUND');
    await act(async () => (dialog.querySelector('form') as HTMLFormElement).requestSubmit());
    await until(() => !!posted('/api/notification-channels'));
    expect(posted('/api/notification-channels')).toEqual({
      type: 'webhook',
      name: 'Webhook',
      config: { url: 'https://hooks.example/x', bodyTemplate: '{"t":"{{title}}"}{{monitor.name}}' },
      isDefault: false,
    });
  });

  it('maps server field errors to the form field', async () => {
    routes['POST /api/notification-channels'] = () => [400, { error: 'Bot token must look like 123:AA…', code: 'invalid_field', field: 'botToken' }];
    await open();
    act(() => button(/Add channel/)!.click());
    await until(() => !!button(/^Telegram/));
    act(() => button(/^Telegram/)!.click());
    await until(() => !!document.querySelector('[data-slot="channel-dialog"] input[type=password]'));
    setValue(document.querySelector<HTMLInputElement>('[data-slot="channel-dialog"] input[type=password]')!, 'nope');
    await act(async () => document.querySelector<HTMLFormElement>('[data-slot="channel-dialog"] form')!.requestSubmit());
    await until(() => (document.querySelector('[data-slot="channel-dialog"]')?.textContent ?? '').includes('Bot token must look like'));
  });

  it('disables providers that hosted members may not use', async () => {
    publicConfig = { signupEnabled: true };
    me = { ...ADMIN, role: 'member' };
    await open();
    act(() => button(/Add channel/)!.click());
    await until(() => !!button(/Raw relay/));
    expect(button(/Raw relay/)?.disabled).toBe(true);
    expect(button(/Raw relay/)?.textContent).toContain('Self-hosted only');
  });
});
