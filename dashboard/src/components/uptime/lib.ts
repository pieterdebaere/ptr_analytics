// Pure helpers for the uptime screens (status semantics, formatting, filtering).
import { statusName, type DisplayStatus, type Monitor, type StatusCode, type StatusName } from '@/api/uptime';

/* ---------------- status semantics ---------------- */

export function displayStatus(m: Pick<Monitor, 'active' | 'state'>): DisplayStatus {
  return m.active ? statusName(m.state.status) : 'paused';
}

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  up: 'Up',
  down: 'Down',
  pending: 'Pending',
  maintenance: 'Maintenance',
  paused: 'Paused',
  unknown: 'No data',
};

/**
 * Tailwind classes per status: dot/bar background (`bg`), text colour (`text`, AA-contrast `*-text` tokens),
 * a soft badge style and a ring. Use `bg` only for non-text marks; words and numbers use `text`.
 */
export const STATUS_STYLES: Record<DisplayStatus, { bg: string; text: string; soft: string; ring: string }> = {
  up: { bg: 'bg-good', text: 'text-good-text', soft: 'bg-good/12 text-good-text', ring: 'ring-good/30' },
  down: { bg: 'bg-poor', text: 'text-poor-text', soft: 'bg-poor/12 text-poor-text', ring: 'ring-poor/30' },
  pending: { bg: 'bg-warn', text: 'text-warn-text', soft: 'bg-warn/15 text-warn-text', ring: 'ring-warn/30' },
  maintenance: { bg: 'bg-maint', text: 'text-maint-text', soft: 'bg-maint/12 text-maint-text', ring: 'ring-maint/30' },
  paused: { bg: 'bg-muted-foreground/40', text: 'text-muted-foreground', soft: 'bg-muted text-muted-foreground', ring: 'ring-foreground/10' },
  unknown: { bg: 'bg-muted-foreground/25', text: 'text-muted-foreground', soft: 'bg-muted text-muted-foreground', ring: 'ring-foreground/10' },
};

/** Severity order used for "worst status" (higher = worse). */
const SEVERITY: Record<DisplayStatus, number> = { down: 5, pending: 4, maintenance: 3, unknown: 2, up: 1, paused: 0 };

export function worstStatus(list: readonly DisplayStatus[]): DisplayStatus | null {
  let worst: DisplayStatus | null = null;
  for (const s of list) if (worst === null || SEVERITY[s] > SEVERITY[worst]) worst = s;
  return worst;
}

/** Worst current status of a site's monitors from the overview counts. */
export function siteHealthStatus(h: { total: number; up: number; down: number; pending: number; maintenance: number; paused: number }): DisplayStatus {
  if (h.down > 0) return 'down';
  if (h.pending > 0) return 'pending';
  if (h.maintenance > 0) return 'maintenance';
  if (h.up > 0) return 'up';
  if (h.total > 0 && h.paused === h.total) return 'paused';
  return 'unknown';
}

export const BEAT_STYLES: Record<StatusName, string> = {
  up: 'bg-good',
  down: 'bg-poor',
  pending: 'bg-warn',
  maintenance: 'bg-maint',
  unknown: 'bg-muted-foreground/25',
};

export function beatClass(status: StatusCode): string {
  return BEAT_STYLES[statusName(status)];
}

/* ---------------- uptime % colour scheme ----------------
 * One documented scheme for every uptime percentage (monitor stats, lists, 90-day bars, public pages):
 *   >= 99.9 %  green        (bar: solid green)
 *   >= 99 %    green        (bar: light green)
 *   >= 95 %    amber
 *   <  95 %    red
 * Days without data are grey, maintenance-only days blue. Text uses the AA `*-text` tokens.
 */
export interface UptimeTier {
  /** lower bound (ratio 0..1, inclusive) */
  min: number;
  /** legend label */
  label: string;
  /** 90-day bar / swatch background */
  bar: string;
  /** text colour for a percentage in this tier */
  text: string;
}

export const UPTIME_TIERS: readonly UptimeTier[] = [
  { min: 0.999, label: '≥ 99.9%', bar: 'bg-good', text: 'text-good-text' },
  { min: 0.99, label: '99–99.9%', bar: 'bg-good/55', text: 'text-good-text' },
  { min: 0.95, label: '95–99%', bar: 'bg-warn', text: 'text-warn-text' },
  { min: 0, label: '< 95%', bar: 'bg-poor', text: 'text-poor-text' },
];

