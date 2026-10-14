// Typed client for the uptime monitoring API (docs/SPEC.md §8.3).
// Every response is parsed defensively: unknown/invalid members are dropped or
// replaced by safe defaults, and all strings stay untrusted (render with displayText).
import { request } from './client';

/* ------------------------------------------------------------------ statuses */

/** -1 unknown, 0 down, 1 up, 2 pending, 3 maintenance (server/src/uptime/types.ts). */
export type StatusCode = -1 | 0 | 1 | 2 | 3;
export type StatusName = 'unknown' | 'down' | 'up' | 'pending' | 'maintenance';
/** What the UI shows for a monitor: its status, or `paused` when inactive. */
export type DisplayStatus = StatusName | 'paused';

export const STATUS = { UNKNOWN: -1, DOWN: 0, UP: 1, PENDING: 2, MAINTENANCE: 3 } as const;

export function statusName(s: number | null | undefined): StatusName {
  switch (s) {
    case 0:
      return 'down';
    case 1:
      return 'up';
    case 2:
      return 'pending';
    case 3:
      return 'maintenance';
    default:
      return 'unknown';
  }
}

export function toStatusCode(v: unknown): StatusCode {
  if (v === 0 || v === 1 || v === 2 || v === 3) return v;
  if (typeof v === 'string') {
    const i = (['down', 'up', 'pending', 'maintenance'] as const).indexOf(v as never);
    if (i >= 0) return i as StatusCode;
  }
  return -1;
}

/* ------------------------------------------------------------- form metadata */

/** Mirror of `FieldDef` in server/src/uptime/types.ts. */
export type FieldKind =
  | 'text'
  | 'url'
  | 'host'
  | 'number'
  | 'boolean'
  | 'select'
  | 'textarea'
  | 'password'
  | 'list'
  | 'keyvalue'
  | 'statuscodes';

export const FIELD_KINDS: readonly FieldKind[] = [
  'text',
  'url',
  'host',
  'number',
  'boolean',
  'select',
  'textarea',
  'password',
  'list',
  'keyvalue',
  'statuscodes',
];

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  /** Write-only: the API never returns the value, only `secretsSet` names it. */
  secret?: boolean;
  default?: unknown;
  options?: ReadonlyArray<{ value: string; label: string }>;
  min?: number;
  max?: number;
  maxLength?: number;
  placeholder?: string;
  help?: string;
  /** Show only when another field has one of these values. */
  showIf?: { key: string; equals: ReadonlyArray<string | number | boolean> };
  group?: string;
  /** Hidden for members in hosted mode. */
  selfHostedOnly?: boolean;
}

export type CheckerCategory = 'web' | 'network' | 'protocol' | 'passive' | 'infrastructure';
export const CATEGORY_LABELS: Record<CheckerCategory, string> = {
  web: 'Web',
  network: 'Network',
  protocol: 'Protocols',
  passive: 'Passive & grouping',
  infrastructure: 'Infrastructure',
};

export interface MonitorTypeInfo {
  type: string;
  label: string;
  description: string;
  category: CheckerCategory;
  fields: FieldDef[];
  defaults: { intervalS?: number; timeoutMs?: number; retries?: number };
  available: boolean;
  hostedAllowed: boolean;
}

export interface UptimeLimits {
  minIntervalS: number;
  maxTimeoutMs: number;
  maxRetries: number;
  monitorsPerSite: number | null;
}

export interface TypesResponse {
  types: MonitorTypeInfo[];
  limits: UptimeLimits;
}

/* ------------------------------------------------------------------ monitors */

export interface MonitorTag {
  uid: string;
  name: string;
  color: string;
  value: string;
}

export interface MonitorState {
  status: StatusCode;
  since: number | null;
  lastCheckAt: number | null;
  latencyMs: number | null;
  msg: string | null;
}

export interface CertInfo {
  subject: string | null;
  issuer: string | null;
  notAfter: number | null;
  fingerprint256: string | null;
}

