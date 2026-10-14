// Typed client for the PTR Analytics dashboard API (docs/SPEC.md 4.7 and 6).
// - cookies are sent same-origin only
// - mutating requests carry `X-PA-Request: 1` (CSRF) and a JSON body
// - 401 responses trigger the unauthorized handler (redirect to /login?next=…)
import { loginUrl } from '../lib/safety';
import { statsParams, vitalsParams } from '../lib/query';
import type {
  AppConfig,
  Billing,
  BreakdownDimension,
  BreakdownResponse,
  EventPropsResponse,
  LiveOverviewResponse,
  OverviewResponse,
  PeriodSelection,
  PublicConfig,
  RealtimeResponse,
  Role,
  Site,
  SiteLiveResponse,
  StatsQuery,
  SummaryResponse,
  TimeseriesResponse,
  User,
  VitalDimension,
  VitalsBreakdownResponse,
  VitalsQuery,
  VitalsSummaryResponse,
  VitalsTimeseriesResponse,
  VitalTimeseriesMetric,
  VitalMetric,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  /** machine readable error code from the body (e.g. "upgrade_required"), if any */
  readonly code: string | undefined;
  /** offending input field from a validation error body (`{error, field}`), if any */
  readonly field: string | undefined;
  constructor(status: number, message: string, code?: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** 402 from POST /api/sites: the member reached the site allowance. */
export function isUpgradeRequired(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 402;
}

type UnauthorizedHandler = () => void;

const defaultUnauthorizedHandler: UnauthorizedHandler = () => {
  const { pathname, search } = window.location;
  if (pathname === '/login') return;
  window.location.assign(loginUrl(pathname + search));
};

let onUnauthorized: UnauthorizedHandler = defaultUnauthorizedHandler;

/** Lets the app replace the hard redirect with a router navigation. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler ?? defaultUnauthorizedHandler;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface RequestOptions {
  query?: URLSearchParams;
  body?: unknown;
  signal?: AbortSignal;
  /** Set to false where a 401 is an expected answer (login, session probe). */
  redirectOn401?: boolean;
}

const API_BASE = '/api';

function friendlyStatus(status: number): string {
  if (status === 401) return 'You are not logged in.';
  if (status === 403) return 'You do not have permission to do this.';
  if (status === 402) return 'Your plan does not include more sites.';
  if (status === 404) return 'Not found.';
  if (status === 429) return 'Too many requests. Please try again later.';
  if (status >= 500) return 'Server error. Please try again.';
  return `Request failed (${status}).`;
}

export async function request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const qs = opts.query?.toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, credentials: 'same-origin', headers, signal: opts.signal, cache: 'no-store' };
  if (method !== 'GET') {
    headers['X-PA-Request'] = '1';
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body ?? {});
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Network error. Check your connection.');
  }

  if (res.status === 401 && opts.redirectOn401 !== false) onUnauthorized();

  if (!res.ok) {
    let message = friendlyStatus(res.status);
    let code: string | undefined;
    let field: string | undefined;
    try {
      const data: unknown = await res.json();
      if (data && typeof data === 'object') {
        const e = (data as { error?: unknown }).error;
        // keep server messages short and plain text
        if (typeof e === 'string' && e.length > 0 && e.length <= 200) message = e;
        const c = (data as { code?: unknown }).code;
        if (typeof c === 'string' && /^[a-z_]{1,64}$/.test(c)) code = c;
        const f = (data as { field?: unknown }).field;
        if (typeof f === 'string' && /^[A-Za-z0-9_.[\]-]{1,100}$/.test(f)) field = f;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, code, field);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'Invalid response from server.');
  }
}

const sitePath = (id: string) => `/sites/${encodeURIComponent(id)}`;

