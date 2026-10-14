import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { draftOf, draftToInput, move, validateDraft } from '../components/status/editor/draft';
import { badgeSnippets } from '../components/status/editor/BadgesTab';
import { normalizeStatusDomain } from '../components/status/editor/DomainsTab';
import { parseStatusPage } from '../api/status';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADMIN = { id: 1, email: 'admin@example.com', role: 'admin', createdAt: 1, emailVerified: true };
const SITE = { id: 'site00000001', name: 'Acme <Cloud>', domains: ['acme.example'], createdAt: 1 };
const PAGE = {
  uid: 'page00000001',
  siteId: SITE.id,
  slug: 'acme',
  title: 'Acme Status',
  description: 'Hello',
  footer: '',
  theme: 'auto',
  accent: '#7c3aed',
  published: true,
  noindex: false,
  showTags: false,
  showCertExpiry: false,
  showPoweredBy: true,
  refreshS: 60,
  analyticsSiteId: null,
  logoUrl: null,
  sections: [{ name: 'Core', monitors: [{ uid: 'mon000000001', displayName: null, showUrl: false }] }],
  domains: [{ domain: 'status.acme.example', verified: false, verifyToken: 'ptr-status-verify=abc', txtName: '_ptr-status.status.acme.example' }],
};
const monitor = (uid: string, name: string) => ({
  uid,
  siteId: SITE.id,
  type: 'http',
  name,
  active: true,
  target: `https://${name.toLowerCase()}.example`,
  state: { status: 1 },
  config: {},
  tags: [],
});

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
  if (path === '/api/auth/me') return new Response(JSON.stringify({ user: ADMIN }));
  if (path === '/api/public-config') return new Response('{}');
  if (path === '/api/config') return new Response(JSON.stringify({ publicUrl: 'https://analytics.example.com', version: '1', geoip: false }));
  if (path === '/api/sites') return new Response(JSON.stringify({ sites: [SITE] }));
  if (path === '/api/status-pages') return new Response(JSON.stringify({ statusPages: [PAGE] }));
  if (path === `/api/status-pages/${PAGE.uid}`) return new Response(JSON.stringify({ statusPage: PAGE }));
  if (path === `/api/sites/${SITE.id}/monitors`) return new Response(JSON.stringify({ monitors: [monitor('mon000000001', 'Website'), monitor('mon000000002', 'Api')] }));
  if (path === `/api/status-pages/${PAGE.uid}/incidents`) return new Response(JSON.stringify({ incidents: [] }));
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
});

