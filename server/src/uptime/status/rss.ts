// RSS 2.0 feed of a status page: incidents and confirmed outages. Every value is XML-escaped
// (Kuma GHSA-9fg7-wgm7-57fh: stored XSS via an RSS feed served without a proper type).
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { escapeXml } from './badge.js';
import { monitorsByIds, recentOutages } from './data.js';
import { opaqueIncidentId, opaqueMonitorId } from './render.js';
import { incidentsOf, sectionsOf, type PageRow } from './store.js';

const DAY = 86_400_000;

// eslint-disable-next-line no-control-regex
const XML_INVALID_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Escape for XML text content, dropping characters XML 1.0 cannot carry. */
export function xmlText(s: string): string {
  return escapeXml(s.replace(XML_INVALID_RE, ''));
}

function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

/** Opaque item guid: stable per item version, no internal ids. */
const guidOf = (parts: string): string => createHash('sha256').update(parts).digest('base64url').slice(0, 22);

export function buildFeed(ctx: AppContext, page: PageRow): string {
  const now = ctx.now();
  const base = ctx.config.statusPageOrigin ?? ctx.config.publicUrl ?? '';
  const link = `${base}/status/${page.slug}`;
  const items: Array<{ title: string; description: string; ts: number; guid: string }> = [];
  for (const i of incidentsOf(ctx.db, page.id, 20)) {
    items.push({
      title: `${i.resolved_at ? '[Resolved] ' : ''}${i.title}`,
      description: i.body,
      ts: i.updated_at ?? i.created_at,
      guid: `incident-${guidOf(`${opaqueIncidentId(page.uid, i.uid)}\n${i.updated_at ?? i.created_at}`)}`,
    });
  }
  const sections = sectionsOf(ctx.db, page.id);
  const names = new Map<number, string>();
  const opaque = new Map<number, string>();
  for (const s of sections) {
    for (const m of s.monitors) {
      names.set(m.monitorId, m.displayName ?? m.name);
      opaque.set(m.monitorId, opaqueMonitorId(page.uid, m.uid));
    }
  }
  const infos = monitorsByIds(ctx.db, [...names.keys()]);
  for (const o of recentOutages(ctx.db, [...names.keys()], now - 30 * DAY, 20)) {
    if (!infos.has(o.monitorId)) continue;
    const name = names.get(o.monitorId) ?? 'Service';
    items.push({
      title: o.endedAt ? `${name} was down for ${duration(o.endedAt - o.startedAt)}` : `${name} is down`,
      description: o.endedAt
        ? `${name} was unavailable from ${new Date(o.startedAt).toUTCString()} to ${new Date(o.endedAt).toUTCString()}.`
        : `${name} has been unavailable since ${new Date(o.startedAt).toUTCString()}.`,
      ts: o.endedAt ?? o.startedAt,
      guid: `outage-${guidOf(`${opaque.get(o.monitorId) ?? ''}\n${o.startedAt}\n${o.endedAt ?? 'open'}`)}`,
    });
  }
  items.sort((a, b) => b.ts - a.ts);
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '<channel>',
    `<title>${xmlText(page.title)}</title>`,
    `<link>${xmlText(link)}</link>`,
    `<description>${xmlText(`Incidents and outages — ${page.title}`)}</description>`,
    `<lastBuildDate>${new Date(now).toUTCString()}</lastBuildDate>`,
    '<ttl>5</ttl>',
  ];
  for (const it of items.slice(0, 30)) {
    out.push(
      '<item>',
      `<title>${xmlText(it.title)}</title>`,
      `<link>${xmlText(link)}</link>`,
      `<description>${xmlText(it.description)}</description>`,
      `<pubDate>${new Date(it.ts).toUTCString()}</pubDate>`,
      `<guid isPermaLink="false">${xmlText(it.guid)}</guid>`,
      '</item>',
    );
  }
  out.push('</channel>', '</rss>', '');
  return out.join('\n');
}
