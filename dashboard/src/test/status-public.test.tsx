import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 6, 1);
const bars = Array.from({ length: 90 }, (_, i) => ({ t: T0 + i * DAY, upRatio: i === 40 ? 0.9 : 1, maintenance: i === 50 }));

function publicJson(over: Record<string, unknown> = {}) {
  return {
    slug: 'acme',
    title: 'Acme <img src=x onerror=alert(1)>',
    description: 'All **good** <script>alert(1)</script> [x](javascript:alert(1))',
    footer: 'Contact [us](mailto:ops@acme.example)',
    theme: 'dark',
    accent: '#7c3aed',
    logoUrl: '/api/public/assets/abc.png',
    showPoweredBy: true,
    noindex: true,
    refreshS: 60,
    tz: 'UTC',
    analytics: { siteId: 'site123', scriptUrl: '/script.js' },
    paused: false,
    overall: 'degraded',
    sections: [
      {
        name: 'Core <b>services</b>',
        monitors: [
          { id: 'm1', name: 'Website', status: 'up', uptime90d: 0.9991, bars },
          { id: 'm2', name: 'API‮gnp.exe', status: 'down', uptime90d: 0.95, bars, url: 'https://api.acme.example/health' },
          { id: 'm3', name: 'Evil link', status: 'paused', uptime90d: null, bars: [], url: 'javascript:alert(1)', certDaysLeft: 5, tags: [{ name: 'eu', color: 'red;background:url(x)', value: '' }] },
        ],
      },
    ],
    incidents: [
      { id: 'i1', title: 'Checkout errors', body: '- one\n- **two**', style: 'warning', pinned: true, createdAt: T0, updatedAt: T0, resolvedAt: null },
      { id: 'i2', title: 'Old outage', body: 'fixed', style: 'danger', pinned: false, createdAt: T0 - DAY, updatedAt: T0, resolvedAt: T0 },
    ],
    maintenance: [{ title: 'DB upgrade', description: 'read-only', start: T0 + DAY, end: T0 + DAY + 3600_000, status: 'scheduled' }],
    updatedAt: Date.now(),
    ...over,
  };
}

let status: Record<string, unknown> | null = publicJson();
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn(async (url: string) => {
  const p = new URL(url, 'http://localhost').pathname;
  if (p === '/api/auth/me') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  if (p === '/api/public-config') return new Response(JSON.stringify({ signupEnabled: false }), { status: 200 });
  if (p === '/api/public/status/acme' && status) return new Response(JSON.stringify(status), { status: 200 });
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  status = publicJson();
  document.documentElement.classList.remove('dark');
});

async function renderAt(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  // lazy route chunk + data fetch
  for (let i = 0; i < 100 && !container.querySelector('[data-slot="public-status"] h1'); i++) {
    await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

describe('public status page', () => {
  it('renders the page without app chrome and escapes untrusted content', async () => {
    await renderAt('/status/acme');
    const text = container.textContent ?? '';
    expect(text).toContain('Acme <img src=x onerror=alert(1)>');
    expect(text).toContain('Partial outage');
    expect(container.querySelector('nav[aria-label="Main"]')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // only the uploaded logo image, no injected <img>
    const imgs = Array.from(container.querySelectorAll('img'));
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/api/public/assets/abc.png']);
    expect(container.querySelector('b')).toBeNull();
    // javascript: links are dropped everywhere
    for (const a of Array.from(container.querySelectorAll('a'))) expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    // bidi override is neutralised
    expect(text).toContain('API�gnp.exe');
    expect(text).not.toContain('‮');
  });

  it('links a monitor only for a safe URL and shows incidents, maintenance and history', async () => {
    await renderAt('/status/acme');
    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent?.includes('API'));
    expect(link?.getAttribute('href')).toBe('https://api.acme.example/health');
    expect(link?.getAttribute('rel')).toContain('noopener');
    const evil = container.querySelector('[data-monitor="m3"]');
    expect(evil?.querySelector('a')).toBeNull();
    expect(evil?.textContent).toContain('Paused');
    expect(evil?.textContent).toContain('Certificate valid for 5 days');
    expect(container.querySelector('[data-monitor="m2"]')?.textContent).toContain('Outage');
    expect(container.textContent).toContain('Checkout errors');
    expect(container.textContent).toContain('DB upgrade');
    expect(container.textContent).toContain('Scheduled');
    expect(container.textContent).toContain('Old outage');
    expect(container.querySelectorAll('[data-style="warning"] li')).toHaveLength(2);
    expect(container.textContent).toContain('99.91% uptime');
    expect(container.querySelector('[data-slot="powered-by"]')).not.toBeNull();
  });

  it('applies theme, accent, title, noindex and the same-origin tracker', async () => {
    await renderAt('/status/acme');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    const shell = container.querySelector<HTMLElement>('[data-slot="public-status"]');
    expect(shell?.style.getPropertyValue('--sp-accent')).toBe('#7c3aed');
    expect(document.title).toBe('Acme <img src=x onerror=alert(1)>');
    expect(document.head.querySelector('meta[name="robots"][content="noindex"]')).not.toBeNull();
    const s = document.head.querySelector<HTMLScriptElement>('script[data-site="site123"]');
    expect(s?.getAttribute('src')).toBe('/script.js');
    act(() => root.unmount());
    root = createRoot(container);
    expect(document.head.querySelector('script[data-site="site123"]')).toBeNull();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  it('refuses third-party tracker scripts and hides "powered by" when disabled', async () => {
    status = publicJson({ analytics: { siteId: 'x', scriptUrl: 'https://evil.example/script.js' }, showPoweredBy: false, noindex: false, theme: 'light' });
    await renderAt('/status/acme');
    expect(document.head.querySelector('script[data-site]')).toBeNull();
    expect(container.querySelector('[data-slot="powered-by"]')).toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('shows a not-found state', async () => {
    await renderAt('/status/missing');
    expect(container.textContent).toContain('Status page not found');
    expect(document.head.querySelector('meta[name="robots"][content="noindex"]')).not.toBeNull();
  });
});
