/** Dark-first theme handling. The choice is remembered in localStorage (a
 *  first-party preference on the marketing site — the tracker never writes storage). */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ptr-landing-theme';
const listeners = new Set<() => void>();

function readStored(): Theme | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function getTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#ffffff');
}

/** Apply the stored theme (default: dark) before the first React render. */
export function initTheme(): void {
  apply(readStored() ?? 'dark');
}

export function setTheme(theme: Theme): void {
  apply(theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — keep the in-memory choice */
  }
  listeners.forEach((l) => l());
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