/** Legend entries for days without a ratio. */
export const UPTIME_LEGEND_EXTRA = [
  { label: 'Maintenance', bar: 'bg-maint' },
  { label: 'No data', bar: 'bg-muted-foreground/20' },
] as const;

export function uptimeTier(ratio: number | null | undefined): UptimeTier | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return null;
  return UPTIME_TIERS.find((t) => ratio >= t.min) ?? UPTIME_TIERS[UPTIME_TIERS.length - 1]!;
}

/** Colour of a day in the 90-day bar from its uptime ratio. */
export function dayClass(upRatio: number | null, maintenance: boolean): string {
  if (upRatio === null) return maintenance ? 'bg-maint' : 'bg-muted-foreground/20';
  return uptimeTier(upRatio)!.bar;
}

/* ---------------- formatting ---------------- */

/** 0.99981 -> "99.98%", 1 -> "100%", null -> "–". Never rounds a non-perfect ratio up to 100%. */
export function formatUptime(ratio: number | null | undefined, digits = 2): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '–';
  if (ratio >= 1) return '100%';
  const factor = 10 ** digits;
  const pct = Math.floor(ratio * 100 * factor) / factor;
  return `${pct.toFixed(digits)}%`;
}

/** Text colour for an uptime percentage (same tiers as the 90-day bars, see UPTIME_TIERS). */
export function uptimeTone(ratio: number | null | undefined): string {
  return uptimeTier(ratio)?.text ?? 'text-muted-foreground';
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

/** Duration in ms as "2d 4h", "3h 12m", "4m 10s", "12s". */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 && m < 10 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

/** "just now", "3 min. ago", "in 2 days" */
export function formatRelative(ts: number | null | undefined, now = Date.now()): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '–';
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < 10_000) return 'just now';
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1000],
  ];
  for (const [unit, size] of units) {
    if (abs >= size || unit === 'second') {
      const v = Math.round(diff / size);
      return rtf ? rtf.format(v, unit) : `${Math.abs(v)} ${unit}${Math.abs(v) === 1 ? '' : 's'} ${diff < 0 ? 'ago' : 'from now'}`;
    }
  }
  return '–';
}

const dtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = dtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, opts);
    dtCache.set(key, f);
  }
  return f;
}

export function formatDateTime(ts: number | null | undefined, withSeconds = false): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '–';
  return dtf({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) }).format(ts);
}

