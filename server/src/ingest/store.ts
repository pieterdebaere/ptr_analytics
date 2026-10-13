import type { DB } from '../db/index.js';
import { randomHex } from '../lib/ids.js';
import type { ParsedUA } from '../lib/ua.js';
import type { IngestPayload } from './payload.js';

const SESSION_TIMEOUT_MS = 30 * 60_000;
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function cleanHost(h: string): string {
  let v = h.toLowerCase();
  if (v.endsWith('.')) v = v.slice(0, -1);
  return v;
}

const stripWww = (h: string): string => (h.startsWith('www.') ? h.slice(4) : h);

export interface PageContext {
  hostname: string;
  path: string;
  referrer: string | null;
  utm: Record<(typeof UTM_KEYS)[number], string | null>;
}

/** Extract the privacy-preserving page context from the URL / referrer (spec section 2). */
export function pageContext(payload: IngestPayload): PageContext {
  const hostname = truncate(cleanHost(payload.url.hostname), 253);
  const path = truncate(payload.url.pathname || '/', 1024);
  let referrer: string | null = null;
  if (payload.referrer) {
    const refHost = stripWww(cleanHost(payload.referrer.hostname));
    if (refHost !== '' && refHost !== stripWww(hostname)) referrer = truncate(refHost, 253);
  }
  const utm = {} as PageContext['utm'];
  for (const k of UTM_KEYS) {
    const v = payload.url.searchParams.get(k)?.trim();
    utm[k] = v ? truncate(v, 256) : null;
  }
  return { hostname, path, referrer, utm };
}

export interface Visitor {
  visitorId: string;
  country: string | null;
  ua: ParsedUA;
}

/** Writes ingested data: sessions + events, or vitals. */
export class IngestStore {
  private readonly findSession;
  private readonly touchSession;
  private readonly insertSession;
  private readonly insertEvent;
  private readonly insertVital;
  private readonly writeEventTx;
  private readonly writeVitalsTx;

  constructor(db: DB) {
    this.findSession = db.prepare(
      `SELECT id FROM sessions WHERE site_id = ? AND visitor_id = ? AND last_seen_at >= ?
       ORDER BY last_seen_at DESC LIMIT 1`,
    );
    this.touchSession = db.prepare(
      'UPDATE sessions SET last_seen_at = MAX(last_seen_at, ?), pageviews = pageviews + ? WHERE id = ?',
    );
    this.insertSession = db.prepare(
      'INSERT INTO sessions (id, site_id, visitor_id, started_at, last_seen_at, pageviews) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.insertEvent = db.prepare(
      `INSERT INTO events (site_id, ts, type, name, visitor_id, session_id, hostname, path, referrer,
         utm_source, utm_medium, utm_campaign, utm_term, utm_content, country, device, browser, os, props)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertVital = db.prepare(
      `INSERT INTO vitals (site_id, ts, metric, value, hostname, path, country, device, browser, os)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.writeEventTx = db.transaction(
      (payload: Exclude<IngestPayload, { type: 'vitals' }>, ctx: PageContext, v: Visitor, now: number) => {
        const pv = payload.type === 'pageview' ? 1 : 0;
        const existing = this.findSession.get(payload.site, v.visitorId, now - SESSION_TIMEOUT_MS) as { id: string } | undefined;
        let sessionId: string;
        if (existing) {
          sessionId = existing.id;
          this.touchSession.run(now, pv, sessionId);
        } else {
          sessionId = randomHex(16);
          this.insertSession.run(sessionId, payload.site, v.visitorId, now, now, pv);
        }
        const name = payload.type === 'event' ? payload.name : null;
        const props = payload.type === 'event' && payload.props ? JSON.stringify(payload.props) : null;
        this.insertEvent.run(
          payload.site,
          now,
          payload.type,
          name,
          v.visitorId,
          sessionId,
          ctx.hostname,
          ctx.path,
          ctx.referrer,
          ctx.utm.utm_source,
          ctx.utm.utm_medium,
          ctx.utm.utm_campaign,
          ctx.utm.utm_term,
          ctx.utm.utm_content,
          v.country,
          v.ua.device,
          v.ua.browser,
          v.ua.os,
          props,
        );
      },
    );

    this.writeVitalsTx = db.transaction(
      (payload: Extract<IngestPayload, { type: 'vitals' }>, ctx: PageContext, v: Visitor, now: number) => {
        for (const m of payload.metrics) {
          this.insertVital.run(payload.site, now, m.name, m.value, ctx.hostname, ctx.path, v.country, v.ua.device, v.ua.browser, v.ua.os);
        }
      },
    );
  }

  write(payload: IngestPayload, visitor: Visitor, now: number): void {
    const ctx = pageContext(payload);
    if (payload.type === 'vitals') this.writeVitalsTx(payload, ctx, visitor, now);
    else this.writeEventTx(payload, ctx, visitor, now);
  }
}
