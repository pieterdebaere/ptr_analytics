// Typed client for status pages, incidents (authenticated, docs/SPEC.md §8.3) and the
// public status page JSON (no auth, §8.4). Everything coming back is parsed defensively;
// strings stay untrusted (displayText / SafeMarkdown), URLs are validated before use.
import { ApiError, request } from './client';
import { safeColor, statusName, type DisplayStatus } from './uptime';

export type StatusTheme = 'auto' | 'light' | 'dark';
export const STATUS_THEMES: readonly StatusTheme[] = ['auto', 'light', 'dark'];

export type IncidentStyle = 'info' | 'warning' | 'danger' | 'success' | 'neutral';
export const INCIDENT_STYLES: readonly IncidentStyle[] = ['info', 'warning', 'danger', 'success', 'neutral'];

export interface StatusSectionMonitor {
  uid: string;
  displayName: string | null;
  showUrl: boolean;
}

export interface StatusSection {
  name: string;
  monitors: StatusSectionMonitor[];
}

export interface StatusDomain {
  domain: string;
  verified: boolean;
  verifyToken: string;
  /** DNS name of the TXT record (`_ptr-status.<domain>`). */
  txtName: string;
  /** Unverified claims are dropped at this time (7 days after they were added); null once verified. */
  expiresAt: number | null;
}

export interface StatusPage {
  uid: string;
  siteId: string;
  slug: string;
  title: string;
  description: string;
  footer: string;
  theme: StatusTheme;
  accent: string | null;
  published: boolean;
  noindex: boolean;
  showTags: boolean;
  showCertExpiry: boolean;
  showPoweredBy: boolean;
  refreshS: number;
  analyticsSiteId: string | null;
  logoUrl: string | null;
  /**
   * Absolute URL of the public page (on STATUS_PAGE_ORIGIN when the server has one), or null
   * when the server sent none / only a path.
   */
  publicUrl: string | null;
  sections: StatusSection[];
  domains: StatusDomain[];
}

export interface StatusPageInput {
  slug?: string;
  title?: string;
  description?: string;
  footer?: string;
  theme?: StatusTheme;
  accent?: string | null;
  published?: boolean;
  noindex?: boolean;
  showTags?: boolean;
  showCertExpiry?: boolean;
  showPoweredBy?: boolean;
  refreshS?: number;
  analyticsSiteId?: string | null;
  sections?: StatusSection[];
  /** Custom domain names; the server keeps tokens/verification of existing ones. */
  domains?: string[];
}

export interface Incident {
  uid: string;
  title: string;
  body: string;
  style: IncidentStyle;
  pinned: boolean;
  createdAt: number | null;
  updatedAt: number | null;
  resolvedAt: number | null;
}

export interface IncidentInput {
  title?: string;
  body?: string;
  style?: IncidentStyle;
  pinned?: boolean;
  /** true resolves now, false re-opens. */
  resolved?: boolean;
}

/* ---------------------------------------------------------------- public JSON */

export type OverallStatus = 'up' | 'degraded' | 'down' | 'maintenance' | 'unknown';

export interface PublicBar {
  t: number;
  upRatio: number | null;
  maintenance: boolean;
}

export interface PublicTag {
  name: string;
  color: string;
  value: string | null;
}

export interface PublicMonitor {
  id: string;
  name: string;
  /** up | down | pending | maintenance | unknown | paused */
  status: DisplayStatus;
  uptime90d: number | null;
  bars: PublicBar[];
  url: string | null;
  certDaysLeft: number | null;
  tags: PublicTag[];
}

export interface PublicSection {
  name: string;
  monitors: PublicMonitor[];
}

export interface PublicIncident {
  id: string;
  title: string;
  body: string;
  style: IncidentStyle;
  pinned: boolean;
  createdAt: number | null;
  updatedAt: number | null;
  resolvedAt: number | null;
}

export interface PublicMaintenance {
  title: string;
  description: string;
  start: number | null;
  end: number | null;
  status: string;
}

