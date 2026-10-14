// Live uptime data: Server-Sent Events from /api/uptime/stream with a 30 s polling
// fallback; everything pauses while the tab is hidden.
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/api/client';
import {
  parseStreamBeat,
  parseStreamState,
  UPTIME_STREAM_URL,
  uptimeApi,
  type Monitor,
  type StreamBeat,
  type StreamState,
} from '@/api/uptime';
import { usePageVisible } from '@/hooks/usePageVisible';
import { timeZone } from '@/hooks/useStatsQuery';
import type { BeatLike } from './bars';

export type LiveMode = 'connecting' | 'live' | 'polling' | 'paused';

export const POLL_INTERVAL_MS = 30_000;
/** Consecutive errors before an EventSource that never opened is given up for polling. */
const MAX_SSE_ERRORS = 3;
/** Retry the stream after falling back to polling (doubles per failed attempt, capped). */
const SSE_RETRY_MS = 120_000;
const SSE_RETRY_MAX_MS = 15 * 60_000;
/** A connection must stay open this long before its error budget / backoff is reset. */
const SSE_STABLE_MS = 30_000;

/**
 * Subscribes to the uptime stream while the page is visible. Handlers may change on
 * every render. Returns the current mode; consumers poll when it is not `live`.
 */
export function useUptimeStream(handlers: { onBeat?: (b: StreamBeat) => void; onState?: (s: StreamState) => void }, enabled = true): LiveMode {
  const visible = usePageVisible();
  const [mode, setMode] = useState<LiveMode>('connecting');
  const ref = useRef(handlers);
  ref.current = handlers;
  const [retryNonce, setRetryNonce] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    if (!visible) {
      setMode('paused');
      return;
    }
    if (typeof EventSource === 'undefined') {
      setMode('polling');
      return;
    }
    let es: EventSource | null = null;
    let errors = 0;
    let opened = false;
    let retryTimer: number | undefined;
    let stableTimer: number | undefined;
    try {
      // same-origin: the session cookie is sent without `withCredentials`
      es = new EventSource(UPTIME_STREAM_URL);
    } catch {
      setMode('polling');
      return;
    }
    setMode('connecting');
    const parse = (e: MessageEvent): unknown => {
      try {
        return typeof e.data === 'string' ? JSON.parse(e.data) : null;
      } catch {
        return null;
      }
    };
    const onBeat = (e: MessageEvent) => {
      const b = parseStreamBeat(parse(e));
      if (b) ref.current.onBeat?.(b);
    };
    const onState = (e: MessageEvent) => {
      const s = parseStreamState(parse(e));
      if (s) ref.current.onState?.(s);
    };
    es.addEventListener('beat', onBeat as EventListener);
    es.addEventListener('state', onState as EventListener);
    es.onopen = () => {
      opened = true;
      setMode('live');
      // only a connection that stays up resets the error budget: a server that accepts and
      // then closes the stream (e.g. after a role change) must not cause a reconnect loop
      window.clearTimeout(stableTimer);
      stableTimer = window.setTimeout(() => {
        errors = 0;
        failures.current = 0;
      }, SSE_STABLE_MS);
    };
    es.onerror = () => {
      errors += 1;
      window.clearTimeout(stableTimer);
      if (!es) return;
      // CLOSED = the browser gave up (e.g. 401/403/404 or wrong content type)
      if (es.readyState === EventSource.CLOSED || (!opened && errors >= MAX_SSE_ERRORS) || errors >= MAX_SSE_ERRORS * 3) {
        es.close();
        es = null;
        setMode('polling');
        const delay = Math.min(SSE_RETRY_MAX_MS, SSE_RETRY_MS * 2 ** failures.current);
        failures.current += 1;
        retryTimer = window.setTimeout(() => setRetryNonce((n) => n + 1), delay);
      } else {
        setMode((m) => (m === 'live' ? 'connecting' : m));
      }
    };
    return () => {
      window.clearTimeout(retryTimer);
      window.clearTimeout(stableTimer);
      if (es) {
        es.removeEventListener('beat', onBeat as EventListener);
        es.removeEventListener('state', onState as EventListener);
        es.close();
      }
    };
  }, [visible, enabled, retryNonce]);

  return enabled ? mode : 'paused';
}

/** setInterval that only runs while `enabled`. */
export function useInterval(fn: () => void, ms: number, enabled: boolean): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => ref.current(), ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
}

export const RECENT_BEATS = 50;

/** Appends a beat (dedup by timestamp, keeps the newest `max`). */
export function appendBeat(list: readonly BeatLike[] | undefined, beat: BeatLike, max = RECENT_BEATS): BeatLike[] {
  const cur = list ?? [];
  const last = cur[cur.length - 1];
  if (last && beat.t <= last.t) {
    if (beat.t === last.t) return [...cur.slice(0, -1), beat].slice(-max);
    return cur as BeatLike[];
  }
  return [...cur, beat].slice(-max);
}

/** Server `recentBeats` (oldest first) plus any locally known beats that are newer. */
export function mergeRecent(server: readonly BeatLike[], local: readonly BeatLike[] | undefined, max = RECENT_BEATS): BeatLike[] {
  const lastT = server.length ? server[server.length - 1]!.t : -Infinity;
  const newer = (local ?? []).filter((b) => b.t > lastT);
  return [...server, ...newer].slice(-max);
}

/** Applies a stream beat to a monitor's state (pure). */
export function applyBeat(m: Monitor, b: StreamBeat): Monitor {
  if (m.uid !== b.uid) return m;
  if (m.state.lastCheckAt !== null && b.ts < m.state.lastCheckAt) return m;
  const changed = b.status !== m.state.status;
  return {
    ...m,
    state: {
      ...m.state,
      status: b.status,
      since: changed ? b.ts : m.state.since,
      lastCheckAt: b.ts,
      latencyMs: b.latencyMs,
      msg: b.msg,
    },
  };
}

