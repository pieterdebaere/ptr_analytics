// Public status page JSON (docs/SPEC.md §8.4). Data minimisation: no internal ids (monitor ids
// are opaque per page), no targets unless "show URL" is on for an http(s) monitor, no check
// messages, no site ids except the analytics site the owner chose to expose.
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { statusName } from '../types.js';
import {
  certDaysLeft,
  dailyBars,
  maintenanceForPage,
  monitorsByIds,
  publicMonitorUrl,
  tagsFor,
  type DayBar,
  type MaintenanceWindow,
  type TagInfo,
} from './data.js';
import { assetUrl, publicIncidents, sectionsOf, type PageRow } from './store.js';
import type { IncidentStyle, Theme } from './validate.js';

export const BAR_DAYS = 90;

export type PublicMonitorStatus = 'up' | 'down' | 'pending' | 'maintenance' | 'unknown' | 'paused';
export type OverallStatus = 'up' | 'degraded' | 'down' | 'maintenance' | 'unknown';

export interface PublicMonitor {
  id: string;
  name: string;
  status: PublicMonitorStatus;
  uptime90d: number | null;
  bars: DayBar[];
  url?: string;
  certDaysLeft?: number | null;
  tags?: TagInfo[];
}

export interface PublicIncident {
  id: string;
  title: string;
  body: string;
  style: IncidentStyle;
  pinned: boolean;
  createdAt: number;
  updatedAt: number | null;
  resolvedAt: number | null;
}

export interface PublicStatus {
  slug: string;
  title: string;
  description: string | null;
  footer: string | null;
  theme: Theme;
  accent: string | null;
  logoUrl: string | null;
  showPoweredBy: boolean;
  noindex: boolean;
  refreshS: number;
  tz: string;
  analytics: { siteId: string; scriptUrl: string } | null;
  /** The site is suspended (hosted mode): checks are paused, the last known state is shown. */
  paused: boolean;
  overall: OverallStatus;
  sections: Array<{ name: string; monitors: PublicMonitor[] }>;
  incidents: PublicIncident[];
  maintenance: MaintenanceWindow[];
  updatedAt: number;
}

/** Stable, opaque id of a monitor on one page (not reversible to the monitor uid). */
export function opaqueMonitorId(pageUid: string, monitorUid: string): string {
  return createHash('sha256').update(`status-page\n${pageUid}\n${monitorUid}`).digest('base64url').slice(0, 16);
}

export function overallStatus(statuses: readonly PublicMonitorStatus[]): OverallStatus {
  const counted = statuses.filter((s) => s !== 'unknown' && s !== 'paused');
  if (counted.length === 0) return 'unknown';
  const up = counted.filter((s) => s === 'up').length;
  const down = counted.filter((s) => s === 'down').length;
  const pending = counted.filter((s) => s === 'pending').length;
  const maint = counted.filter((s) => s === 'maintenance').length;
  if (down > 0) return up === 0 && pending === 0 && maint === 0 ? 'down' : 'degraded';
  if (pending > 0) return 'degraded';
  if (maint > 0) return 'maintenance';
  return 'up';
}

export function buildPublicStatus(ctx: AppContext, page: PageRow): PublicStatus {
  const db = ctx.db;
  const now = ctx.now();
  const site = ctx.sites.byId(page.site_id);
  const sections = sectionsOf(db, page.id);
  const ids = [...new Set(sections.flatMap((s) => s.monitors.map((m) => m.monitorId)))];
  const infos = monitorsByIds(db, ids);
  const bars = dailyBars(db, ids, page.tz, BAR_DAYS, now);
  const certs = page.show_cert_expiry === 1 ? certDaysLeft(db, ids, now) : null;
  const tags = page.show_tags === 1 ? tagsFor(db, ids) : null;
  const statuses: PublicMonitorStatus[] = [];
  const outSections = sections.map((sec) => ({
    name: sec.name,
    monitors: sec.monitors.flatMap((sm): PublicMonitor[] => {
      const info = infos.get(sm.monitorId);
      if (!info) return [];
      const status: PublicMonitorStatus = info.active ? statusName(info.status) : 'paused';
      statuses.push(status);
      const b = bars.get(sm.monitorId);
      const m: PublicMonitor = {
        id: opaqueMonitorId(page.uid, info.uid),
        name: sm.displayName ?? info.name,
        status,
        uptime90d: b?.uptime ?? null,
        bars: b?.bars ?? [],
      };
      if (sm.showUrl) {
        const url = publicMonitorUrl(info.config);
        if (url) m.url = url;
      }
      if (certs) m.certDaysLeft = certs.get(sm.monitorId) ?? null;
      if (tags) m.tags = tags.get(sm.monitorId) ?? [];
      return [m];
    }),
  }));
  const analyticsSite = page.analytics_site_id ? ctx.sites.byId(page.analytics_site_id) : null;
  return {
    slug: page.slug,
    title: page.title,
    description: page.description,
    footer: page.footer,
    theme: page.theme,
    accent: page.accent,
    logoUrl: assetUrl(page.logo_asset),
    showPoweredBy: page.show_powered_by === 1,
    noindex: page.noindex === 1,
    refreshS: page.refresh_s,
    tz: page.tz,
    // Same-origin path: the page may be served on PUBLIC_URL or on a custom domain of this
    // server, and the status page CSP only allows scripts from 'self'.
    analytics: analyticsSite ? { siteId: analyticsSite.id, scriptUrl: '/script.js' } : null,
    paused: site?.suspended ?? false,
    overall: overallStatus(statuses),
    sections: outSections,
    incidents: publicIncidents(db, page.id).map((i) => ({
      id: i.uid,
      title: i.title,
      body: i.body,
      style: i.style,
      pinned: i.pinned === 1,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      resolvedAt: i.resolved_at,
    })),
    maintenance: maintenanceForPage(db, page.id, ids, now),
    updatedAt: now,
  };
}