export interface PublicStatus {
  title: string;
  description: string;
  footer: string;
  theme: StatusTheme;
  accent: string | null;
  logoUrl: string | null;
  showPoweredBy: boolean;
  noindex: boolean;
  refreshS: number;
  /** IANA time zone of the daily bars (validated), or null. */
  tz: string | null;
  /** The site is suspended: monitoring is paused. */
  paused: boolean;
  analytics: { siteId: string; scriptUrl: string } | null;
  overall: OverallStatus;
  sections: PublicSection[];
  incidents: PublicIncident[];
  maintenance: PublicMaintenance[];
  updatedAt: number | null;
}

/* ------------------------------------------------------------------ helpers */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const notNull = <T>(v: T | null): v is T => v !== null;

/** Same rules as the server (uptime/status/validate.ts). */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const SLUG_MAX = 64;
const RESERVED_SLUGS = new Set(
  (
    'api admin administrator status statuses login logout signin signup register assets static public dashboard settings account accounts ' +
    'billing verify reset auth oauth sso metrics healthz health uptime-bot uptime script script-js app www mail email help support docs doc ' +
    'about feed rss new edit default sites site monitors monitor incidents incident maintenance maintenances security root system null ' +
    'undefined favicon-ico robots-txt index home ptr ptr-analytics official'
  ).split(' '),
);

/** Problem with a slug, or null when it is valid. */
export function slugError(slug: string): string | null {
  if (!slug) return 'Enter a slug.';
  if (slug.length > SLUG_MAX) return `At most ${SLUG_MAX} characters.`;
  if (!SLUG_RE.test(slug)) return 'Use lower-case letters, digits and hyphens (not at the start or end).';
  if (RESERVED_SLUGS.has(slug)) return 'This slug is reserved. Choose another one.';
  return null;
}

/** Slug suggestion from a title ("ACME Status!" → "acme-status"). */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
export function safeAccent(v: unknown): string | null {
  return typeof v === 'string' && ACCENT_RE.test(v) ? v.toLowerCase() : null;
}

/**
 * Same-origin asset path (e.g. the uploaded logo): "/…" without "//", backslashes,
 * whitespace, control characters or dot segments; absolute URLs only for this origin.
 */
export function safeAssetUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) return null;
  let path = v;
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (typeof window === 'undefined' || u.origin !== window.location.origin) return null;
      path = u.pathname + u.search;
    } catch {
      return null;
    }
  }
  if (!/^\/(?!\/)[A-Za-z0-9._~\-/?=&%]*$/.test(path)) return null;
  const p = path.split('?', 1)[0] ?? '';
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return path;
}

/** Link target for a public monitor ("show URL"): http(s) only. */
export function safeHttpUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f\\]/.test(v)) return null;
  try {
    const u = new URL(v);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * The tracker script for a status page must be our own `/script.js` (CSP script-src 'self').
 * Returns the same-origin path or null.
 */
export function safeTrackerScript(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 512) return null;
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const u = new URL(v, base);
    if (u.origin !== base || u.pathname !== '/script.js' || u.search || u.hash) return null;
    if (!/^(?:\/script\.js|https?:\/\/[^/]+\/script\.js)$/.test(v)) return null;
    return '/script.js';
  } catch {
    return null;
  }
}

const DISPLAY_STATUSES: readonly DisplayStatus[] = ['up', 'down', 'pending', 'maintenance', 'unknown', 'paused'];

/** Public monitor status: a name ("up", "paused" …) or a numeric status code. */
export function publicMonitorStatus(v: unknown): DisplayStatus {
  if (typeof v === 'number') return statusName(v);
  return (DISPLAY_STATUSES as readonly unknown[]).includes(v) ? (v as DisplayStatus) : 'unknown';
}

function timeZone(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(v)) return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: v });
    return v;
  } catch {
    return null;
  }
}

function theme(v: unknown): StatusTheme {
  return v === 'light' || v === 'dark' ? v : 'auto';
}