export interface MonitorTls {
  valid: boolean;
  notAfter: number | null;
  daysLeft: number | null;
  issuer: string | null;
  subject?: string | null;
  notBefore?: number | null;
  sans?: string[];
  fingerprint256?: string | null;
  hostnameOk?: boolean;
  error?: string | null;
  chain?: CertInfo[];
}

export interface DomainExpiry {
  domain: string | null;
  expiresAt: number | null;
  daysLeft: number | null;
}

export interface RecentBeat {
  t: number;
  status: StatusCode;
  latencyMs: number | null;
}

export interface Monitor {
  uid: string;
  siteId: string;
  parentUid: string | null;
  type: string;
  name: string;
  description: string | null;
  active: boolean;
  intervalS: number;
  retryIntervalS: number;
  maxRetries: number;
  resendEvery: number;
  timeoutMs: number;
  upsideDown: boolean;
  certNotify: boolean;
  domainNotify: boolean;
  config: Record<string, unknown>;
  secretsSet: string[];
  target: string | null;
  tags: MonitorTag[];
  channelUids: string[];
  publicId: string | null;
  pushUrl: string | null;
  state: MonitorState;
  uptime24h: number | null;
  uptime30d: number | null;
  tls: MonitorTls | null;
  /** Manual monitors: the status set by the user (0 down, 1 up, 2 pending), else null. */
  manualStatus: StatusCode | null;
  /** Optional (not in the base contract): domain expiry when tracked. */
  domain: DomainExpiry | null;
  /** The last (up to 50) beats, oldest first; null when the server did not send them. */
  recentBeats: RecentBeat[] | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/** Writable members for POST /api/sites/:siteId/monitors and PATCH /api/monitors/:uid. */
export interface MonitorInput {
  parentUid?: string | null;
  type?: string;
  name?: string;
  description?: string | null;
  active?: boolean;
  intervalS?: number;
  retryIntervalS?: number;
  maxRetries?: number;
  resendEvery?: number;
  timeoutMs?: number;
  upsideDown?: boolean;
  certNotify?: boolean;
  domainNotify?: boolean;
  /** Type specific; secret fields: omitted/"" keep, null clears. */
  config?: Record<string, unknown>;
  tags?: Array<{ uid: string; value: string }>;
  channelUids?: string[];
  /** Move to another site (PATCH). */
  siteId?: string;
}

export interface SiteHealth {
  siteId: string;
  total: number;
  up: number;
  down: number;
  pending: number;
  maintenance: number;
  paused: number;
  uptime30d: number | null;
}

export interface UptimeOverview {
  sites: SiteHealth[];
  monitors: Monitor[];
}

export type HeartbeatInterval = 'raw' | 'hour' | 'day';

export interface HeartbeatPoint {
  t: number;
  status: StatusCode;
  latencyMs: number | null;
  latencyMin: number | null;
  latencyMax: number | null;
  /** 0..1 or null (no data / maintenance only) */
  upRatio: number | null;
  /** Only present for raw beats coming from the stream. */
  msg?: string | null;
}

export interface HeartbeatsResponse {
  interval: HeartbeatInterval;
  points: HeartbeatPoint[];
}

export interface DayBar {
  t: number;
  upRatio: number | null;
  maintenance: boolean;
}

export interface MonitorStats {
  uptime: number | null;
  previousUptime: number | null;
  avgLatencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  checks: number;
  outages: number;
  downtimeMs: number;
  mttrMs: number | null;
  bars: DayBar[];
}

export interface MonitorEvent {
  id: number;
  ts: number;
  from: StatusCode | null;
  to: StatusCode;
  msg: string | null;
}

export interface Outage {
  id: number;
  startedAt: number;
  confirmedAt: number | null;
  endedAt: number | null;
  cause: string | null;
}

export type UptimePeriod = '24h' | '7d' | '30d' | '90d' | 'custom';
export const UPTIME_PERIODS: readonly UptimePeriod[] = ['24h', '7d', '30d', '90d', 'custom'];

export interface UptimeQuery {
  period: UptimePeriod;
  from?: string;
  to?: string;
  tz: string;
}

/* ---------------------------------------------------------------------- tags */

export interface Tag {
  uid: string;
  name: string;
  color: string;
}

/* --------------------------------------------------------------- maintenance */

export type MaintenanceStrategy = 'manual' | 'single' | 'weekly' | 'monthly' | 'interval' | 'cron';
export const MAINTENANCE_STRATEGIES: readonly MaintenanceStrategy[] = ['manual', 'single', 'weekly', 'monthly', 'interval', 'cron'];
export type MaintenanceStatus = 'scheduled' | 'under-maintenance' | 'inactive' | 'ended';

export interface Maintenance {
  uid: string;
  title: string;
  description: string | null;
  active: boolean;
  strategy: MaintenanceStrategy;
  tz: string;
  startsAt: number | null;
  endsAt: number | null;
  /** "HH:mm" */
  timeStart: string | null;
  timeEnd: string | null;
  /** 0 = Sunday */
  weekdays: number[];
  daysOfMonth: Array<number | 'L'>;
  intervalDays: number | null;
  cron: string | null;
  durationS: number | null;
  monitorUids: string[];
  statusPageUids: string[];
  status: MaintenanceStatus;
  nextWindow: { start: number; end: number } | null;
}

export type MaintenanceInput = Omit<Maintenance, 'uid' | 'status' | 'nextWindow'>;

/* ----------------------------------------------------- notification channels */

export interface ChannelSummary {
  uid: string;
  type: string;
  name: string;
  isDefault: boolean;
  active: boolean;
}

/* ------------------------------------------------------------------- stream */

export interface StreamBeat {
  uid: string;
  ts: number;
  status: StatusCode;
  latencyMs: number | null;
  msg: string | null;
}

export interface StreamState {
  uid: string;
  status: StatusCode;
  since: number | null;
}

export const UPTIME_STREAM_URL = '/api/uptime/stream';

/* ------------------------------------------------------------------ parsing */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strArr = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');
/** Ratios are clamped to 0..1. */
const ratio = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n === null ? null : Math.min(1, Math.max(0, n));
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** Tag colours are interpolated into styles: only #rrggbb is accepted. */
export function safeColor(v: unknown): string {
  return typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : '#64748b';
}

function parseCategory(v: unknown): CheckerCategory {
  return v === 'web' || v === 'network' || v === 'protocol' || v === 'passive' || v === 'infrastructure' ? v : 'network';
}

export function parseFieldDef(raw: unknown): FieldDef | null {
  if (!isObj(raw)) return null;
  const key = str(raw.key);
  const kind = raw.kind;
  if (!key || !(FIELD_KINDS as readonly unknown[]).includes(kind)) return null;
  const f: FieldDef = { key, label: str(raw.label, key), kind: kind as FieldKind };
  if (raw.required === true) f.required = true;
  if (raw.secret === true || kind === 'password') f.secret = true;
  if ('default' in raw) f.default = raw.default;
  if (Array.isArray(raw.options)) {
    f.options = raw.options
      .filter(isObj)
      .map((o) => ({ value: String(o.value ?? ''), label: str(o.label, String(o.value ?? '')) }));
  }
  const min = numOrNull(raw.min);
  if (min !== null) f.min = min;
  const max = numOrNull(raw.max);
  if (max !== null) f.max = max;
  const maxLength = numOrNull(raw.maxLength);
  if (maxLength !== null) f.maxLength = maxLength;
  if (typeof raw.placeholder === 'string') f.placeholder = raw.placeholder;
  if (typeof raw.help === 'string') f.help = raw.help;
  if (isObj(raw.showIf) && typeof raw.showIf.key === 'string' && Array.isArray(raw.showIf.equals)) {
    f.showIf = {
      key: raw.showIf.key,
      equals: raw.showIf.equals.filter((x): x is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof x)),
    };
  }
  if (typeof raw.group === 'string' && raw.group) f.group = raw.group;
  if (raw.selfHostedOnly === true) f.selfHostedOnly = true;
  return f;
}