const tick = () => act(async () => new Promise((r) => setTimeout(r, 10)));
async function until(cond: () => boolean) {
  for (let i = 0; i < 150 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}
function setValue(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const button = (name: RegExp, root: ParentNode = document) => Array.from(root.querySelectorAll('button')).find((b) => name.test(b.textContent ?? '') || name.test(b.getAttribute('aria-label') ?? ''));
const sent = (method: string, path: string) => JSON.parse(String(calls.filter((c) => c.path === path && c.init?.method === method).at(-1)?.init?.body ?? 'null')) as Record<string, unknown> | null;
async function renderAt(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
}

describe('status pages list', () => {
  it('lists pages and creates one with live slug validation', async () => {
    routes[`POST /api/sites/${SITE.id}/status-pages`] = () => [409, { error: 'this slug is already taken' }];
    await renderAt('/status-pages');
    await until(() => !!container.querySelector(`[data-page="${PAGE.uid}"]`));
    expect(container.textContent).toContain('/status/acme');
    act(() => button(/New status page/)!.click());
    await until(() => !!document.querySelector('[role=dialog] input'));
    const title = document.querySelector<HTMLInputElement>('[role=dialog] input[placeholder="Acme status"]');
    const slug = document.querySelector<HTMLInputElement>('[role=dialog] input[placeholder="acme"]');
    setValue(title!, 'Acme Ünited Status!');
    expect(slug!.value).toBe('acme-united-status');
    expect(document.querySelector('[data-slot="slug-hint"]')?.textContent).toBe('https://analytics.example.com/status/acme-united-status');
    setValue(slug!, 'admin');
    expect(document.querySelector('[data-slot="slug-hint"]')?.textContent).toMatch(/reserved/);
    setValue(slug!, 'acme');
    await act(async () => document.querySelector<HTMLFormElement>('[role=dialog] form')!.requestSubmit());
    await until(() => (document.querySelector('[data-slot="slug-hint"]')?.textContent ?? '').includes('already taken'));
    expect(sent('POST', `/api/sites/${SITE.id}/status-pages`)).toEqual({ title: 'Acme Ünited Status!', slug: 'acme' });
  });
});

describe('status page editor', () => {
  it('edits sections and saves the draft with one PATCH', async () => {
    routes[`PATCH /api/status-pages/${PAGE.uid}`] = (init) => [200, { statusPage: { ...PAGE, ...JSON.parse(String(init?.body)) } }];
    await renderAt(`/status-pages/${PAGE.uid}?tab=monitors`);
    await until(() => !!container.querySelector('[data-monitor="mon000000001"]'));
    act(() => button(/Add monitors/)!.click());
    await until(() => !!document.querySelector('[role=option]'));
    const options = document.querySelectorAll('[role=option]');
    expect(options).toHaveLength(1); // Website is already on the page
    act(() => (options[0] as HTMLButtonElement).click());
    act(() => button(/Add 1 monitor/)!.click());
    await until(() => !!container.querySelector('[data-monitor="mon000000002"]'));
    act(() => button(/Add group/)!.click());
    // save bar appears
    await until(() => !!document.querySelector('[data-slot="save-bar"]'));
    await act(async () => button(/^Save$/, document.querySelector('[data-slot="save-bar"]')!)!.click());
    await until(() => !!sent('PATCH', `/api/status-pages/${PAGE.uid}`));
    const body = sent('PATCH', `/api/status-pages/${PAGE.uid}`)!;
    expect(body.sections).toEqual([
      { name: 'Core', monitors: [{ uid: 'mon000000001', displayName: null, showUrl: false }, { uid: 'mon000000002', displayName: null, showUrl: false }] },
      { name: 'Group 2', monitors: [] },
    ]);
    expect(body).not.toHaveProperty('domains');
    expect(body).not.toHaveProperty('logoUrl');
  });

  it('shows the TXT record for custom domains and verifies on demand', async () => {
    routes[`POST /api/status-pages/${PAGE.uid}/domains/verify`] = () => [200, { domain: { ...PAGE.domains[0], verified: true } }];
    await renderAt(`/status-pages/${PAGE.uid}?tab=domains`);
    await until(() => !!container.querySelector('[data-domain="status.acme.example"]'));
    const card = container.querySelector('[data-domain="status.acme.example"]')!;
    expect(card.textContent).toContain('_ptr-status.status.acme.example');
    expect(card.textContent).toContain('ptr-status-verify=abc');
    await act(async () => button(/Check now/, card)!.click());
    await until(() => (container.querySelector('[data-domain="status.acme.example"]')?.textContent ?? '').includes('Verified'));
    expect(sent('POST', `/api/status-pages/${PAGE.uid}/domains/verify`)).toEqual({ domain: 'status.acme.example' });
  });
});

describe('editor helpers', () => {
  it('validates and serialises drafts', () => {
    const page = parseStatusPage(PAGE)!;
    const d = draftOf(page);
    expect(validateDraft(d)).toEqual({});
    expect(validateDraft({ ...d, title: ' ', slug: 'Bad Slug', sections: [{ name: '', monitors: [] }] })).toMatchObject({ title: expect.any(String), slug: expect.any(String), sections: expect.any(String) });
    const input = draftToInput({ ...d, sections: [{ name: ' Core ', monitors: [{ uid: 'm', displayName: '  ', showUrl: true }] }] });
    expect(input.sections).toEqual([{ name: 'Core', monitors: [{ uid: 'm', displayName: null, showUrl: true }] }]);
    expect(move([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(move([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  });

  it('builds badge snippets and normalises domains', () => {
    const s = badgeSnippets('https://a.example', { slug: 'acme', title: 'x' }, 'for-the-badge');
    expect(s.markdown).toBe('[![Status](https://a.example/api/public/status/acme/badge.svg?style=for-the-badge)](https://a.example/status/acme)');
    expect(s.html).toContain('<img src="https://a.example/api/public/status/acme/badge.svg?style=for-the-badge" alt="Status">');
    expect(normalizeStatusDomain('https://Status.Example.com/path')).toBe('status.example.com');
    expect(normalizeStatusDomain('*.example.com')).toBeNull();
    expect(normalizeStatusDomain('localhost')).toBeNull();
    expect(normalizeStatusDomain('10.0.0.1')).toBeNull();
  });
});