function incidentStyle(v: unknown): IncidentStyle {
  return (INCIDENT_STYLES as readonly unknown[]).includes(v) ? (v as IncidentStyle) : 'info';
}

export const REFRESH_MIN_S = 30;
export const REFRESH_MAX_S = 3600;

function refresh(v: unknown): number {
  const n = numOrNull(v);
  if (n === null) return 60;
  return Math.min(REFRESH_MAX_S, Math.max(REFRESH_MIN_S, Math.round(n)));
}

/* ------------------------------------------------------------- authenticated */

export function parseStatusPage(raw: unknown): StatusPage | null {
  if (!isObj(raw) || typeof raw.uid !== 'string' || !raw.uid) return null;
  return {
    uid: raw.uid,
    siteId: str(raw.siteId),
    slug: str(raw.slug),
    title: str(raw.title, raw.uid),
    description: str(raw.description),
    footer: str(raw.footer),
    theme: theme(raw.theme),
    accent: safeAccent(raw.accent),
    published: raw.published === true,
    noindex: raw.noindex === true,
    showTags: raw.showTags === true,
    showCertExpiry: raw.showCertExpiry === true,
    showPoweredBy: raw.showPoweredBy !== false,
    refreshS: refresh(raw.refreshS),
    analyticsSiteId: typeof raw.analyticsSiteId === 'string' && raw.analyticsSiteId ? raw.analyticsSiteId : null,
    logoUrl: safeAssetUrl(raw.logoUrl),
    publicUrl: safeHttpUrl(raw.publicUrl),
    sections: arr(raw.sections)
      .filter(isObj)
      .map((s) => ({
        name: str(s.name),
        monitors: arr(s.monitors)
          .filter(isObj)
          .filter((m) => typeof m.uid === 'string')
          .map((m) => ({
            uid: str(m.uid),
            displayName: typeof m.displayName === 'string' && m.displayName ? m.displayName : null,
            showUrl: m.showUrl === true,
          })),
      })),
    domains: arr(raw.domains)
      .filter(isObj)
      .filter((d) => typeof d.domain === 'string')
      .map(parseDomain),
  };
}

function parseDomain(d: Obj): StatusDomain {
  const domain = str(d.domain);
  const verified = d.verified === true;
  return {
    domain,
    verified,
    verifyToken: str(d.verifyToken),
    txtName: str(d.txtName, `_ptr-status.${domain}`),
    expiresAt: verified ? null : numOrNull(d.expiresAt),
  };
}

export function parseIncident(raw: unknown): Incident | null {
  if (!isObj(raw) || typeof raw.uid !== 'string' || !raw.uid) return null;
  return {
    uid: raw.uid,
    title: str(raw.title),
    body: str(raw.body),
    style: incidentStyle(raw.style),
    pinned: raw.pinned === true,
    createdAt: numOrNull(raw.createdAt),
    updatedAt: numOrNull(raw.updatedAt),
    resolvedAt: numOrNull(raw.resolvedAt),
  };
}

function pageFrom(raw: unknown): StatusPage {
  const p = parseStatusPage(isObj(raw) ? (raw.statusPage ?? raw.page ?? raw) : null);
  if (!p) throw new ApiError(500, 'Invalid response from server.');
  return p;
}

function incidentFrom(raw: unknown): Incident {
  const i = parseIncident(isObj(raw) ? (raw.incident ?? raw) : null);
  if (!i) throw new ApiError(500, 'Invalid response from server.');
  return i;
}

/* ------------------------------------------------------------------ public */

