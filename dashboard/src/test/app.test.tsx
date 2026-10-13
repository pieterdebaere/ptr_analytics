import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SITE = { id: 'abc123def456', name: 'My <Site>', domains: ['example.com'], createdAt: 1_700_000_000_000 };
const T0 = Date.UTC(2026, 9, 1);
const HOSTED = {
  signupEnabled: true,
  billingEnabled: true,
  freeSites: 1,
  pricePerSiteCents: 100,
  currency: 'eur',
  termsUrl: 'https://example.com/terms',
  privacyUrl: 'javascript:alert(1)',
};
const ADMIN = { id: 1, email: 'admin@example.com', role: 'admin', createdAt: 1, emailVerified: true };
const MEMBER = { id: 5, email: 'member@example.com', role: 'member', createdAt: 1, emailVerified: true };
let me: Record<string, unknown> | null = ADMIN;
let sites: Array<Record<string, unknown>> = [SITE];
let publicConfig: Record<string, unknown> = { signupEnabled: false, billingEnabled: false, freeSites: 1, pricePerSiteCents: 100, currency: 'eur', termsUrl: null, privacyUrl: null };
let billing: Record<string, unknown> = {
  enabled: true,
  freeSites: 1,
  pricePerSiteCents: 100,
  currency: 'eur',
  sitesUsed: 3,
  sitesAllowed: 3,
  paidSites: 2,
  status: 'active',
  hasCustomer: true,
};

function routes(url: string): unknown {
  const u = new URL(url, 'http://localhost');
  const p = u.pathname;
  if (p === '/api/auth/me') return { user: me };
  if (p === '/api/config') return { publicUrl: 'https://analytics.example.com', version: '0.1.0', geoip: true };
  if (p === '/api/sites') return { sites };
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
  if (p === '/api/users') return { users: [{ id: 1, email: 'admin@example.com', role: 'admin', createdAt: 1, emailVerified: true }] };
  if (p === '/api/public-config') return publicConfig;
  if (p.endsWith('/stats/live'))
    return {
      visitors: 4,
      countries: [{ country: 'BE', visitors: 3 }, { country: null, visitors: 1 }],
      recent: [{ ts: Date.now() - 2000, country: 'BE', path: '/x\u202Ey' }, { ts: Date.now() - 90_000, country: null, path: '/about' }],
    };
  if (p === '/api/live') return { visitors: 7, countries: [{ country: 'US', visitors: 7 }], sites: [{ id: SITE.id, name: SITE.name, visitors: 7 }] };
  if (p === '/api/billing') return billing;
  return { error: 'not found' };
}

let container: HTMLDivElement;
let root: Root;
const defaultFetch = async (url: string) => {
  if (me === null && new URL(url, 'http://localhost').pathname === '/api/auth/me') {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  return new Response(JSON.stringify(routes(url)), { status: 200 });
};
const fetchMock = vi.fn(defaultFetch);

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
  fetchMock.mockImplementation(defaultFetch);
  me = ADMIN;
  sites = [SITE];
  publicConfig = { signupEnabled: false, billingEnabled: false, freeSites: 1, pricePerSiteCents: 100, currency: 'eur', termsUrl: null, privacyUrl: null };
  billing = { ...billing, status: 'active', paidSites: 2, hasCustomer: true };
});

