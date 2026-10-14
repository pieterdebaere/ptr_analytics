// Pure state helpers of the monitor editor (common settings, validation, payload,
// server error mapping).
import { ApiError } from '@/api/client';
import type { FieldDef, Monitor, MonitorInput, MonitorTypeInfo, UptimeLimits } from '@/api/uptime';
import { fieldValuesToConfig } from '@/components/forms/field-values';

export interface MonitorForm {
  name: string;
  siteId: string;
  parentUid: string;
  description: string;
  intervalS: number | undefined;
  retryIntervalS: number | undefined;
  maxRetries: number | undefined;
  resendEvery: number | undefined;
  timeoutS: number | undefined;
  upsideDown: boolean;
  certNotify: boolean;
  domainNotify: boolean;
  active: boolean;
  tags: Array<{ uid: string; value: string }>;
  channelUids: string[];
}

export type CommonKey = keyof MonitorForm;

/** Types without an own network check (no timeout / retries semantics of a probe). */
export const PASSIVE_TYPES = new Set(['push', 'group', 'manual']);
/** Types whose checks see a TLS certificate. */
export const CERT_TYPES = new Set(['http', 'keyword', 'json', 'tls', 'websocket', 'grpc_health', 'smtp']);
/** Types with a host name that has a registrable domain. */
export const DOMAIN_TYPES = new Set(['http', 'keyword', 'json', 'tcp', 'tls', 'dns', 'ping', 'websocket', 'smtp', 'ssh', 'grpc_health', 'domain']);

export function newMonitorForm(type: MonitorTypeInfo | undefined, limits: UptimeLimits | undefined, siteId: string): MonitorForm {
  const min = limits?.minIntervalS ?? 20;
  const intervalS = Math.max(min, type?.defaults.intervalS ?? 60);
  const maxTimeoutS = (limits?.maxTimeoutMs ?? 60_000) / 1000;
  const timeoutS = Math.min(maxTimeoutS, intervalS * 0.8, (type?.defaults.timeoutMs ?? 10_000) / 1000);
  return {
    name: '',
    siteId,
    parentUid: '',
    description: '',
    intervalS,
    retryIntervalS: intervalS,
    maxRetries: Math.min(limits?.maxRetries ?? 10, type?.defaults.retries ?? 1),
    resendEvery: 0,
    timeoutS: Math.round(timeoutS * 10) / 10,
    upsideDown: false,
    certNotify: type ? CERT_TYPES.has(type.type) : true,
    domainNotify: false,
    active: true,
    tags: [],
    channelUids: [],
  };
}

