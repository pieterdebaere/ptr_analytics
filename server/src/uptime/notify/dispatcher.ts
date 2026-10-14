// Outbox dispatcher (docs/uptime/ANALYSIS.md §8.4). The engine inserts notify_outbox rows in
// the same transaction as the monitor event; this loop delivers them:
//
// * polls due rows in small batches; per channel strictly in order (only the oldest row of a
//   channel is eligible, so a DOWN retry is never overtaken by the following UP), 8 deliveries
//   in flight overall and 1 per channel;
// * retries transient failures (network, timeout, 5xx, 408, 429) after 30 s, 2 min and 10 min,
//   honouring Retry-After; other 4xx answers fail at once;
// * logs every attempt in notify_log (redacted error ≤ 300 chars), counts consecutive final
//   failures per channel and disables a channel after 10 (warning in the server log);
// * members: at most MEMBER_NOTIFY_PER_HOUR deliveries per hour (beyond: dropped + logged);
// * skips inactive / deleted channels and e-mail channels without confirmed recipients;
// * housekeeping: notify_log retention (30 days), orphaned rows, purged channels — chunked.
// All I/O is async; database work per row is a handful of indexed statements.
import type { AppContext } from '../../context.js';
import type { NotifyPayload } from '../types.js';
import { AUTO_DISABLE_AFTER, openSecrets, type ChannelRow } from './channels.js';
import { deliver, savedTarget, type DeliverResult } from './deliver.js';
import { deliveryRecipients } from './email.js';
import { redactError } from './redact.js';
import { PROVIDERS } from './providers/registry.js';
import { isHosted, notifyState } from './state.js';

export interface NotifierHandle {
  stop(): Promise<void>;
}

export interface NotifierOptions {
  pollMs?: number;
  concurrency?: number;
  batch?: number;
  /** Per delivery attempt. */
  timeoutMs?: number;
  housekeepingMs?: number;
  /** Start the timers (default true); tests drive `runOnce()` instead. */
  autoStart?: boolean;
}

