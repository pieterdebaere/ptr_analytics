// Monitor rows for status-page / metrics tests. The engine owns these tables; tests insert
// rows directly following the column contract in src/uptime/schema/core.ts.
import type { AppContext } from '../src/context.js';

let seq = 0;

export interface MonitorFixture {
  uid?: string;
  name?: string;
  type?: string;
  config?: Record<string, unknown>;
  status?: number;
  latencyMs?: number | null;
  publicId?: string | null;
  active?: boolean;
}

export function insertMonitor(ctx: AppContext, siteId: string, o: MonitorFixture = {}): { id: number; uid: string } {
  const uid = o.uid ?? `mon${String(++seq).padStart(9, '0')}`;
  const now = ctx.now();
  const res = ctx.db
    .prepare(
      `INSERT INTO monitors (uid, site_id, type, name, active, interval_s, retry_interval_s, timeout_ms, config, public_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 60, 60, 10000, ?, ?, ?, ?)`,
    )
    .run(
      uid,
      siteId,
      o.type ?? 'http',
      o.name ?? `Monitor ${seq}`,
      o.active === false ? 0 : 1,
      JSON.stringify(o.config ?? { url: 'https://internal.example.com/health?token=s3cret' }),
      o.publicId ?? null,
      now,
      now,
    );
  const id = Number(res.lastInsertRowid);
  ctx.db
    .prepare('INSERT INTO monitor_state (monitor_id, status, last_check_at, last_change_at, last_latency_ms, last_msg) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, o.status ?? 1, now, now - 3_600_000, o.latencyMs === undefined ? 123 : o.latencyMs, 'secret check message');
  return { id, uid };
}

/** Hourly aggregate row (bucket = UTC hour start, ms). */
export function insertHour(ctx: AppContext, monitorId: number, bucket: number, v: { up?: number; down?: number; pending?: number; maint?: number }): void {
  ctx.db
    .prepare(
      `INSERT INTO monitor_stats_hour (monitor_id, bucket, up_ms, down_ms, pending_ms, maint_ms, checks, lat_n, lat_sum)
       VALUES (?, ?, ?, ?, ?, ?, 60, 60, 6000)`,
    )
    .run(monitorId, bucket, v.up ?? 0, v.down ?? 0, v.pending ?? 0, v.maint ?? 0);
}

export function insertTls(ctx: AppContext, monitorId: number, notAfter: number): void {
  ctx.db.prepare('INSERT INTO monitor_tls (monitor_id, checked_at, valid, not_after) VALUES (?, ?, 1, ?)').run(monitorId, ctx.now(), notAfter);
}

export function insertTag(ctx: AppContext, monitorId: number, name: string, value = '', ownerId: number | null = null): void {
  const uid = `tag${String(++seq).padStart(9, '0')}`;
  const r = ctx.db.prepare('INSERT INTO tags (uid, owner_id, name, color) VALUES (?, ?, ?, ?)').run(uid, ownerId, name, '#ff0000');
  ctx.db.prepare('INSERT INTO monitor_tags (monitor_id, tag_id, value) VALUES (?, ?, ?)').run(monitorId, Number(r.lastInsertRowid), value);
}
