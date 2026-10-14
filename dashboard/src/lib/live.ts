// Pure helpers for the live views (globe pings, client-side visitor series, feed).
import type { LiveCountry, LiveRecentPageview } from '../api/types';

/** Poll interval of the live endpoints while the page is visible. */
export const LIVE_POLL_MS = 5_000;
/** Visible window of the client-side "visitors over time" series. */
export const LIVE_WINDOW_SECONDS = 5 * 60;
/** Pings older than this (relative to the poll) are not animated on the globe. */
export const PING_MAX_AGE_MS = 60_000;
/** At most this many pings are handed to the globe. */
export const MAX_PINGS = 60;

export interface Ping {
  id: string;
  country: string;
}

export interface LiveSample {
  /** unix seconds */
  time: number;
  value: number;
}

const ISO_RE = /^[A-Z]{2}$/;

/** Upper-case ISO 3166-1 alpha-2 code, or null for unknown / invalid values. */
export function isoCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const c = value.toUpperCase();
  if (!ISO_RE.test(c) || c === 'XX' || c === 'ZZ') return null;
  return c;
}

/** Stable id of a recent pageview: `${ts}-${country}-${path}`. */
export function pingId(r: Pick<LiveRecentPageview, 'ts' | 'country' | 'path'>): string {
  return `${r.ts}-${r.country}-${r.path}`;
}

/**
 * Diffs the `recent` list of a live response against the ids already seen.
 * Returns the new pings (newest first, only entries with a valid country that
 * are at most `maxAgeMs` old at `now`) and the ids to remember for the next
 * poll — just the ids of this response, since entries only ever drop off the
 * end of the list (bounded memory).
 */
export function diffRecent(
  seen: ReadonlySet<string>,
  recent: readonly LiveRecentPageview[],
  now: number,
  maxAgeMs = PING_MAX_AGE_MS,
): { pings: Ping[]; seen: Set<string> } {
  const next = new Set<string>();
  const pings: Ping[] = [];
  for (const r of recent) {
    if (!r || typeof r.ts !== 'number' || typeof r.path !== 'string') continue;
    const id = pingId(r);
    next.add(id);
    if (seen.has(id)) continue;
    const country = isoCountry(r.country);
    if (!country) continue;
    if (now - r.ts > maxAgeMs) continue;
    pings.push({ id, country });
  }
  return { pings, seen: next };
}

/** Prepends new pings to the list handed to the globe, de-duplicated and capped. */
export function mergePings(previous: readonly Ping[], added: readonly Ping[], max = MAX_PINGS): Ping[] {
  if (added.length === 0) return previous as Ping[];
  const ids = new Set<string>();
  const out: Ping[] = [];
  for (const p of [...added, ...previous]) {
    if (ids.has(p.id)) continue;
    ids.add(p.id);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** Globe input: valid countries only, highest first. */
export function globeCountries(countries: readonly LiveCountry[] | undefined): Array<{ country: string; value: number }> {
  const map = new Map<string, number>();
  for (const c of countries ?? []) {
    const iso = isoCountry(c?.country);
    if (!iso || !(typeof c.visitors === 'number' && c.visitors > 0)) continue;
    map.set(iso, (map.get(iso) ?? 0) + c.visitors);
  }
  return [...map.entries()].map(([country, value]) => ({ country, value })).sort((a, b) => b.value - a.value);
}

/**
 * Appends a sample (unix seconds) to the client-side series, replacing a sample
 * in the same second and dropping samples that fell out of the window.
 */
export function appendSample(series: readonly LiveSample[], sample: LiveSample, windowSeconds = LIVE_WINDOW_SECONDS): LiveSample[] {
  if (!Number.isFinite(sample.time) || !Number.isFinite(sample.value)) return series as LiveSample[];
  const cutoff = sample.time - windowSeconds;
  const kept = series.filter((s) => s.time >= cutoff && s.time < sample.time);
  kept.push(sample);
  return kept;
}

/** "just now", "42s ago", "3m ago", "2h ago" */
export function relativeTime(ts: number, now: number): string {
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