export function parseFieldDefs(raw: unknown): FieldDef[] {
  return arr(raw)
    .map(parseFieldDef)
    .filter((f): f is FieldDef => f !== null);
}

export function parseTypes(raw: unknown): TypesResponse {
  const o = isObj(raw) ? raw : {};
  const types = arr(o.types)
    .filter(isObj)
    .filter((t) => typeof t.type === 'string' && t.type)
    .map(
      (t): MonitorTypeInfo => ({
        type: str(t.type),
        label: str(t.label, str(t.type)),
        description: str(t.description),
        category: parseCategory(t.category),
        fields: parseFieldDefs(t.fields),
        defaults: isObj(t.defaults)
          ? {
              intervalS: numOrNull(t.defaults.intervalS) ?? undefined,
              timeoutMs: numOrNull(t.defaults.timeoutMs) ?? undefined,
              retries: numOrNull(t.defaults.retries) ?? undefined,
            }
          : {},
        available: bool(t.available, true),
        hostedAllowed: bool(t.hostedAllowed, true),
      }),
    );
  const l = isObj(o.limits) ? o.limits : {};
  return {
    types,
    limits: {
      minIntervalS: num(l.minIntervalS, 20),
      maxTimeoutMs: num(l.maxTimeoutMs, 60_000),
      maxRetries: num(l.maxRetries, 10),
      monitorsPerSite: numOrNull(l.monitorsPerSite),
    },
  };
}

