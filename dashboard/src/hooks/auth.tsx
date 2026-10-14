import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api, setUnauthorizedHandler } from '../api/client';
import type { AppConfig, PublicConfig, Role, User } from '../api/types';
import { loginUrl } from '../lib/safety';

/** Hosted mode is off unless /api/public-config says otherwise (self-hosted default). */
export const DEFAULT_PUBLIC_CONFIG: PublicConfig = {
  signupEnabled: false,
  billingEnabled: false,
  freeSites: 1,
  pricePerSiteCents: 100,
  currency: 'eur',
  termsUrl: null,
  privacyUrl: null,
  statusPageOrigin: null,
};

/** Routes that work without a session (never redirected to /login on 401). */
export const PUBLIC_PATHS = ['/login', '/signup', '/verify', '/forgot', '/reset'] as const;

export function isPublicPath(pathname: string): boolean {
  return (PUBLIC_PATHS as readonly string[]).includes(pathname);
}

/** Public status pages: rendered without the app and never need the session. */
export function isStatusPagePath(pathname: string): boolean {
  return pathname.startsWith('/status/');
}

/**
 * "This browser had a session" (not a secret: the session cookie itself is httpOnly). Pages
 * that work without a login only probe GET /api/auth/me when it is set, so anonymous
 * visitors of the login page never get a 401 (and its console error).
 */
const SESSION_HINT_KEY = 'pa:had-session';

function readSessionHint(): boolean {
  try {
    return window.localStorage.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSessionHint(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(SESSION_HINT_KEY, '1');
    else window.localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    /* storage unavailable: login pages simply skip the redirect for logged-in users */
  }
}

/**
 * Whether the session must be probed on `pathname`: always on app pages; on login / sign-up
 * / verification pages only when the browser had a session (to redirect logged-in users);
 * never on public status pages.
 */
export function shouldProbeSession(pathname: string, hadSession: boolean): boolean {
  if (isStatusPagePath(pathname)) return false;
  if (isPublicPath(pathname)) return hadSession;
  return true;
}

interface AuthState {
  /** undefined = still checking the session */
  user: User | null | undefined;
  config: AppConfig | null;
  /** hosted-mode switches (defaults until loaded) */
  publicConfig: PublicConfig;
  /** network/server error while checking the session */
  error: string | null;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
  retry: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** Normalises the untrusted public config (wrong types fall back to the defaults). */
export function normalizePublicConfig(raw: unknown): PublicConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_PUBLIC_CONFIG;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  const url = (v: unknown) => (typeof v === 'string' && /^https?:\/\//i.test(v) && v.length <= 2048 ? v : null);
  return {
    signupEnabled: r.signupEnabled === true,
    billingEnabled: r.billingEnabled === true,
    freeSites: Math.floor(num(r.freeSites, DEFAULT_PUBLIC_CONFIG.freeSites)),
    pricePerSiteCents: num(r.pricePerSiteCents, DEFAULT_PUBLIC_CONFIG.pricePerSiteCents),
    currency: typeof r.currency === 'string' && /^[a-z]{3}$/i.test(r.currency) ? r.currency.toLowerCase() : 'eur',
    termsUrl: url(r.termsUrl),
    privacyUrl: url(r.privacyUrl),
    statusPageOrigin: (() => {
      const v = url(r.statusPageOrigin);
      if (!v) return null;
      try {
        return new URL(v).origin;
      } catch {
        return null;
      }
    })(),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [publicConfig, setPublicConfig] = useState<PublicConfig>(DEFAULT_PUBLIC_CONFIG);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const statusPage = isStatusPagePath(location.pathname);

  // Probe the session once, when the first page that needs it is shown (not on anonymous
  // pages: their visitors have no session, and a 401 is logged as an error by browsers).
  const probe = user === undefined && shouldProbeSession(location.pathname, readSessionHint());
  useEffect(() => {
    if (!probe) return;
    const ctrl = new AbortController();
    setError(null);
    api.me(ctrl.signal).then(
      (u) => setUser(u),
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) setUser(null);
        else setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
      },
    );
    return () => ctrl.abort();
  }, [probe, nonce]);

  useEffect(() => {
    if (user) writeSessionHint(true);
    else if (user === null) writeSessionHint(false);
  }, [user]);

  // Hosted-mode switches (no auth). Older servers answer 404: keep the defaults.
  // Status pages don't use them.
  useEffect(() => {
    if (statusPage) return;
    const ctrl = new AbortController();
    api.publicConfig(ctrl.signal).then(
      (c) => setPublicConfig(normalizePublicConfig(c)),
      () => {
        /* optional */
      },
    );
    return () => ctrl.abort();
  }, [statusPage]);

  // Load the instance config once logged in (it requires a session).
  useEffect(() => {
    if (!user) return;
    const ctrl = new AbortController();
    api.config(ctrl.signal).then(setConfig, () => {
      /* optional */
    });
    return () => ctrl.abort();
  }, [user]);

  // Any 401 from the API: drop the user and go to the login page via the router.
  const path = location.pathname + location.search;
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      if (!isPublicPath(location.pathname)) navigate(loginUrl(path), { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate, path, location.pathname]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setConfig(null);
      navigate('/login', { replace: true });
    }
  }, [navigate]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  const value = useMemo<AuthState>(
    () => ({ user, config, publicConfig, error, setUser, logout, retry }),
    [user, config, publicConfig, error, logout, retry],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  viewer: 'Viewer',
  member: 'Member',
};

export function roleLabel(role: unknown): string {
  return role === 'admin' || role === 'viewer' || role === 'member' ? ROLE_LABELS[role] : 'User';
}

/** Admins manage users and every site. */
export function useIsAdmin(): boolean {
  return useAuth().user?.role === 'admin';
}

/** Admins and members (their own sites) can add, edit and delete sites; viewers are read-only. */
export function useCanManageSites(): boolean {
  const role = useAuth().user?.role;
  return role === 'admin' || role === 'member';
}

/** Members see billing when the instance charges per site. */
export function useShowBilling(): boolean {
  const { user, publicConfig } = useAuth();
  return user?.role === 'member' && publicConfig.billingEnabled;
}