/** Delays before retry 1, 2, 3. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
export const LOG_RETENTION_MS = 30 * 86_400_000;
const CHUNK = 2000;

interface OutboxRow {
  id: number;
  channel_id: number;
  monitor_id: number | null;
  event: string;
  payload: string;
  attempts: number;
  next_attempt_at: number;
}

type ChannelWithOwner = ChannelRow & { owner_role: string | null };

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

function parsePayload(raw: string): NotifyPayload | null {
  try {
    const v = JSON.parse(raw) as NotifyPayload;
    return v && typeof v === 'object' && typeof v.event === 'string' ? v : null;
  } catch {
    return null;
  }
}

export class Notifier implements NotifierHandle {
  private readonly inflightChannels = new Set<number>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly stopController = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private housekeepingTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking = false;
  private readonly pollMs: number;
  private readonly concurrency: number;
  private readonly batch: number;
  private readonly timeoutMs: number | undefined;
  private readonly housekeepingMs: number;

  constructor(
    private readonly ctx: AppContext,
    opts: NotifierOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 1000;
    this.concurrency = opts.concurrency ?? 8;
    this.batch = opts.batch ?? 32;
    this.timeoutMs = opts.timeoutMs;
    this.housekeepingMs = opts.housekeepingMs ?? 3_600_000;
  }

  start(): void {
    const loop = (): void => {
      if (this.stopped) return;
      this.tick();
      this.timer = setTimeout(loop, this.pollMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(loop, Math.min(this.pollMs, 1000));
    this.timer.unref?.();
    const hk = (): void => {
      if (this.stopped) return;
      this.housekeeping().catch((err: unknown) => this.ctx.log.error({ err: redactError(err) }, 'notification housekeeping failed'));
      this.housekeepingTimer = setTimeout(hk, this.housekeepingMs);
      this.housekeepingTimer.unref?.();
    };
    this.housekeepingTimer = setTimeout(hk, 60_000);
    this.housekeepingTimer.unref?.();
  }

  /** Claim due rows up to the free capacity and start delivering them (returns how many started). */
  tick(): number {
    if (this.stopped || this.ticking) return 0;
    this.ticking = true;
    let started = 0;
    try {
      const free = this.concurrency - this.inflight.size;
      if (free <= 0) return 0;
      const rows = this.ctx.db
        .prepare(
          `SELECT o.id, o.channel_id, o.monitor_id, o.event, o.payload, o.attempts, o.next_attempt_at FROM notify_outbox o
           WHERE o.next_attempt_at <= ? AND o.id = (SELECT min(i.id) FROM notify_outbox i WHERE i.channel_id = o.channel_id)
           ORDER BY o.next_attempt_at, o.id LIMIT ?`,
        )
        .all(this.ctx.now(), this.batch) as OutboxRow[];
      for (const row of rows) {
        if (started >= free) break;
        if (this.inflightChannels.has(row.channel_id)) continue;
        this.inflightChannels.add(row.channel_id);
        const p = this.process(row)
          .catch((err: unknown) => this.ctx.log.error({ err: redactError(err) }, 'notification delivery crashed'))
          .finally(() => {
            this.inflightChannels.delete(row.channel_id);
            this.inflight.delete(p);
            // Fill the freed slot right away (next row of this channel, or another channel).
            if (!this.stopped && this.timer !== null) setImmediate(() => this.tick());
          });
        this.inflight.add(p);
        started++;
      }
    } catch (err) {
      this.ctx.log.error({ err: redactError(err) }, 'notification outbox poll failed');
    } finally {
      this.ticking = false;
    }
    return started;
  }

  /** Deliver everything that is due now (tests): repeats until no due row is left. */
  async runOnce(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = this.tick();
      total += n;
      if (this.inflight.size === 0) {
        if (n === 0) return total;
        continue;
      }
      await Promise.race(this.inflight);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.housekeepingTimer) clearTimeout(this.housekeepingTimer);
    this.timer = null;
    // Give running deliveries a moment, then abort them (they stay in the outbox and are retried after a restart).
    let t: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise<void>((r) => (t = setTimeout(r, 2000)))]);
    clearTimeout(t);
    this.stopController.abort();
    await Promise.allSettled([...this.inflight]);
  }

  private log(row: OutboxRow, ok: boolean, httpStatus: number | null, error: string | null): void {
    this.ctx.db
      .prepare('INSERT INTO notify_log (channel_id, monitor_id, ts, event, ok, http_status, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.channel_id, row.monitor_id, this.ctx.now(), row.event, ok ? 1 : 0, httpStatus, error === null ? null : redactError(error));
  }

  private drop(row: OutboxRow): void {
    this.ctx.db.prepare('DELETE FROM notify_outbox WHERE id = ?').run(row.id);
  }

  private async process(row: OutboxRow): Promise<void> {
    const ctx = this.ctx;
    const channel = ctx.db
      .prepare('SELECT c.*, u.role AS owner_role FROM notify_channels c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?')
      .get(row.channel_id) as ChannelWithOwner | undefined;
    if (!channel || channel.deleted_at !== null || channel.active !== 1 || (channel.owner_id !== null && channel.owner_role === null)) {
      this.drop(row);
      return;
    }
    const provider = PROVIDERS.get(channel.type);
    const payload = parsePayload(row.payload);
    if (!provider || !payload) {
      this.drop(row);
      this.log(row, false, null, provider ? 'invalid notification payload' : 'unknown channel type');
      return;
    }
    const hostedMember = isHosted(ctx) && channel.owner_role === 'member';
    if (channel.owner_role === 'member' && row.attempts === 0) {
      const st = notifyState(ctx);
      if (!st.memberHourly.hit(String(channel.owner_id))) {
        this.drop(row);
        this.log(row, false, null, 'hourly delivery limit reached (MEMBER_NOTIFY_PER_HOUR), notification dropped');
        if (st.capWarned.hit(String(channel.owner_id))) {
          ctx.log.warn({ userId: channel.owner_id }, 'member reached the hourly notification limit; further notifications are dropped');
        }
        return;
      }
    }
    if (provider.id === 'email' && deliveryRecipients(ctx, channel).length === 0) {
      this.drop(row);
      this.log(row, false, null, 'skipped: no confirmed recipients');
      return;
    }
    let secrets: Record<string, string>;
    try {
      secrets = openSecrets(ctx, channel);
    } catch {
      this.drop(row);
      this.log(row, false, null, 'cannot decrypt the channel secrets (SECRETS_KEY changed?)');
      this.finalFailure(channel);
      return;
    }

    const result = await deliver(ctx, savedTarget(provider, channel, secrets, hostedMember), payload, {
      deliveryId: `${channel.uid}-${row.id}`,
      stopSignal: this.stopController.signal,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
    if (this.stopped && !result.ok && this.stopController.signal.aborted) return; // aborted by shutdown: keep the row
    this.settle(row, channel, result);
  }

  private settle(row: OutboxRow, channel: ChannelRow, r: DeliverResult): void {
    const ctx = this.ctx;
    if (r.ok) {
      ctx.db.transaction(() => {
        this.drop(row);
        this.log(row, true, r.httpStatus, null);
        if (channel.consecutive_failures !== 0) ctx.db.prepare('UPDATE notify_channels SET consecutive_failures = 0 WHERE id = ?').run(channel.id);
      })();
      return;
    }
    const attempt = row.attempts + 1;
    if (r.retryable && attempt <= RETRY_DELAYS_MS.length) {
      const delay = Math.max(RETRY_DELAYS_MS[attempt - 1] as number, r.retryAfterMs ?? 0);
      ctx.db.transaction(() => {
        ctx.db.prepare('UPDATE notify_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?').run(attempt, ctx.now() + delay, row.id);
        this.log(row, false, r.httpStatus, `${r.error ?? 'failed'} (retry ${attempt}/${RETRY_DELAYS_MS.length} in ${Math.round(delay / 1000)}s)`);
      })();
      return;
    }
    ctx.db.transaction(() => {
      this.drop(row);
      this.log(row, false, r.httpStatus, r.error);
    })();
    this.finalFailure(channel);
  }

  private finalFailure(channel: ChannelRow): void {
    const ctx = this.ctx;
    const updated = ctx.db
      .prepare(
        `UPDATE notify_channels SET consecutive_failures = consecutive_failures + 1,
           active = CASE WHEN consecutive_failures + 1 >= ? THEN 0 ELSE active END
         WHERE id = ? RETURNING consecutive_failures, active`,
      )
      .get(AUTO_DISABLE_AFTER, channel.id) as { consecutive_failures: number; active: number } | undefined;
    if (updated && updated.active === 0 && updated.consecutive_failures === AUTO_DISABLE_AFTER) {
      ctx.log.warn({ channel: channel.uid, type: channel.type }, `notification channel disabled after ${AUTO_DISABLE_AFTER} consecutive failed deliveries`);
    }
  }

  /** Retention + orphan cleanup in small chunks, yielding between them. */
  async housekeeping(): Promise<void> {
    const db = this.ctx.db;
    const now = this.ctx.now();
    const loop = async (sql: string, ...args: unknown[]): Promise<void> => {
      for (let i = 0; i < 1000 && !this.stopped; i++) {
        if (db.prepare(sql).run(...args).changes === 0) return;
        await yieldToLoop();
      }
    };
    await loop(`DELETE FROM notify_log WHERE id IN (SELECT id FROM notify_log WHERE ts < ? LIMIT ${CHUNK})`, now - LOG_RETENTION_MS);
    const dead = `SELECT id FROM notify_channels WHERE deleted_at IS NULL`;
    await loop(`DELETE FROM notify_outbox WHERE id IN (SELECT id FROM notify_outbox WHERE channel_id NOT IN (${dead}) LIMIT ${CHUNK})`);
    await loop(
      `DELETE FROM monitor_channels WHERE channel_id IN (SELECT DISTINCT channel_id FROM monitor_channels WHERE channel_id NOT IN (${dead}) LIMIT 20)`,
    );
    await loop(`DELETE FROM notify_log WHERE id IN (SELECT id FROM notify_log WHERE channel_id NOT IN (${dead}) LIMIT ${CHUNK})`);
    // Soft-deleted channels whose log rows are gone can go for good.
    db.prepare(`DELETE FROM notify_channels WHERE deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM notify_log l WHERE l.channel_id = notify_channels.id)`).run();
    db.prepare('UPDATE notify_email_recipients SET verify_token_hash = NULL, verify_expires_at = NULL WHERE verify_expires_at < ?').run(now);
  }
}

/** Start the outbox dispatcher (only when background jobs run). */
export function startNotifier(ctx: AppContext, opts: NotifierOptions = {}): Notifier {
  const n = new Notifier(ctx, opts);
  if (opts.autoStart !== false) n.start();
  return n;
}