function parseState(raw: unknown): MonitorState {
  const s = isObj(raw) ? raw : {};
  return {
    status: toStatusCode(s.status),
    since: numOrNull(s.since),
    lastCheckAt: numOrNull(s.lastCheckAt),
    latencyMs: numOrNull(s.latencyMs),
    msg: strOrNull(s.msg),
  };
}

function parseCert(raw: unknown): CertInfo | null {
  if (!isObj(raw)) return null;
  return {
    subject: strOrNull(raw.subject),
    issuer: strOrNull(raw.issuer),
    notAfter: numOrNull(raw.notAfter),
    fingerprint256: strOrNull(raw.fingerprint256),
  };
}

const DAY_MS = 86_400_000;

function parseTls(raw: unknown): MonitorTls | null {
  if (!isObj(raw)) return null;
  const notAfter = numOrNull(raw.notAfter);
  const daysLeft = numOrNull(raw.daysLeft) ?? (notAfter !== null ? Math.floor((notAfter - Date.now()) / DAY_MS) : null);
  const tls: MonitorTls = { valid: bool(raw.valid, true), notAfter, daysLeft, issuer: strOrNull(raw.issuer) };
  if ('subject' in raw) tls.subject = strOrNull(raw.subject);
  if ('notBefore' in raw) tls.notBefore = numOrNull(raw.notBefore);
  if ('sans' in raw) tls.sans = strArr(raw.sans);
  if ('fingerprint256' in raw) tls.fingerprint256 = strOrNull(raw.fingerprint256);
  if (typeof raw.hostnameOk === 'boolean') tls.hostnameOk = raw.hostnameOk;
  if ('error' in raw) tls.error = strOrNull(raw.error);
  if (Array.isArray(raw.chain)) tls.chain = raw.chain.map(parseCert).filter((c): c is CertInfo => c !== null);
  return tls;
}

