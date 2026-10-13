import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** The only thing the dashboard keeps in localStorage. */
export const THEME_STORAGE_KEY = 'pa_theme';

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system';
}

export function readThemePreference(): ThemePreference {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

/** Sets / removes the `dark` class on <html> (Tailwind `dark:` variant + theme tokens). */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
}

/** Applies the stored preference as early as possible (called from main.tsx, no inline script). */
export function applyStoredTheme(): void {
  applyTheme(resolveTheme(readThemePreference(), systemPrefersDark()));
}

/* A tiny store so every toggle on the page stays in sync. */
const listeners = new Set<() => void>();
let preference: ThemePreference | null = null;

function getPreference(): ThemePreference {
  if (preference === null) preference = readThemePreference();
  return preference;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  let mq: MediaQueryList | null = null;
  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', cb);
  } catch {
    mq = null;
  }
  return () => {
    listeners.delete(cb);
    mq?.removeEventListener?.('change', cb);
  };
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    if (next === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* storage unavailable: still applies for this page view */
  }
  applyTheme(resolveTheme(next, systemPrefersDark()));
  for (const l of listeners) l();
}

/** Theme preference (light / dark / system) and the resolved theme. */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
} {
  const pref = useSyncExternalStore(subscribe, getPreference, () => 'system' as ThemePreference);
  const systemDark = useSyncExternalStore(subscribe, systemPrefersDark, () => false);
  const resolved = resolveTheme(pref, systemDark);

  // Follow OS changes while on "system".
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setPreference = useCallback((p: ThemePreference) => setThemePreference(p), []);
  return { preference: pref, resolved, setPreference };
}
