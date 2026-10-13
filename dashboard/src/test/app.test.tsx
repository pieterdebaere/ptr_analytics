import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SITE = { id: 'abc123def456', name: 'My <Site>', domains: ['example.com'], createdAt: 1_700_000_000_000 };
const T0 = Date.UTC(2026, 9, 1);

function routes(url: string): unknown {
  const u = new URL(url, 'http://localhost');
  const p = u.pathname;
  if (p === '/api/auth/me') return { user: { id: 1, email: 'admin@example.com', role: 'admin', createdAt: 1 } };
  if (p === '/api/config') return { publicUrl: 'https://analytics.example.com', version: '0.1.0', geoip: true };
  if (p === '/api/sites') return { sites: [SITE] };
  if (p === '/api/overview')
    return { sites: [{ ...SITE, visitors: 120, pageviews: 300, previousVisitors: 100, series: [1, 5, 3, 8, 2, 9, 4] }] };
  if (p.endsWith('/stats/summary'))
    return { visitors: 120, pageviews: 300, bounceRate: 0.42, events: 4, previous: { visitors: 100, pageviews: 310, bounceRate: 0.5, events: 2 } };
  if (p.endsWith('/stats/timeseries'))
    return { interval: 'day', points: Array.from({ length: 7 }, (_, i) => ({ t: T0 + i * 86_400_000, visitors: i * 3, pageviews: i * 5 })) };
  if (p.endsWith('/stats/breakdown')) {
    const d = u.searchParams.get('dimension');
    return { dimension: d, rows: [{ value: d === 'country' ? 'BE' : '/blog', visitors: 10, count: 20 }, { value: null, visitors: 1, count: 1 }] };
  }
  if (p.endsWith('/stats/realtime')) return { visitors: 3 };
  if (p.endsWith('/vitals/summary'))
    return {
      score: 87,
      metrics: {
        LCP: { p75: 2100, count: 50, score: 92, rating: 'good' },
        FCP: { p75: 1200, count: 50, score: 95, rating: 'good' },
        INP: { p75: 260, count: 30, score: 70, rating: 'needs-improvement' },
        CLS: { p75: 0.31, count: 50, score: 20, rating: 'poor' },
        TTFB: { p75: 400, count: 50, score: null, rating: 'good' },
      },
    };
  if (p.endsWith('/vitals/timeseries'))
    return { interval: 'day', points: Array.from({ length: 7 }, (_, i) => ({ t: T0 + i * 86_400_000, value: i === 3 ? null : 2000 + i * 100, count: 5 })) };
  if (p.endsWith('/vitals/breakdown')) return { rows: [{ value: '/', p75: 2100, count: 40, rating: 'good' }] };
  if (p === '/api/users') return { users: [{ id: 1, email: 'admin@example.com', role: 'admin', createdAt: 1 }] };
  return { error: 'not found' };
}

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(routes(url)), { status: 200 }));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'matchMedia',
    (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  fetchMock.mockClear();
});

async function renderAt(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  // let the chained requests (me -> sites -> stats) settle
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

describe('App smoke tests', () => {
  it('renders the overview', async () => {
    await renderAt('/');
    expect(container.textContent).toContain('All sites');
    expect(container.textContent).toContain('My <Site>');
    expect(container.textContent).toContain('+20%');
    expect(container.textContent).toContain('IP geolocation by DB-IP');
  });

  it('renders site analytics with filters from the URL', async () => {
    await renderAt('/sites/abc123def456?period=30d&referrer=');
    expect(container.textContent).toContain('Bounce Rate');
    expect(container.textContent).toContain('42%');
    expect(container.textContent).toContain('3 online');
    expect(container.textContent).toContain('Direct / None');
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    const summary = urls.find((u) => u.includes('/stats/summary'))!;
    expect(summary).toContain('period=30d');
    expect(summary).toContain('referrer=');
    expect(summary).toMatch(/tz=/);
    const exportLink = container.querySelector<HTMLAnchorElement>('a[download]');
    expect(exportLink!.getAttribute('href')).toMatch(/^\/api\/sites\/abc123def456\/export\?period=30d&tz=.+&referrer=$/);
  });

  it('renders speed insights', async () => {
    await renderAt('/sites/abc123def456/speed');
    expect(container.textContent).toContain('Real Experience Score');
    expect(container.textContent).toContain('2.10 s');
    expect(container.textContent).toContain('0.310');
  });

  it('renders site settings with the install snippet', async () => {
    await renderAt('/sites/abc123def456/settings');
    expect(container.textContent).toContain(
      '<script defer src="https://analytics.example.com/script.js" data-site="abc123def456"></script>',
    );
    expect(container.textContent).toContain('Danger zone');
  });

  it('renders account & users', async () => {
    await renderAt('/settings');
    expect(container.textContent).toContain('Change password');
    expect(container.textContent).toContain('Add user');
  });
});