function parseDomain(raw: Obj): DomainExpiry | null {
  if (isObj(raw.domain)) {
    const expiresAt = numOrNull(raw.domain.expiresAt);
    return {
      domain: strOrNull(raw.domain.domain),
      expiresAt,
      daysLeft: numOrNull(raw.domain.daysLeft) ?? (expiresAt !== null ? Math.floor((expiresAt - Date.now()) / DAY_MS) : null),
    };
  }
  const expiresAt = numOrNull(raw.domainExpiresAt);
  if (expiresAt === null) return null;
  return { domain: null, expiresAt, daysLeft: Math.floor((expiresAt - Date.now()) / DAY_MS) };
}

export function parseMonitor(raw: unknown): Monitor | null {
  if (!isObj(raw)) return null;
  const uid = str(raw.uid);
  if (!uid) return null;
  return {
    uid,
    siteId: str(raw.siteId),
    parentUid: strOrNull(raw.parentUid),
    type: str(raw.type, 'unknown'),
    name: str(raw.name, uid),
    description: strOrNull(raw.description),
    active: bool(raw.active, true),
    intervalS: num(raw.intervalS, 60),
    retryIntervalS: num(raw.retryIntervalS, num(raw.intervalS, 60)),
    maxRetries: num(raw.maxRetries, 0),
    resendEvery: num(raw.resendEvery, 0),
    timeoutMs: num(raw.timeoutMs, 10_000),
    upsideDown: bool(raw.upsideDown),
    certNotify: bool(raw.certNotify),
    domainNotify: bool(raw.domainNotify),
    config: isObj(raw.config) ? raw.config : {},
    secretsSet: strArr(raw.secretsSet),
    target: strOrNull(raw.target),
    tags: arr(raw.tags)
      .filter(isObj)
      .filter((t) => typeof t.uid === 'string')
      .map((t) => ({ uid: str(t.uid), name: str(t.name), color: safeColor(t.color), value: str(t.value) })),
    channelUids: strArr(raw.channelUids),
    publicId: strOrNull(raw.publicId),
    pushUrl: strOrNull(raw.pushUrl),
    state: parseState(raw.state),
    uptime24h: ratio(raw.uptime24h),
    uptime30d: ratio(raw.uptime30d),
    tls: parseTls(raw.tls),
    manualStatus: raw.manualStatus === null || raw.manualStatus === undefined ? null : toStatusCode(raw.manualStatus),
    domain: parseDomain(raw),
    recentBeats: Array.isArray(raw.recentBeats)
      ? raw.recentBeats
          .filter(isObj)
          .filter((x) => typeof x.t === 'number' && Number.isFinite(x.t))
          .slice(-50)
          .map((x) => ({ t: x.t as number, status: toStatusCode(x.status), latencyMs: numOrNull(x.latencyMs) }))
      : null,
    createdAt: numOrNull(raw.createdAt),
    updatedAt: numOrNull(raw.updatedAt),
  };
}

export function parseMonitors(raw: unknown): Monitor[] {
  return arr(raw)
    .map(parseMonitor)
    .filter((m): m is Monitor => m !== null);
}

export function parseOverview(raw: unknown): UptimeOverview {
  const o = isObj(raw) ? raw : {};
  return {
    sites: arr(o.sites)
      .filter(isObj)
      .filter((s) => typeof s.siteId === 'string')
      .map((s) => ({
        siteId: str(s.siteId),
        total: num(s.total),
        up: num(s.up),
        down: num(s.down),
        pending: num(s.pending),
        maintenance: num(s.maintenance),
        paused: num(s.paused),
        uptime30d: ratio(s.uptime30d),
      })),
    monitors: parseMonitors(o.monitors),
  };
}

function parseInterval(v: unknown): HeartbeatInterval {
  return v === 'hour' || v === 'day' ? v : 'raw';
}