export const api = {
  /* ---------- auth ---------- */
  login: (email: string, password: string) =>
    request<{ user: User }>('POST', '/auth/login', { body: { email, password }, redirectOn401: false }).then((r) => r.user),
  logout: () => request<void>('POST', '/auth/logout', { redirectOn401: false }),
  me: (signal?: AbortSignal) =>
    request<{ user: User }>('GET', '/auth/me', { signal, redirectOn401: false }).then((r) => r.user),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('POST', '/auth/password', { body: { currentPassword, newPassword } }),

  /* ---------- hosted mode: sign-up, verification, password reset ---------- */
  signup: (email: string, password: string) =>
    request<{ ok: true }>('POST', '/auth/signup', {
      body: { email, password, acceptTerms: true },
      redirectOn401: false,
    }),
  /** Confirms the address; the password proves the person opening the link owns the account. */
  verifyEmail: (token: string, password: string) =>
    request<{ user: User }>('POST', '/auth/verify', { body: { token, password }, redirectOn401: false }).then((r) => r.user),
  forgotPassword: (email: string) =>
    request<{ ok: true }>('POST', '/auth/forgot', { body: { email }, redirectOn401: false }),
  resetPassword: (token: string, password: string) =>
    request<void>('POST', '/auth/reset', { body: { token, password }, redirectOn401: false }),
  /** Members only: deletes the account, its sites and all data. */
  deleteAccount: (password: string) => request<void>('DELETE', '/account', { body: { password } }),

  /* ---------- config ---------- */
  config: (signal?: AbortSignal) => request<AppConfig>('GET', '/config', { signal }),
  /** No auth required. */
  publicConfig: (signal?: AbortSignal) =>
    request<PublicConfig>('GET', '/public-config', { signal, redirectOn401: false }),

  /* ---------- billing (members, hosted mode) ---------- */
  billing: (signal?: AbortSignal) => request<Billing>('GET', '/billing', { signal }),
  /** Returns the Stripe Checkout URL — validate with `safeStripeUrl` before navigating. */
  billingCheckout: (paidSites: number) =>
    request<{ url: string }>('POST', '/billing/checkout', { body: { paidSites } }).then((r) => r.url),
  billingQuantity: (paidSites: number) =>
    request<{ billing: Billing }>('POST', '/billing/quantity', { body: { paidSites } }).then((r) => r.billing),
  /** Returns the Stripe customer portal URL — validate with `safeStripeUrl` before navigating. */
  billingPortal: () => request<{ url: string }>('POST', '/billing/portal').then((r) => r.url),

  /* ---------- users (admin) ---------- */
  listUsers: (signal?: AbortSignal) => request<{ users: User[] }>('GET', '/users', { signal }).then((r) => r.users),
  createUser: (body: { email: string; password: string; role: Role }) =>
    request<{ user: User }>('POST', '/users', { body }).then((r) => r.user),
  updateUser: (id: number, body: { role?: Role; password?: string }) =>
    request<{ user: User }>('PATCH', `/users/${encodeURIComponent(String(id))}`, { body }).then((r) => r.user),
  deleteUser: (id: number) => request<void>('DELETE', `/users/${encodeURIComponent(String(id))}`),

  /* ---------- sites ---------- */
  listSites: (signal?: AbortSignal) => request<{ sites: Site[] }>('GET', '/sites', { signal }).then((r) => r.sites),
  getSite: (id: string, signal?: AbortSignal) =>
    request<{ site: Site }>('GET', sitePath(id), { signal }).then((r) => r.site),
  createSite: (body: { name: string; domains: string[] }) =>
    request<{ site: Site }>('POST', '/sites', { body }).then((r) => r.site),
  updateSite: (id: string, body: { name?: string; domains?: string[] }) =>
    request<{ site: Site }>('PATCH', sitePath(id), { body }).then((r) => r.site),
  deleteSite: (id: string) => request<void>('DELETE', sitePath(id)),

  /* ---------- stats ---------- */
  overview: (q: PeriodSelection & { tz: string }, signal?: AbortSignal) =>
    request<OverviewResponse>('GET', '/overview', { query: statsParams(q), signal }),
  summary: (id: string, q: StatsQuery, signal?: AbortSignal) =>
    request<SummaryResponse>('GET', `${sitePath(id)}/stats/summary`, { query: statsParams(q), signal }),
  timeseries: (id: string, q: StatsQuery, signal?: AbortSignal) =>
    request<TimeseriesResponse>('GET', `${sitePath(id)}/stats/timeseries`, { query: statsParams(q), signal }),
  breakdown: (id: string, q: StatsQuery, dimension: BreakdownDimension, limit: number, signal?: AbortSignal) =>
    request<BreakdownResponse>('GET', `${sitePath(id)}/stats/breakdown`, {
      query: statsParams(q, { dimension, limit }),
      signal,
    }),
  eventProps: (id: string, q: StatsQuery, event: string, limit: number, signal?: AbortSignal) =>
    request<EventPropsResponse>('GET', `${sitePath(id)}/stats/event-props`, {
      // `event` here names the event whose properties are listed; it replaces any event filter.
      query: statsParams({ ...q, filters: { ...q.filters, event } }, { limit }),
      signal,
    }),
  realtime: (id: string, tz: string, signal?: AbortSignal) =>
    request<RealtimeResponse>('GET', `${sitePath(id)}/stats/realtime`, {
      query: new URLSearchParams({ tz }),
      signal,
    }),

  /* ---------- live map ---------- */
  siteLive: (id: string, signal?: AbortSignal) =>
    request<SiteLiveResponse>('GET', `${sitePath(id)}/stats/live`, { signal }),
  live: (signal?: AbortSignal) => request<LiveOverviewResponse>('GET', '/live', { signal }),

  /* ---------- speed insights ---------- */
  vitalsSummary: (id: string, q: VitalsQuery, signal?: AbortSignal) =>
    request<VitalsSummaryResponse>('GET', `${sitePath(id)}/vitals/summary`, { query: vitalsParams(q), signal }),
  vitalsTimeseries: (id: string, q: VitalsQuery, metric: VitalTimeseriesMetric, signal?: AbortSignal) =>
    request<VitalsTimeseriesResponse>('GET', `${sitePath(id)}/vitals/timeseries`, {
      query: vitalsParams(q, { metric }),
      signal,
    }),
  vitalsBreakdown: (
    id: string,
    q: VitalsQuery,
    metric: VitalMetric,
    dimension: VitalDimension,
    limit: number,
    signal?: AbortSignal,
  ) =>
    request<VitalsBreakdownResponse>('GET', `${sitePath(id)}/vitals/breakdown`, {
      query: vitalsParams(q, { metric, dimension, limit }),
      signal,
    }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.name === 'AbortError') return '';
  return 'Something went wrong.';
}