export function parsePublicStatus(raw: unknown): PublicStatus {
  const o = isObj(raw) ? raw : {};
  const analytics = isObj(o.analytics) ? o.analytics : null;
  const analyticsSite = analytics && typeof analytics.siteId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(analytics.siteId) ? analytics.siteId : null;
  const analyticsScript = analytics ? safeTrackerScript(analytics.scriptUrl) : null;
  const overall = o.overall;
  return {
    title: str(o.title, 'Status'),
    description: str(o.description),
    footer: str(o.footer),
    theme: theme(o.theme),
    accent: safeAccent(o.accent),
    logoUrl: safeAssetUrl(o.logoUrl),
    showPoweredBy: o.showPoweredBy !== false,
    noindex: o.noindex === true,
    refreshS: refresh(o.refreshS),
    tz: timeZone(o.tz),
    paused: o.paused === true,
    analytics: analyticsSite && analyticsScript ? { siteId: analyticsSite, scriptUrl: analyticsScript } : null,
    overall: overall === 'up' || overall === 'degraded' || overall === 'down' || overall === 'maintenance' ? overall : 'unknown',
    sections: arr(o.sections)
      .filter(isObj)
      .map((s) => ({
        name: str(s.name),
        monitors: arr(s.monitors)
          .filter(isObj)
          .map(
            (m, i): PublicMonitor => ({
              id: typeof m.id === 'string' || typeof m.id === 'number' ? String(m.id) : `m${i}`,
              name: str(m.name),
              status: publicMonitorStatus(m.status),
              uptime90d: (() => {
                const n = numOrNull(m.uptime90d);
                return n === null ? null : Math.min(1, Math.max(0, n));
              })(),
              bars: arr(m.bars)
                .filter(isObj)
                .map((b) => {
                  const t = numOrNull(b.t);
                  const r = numOrNull(b.upRatio);
                  return t === null ? null : { t, upRatio: r === null ? null : Math.min(1, Math.max(0, r)), maintenance: b.maintenance === true };
                })
                .filter(notNull)
                .slice(-90),
              url: safeHttpUrl(m.url),
              certDaysLeft: numOrNull(m.certDaysLeft),
              tags: arr(m.tags)
                .filter(isObj)
                .filter((t) => typeof t.name === 'string')
                .map((t) => ({ name: str(t.name), color: safeColor(t.color), value: typeof t.value === 'string' && t.value ? t.value : null })),
            }),
          ),
      })),
    incidents: arr(o.incidents)
      .filter(isObj)
      .map(
        (inc, i): PublicIncident => ({
          id: typeof inc.id === 'string' || typeof inc.uid === 'string' ? str(inc.id, str(inc.uid)) : `i${i}`,
          title: str(inc.title),
          body: str(inc.body),
          style: incidentStyle(inc.style),
          pinned: inc.pinned === true,
          createdAt: numOrNull(inc.createdAt),
          updatedAt: numOrNull(inc.updatedAt),
          resolvedAt: numOrNull(inc.resolvedAt),
        }),
      ),
    maintenance: arr(o.maintenance)
      .filter(isObj)
      .map((m) => ({
        title: str(m.title),
        description: str(m.description),
        start: numOrNull(m.start),
        end: numOrNull(m.end),
        status: str(m.status),
      })),
    updatedAt: numOrNull(o.updatedAt),
  };
}

/* ------------------------------------------------------------------ client */

const enc = encodeURIComponent;
const pagePath = (uid: string) => `/status-pages/${enc(uid)}`;

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Client-side logo check (the server sniffs the content again). */
export async function checkLogoFile(file: Blob): Promise<string | null> {
  if (file.size === 0) return 'The file is empty.';
  if (file.size > LOGO_MAX_BYTES) return 'The logo must be at most 512 KB.';
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return 'Use a PNG, JPEG or WebP image.';
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const webp =
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
  if (!png && !jpeg && !webp) return 'The file is not a valid PNG, JPEG or WebP image.';
  return null;
}

async function uploadRaw(path: string, file: Blob): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'X-PA-Request': '1', 'Content-Type': file.type },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'Network error. Check your connection.');
  }
  if (!res.ok) {
    let message = res.status === 413 ? 'The logo must be at most 512 KB.' : res.status === 415 ? 'Use a PNG, JPEG or WebP image.' : `Upload failed (${res.status}).`;
    try {
      const data: unknown = await res.json();
      if (isObj(data) && typeof data.error === 'string' && data.error.length <= 200) message = data.error;
    } catch {
      /* non-JSON */
    }
    throw new ApiError(res.status, message);
  }
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