export function parseHeartbeats(raw: unknown): HeartbeatsResponse {
  const o = isObj(raw) ? raw : {};
  const points = arr(o.points)
    .filter(isObj)
    .filter((p) => numOrNull(p.t) !== null)
    .map(
      (p): HeartbeatPoint => ({
        t: num(p.t),
        status: toStatusCode(p.status),
        latencyMs: numOrNull(p.latencyMs),
        latencyMin: numOrNull(p.latencyMin),
        latencyMax: numOrNull(p.latencyMax),
        upRatio: ratio(p.upRatio),
        ...(typeof p.msg === 'string' ? { msg: p.msg } : {}),
      }),
    )
    .sort((a, b) => a.t - b.t);
  return { interval: parseInterval(o.interval), points };
}

export function parseStats(raw: unknown): MonitorStats {
  const o = isObj(raw) ? raw : {};
  return {
    uptime: ratio(o.uptime),
    previousUptime: ratio(o.previousUptime),
    avgLatencyMs: numOrNull(o.avgLatencyMs),
    minLatencyMs: numOrNull(o.minLatencyMs),
    maxLatencyMs: numOrNull(o.maxLatencyMs),
    checks: num(o.checks),
    outages: num(o.outages),
    downtimeMs: num(o.downtimeMs),
    mttrMs: numOrNull(o.mttrMs),
    bars: arr(o.bars)
      .filter(isObj)
      .filter((b) => numOrNull(b.t) !== null)
      .map((b) => ({ t: num(b.t), upRatio: ratio(b.upRatio), maintenance: bool(b.maintenance) })),
  };
}

export function parseEvents(raw: unknown): MonitorEvent[] {
  const o = isObj(raw) ? raw : {};
  return arr(o.events)
    .filter(isObj)
    .filter((e) => numOrNull(e.id) !== null && numOrNull(e.ts) !== null)
    .map((e) => ({
      id: num(e.id),
      ts: num(e.ts),
      from: e.from === null || e.from === undefined ? null : toStatusCode(e.from),
      to: toStatusCode(e.to),
      msg: strOrNull(e.msg),
    }));
}

export function parseOutages(raw: unknown): Outage[] {
  const o = isObj(raw) ? raw : {};
  return arr(o.outages)
    .filter(isObj)
    .filter((e) => numOrNull(e.id) !== null && numOrNull(e.startedAt) !== null)
    .map((e) => ({
      id: num(e.id),
      startedAt: num(e.startedAt),
      confirmedAt: numOrNull(e.confirmedAt),
      endedAt: numOrNull(e.endedAt),
      cause: strOrNull(e.cause),
    }));
}

export function parseTag(raw: unknown): Tag | null {
  if (!isObj(raw) || typeof raw.uid !== 'string') return null;
  return { uid: raw.uid, name: str(raw.name), color: safeColor(raw.color) };
}

function parseStrategy(v: unknown): MaintenanceStrategy {
  return (MAINTENANCE_STRATEGIES as readonly unknown[]).includes(v) ? (v as MaintenanceStrategy) : 'manual';
}

function parseMaintStatus(v: unknown): MaintenanceStatus {
  return v === 'scheduled' || v === 'under-maintenance' || v === 'ended' ? v : 'inactive';
}

export function parseMaintenance(raw: unknown): Maintenance | null {
  if (!isObj(raw) || typeof raw.uid !== 'string') return null;
  const nw = isObj(raw.nextWindow) ? raw.nextWindow : null;
  return {
    uid: raw.uid,
    title: str(raw.title),
    description: strOrNull(raw.description),
    active: bool(raw.active, true),
    strategy: parseStrategy(raw.strategy),
    tz: str(raw.tz, 'UTC'),
    startsAt: numOrNull(raw.startsAt),
    endsAt: numOrNull(raw.endsAt),
    timeStart: strOrNull(raw.timeStart),
    timeEnd: strOrNull(raw.timeEnd),
    weekdays: arr(raw.weekdays).filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6),
    daysOfMonth: arr(raw.daysOfMonth).filter(
      (d): d is number | 'L' => d === 'L' || (typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 31),
    ),
    intervalDays: numOrNull(raw.intervalDays),
    cron: strOrNull(raw.cron),
    durationS: numOrNull(raw.durationS),
    monitorUids: strArr(raw.monitorUids),
    statusPageUids: strArr(raw.statusPageUids),
    status: parseMaintStatus(raw.status),
    nextWindow: nw && numOrNull(nw.start) !== null && numOrNull(nw.end) !== null ? { start: num(nw.start), end: num(nw.end) } : null,
  };
}

