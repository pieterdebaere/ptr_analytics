import { badRequest } from '../lib/errors.js';

/** Allow-list: filter / dimension name -> column name. Never interpolate anything else. */
export const EVENT_COLUMNS = {
  path: 'path',
  hostname: 'hostname',
  referrer: 'referrer',
  country: 'country',
  device: 'device',
  browser: 'browser',
  os: 'os',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_term: 'utm_term',
  utm_content: 'utm_content',
} as const;

export type ColumnFilterKey = keyof typeof EVENT_COLUMNS;
export const COLUMN_FILTER_KEYS = Object.keys(EVENT_COLUMNS) as ColumnFilterKey[];

export const VITALS_COLUMNS = {
  path: 'path',
  hostname: 'hostname',
  country: 'country',
  device: 'device',
  browser: 'browser',
  os: 'os',
} as const;
export type VitalsDimension = keyof typeof VITALS_COLUMNS;

/** value === null means "IS NULL" (filter given with an empty value). */
export interface Filters {
  columns: Array<{ key: ColumnFilterKey; value: string | null }>;
  event?: string | null;
}

export type Query = Record<string, unknown>;

/** Read an optional single string query param (rejects arrays / over-long values). */
export function queryString(q: Query, key: string, maxLen = 1024): string | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > maxLen) throw badRequest(`invalid ${key}`);
  return v;
}

export function parseFilters(q: Query): Filters {
  const columns: Filters['columns'] = [];
  for (const key of COLUMN_FILTER_KEYS) {
    const v = queryString(q, key);
    if (v !== undefined) columns.push({ key, value: v === '' ? null : v });
  }
  const filters: Filters = { columns };
  const ev = queryString(q, 'event');
  if (ev !== undefined) filters.event = ev === '' ? null : ev;
  return filters;
}

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

function eq(col: string, value: string | null, params: unknown[]): string {
  if (value === null) return `${col} IS NULL`;
  params.push(value);
  return `${col} = ?`;
}

/** Column filters (`AND ...`) for the events table under alias `alias`. */
export function columnFilterSql(filters: Filters, alias: string, allowed?: Readonly<Record<string, string>>): SqlFragment {
  const params: unknown[] = [];
  let sql = '';
  for (const { key, value } of filters.columns) {
    const col = (allowed ?? EVENT_COLUMNS)[key];
    if (col === undefined) continue; // not applicable to this table (e.g. utm_* for vitals)
    sql += ` AND ${eq(`${alias}.${col}`, value, params)}`;
  }
  return { sql, params };
}

/**
 * Restrict pageview-based queries to visitors that triggered the `event` filter's custom
 * event within [from, to).
 */
export function eventVisitorSql(filters: Filters, alias: string, siteId: string, from: number, to: number): SqlFragment {
  if (filters.event === undefined) return { sql: '', params: [] };
  const params: unknown[] = [siteId, from, to];
  const cond = eq('x.name', filters.event, params);
  return {
    sql: ` AND ${alias}.visitor_id IN (SELECT x.visitor_id FROM events x WHERE x.site_id = ? AND x.type = 'event' AND x.ts >= ? AND x.ts < ? AND ${cond})`,
    params,
  };
}

/** Pageview filter: columns + event visitor restriction. */
export function pageviewFilterSql(filters: Filters, alias: string, siteId: string, from: number, to: number): SqlFragment {
  const a = columnFilterSql(filters, alias);
  const b = eventVisitorSql(filters, alias, siteId, from, to);
  return { sql: a.sql + b.sql, params: [...a.params, ...b.params] };
}

/** Custom event filter: columns + exact event name. */
export function customEventFilterSql(filters: Filters, alias: string): SqlFragment {
  const a = columnFilterSql(filters, alias);
  if (filters.event === undefined) return a;
  const params = [...a.params];
  const sql = `${a.sql} AND ${eq(`${alias}.name`, filters.event, params)}`;
  return { sql, params };
}

export function parseLimit(q: Query, def = 10, max = 1000): number {
  const v = queryString(q, 'limit', 10);
  if (v === undefined) return def;
  if (!/^\d+$/.test(v)) throw badRequest('invalid limit');
  const n = Number(v);
  if (n < 1 || n > max) throw badRequest('invalid limit');
  return n;
}
