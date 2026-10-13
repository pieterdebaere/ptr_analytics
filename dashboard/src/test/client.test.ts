import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setUnauthorizedHandler } from '../api/client';

function mockFetch(status: number, body?: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe('api client', () => {
  it('sends GET requests same-origin without CSRF header', async () => {
    const fetch = mockFetch(200, { sites: [] });
    await api.listSites();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/sites');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)['X-PA-Request']).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it('sends mutating requests with X-PA-Request and a JSON body', async () => {
    const fetch = mockFetch(201, { site: { id: 'abc123def456', name: 'x', domains: ['x.com'], createdAt: 1 } });
    const site = await api.createSite({ name: 'x', domains: ['x.com'] });
    expect(site.id).toBe('abc123def456');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/sites');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-PA-Request']).toBe('1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'x', domains: ['x.com'] });
  });

  it('handles 204 responses', async () => {
    const fetch = mockFetch(204);
    await expect(api.deleteSite('abc123def456')).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]![0]).toBe('/api/sites/abc123def456');
    expect(fetch.mock.calls[0]![1]?.method).toBe('DELETE');
  });

  it('builds stats URLs with params', async () => {
    const fetch = mockFetch(200, { dimension: 'path', rows: [] });
    await api.breakdown('abc123def456', { period: '30d', tz: 'UTC', filters: { referrer: '' } }, 'path', 10);
    expect(fetch.mock.calls[0]![0]).toBe(
      '/api/sites/abc123def456/stats/breakdown?period=30d&tz=UTC&referrer=&dimension=path&limit=10',
    );
  });

  it('event-props uses the event name as `event` param', async () => {
    const fetch = mockFetch(200, { rows: [] });
    await api.eventProps('abc123def456', { period: '7d', tz: 'UTC', filters: { event: 'Other' } }, 'Signup', 100);
    expect(fetch.mock.calls[0]![0]).toBe('/api/sites/abc123def456/stats/event-props?period=7d&tz=UTC&event=Signup&limit=100');
  });

  it('calls the unauthorized handler on 401 and throws ApiError', async () => {
    mockFetch(401, { error: 'unauthorized' });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const err = await api.listSites().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not redirect on a failed login', async () => {
    mockFetch(401, { error: 'invalid credentials' });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(api.login('a@b.c', 'x')).rejects.toBeInstanceOf(ApiError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('surfaces server error messages', async () => {
    mockFetch(409, { error: 'user already exists' });
    await expect(api.createUser({ email: 'a@b.c', password: 'x'.repeat(12), role: 'viewer' })).rejects.toThrow(
      'user already exists',
    );
  });
});