export function parseChannels(raw: unknown): ChannelSummary[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) ? arr(raw.channels) : [];
  return list
    .filter(isObj)
    .filter((c) => typeof c.uid === 'string')
    .map((c) => ({ uid: str(c.uid), type: str(c.type), name: str(c.name, str(c.uid)), isDefault: bool(c.isDefault), active: bool(c.active, true) }));
}

export function parseStreamBeat(raw: unknown): StreamBeat | null {
  if (!isObj(raw) || typeof raw.uid !== 'string' || numOrNull(raw.ts) === null) return null;
  return { uid: raw.uid, ts: num(raw.ts), status: toStatusCode(raw.status), latencyMs: numOrNull(raw.latencyMs), msg: strOrNull(raw.msg) };
}

export function parseStreamState(raw: unknown): StreamState | null {
  if (!isObj(raw) || typeof raw.uid !== 'string') return null;
  return { uid: raw.uid, status: toStatusCode(raw.status), since: numOrNull(raw.since) };
}

/* ------------------------------------------------------------------ client */

const enc = encodeURIComponent;
const monitorPath = (uid: string) => `/monitors/${enc(uid)}`;
const maintPath = (uid: string) => `/maintenances/${enc(uid)}`;

function periodQuery(q: UptimeQuery): URLSearchParams {
  const p = new URLSearchParams({ period: q.period, tz: q.tz });
  if (q.period === 'custom') {
    if (q.from) p.set('from', q.from);
    if (q.to) p.set('to', q.to);
  }
  return p;
}

/** Monitor from a `{monitor}` body, or null when the server answered something else (204 …). */
function monitorFrom(raw: unknown): Monitor | null {
  return isObj(raw) ? parseMonitor(raw.monitor) : null;
}

