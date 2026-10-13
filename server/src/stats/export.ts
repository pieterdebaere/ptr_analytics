import type Database from 'better-sqlite3';
import type { DB } from '../db/index.js';
import { csvRow } from '../lib/csv.js';
import { columnFilterSql, type Filters } from './filters.js';

export const EXPORT_HEADER = [
  'timestamp',
  'type',
  'name',
  'hostname',
  'path',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'country',
  'device',
  'browser',
  'os',
  'props',
] as const;

/** Rows per keyset page. Each page is a short indexed query (~1 ms on large data sets). */
export const EXPORT_BATCH = 1000;
/** Open cursors per connection; the oldest is dropped beyond this (exports are capped far lower). */
const MAX_OPEN_CURSORS = 16;

interface ExportRow {
  id: number;
  ts: number;
  type: string;
  name: string | null;
  hostname: string;
  path: string;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  country: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  props: string | null;
}

export interface ExportSpec {
  siteId: string;
  from: number;
  to: number;
  filters: Filters;
}

export interface ExportBatch {
  csv: string;
  rows: number;
  done: boolean;
}

interface Cursor {
  stmt: Database.Statement;
  spec: ExportSpec;
  params: unknown[];
  lastTs: number;
  lastId: number;
  done: boolean;
  tempTable: string | null;
}

/**
 * Keyset-paginated CSV export over one connection. The lower time bound of every page is
 * `max(from, lastTs)`, so each page starts where the previous one ended instead of rescanning
 * the range from the beginning; `(ts > lastTs OR (ts = lastTs AND id > lastId))` breaks ties.
 *
 * With an `event` filter, the visitors who triggered the event are materialised once per
 * export into a TEMP table instead of re-running the sub-query for every page.
 */
export class ExportCursors {
  private readonly cursors = new Map<number, Cursor>();
  private nextHandle = 1;

  constructor(
    private readonly db: DB,
    /** Runs fn with TEMP-table writes allowed (worker connections are query_only). */
    private readonly allowTempWrites: <T>(fn: () => T) => T = (fn) => fn(),
  ) {}

  open(spec: ExportSpec): number {
    const handle = this.nextHandle++;
    const cols = columnFilterSql(spec.filters, 'e');
    const params: unknown[] = [...cols.params];
    let sql = `SELECT e.id, e.ts, e.type, e.name, e.hostname, e.path, e.referrer, e.utm_source, e.utm_medium,
         e.utm_campaign, e.utm_term, e.utm_content, e.country, e.device, e.browser, e.os, e.props
       FROM events e
       WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND (e.ts > ? OR (e.ts = ? AND e.id > ?))${cols.sql}`;
    let tempTable: string | null = null;
    if (spec.filters.event !== undefined) {
      // custom events with that name, plus pageviews of visitors that triggered it (spec 4.7)
      tempTable = `export_visitors_${handle}`;
      const name = spec.filters.event;
      const nameCond = name === null ? 'IS NULL' : '= ?';
      const table = tempTable;
      this.allowTempWrites(() => {
        this.db.exec(`CREATE TEMP TABLE ${table} (visitor_id TEXT PRIMARY KEY) WITHOUT ROWID`);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO temp.${table} (visitor_id)
             SELECT x.visitor_id FROM events x
             WHERE x.site_id = ? AND x.type = 'event' AND x.name ${nameCond} AND x.ts >= ? AND x.ts < ?`,
          )
          .run(spec.siteId, ...(name === null ? [] : [name]), spec.from, spec.to);
      });
      sql += ` AND ((e.type = 'event' AND e.name ${nameCond}) OR (e.type = 'pageview' AND e.visitor_id IN (SELECT visitor_id FROM temp.${table})))`;
      if (name !== null) params.push(name);
    }
    sql += ' ORDER BY e.ts, e.id LIMIT ?';
    this.cursors.set(handle, {
      stmt: this.db.prepare(sql),
      spec,
      params,
      lastTs: spec.from - 1,
      lastId: -1,
      done: false,
      tempTable,
    });
    while (this.cursors.size > MAX_OPEN_CURSORS) {
      const oldest = this.cursors.keys().next().value;
      if (oldest === undefined) break;
      this.close(oldest);
    }
    return handle;
  }

  next(handle: number, size = EXPORT_BATCH): ExportBatch {
    const c = this.cursors.get(handle);
    if (!c) throw new Error('export cursor not found');
    if (c.done) return { csv: '', rows: 0, done: true };
    const { spec } = c;
    const rows = c.stmt.all(
      spec.siteId,
      Math.max(spec.from, c.lastTs),
      spec.to,
      c.lastTs,
      c.lastTs,
      c.lastId,
      ...c.params,
      size,
    ) as ExportRow[];
    let csv = '';
    for (const r of rows) {
      csv += csvRow([
        new Date(r.ts).toISOString(),
        r.type,
        r.name,
        r.hostname,
        r.path,
        r.referrer,
        r.utm_source,
        r.utm_medium,
        r.utm_campaign,
        r.utm_term,
        r.utm_content,
        r.country,
        r.device,
        r.browser,
        r.os,
        r.props,
      ]);
    }
    const last = rows[rows.length - 1];
    if (last) {
      c.lastTs = last.ts;
      c.lastId = last.id;
    }
    if (rows.length < size) {
      c.done = true;
      this.close(handle);
    }
    return { csv, rows: rows.length, done: c.done };
  }

  close(handle: number): void {
    const c = this.cursors.get(handle);
    if (!c) return;
    this.cursors.delete(handle);
    const table = c.tempTable;
    if (table !== null && this.db.open) {
      try {
        this.allowTempWrites(() => this.db.exec(`DROP TABLE IF EXISTS temp.${table}`));
      } catch {
        // connection closing; TEMP tables die with it
      }
    }
  }
}