async function renderAt(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  // let the chained requests (me -> sites -> stats) and lazy route chunks settle
  for (let i = 0; i < 8; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
  for (let i = 0; i < 40 && container.querySelector('[role="status"][aria-label="Loading"]'); i++) {
    await act(async () => new Promise((r) => setTimeout(r, 25)));
  }
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

  it('does not blank the login page for a next= that normalises to //host', async () => {
    for (const next of ['/.//evil.example', '/%2e//evil.example', '/a/..//evil.example', '/sites/../..//evil.example']) {
      await renderAt(`/login?next=${encodeURIComponent(next)}`);
      expect(container.textContent, next).toContain('All sites');
      expect(container.textContent, next).not.toContain('Something went wrong');
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it('keeps the shell when a page crashes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // malformed API response that makes the overview page throw while rendering
    fetchMock.mockImplementation(async (url: string) => {
      const body = new URL(url, 'http://localhost').pathname === '/api/overview' ? { sites: 'xy' } : routes(url);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    await renderAt('/');
    expect(container.textContent).toContain('Something went wrong');
    expect(container.querySelector('header[data-slot="navbar"]')).not.toBeNull();
    expect(container.textContent).toContain('All sites');
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
  });

  it('isolates site names', async () => {
    await renderAt('/');
    const name = container.querySelector('[data-slot="site-card-name"]');
    expect(name?.classList.contains('bidi-isolate')).toBe(true);
  });

  it('renders account & users', async () => {
    await renderAt('/settings');
    expect(container.textContent).toContain('Change password');
    expect(container.textContent).toContain('Add user');
  });
});

async function settle(n = 5) {
  for (let i = 0; i < n; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Live views', () => {
  it('renders the live tab with counter and an isolated recent pageviews feed', async () => {
    await renderAt('/sites/abc123def456/live');
    expect(container.textContent).toContain('Recent pageviews');
    expect(container.textContent).toContain('visitors online');
    expect(container.textContent).toContain('just now');
    expect(container.textContent).not.toContain('\u202E');
    const feed = container.querySelector('ol[aria-label="Recent pageviews"]')!;
    const paths = Array.from(feed.querySelectorAll('bdi')).map((b) => b.textContent);
    expect(paths).toEqual(['/x\uFFFDy', '/about']);
    expect(feed.querySelectorAll('bdi.bidi-isolate')).toHaveLength(2);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('/api/sites/abc123def456/stats/live');
  });

  it('shows the aggregated live card on the overview', async () => {
    await renderAt('/');
    expect(container.textContent).toContain('visitors online');
    expect(container.textContent).toContain('Active sites');
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('/api/live');
  });
});

describe('Hosted mode', () => {
  it('shows the sign-up form with pricing note and only safe terms links', async () => {
    publicConfig = HOSTED;
    me = null;
    await renderAt('/signup');
    expect(container.textContent).toContain('Create your account');
    expect(container.textContent).toContain('First site free, then €1/month per site');
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://example.com/terms');
    expect(hrefs.some((h) => h?.startsWith('javascript:'))).toBe(false);
  });

  it('says sign-up is unavailable when disabled', async () => {
    me = null;
    await renderAt('/signup');
    expect(container.textContent).toContain('Sign-up is not available');
  });

  it('shows "check your email" after sign-up (202)', async () => {
    publicConfig = HOSTED;
    me = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/signup') {
        expect(JSON.parse(String(init?.body))).toEqual({ email: 'new@example.com', password: 'p'.repeat(12), acceptTerms: true });
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      return defaultFetch(url);
    });
    await renderAt('/signup');
    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    setInput(inputs[0]!, 'new@example.com');
    setInput(inputs[1]!, 'p'.repeat(12));
    setInput(inputs[2]!, 'p'.repeat(12));
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => {
      container.querySelector<HTMLFormElement>('form')!.requestSubmit();
    });
    await settle();
    expect(container.textContent).toContain('Check your email');
    expect(container.textContent).toContain('new@example.com');
  });

  it('links to sign-up / forgot and hints at email confirmation after a failed login', async () => {
    publicConfig = HOSTED;
    me = null;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/login') return new Response(JSON.stringify({ error: 'invalid email or password' }), { status: 401 });
      return defaultFetch(url);
    });
    await renderAt('/login');
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/signup');
    expect(hrefs).toContain('/forgot');
    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    setInput(inputs[0]!, 'new@example.com');
    setInput(inputs[1]!, 'p'.repeat(12));
    await act(async () => {
      container.querySelector<HTMLFormElement>('form')!.requestSubmit();
    });
    await settle();
    expect(container.textContent).toContain('Invalid email or password.');
    expect(container.querySelector('[data-slot="verify-hint"]')?.textContent).toContain('Confirm your email first');
  });

  it('verifies only after the password is entered, with the token from the fragment', async () => {
    publicConfig = HOSTED;
    me = null;
    const calls: Array<{ url: string; body: unknown }> = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/verify') {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ user: MEMBER }), { status: 200 });
      }
      return defaultFetch(url);
    });
    await renderAt('/verify#token=tok_123');
    expect(container.textContent).toContain('Confirm your email');
    expect(calls).toHaveLength(0);
    setInput(container.querySelector<HTMLInputElement>('input')!, 'p'.repeat(12));
    await act(async () => {
      container.querySelector<HTMLFormElement>('form')!.requestSubmit();
    });
    await settle();
    expect(calls).toEqual([{ url: '/api/auth/verify', body: { token: 'tok_123', password: 'p'.repeat(12) } }]);
    expect(container.textContent).toContain('All sites');
  });

  it('rejects sign-up emails with display-name syntax', async () => {
    publicConfig = HOSTED;
    me = null;
    await renderAt('/signup');
    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    setInput(inputs[0]!, 'a<b@c.de>');
    setInput(inputs[1]!, 'p'.repeat(12));
    setInput(inputs[2]!, 'p'.repeat(12));
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => {
      container.querySelector<HTMLFormElement>('form')!.requestSubmit();
    });
    await settle();
    expect(container.textContent).toContain('plain email address');
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/auth/signup')).toBe(false);
  });

  it('shows the billing overview for members', async () => {
    publicConfig = HOSTED;
    me = MEMBER;
    await renderAt('/billing');
    expect(container.querySelector('[data-slot="monthly-cost"]')?.textContent).toContain('€2');
    expect(container.querySelector('[data-slot="billing-status"]')?.textContent).toBe('Active');
    expect(container.textContent).toContain('Change paid sites');
    expect(container.textContent).toContain('Manage billing');
    // the navbar offers billing to members, never user management
    expect(container.textContent).not.toContain('Account & users');
  });

  it('refuses to redirect to a checkout URL that is not Stripe', async () => {
    publicConfig = HOSTED;
    me = MEMBER;
    billing = { ...billing, status: 'none', paidSites: 0, hasCustomer: false, sitesAllowed: 1, sitesUsed: 1 };
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/billing/checkout') return new Response(JSON.stringify({ url: 'https://checkout.stripe.com.evil.example/pay' }), { status: 200 });
      return defaultFetch(url);
    });
    await renderAt('/billing');
    expect(container.textContent).toContain('Add paid sites');
    await act(async () => {
      container.querySelector<HTMLFormElement>('form')!.requestSubmit();
    });
    await settle();
    expect(container.textContent).toContain('unexpected checkout address');
  });

  it('opens the upgrade dialog when adding a site returns 402', async () => {
    publicConfig = HOSTED;
    me = MEMBER;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sites' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'upgrade required', code: 'upgrade_required' }), { status: 402 });
      }
      return defaultFetch(url);
    });
    await renderAt('/');
    const add = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Add site'))!;
    await act(async () => add.click());
    await settle();
    const dialog = document.querySelector('[data-slot="dialog-content"]')!;
    const inputs = dialog.querySelectorAll<HTMLInputElement>('input');
    setInput(inputs[0]!, 'New');
    setInput(inputs[1]!, 'new.example.com');
    act(() => {
      inputs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      dialog.querySelector<HTMLFormElement>('form')!.requestSubmit();
    });
    await settle();
    expect(document.body.textContent).toContain('Upgrade to add more sites');
    expect(document.body.textContent).toContain('€1');
    const billingLink = Array.from(document.querySelectorAll('a')).find((a) => a.textContent?.includes('Go to billing'));
    expect(billingLink?.getAttribute('href')).toBe('/billing');
  });

  it('shows a banner on suspended sites and a badge in the overview', async () => {
    sites = [{ ...SITE, suspended: true }];
    await renderAt('/sites/abc123def456');
    expect(container.querySelector('[data-slot="suspended-banner"]')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await renderAt('/');
    expect(container.textContent).toContain('Suspended');
  });

  it('lets members delete their account but hides user management', async () => {
    me = MEMBER;
    await renderAt('/settings');
    expect(container.textContent).toContain('Delete account');
    expect(container.textContent).not.toContain('Add user');
    expect(container.textContent).toContain('Member');
  });

  it('defaults new users to members in hosted mode (no viewers there)', async () => {
    publicConfig = HOSTED;
    await renderAt('/settings');
    const roleTrigger = container.querySelector('[aria-label="Role of the new user"]');
    expect(roleTrigger?.textContent).toContain('Member');
    expect(container.textContent).not.toContain('Viewers can see all sites');
  });

  it('hides site management from viewers', async () => {
    me = { ...ADMIN, role: 'viewer' };
    await renderAt('/');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('Add site'))).toBe(false);
    await renderAt('/sites/abc123def456/settings');
    expect(container.textContent).not.toContain('Danger zone');
  });
});

