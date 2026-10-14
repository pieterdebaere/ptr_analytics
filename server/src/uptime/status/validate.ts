// Input validation for status pages and incidents (docs/SPEC.md §8.3, ANALYSIS §8.7.4).
import { isIP } from 'node:net';
import { badRequest } from '../../lib/errors.js';
import { isValidTimeZone } from '../../lib/time.js';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Slugs that would collide with routes, look official or confuse visitors. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api', 'admin', 'administrator', 'status', 'statuses', 'login', 'logout', 'signin', 'signup', 'register',
  'assets', 'static', 'public', 'dashboard', 'settings', 'account', 'accounts', 'billing', 'verify', 'reset',
  'auth', 'oauth', 'sso', 'metrics', 'healthz', 'health', 'uptime-bot', 'uptime', 'script', 'script-js',
  'app', 'www', 'mail', 'email', 'help', 'support', 'docs', 'doc', 'about', 'feed', 'rss', 'new', 'edit',
  'default', 'sites', 'site', 'monitors', 'monitor', 'incidents', 'incident', 'maintenance', 'maintenances',
  'security', 'root', 'system', 'null', 'undefined', 'favicon-ico', 'robots-txt', 'index', 'home', 'ptr',
  'ptr-analytics', 'official',
]);

export function slugProblem(slug: unknown): string | null {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return 'slug must be 1..64 characters of a-z, 0-9 and "-" (not at the start or end)';
  }
  if (RESERVED_SLUGS.has(slug)) return 'this slug is reserved';
  return null;
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/;
// eslint-disable-next-line no-control-regex
const TEXT_STRIP_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g;

/** Single-line text (titles, names): trimmed, 1..max, no control / bidi characters. */
export function lineText(v: unknown, key: string, max: number, opts: { min?: number } = {}): string {
  if (typeof v !== 'string') throw badRequest(`invalid ${key}`);
  const s = v.trim();
  if (s.length < (opts.min ?? 1) || s.length > max || CONTROL_RE.test(s)) throw badRequest(`${key} must be ${opts.min ?? 1}..${max} characters`);
  return s;
}

/**
 * Markdown subset stored as plain text (rendered by the dashboard as React elements, never as
 * HTML). Newlines and tabs are kept, CR removed, other control and bidi characters stripped.
 */
export function markdownText(v: unknown, key: string, max = 5000): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw badRequest(`invalid ${key}`);
  const s = v.replace(/\r\n?/g, '\n').replace(TEXT_STRIP_RE, '').trim();
  if (s.length > max) throw badRequest(`${key} must be at most ${max} characters`);
  return s === '' ? null : s;
}

export function boolField(v: unknown, key: string): boolean {
  if (typeof v !== 'boolean') throw badRequest(`${key} must be true or false`);
  return v;
}

export const THEMES = ['auto', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export function themeField(v: unknown): Theme {
  if (typeof v !== 'string' || !(THEMES as readonly string[]).includes(v)) throw badRequest('theme must be auto, light or dark');
  return v as Theme;
}

export function accentField(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw badRequest('accent must be a colour like #1f6feb');
  return v.toLowerCase();
}

export function refreshField(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 30 || v > 3600) throw badRequest('refreshS must be an integer 30..3600');
  return v;
}

export function tzField(v: unknown): string {
  if (typeof v !== 'string' || v.length > 64 || !isValidTimeZone(v)) throw badRequest('tz must be a valid IANA time zone');
  return v;
}

export const INCIDENT_STYLES = ['info', 'warning', 'danger', 'success', 'neutral'] as const;
export type IncidentStyle = (typeof INCIDENT_STYLES)[number];

export function incidentStyle(v: unknown): IncidentStyle {
  if (typeof v !== 'string' || !(INCIDENT_STYLES as readonly string[]).includes(v)) {
    throw badRequest('style must be one of info, warning, danger, success, neutral');
  }
  return v as IncidentStyle;
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Custom domain for a status page: a lowercase DNS name with at least two labels, not an IP
 * address, not localhost, not the dashboard host or the STATUS_PAGE_ORIGIN host, nor one of
 * their subdomains.
 */
export function normalizeStatusDomain(v: unknown, publicUrl: string | null, statusPageOrigin: string | null = null): string {
  if (typeof v !== 'string') throw badRequest('invalid domain');
  const d = v.trim().toLowerCase().replace(/\.$/, '');
  const labels = d.split('.');
  if (d.length > 253 || labels.length < 2 || isIP(d) !== 0 || !labels.every((l) => LABEL_RE.test(l)) || /^\d+$/.test(labels[labels.length - 1] as string)) {
    throw badRequest(`"${d.slice(0, 80)}" is not a valid domain name`);
  }
  if (d === 'localhost' || d.endsWith('.localhost') || d.endsWith('.local') || d.endsWith('.internal')) throw badRequest('this domain cannot be used');
  for (const origin of [publicUrl, statusPageOrigin]) {
    if (!origin) continue;
    try {
      const host = new URL(origin).hostname.toLowerCase();
      if (d === host || d.endsWith(`.${host}`)) throw badRequest('the domain of this server (or a subdomain of it) cannot be used');
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
    }
  }
  return d;
}