export const uptimeApi = {
  types: (signal?: AbortSignal) => request<unknown>('GET', '/uptime/types', { signal }).then(parseTypes),
  overview: (signal?: AbortSignal) => request<unknown>('GET', '/uptime/overview', { signal }).then(parseOverview),

  siteMonitors: (siteId: string, signal?: AbortSignal) =>
    request<unknown>('GET', `/sites/${enc(siteId)}/monitors`, { signal }).then((r) => parseMonitors(isObj(r) ? r.monitors : [])),
  getMonitor: (uid: string, signal?: AbortSignal) =>
    request<unknown>('GET', monitorPath(uid), { signal }).then((r) => {
      const m = monitorFrom(r);
      if (!m) throw new Error('Invalid response');
      return m;
    }),
  createMonitor: (siteId: string, body: MonitorInput) =>
    request<unknown>('POST', `/sites/${enc(siteId)}/monitors`, { body }).then((r) => {
      const m = monitorFrom(r);
      if (!m) throw new Error('Invalid response');
      return m;
    }),
  updateMonitor: (uid: string, body: MonitorInput) => request<unknown>('PATCH', monitorPath(uid), { body }).then(monitorFrom),
  deleteMonitor: (uid: string) => request<void>('DELETE', monitorPath(uid)),
  pauseMonitor: (uid: string) => request<unknown>('POST', `${monitorPath(uid)}/pause`).then(monitorFrom),
  resumeMonitor: (uid: string) => request<unknown>('POST', `${monitorPath(uid)}/resume`).then(monitorFrom),
  cloneMonitor: (uid: string) => request<unknown>('POST', `${monitorPath(uid)}/clone`).then(monitorFrom),
  checkMonitor: (uid: string) => request<unknown>('POST', `${monitorPath(uid)}/check`),
  /** Manual monitors only. */
  setManualStatus: (uid: string, status: 'up' | 'down' | 'pending', msg?: string) =>
    request<unknown>('POST', `${monitorPath(uid)}/status`, { body: msg ? { status, msg } : { status } }).then(monitorFrom),
  /** Returns the new push URL (shown once — never log or persist it). */
  regeneratePushToken: (uid: string) =>
    request<unknown>('POST', `${monitorPath(uid)}/push-token`).then((r) => (isObj(r) ? strOrNull(r.pushUrl) : null)),
  setBadges: (uid: string, enabled: boolean) =>
    request<unknown>('POST', `${monitorPath(uid)}/badges`, { body: { enabled } }).then((r) => (isObj(r) ? strOrNull(r.publicId) : null)),

  heartbeats: (uid: string, q: UptimeQuery, signal?: AbortSignal) =>
    request<unknown>('GET', `${monitorPath(uid)}/heartbeats`, { query: periodQuery(q), signal }).then(parseHeartbeats),
  stats: (uid: string, q: UptimeQuery, signal?: AbortSignal) =>
    request<unknown>('GET', `${monitorPath(uid)}/stats`, { query: periodQuery(q), signal }).then(parseStats),
  events: (uid: string, opts: { before?: number; limit?: number } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (opts.before !== undefined) query.set('before', String(opts.before));
    if (opts.limit !== undefined) query.set('limit', String(opts.limit));
    return request<unknown>('GET', `${monitorPath(uid)}/events`, { query, signal }).then(parseEvents);
  },
  outages: (uid: string, limit = 50, signal?: AbortSignal) =>
    request<unknown>('GET', `${monitorPath(uid)}/outages`, { query: new URLSearchParams({ limit: String(limit) }), signal }).then(
      parseOutages,
    ),

  listTags: (signal?: AbortSignal) =>
    request<unknown>('GET', '/tags', { signal }).then((r) =>
      arr(isObj(r) ? r.tags : r)
        .map(parseTag)
        .filter((t): t is Tag => t !== null),
    ),
  createTag: (body: { name: string; color: string }) =>
    request<unknown>('POST', '/tags', { body }).then((r) => {
      const t = parseTag(isObj(r) ? (r.tag ?? r) : null);
      if (!t) throw new Error('Invalid response');
      return t;
    }),
  updateTag: (uid: string, body: { name?: string; color?: string }) => request<unknown>('PATCH', `/tags/${enc(uid)}`, { body }),
  deleteTag: (uid: string) => request<void>('DELETE', `/tags/${enc(uid)}`),

  listMaintenances: (signal?: AbortSignal) =>
    request<unknown>('GET', '/maintenances', { signal }).then((r) =>
      arr(isObj(r) ? r.maintenances : r)
        .map(parseMaintenance)
        .filter((m): m is Maintenance => m !== null),
    ),
  createMaintenance: (body: MaintenanceInput) =>
    request<unknown>('POST', '/maintenances', { body }).then((r) => parseMaintenance(isObj(r) ? r.maintenance : null)),
  updateMaintenance: (uid: string, body: Partial<MaintenanceInput>) =>
    request<unknown>('PATCH', maintPath(uid), { body }).then((r) => parseMaintenance(isObj(r) ? r.maintenance : null)),
  deleteMaintenance: (uid: string) => request<void>('DELETE', maintPath(uid)),
  pauseMaintenance: (uid: string) => request<unknown>('POST', `${maintPath(uid)}/pause`),
  resumeMaintenance: (uid: string) => request<unknown>('POST', `${maintPath(uid)}/resume`),

  /** Read-only use of the notification channel list (owned by the notifications UI). */
  listChannels: (signal?: AbortSignal) => request<unknown>('GET', '/notification-channels', { signal }).then(parseChannels),
};
