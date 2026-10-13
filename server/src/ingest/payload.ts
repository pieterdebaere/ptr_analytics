import { SITE_ID_RE } from '../lib/ids.js';
import { VITAL_METRICS, type VitalMetric } from '../stats/vitals-score.js';

export type PropValue = string | number | boolean | null;

interface Common {
  site: string;
  url: URL;
  referrer: URL | null;
  width: number | undefined;
}

export type IngestPayload =
  | (Common & { type: 'pageview' })
  | (Common & { type: 'event'; name: string; props: Record<string, PropValue> | null })
  | (Common & { type: 'vitals'; metrics: Array<{ name: VitalMetric; value: number }> });

const MAX_URL = 2048;
const MAX_PROPS = 30;
const MAX_PROP_KEY = 100;
const MAX_PROP_STRING = 500;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function own(o: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

function parseHttpUrl(v: string): URL | null {
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.hostname === '') return null;
    return u;
  } catch {
    return null;
  }
}

function parseProps(v: unknown): Record<string, PropValue> | null | false {
  if (v === undefined || v === null) return null;
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > MAX_PROPS) return false;
  const out = Object.create(null) as Record<string, PropValue>;
  for (const key of keys) {
    if (key.length < 1 || key.length > MAX_PROP_KEY || FORBIDDEN_KEYS.has(key)) return false;
    const val = v[key];
    if (typeof val === 'string') out[key] = val.slice(0, MAX_PROP_STRING);
    else if (typeof val === 'number') {
      if (!Number.isFinite(val)) return false;
      out[key] = val;
    } else if (typeof val === 'boolean' || val === null) out[key] = val;
    else return false;
  }
  return keys.length === 0 ? null : out;
}

function parseMetrics(v: unknown): Array<{ name: VitalMetric; value: number }> | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > VITAL_METRICS.length) return null;
  const seen = new Set<string>();
  const out: Array<{ name: VitalMetric; value: number }> = [];
  for (const m of v) {
    if (!isPlainObject(m)) return null;
    const name = own(m, 'name');
    const value = own(m, 'value');
    if (typeof name !== 'string' || !(VITAL_METRICS as readonly string[]).includes(name) || seen.has(name)) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const max = name === 'CLS' ? 100 : 600_000;
    if (value < 0 || value > max) return null;
    seen.add(name);
    out.push({ name: name as VitalMetric, value });
  }
  return out;
}

/** Validate an ingest body (spec 3.3 / 4.3). Returns null when invalid. */
export function parseIngestPayload(body: unknown): IngestPayload | null {
  if (!isPlainObject(body)) return null;

  const site = own(body, 'site');
  if (typeof site !== 'string' || !SITE_ID_RE.test(site)) return null;

  const type = own(body, 'type');
  if (type !== 'pageview' && type !== 'event' && type !== 'vitals') return null;

  const rawUrl = own(body, 'url');
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_URL) return null;
  const url = parseHttpUrl(rawUrl);
  if (!url) return null;

  const rawRef = own(body, 'referrer');
  let referrer: URL | null = null;
  if (rawRef !== undefined && rawRef !== null) {
    if (typeof rawRef !== 'string') return null;
    if (rawRef !== '' && rawRef.length <= MAX_URL) referrer = parseHttpUrl(rawRef);
  }

  const rawWidth = own(body, 'width');
  let width: number | undefined;
  if (rawWidth !== undefined && rawWidth !== null) {
    if (typeof rawWidth !== 'number' || !Number.isInteger(rawWidth) || rawWidth < 0 || rawWidth > 100_000) return null;
    width = rawWidth;
  }

  const common: Common = { site, url, referrer, width };

  if (type === 'pageview') return { ...common, type };

  if (type === 'event') {
    const rawName = own(body, 'name');
    if (typeof rawName !== 'string') return null;
    const name = rawName.trim();
    if (name.length < 1 || name.length > 100 || CONTROL_RE.test(name)) return null;
    const props = parseProps(own(body, 'props'));
    if (props === false) return null;
    return { ...common, type, name, props };
  }

  const metrics = parseMetrics(own(body, 'metrics'));
  if (!metrics) return null;
  return { ...common, type, metrics };
}
