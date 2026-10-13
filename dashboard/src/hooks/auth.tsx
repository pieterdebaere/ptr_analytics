import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api, setUnauthorizedHandler } from '../api/client';
import type { AppConfig, User } from '../api/types';
import { loginUrl } from '../lib/safety';

interface AuthState {
  /** undefined = still checking the session */
  user: User | null | undefined;
  config: AppConfig | null;
  /** network/server error while checking the session */
  error: string | null;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
  retry: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();

  // Probe the session once on start.
  useEffect(() => {
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
  }, [nonce]);

  // Load the public config once logged in (it requires a session).
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
      if (location.pathname !== '/login') navigate(loginUrl(path), { replace: true });
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
    () => ({ user, config, error, setUser, logout, retry }),
    [user, config, error, logout, retry],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function useIsAdmin(): boolean {
  return useAuth().user?.role === 'admin';
}