export function applyState(m: Monitor, s: StreamState): Monitor {
  if (m.uid !== s.uid) return m;
  return { ...m, state: { ...m.state, status: s.status, since: s.since ?? m.state.since } };
}

export interface LiveMonitors {
  monitors: Monitor[] | undefined;
  beats: ReadonlyMap<string, BeatLike[]>;
  error: string | null;
  loading: boolean;
  mode: LiveMode;
  reload: () => void;
  /** Replace one monitor locally (after an action). */
  replace: (m: Monitor) => void;
  remove: (uid: string) => void;
}

/**
 * Monitor list kept fresh by the stream (or polling). Recent beats for the heartbeat
 * bars are fetched once per monitor (`heartbeats?period=24h`, 4 at a time) and then
 * extended from the stream / from each poll's `state.lastCheckAt`.
 */
export function useLiveMonitors(load: (signal: AbortSignal) => Promise<Monitor[]>, deps: readonly unknown[]): LiveMonitors {
  const [monitors, setMonitors] = useState<Monitor[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [beats, setBeats] = useState<Map<string, BeatLike[]>>(() => new Map());
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const requested = useRef(new Set<string>());
  const visible = usePageVisible();

  const mode = useUptimeStream({
    onBeat: (b) => {
      setMonitors((list) => list?.map((m) => applyBeat(m, b)));
      setBeats((prev) => {
        if (!prev.has(b.uid) && !requested.current.has(b.uid)) return prev;
        const next = new Map(prev);
        next.set(b.uid, appendBeat(prev.get(b.uid), { t: b.ts, status: b.status, latencyMs: b.latencyMs, msg: b.msg }));
        return next;
      });
    },
    onState: (s) => setMonitors((list) => list?.map((m) => applyState(m, s))),
  });

  // (re)load the list
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    loadRef.current(ctrl.signal).then(
      (list) => {
        if (ctrl.signal.aborted) return;
        setMonitors(list);
        setError(null);
        setLoading(false);
        // bars: the server's recentBeats (kept extended by stream beats newer than them),
        // else extend what we have from the polled state
        for (const m of list) if (m.recentBeats) requested.current.add(m.uid);
        setBeats((prev) => {
          let next: Map<string, BeatLike[]> | null = null;
          for (const m of list) {
            if (m.recentBeats) {
              next ??= new Map(prev);
              next.set(m.uid, mergeRecent(m.recentBeats, prev.get(m.uid)));
              continue;
            }
            const cur = prev.get(m.uid);
            const ts = m.state.lastCheckAt;
            if (!cur || ts === null) continue;
            const last = cur[cur.length - 1];
            if (last && ts <= last.t) continue;
            next ??= new Map(prev);
            next.set(m.uid, appendBeat(cur, { t: ts, status: m.state.status, latencyMs: m.state.latencyMs, msg: m.state.msg }));
          }
          return next ?? prev;
        });
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(errorMessage(err) || 'Something went wrong.');
        setLoading(false);
      },
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  // fallback polling (and a slow refresh of the uptime figures while live)
  useInterval(reload, mode === 'live' ? 5 * POLL_INTERVAL_MS : POLL_INTERVAL_MS, visible && mode !== 'connecting' && mode !== 'paused');

  const beatsRef = useRef(beats);
  beatsRef.current = beats;
  // stable while only states change (stream beats must not abort the loads below)
  const uidKey = monitors ? monitors.map((m) => m.uid).join(',') : null;

  // lazy-load recent beats for monitors we have not seen yet (only servers that do not
  // send `recentBeats` with the list; those monitors are marked as requested on load)
  useEffect(() => {
    if (uidKey === null) return;
    const todo = (uidKey ? uidKey.split(',') : []).filter((uid) => !requested.current.has(uid));
    if (todo.length === 0) return;
    todo.forEach((uid) => requested.current.add(uid));
    const ctrl = new AbortController();
    let i = 0;
    const worker = async () => {
      while (i < todo.length && !ctrl.signal.aborted) {
        const uid = todo[i++]!;
        try {
          const r = await uptimeApi.heartbeats(uid, { period: '24h', tz: timeZone }, ctrl.signal);
          if (ctrl.signal.aborted) return;
          const list: BeatLike[] = r.points
            .slice(-RECENT_BEATS)
            .map((p) => ({ t: p.t, status: p.status, latencyMs: p.latencyMs, upRatio: r.interval === 'raw' ? undefined : p.upRatio, msg: p.msg }));
          setBeats((prev) => {
            const next = new Map(prev);
            // keep beats that arrived from the stream meanwhile
            const streamed = (prev.get(uid) ?? []).filter((b) => b.t > (list[list.length - 1]?.t ?? 0));
            next.set(uid, [...list, ...streamed].slice(-RECENT_BEATS));
            return next;
          });
        } catch {
          if (ctrl.signal.aborted) return;
          requested.current.delete(uid);
        }
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
    return () => {
      ctrl.abort();
      // unfinished ones may be requested again by the next run
      for (const uid of todo) if (!beatsRef.current.has(uid)) requested.current.delete(uid);
    };
  }, [uidKey]);

  const replace = useCallback((m: Monitor) => setMonitors((list) => list?.map((x) => (x.uid === m.uid ? m : x))), []);
  const remove = useCallback((uid: string) => setMonitors((list) => list?.filter((x) => x.uid !== uid)), []);

  return { monitors, beats, error, loading: loading && !monitors, mode, reload, replace, remove };
}