export function monitorToForm(m: Monitor): MonitorForm {
  return {
    name: m.name,
    siteId: m.siteId,
    parentUid: m.parentUid ?? '',
    description: m.description ?? '',
    intervalS: m.intervalS,
    retryIntervalS: m.retryIntervalS,
    maxRetries: m.maxRetries,
    resendEvery: m.resendEvery,
    timeoutS: Math.round(m.timeoutMs / 100) / 10,
    upsideDown: m.upsideDown,
    certNotify: m.certNotify,
    domainNotify: m.domainNotify,
    active: m.active,
    tags: m.tags.map((t) => ({ uid: t.uid, value: t.value })),
    channelUids: [...m.channelUids],
  };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export function validateMonitorForm(f: MonitorForm, type: string, limits: UptimeLimits | undefined): Partial<Record<CommonKey, string>> {
  const e: Partial<Record<CommonKey, string>> = {};
  const min = limits?.minIntervalS ?? 20;
  const maxTimeoutS = (limits?.maxTimeoutMs ?? 60_000) / 1000;
  const maxRetries = limits?.maxRetries ?? 10;
  if (!f.name.trim()) e.name = 'Enter a name.';
  else if (f.name.trim().length > 100) e.name = 'At most 100 characters.';
  if (!f.siteId) e.siteId = 'Pick a site.';
  if (f.description.trim().length > 500) e.description = 'At most 500 characters.';
  if (!isInt(f.intervalS)) e.intervalS = 'Enter a whole number of seconds.';
  else if (f.intervalS < min) e.intervalS = `At least ${min} seconds.`;
  else if (f.intervalS > 86_400) e.intervalS = 'At most 24 hours (86400 s).';
  if (!isInt(f.retryIntervalS)) e.retryIntervalS = 'Enter a whole number of seconds.';
  else if (f.retryIntervalS < min) e.retryIntervalS = `At least ${min} seconds.`;
  else if (f.retryIntervalS > 86_400) e.retryIntervalS = 'At most 24 hours (86400 s).';
  if (!isInt(f.maxRetries) || f.maxRetries < 0) e.maxRetries = 'Enter 0 or more.';
  else if (f.maxRetries > maxRetries) e.maxRetries = `At most ${maxRetries}.`;
  if (!isInt(f.resendEvery) || f.resendEvery < 0) e.resendEvery = 'Enter 0 or more.';
  else if (f.resendEvery > 1000) e.resendEvery = 'At most 1000.';
  if (!PASSIVE_TYPES.has(type)) {
    if (typeof f.timeoutS !== 'number' || !Number.isFinite(f.timeoutS) || f.timeoutS <= 0) e.timeoutS = 'Enter a timeout in seconds.';
    else if (f.timeoutS < 0.5) e.timeoutS = 'At least 0.5 seconds.';
    else if (f.timeoutS > maxTimeoutS) e.timeoutS = `At most ${maxTimeoutS} seconds.`;
    else if (isInt(f.intervalS) && f.timeoutS > f.intervalS * 0.8) e.timeoutS = `At most 80% of the check interval (${Math.floor(f.intervalS * 8) / 10} s).`;
  }
  const seen = new Set<string>();
  for (const t of f.tags) {
    const k = `${t.uid}\u0000${t.value.trim()}`;
    if (seen.has(k)) {
      e.tags = 'The same tag and value is used twice.';
      break;
    }
    seen.add(k);
  }
  return e;
}

export function buildMonitorPayload(
  f: MonitorForm,
  type: MonitorTypeInfo,
  fieldValues: Record<string, unknown>,
  opts: { hosted: boolean; create: boolean },
): MonitorInput {
  const passive = PASSIVE_TYPES.has(type.type);
  const body: MonitorInput = {
    name: f.name.trim(),
    description: f.description.trim() ? f.description.trim() : null,
    parentUid: f.parentUid || null,
    active: f.active,
    intervalS: f.intervalS,
    retryIntervalS: f.retryIntervalS,
    maxRetries: f.maxRetries,
    resendEvery: f.resendEvery,
    upsideDown: f.upsideDown,
    certNotify: CERT_TYPES.has(type.type) ? f.certNotify : false,
    domainNotify: DOMAIN_TYPES.has(type.type) ? f.domainNotify : false,
    config: fieldValuesToConfig(type.fields, fieldValues, opts.hosted),
    tags: f.tags.map((t) => ({ uid: t.uid, value: t.value.trim() })),
    channelUids: [...f.channelUids],
  };
  if (!passive && typeof f.timeoutS === 'number') body.timeoutMs = Math.round(f.timeoutS * 1000);
  if (opts.create) body.type = type.type;
  return body;
}

const COMMON_FIELD_MAP: Record<string, CommonKey> = {
  name: 'name',
  siteId: 'siteId',
  parentUid: 'parentUid',
  description: 'description',
  intervalS: 'intervalS',
  retryIntervalS: 'retryIntervalS',
  maxRetries: 'maxRetries',
  resendEvery: 'resendEvery',
  timeoutMs: 'timeoutS',
  tags: 'tags',
  channelUids: 'channelUids',
};

export interface MappedErrors {
  common: Partial<Record<CommonKey, string>>;
  fields: Record<string, string>;
  form: string | null;
}

/**
 * Maps a server validation error to the form: `ApiError.field` (`name`, `config.url`,
 * `url` …) or a "field: message" prefix in the message. Unmapped errors go to `form`.
 */
export function mapServerError(err: unknown, fields: readonly FieldDef[], fallback: string): MappedErrors {
  const out: MappedErrors = { common: {}, fields: {}, form: null };
  const message = err instanceof Error && err.message ? err.message : fallback;
  let field = err instanceof ApiError ? err.field : undefined;
  let text = message;
  if (!field) {
    const m = /^([A-Za-z][\w.[\]-]{0,80}):\s*(.+)$/.exec(message);
    if (m) {
      field = m[1];
      text = m[2]!;
    }
  }
  if (field) {
    const key = field.replace(/^config\./, '').replace(/\[\d+\]$/, '');
    if (COMMON_FIELD_MAP[field]) {
      out.common[COMMON_FIELD_MAP[field]!] = text;
      return out;
    }
    if (fields.some((f) => f.key === key)) {
      out.fields[key] = text;
      return out;
    }
  }
  out.form = message;
  return out;
}

export function hasErrors(e: MappedErrors | { common: object; fields: object }): boolean {
  return Object.keys(e.common).length > 0 || Object.keys(e.fields).length > 0;
}

/** "every 1 min", "every 30 s", "every 2 h" */
export function everyText(s: number | undefined): string {
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return '';
  if (s % 3600 === 0) return `every ${s / 3600} h`;
  if (s % 60 === 0) return `every ${s / 60} min`;
  if (s > 60) return `every ${Math.floor(s / 60)} min ${s % 60} s`;
  return `every ${s} s`;
}