export const statusApi = {
  list: (signal?: AbortSignal) =>
    request<unknown>('GET', '/status-pages', { signal }).then((r) =>
      arr(isObj(r) ? (r.statusPages ?? r.pages) : r)
        .map(parseStatusPage)
        .filter(notNull),
    ),
  create: (siteId: string, body: StatusPageInput) => request<unknown>('POST', `/sites/${enc(siteId)}/status-pages`, { body }).then(pageFrom),
  get: (uid: string, signal?: AbortSignal) => request<unknown>('GET', pagePath(uid), { signal }).then(pageFrom),
  update: (uid: string, body: StatusPageInput) => request<unknown>('PATCH', pagePath(uid), { body }).then(pageFrom),
  remove: (uid: string) => request<void>('DELETE', pagePath(uid)),
  /** The public JSON of a page as visitors would see it — also for unpublished pages. */
  preview: (uid: string, signal?: AbortSignal) => request<unknown>('GET', `${pagePath(uid)}/preview`, { signal }).then(parsePublicStatus),
  /** Raw PNG/JPEG/WebP upload; returns the updated page. */
  uploadLogo: async (uid: string, file: Blob): Promise<StatusPage | null> => {
    const r = await uploadRaw(`${pagePath(uid)}/logo`, file);
    return isObj(r) ? parseStatusPage(r.statusPage ?? r) : null;
  },
  deleteLogo: (uid: string) =>
    request<unknown>('DELETE', `${pagePath(uid)}/logo`).then((r) => (isObj(r) ? parseStatusPage(r.statusPage ?? r) : null)),
  /** Looks up the TXT record `_ptr-status.<domain>` now (rate limited). */
  verifyDomain: (uid: string, domain: string) =>
    request<unknown>('POST', `${pagePath(uid)}/domains/verify`, { body: { domain } }).then((r) => {
      const d = isObj(r) && isObj(r.domain) ? r.domain : null;
      if (!d || typeof d.domain !== 'string') throw new ApiError(500, 'Invalid response from server.');
      return parseDomain(d);
    }),

  incidents: (uid: string, signal?: AbortSignal) =>
    request<unknown>('GET', `${pagePath(uid)}/incidents`, { signal }).then((r) =>
      arr(isObj(r) ? r.incidents : r)
        .map(parseIncident)
        .filter(notNull),
    ),
  createIncident: (uid: string, body: IncidentInput) => request<unknown>('POST', `${pagePath(uid)}/incidents`, { body }).then(incidentFrom),
  updateIncident: (uid: string, body: IncidentInput) => request<unknown>('PATCH', `/incidents/${enc(uid)}`, { body }).then(incidentFrom),
  deleteIncident: (uid: string) => request<void>('DELETE', `/incidents/${enc(uid)}`),

  /** Public status page JSON (no login; a 401 never redirects). */
  publicStatus: (slug: string, signal?: AbortSignal) =>
    request<unknown>('GET', `/public/status/${enc(slug)}`, { signal, redirectOn401: false }).then(parsePublicStatus),
};

/**
 * Origin public status pages are served on: the page's own `publicUrl`, else the server's
 * STATUS_PAGE_ORIGIN (public config), else `fallback` (PUBLIC_URL or this origin).
 */
export function statusOrigin(page: Pick<StatusPage, 'publicUrl'> | null, statusPageOrigin: string | null | undefined, fallback: string): string {
  for (const v of [page?.publicUrl, statusPageOrigin]) {
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    } catch {
      /* next */
    }
  }
  return fallback;
}

/** Absolute URLs for a page (public page, badge, RSS). `origin` = see statusOrigin(). */
export function statusUrls(origin: string, slug: string) {
  const o = origin.replace(/\/+$/, '');
  const s = enc(slug);
  return {
    page: `${o}/status/${s}`,
    badge: `${o}/api/public/status/${s}/badge.svg`,
    rss: `${o}/status/${s}/feed.xml`,
  };
}