export function formatDay(ts: number | null | undefined, tz?: string): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '–';
  return dtf({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', ...(tz ? { timeZone: tz } : {}) }).format(ts);
}

export function formatDateLong(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '–';
  return dtf({ year: 'numeric', month: 'short', day: 'numeric' }).format(ts);
}

/** Days until a date (negative when past). */
export function daysUntil(ts: number | null | undefined, now = Date.now()): number | null {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return null;
  return Math.floor((ts - now) / 86_400_000);
}

export function expiryTone(days: number | null): string {
  if (days === null) return 'text-muted-foreground';
  if (days < 7) return 'text-poor-text';
  if (days < 21) return 'text-warn-text';
  return 'text-good-text';
}

/* ---------------- monitors ---------------- */

/** Fallback labels when GET /api/uptime/types is not loaded. */
export const TYPE_LABELS: Record<string, string> = {
  http: 'HTTP(S)',
  keyword: 'HTTP keyword',
  json: 'HTTP JSON query',
  tcp: 'TCP port',
  tls: 'TLS certificate',
  dns: 'DNS',
  push: 'Push',
  group: 'Group',
  manual: 'Manual',
  ping: 'Ping',
  websocket: 'WebSocket',
  smtp: 'SMTP',
  ntp: 'NTP',
  redis: 'Redis',
  ssh: 'SSH',
  grpc_health: 'gRPC health',
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  mongodb: 'MongoDB',
  mqtt: 'MQTT',
  docker: 'Docker container',
  domain: 'Domain expiry',
};

export function typeLabel(type: string, labels?: Readonly<Record<string, string>>): string {
  return labels?.[type] ?? TYPE_LABELS[type] ?? type.toUpperCase();
}

/** href for a monitor target when it is an http(s) URL without credentials, else null. */
export function safeTargetHref(target: string | null | undefined): string | null {
  if (typeof target !== 'string' || target.length > 2048) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f\\]/.test(target)) return null;
  try {
    const u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

export interface MonitorFilters {
  q?: string;
  status?: DisplayStatus | '';
  siteId?: string;
  tag?: string;
  type?: string;
}

/** Client-side search + filters (name, target, type, tags, description). */
export function filterMonitors<M extends Monitor>(monitors: readonly M[], f: MonitorFilters): M[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return monitors.filter((m) => {
    if (f.status && displayStatus(m) !== f.status) return false;
    if (f.siteId && m.siteId !== f.siteId) return false;
    if (f.type && m.type !== f.type) return false;
    if (f.tag && !m.tags.some((t) => t.uid === f.tag)) return false;
    if (!q) return true;
    const hay = [m.name, m.target ?? '', m.type, m.description ?? '', ...m.tags.map((t) => (t.value ? `${t.name}:${t.value}` : t.name))]
      .join('\n')
      .toLowerCase();
    return q.split(/\s+/).every((word) => hay.includes(word));
  });
}

export function hasFilters(f: MonitorFilters): boolean {
  return Boolean((f.q ?? '').trim() || f.status || f.siteId || f.tag || f.type);
}

export interface TreeRow<M> {
  monitor: M;
  depth: number;
  childCount: number;
}

/**
 * Orders monitors as a tree (groups followed by their children, sorted by name).
 * Monitors whose parent is not in the list are top-level. Cycles are broken.
 */
export function monitorTree<M extends Monitor>(monitors: readonly M[], collapsed: ReadonlySet<string> = new Set()): TreeRow<M>[] {
  const byUid = new Map(monitors.map((m) => [m.uid, m]));
  const children = new Map<string, M[]>();
  const roots: M[] = [];
  for (const m of monitors) {
    if (m.parentUid && m.parentUid !== m.uid && byUid.has(m.parentUid)) {
      const list = children.get(m.parentUid) ?? [];
      list.push(m);
      children.set(m.parentUid, list);
    } else roots.push(m);
  }
  const byName = (a: M, b: M) => {
    const sa = displayStatus(a) === 'down' ? 0 : 1;
    const sb = displayStatus(b) === 'down' ? 0 : 1;
    return sa - sb || a.name.localeCompare(b.name);
  };
  const out: TreeRow<M>[] = [];
  const seen = new Set<string>();
  const visit = (m: M, depth: number) => {
    if (seen.has(m.uid)) return;
    seen.add(m.uid);
    const kids = (children.get(m.uid) ?? []).slice().sort(byName);
    out.push({ monitor: m, depth, childCount: kids.length });
    if (collapsed.has(m.uid)) {
      // still mark descendants as seen so they do not show up as roots
      const mark = (x: M) => {
        for (const k of children.get(x.uid) ?? []) if (!seen.has(k.uid)) (seen.add(k.uid), mark(k));
      };
      mark(m);
      return;
    }
    for (const k of kids) visit(k, Math.min(depth + 1, 4));
  };
  roots.sort(byName).forEach((m) => visit(m, 0));
  // members of a cycle (no root reachable) are appended flat
  for (const m of monitors) if (!seen.has(m.uid)) visit(m, 0);
  return out;
}

export function countByStatus(monitors: readonly Monitor[]): Record<DisplayStatus, number> {
  const c: Record<DisplayStatus, number> = { up: 0, down: 0, pending: 0, maintenance: 0, paused: 0, unknown: 0 };
  for (const m of monitors) c[displayStatus(m)] += 1;
  return c;
}

/** Group monitors that can be used as a parent for `self` (no cycles). */
export function parentCandidates(monitors: readonly Monitor[], siteId: string, selfUid?: string): Monitor[] {
  const byUid = new Map(monitors.map((m) => [m.uid, m]));
  const isDescendant = (m: Monitor): boolean => {
    let cur: Monitor | undefined = m;
    for (let i = 0; cur && i < 50; i++) {
      if (cur.uid === selfUid) return true;
      cur = cur.parentUid ? byUid.get(cur.parentUid) : undefined;
    }
    return false;
  };
  return monitors.filter((m) => m.type === 'group' && m.siteId === siteId && m.uid !== selfUid && !(selfUid && isDescendant(m)));
}
