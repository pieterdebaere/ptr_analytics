// Message rendering for notifications (docs/uptime/ANALYSIS.md §4.2, §8.7.7).
//
// No template engine: the default messages are built in code, and user templates (generic
// webhook) only support `{{placeholder}}` substitution from a fixed allow-list, in a single
// pass (substituted values are never re-scanned), with escaping chosen by the sink. All values
// that can come from users or monitored targets (monitor/site names, error messages, cert
// subjects …) are cleaned (control/bidi characters stripped) and truncated here, and every
// provider escapes them again for its own markup.
import { cleanText } from '../../lib/text.js';
import type { NotifyEvent, NotifyPayload } from '../types.js';

export interface Fact {
  label: string;
  value: string;
}

export type Severity = 'down' | 'up' | 'warning' | 'info';

/** Structured, plain-text (unescaped but cleaned) notification. */
export interface Message {
  event: NotifyEvent;
  severity: Severity;
  /** Short headline, e.g. "🔴 Homepage is down". */
  title: string;
  /** Headline without emoji. */
  headline: string;
  emoji: string;
  /** One sentence, e.g. "Homepage is DOWN: connection refused". */
  summary: string;
  /** Details shown as a list / table. */
  facts: Fact[];
  /** Plain-text body: summary + facts, one per line. */
  text: string;
  /** Colour for chat attachments (hex, with '#') and as integer (Discord). */
  color: string;
  colorInt: number;
  /** Deep link into the dashboard (http/https only) or null. */
  url: string | null;
  monitorName: string | null;
  timeIso: string;
}

const COLORS: Record<Severity, string> = { down: '#e01e5a', up: '#2eb886', warning: '#f59e0b', info: '#3b82f6' };
const EMOJI: Record<Severity, string> = { down: '🔴', up: '✅', warning: '⚠️', info: 'ℹ️' };

/** Clean a user/target controlled value: no control or bidi characters, at most `max` chars. */
export function clean(v: unknown, max = 200): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  return cleanText(s.replace(/[\r\n\t]+/g, ' '), max).trim();
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Build the structured message for a payload. Never throws on malformed payloads. */
export function buildMessage(p: NotifyPayload): Message {
  const ts = num(p.ts) ?? Date.now();
  const timeIso = new Date(ts).toISOString();
  const name = p.monitor ? clean(p.monitor.name, 100) || 'Monitor' : null;
  const target = p.monitor ? clean(p.monitor.target, 200) : '';
  const site = p.monitor ? clean(p.monitor.siteName, 100) : '';
  const msg = clean(p.msg, 200);
  const facts: Fact[] = [];
  let severity: Severity = 'info';
  let headline = '';
  let summary = '';

  switch (p.event) {
    case 'down':
    case 'resend':
      severity = 'down';
      headline = p.event === 'down' ? `${name ?? 'Monitor'} is down` : `${name ?? 'Monitor'} is still down`;
      summary = `${name ?? 'Monitor'} is DOWN${msg ? `: ${msg}` : ''}`;
      break;
    case 'up': {
      severity = 'up';
      headline = `${name ?? 'Monitor'} is up`;
      const d = num(p.downtimeMs);
      summary = `${name ?? 'Monitor'} is UP again${d !== null && d > 0 ? ` after ${formatDuration(d)}` : ''}${msg ? `: ${msg}` : ''}`;
      break;
    }
    case 'cert': {
      severity = 'warning';
      const days = num(p.cert?.daysLeft);
      const host = clean(p.cert?.host, 253) || target || name || 'certificate';
      headline = days !== null && days < 0 ? `TLS certificate of ${host} has expired` : `TLS certificate of ${host} expires in ${days ?? '?'} days`;
      summary = `${headline}${name ? ` (monitor ${name})` : ''}`;
      const notAfter = num(p.cert?.notAfter);
      if (notAfter !== null) facts.push({ label: 'Expires', value: new Date(notAfter).toISOString() });
      const subject = clean(p.cert?.subject, 200);
      if (subject) facts.push({ label: 'Subject', value: subject });
      break;
    }
    case 'domain': {
      severity = 'warning';
      const days = num(p.domain?.daysLeft);
      const domain = clean(p.domain?.domain, 253) || 'domain';
      headline = days !== null && days < 0 ? `Domain ${domain} has expired` : `Domain ${domain} expires in ${days ?? '?'} days`;
      summary = `${headline}${name ? ` (monitor ${name})` : ''}`;
      const exp = num(p.domain?.expiresAt);
      if (exp !== null) facts.push({ label: 'Expires', value: new Date(exp).toISOString() });
      break;
    }
    case 'maint_start':
    case 'maint_end': {
      severity = 'info';
      const title = clean(p.maintenance?.title, 100) || 'maintenance';
      headline = p.event === 'maint_start' ? `Maintenance started: ${title}` : `Maintenance ended: ${title}`;
      summary = headline;
      break;
    }
    case 'test':
    default:
      severity = 'info';
      headline = 'Test notification from PTR Analytics';
      summary = 'This is a test notification from PTR Analytics. If you can read this, the channel works.';
      break;
  }

  if (name && p.event !== 'test') facts.unshift({ label: 'Monitor', value: name });
  if (target && p.event !== 'test') facts.push({ label: 'Target', value: target });
  if (site && p.event !== 'test') facts.push({ label: 'Site', value: site });
  if ((p.event === 'down' || p.event === 'resend') && msg) facts.push({ label: 'Reason', value: msg });
  if (p.event === 'up') {
    const lat = num(p.latencyMs);
    if (lat !== null) facts.push({ label: 'Response time', value: `${Math.round(lat)} ms` });
    const d = num(p.downtimeMs);
    if (d !== null && d > 0) facts.push({ label: 'Downtime', value: formatDuration(d) });
  }
  facts.push({ label: 'Time (UTC)', value: timeIso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') });

  const emoji = severity === 'info' && p.event !== 'test' ? '🔧' : EMOJI[severity];
  const color = COLORS[severity];
  const title = `${emoji} ${headline}`;
  const text = [summary, ...facts.filter((f) => f.label !== 'Monitor').map((f) => `${f.label}: ${f.value}`)].join('\n');
  return {
    event: p.event,
    severity,
    title,
    headline,
    emoji,
    summary,
    facts,
    text,
    color,
    colorInt: parseInt(color.slice(1), 16),
    url: safeUrl(p.dashboardUrl),
    monitorName: name,
    timeIso,
  };
}

/* ------------------------------------------------------------------ escaping */

/** HTML text and attribute values (Telegram HTML, e-mail, Google Chat, Matrix formatted_body). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

/**
 * Break every `@` mention (`@everyone`, `@here`, `@channel`, `@all`, `@room`, `@**all**` …) with
 * a zero-width space, so text from monitor names or target error messages can never ping people.
 */
export function neutralizeMentions(s: string): string {
  return s.replace(/@/g, '@​');
}

/** Slack mrkdwn: `&`, `<`, `>` are the only control characters (`<!channel>`, `<@U…>`, links). */
export function escapeSlack(s: string): string {
  return neutralizeMentions(s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
}

/**
 * Markdown (Discord, Mattermost, Rocket.Chat, Teams, Zulip, Matrix plain body): backslash-escape
 * the formatting characters, neutralise mentions and `<…>` constructs (`<@id>`, `<!channel>`, `<t:…>`).
 */
export function escapeMarkdown(s: string): string {
  return neutralizeMentions(s.replace(/[\\`*_~|>#[\]()<]/g, (c) => `\\${c}`));
}

/** Plain text for push services that do not render markup but may notify on mentions. */
export function plain(s: string): string {
  return neutralizeMentions(s);
}

/* ---------------------------------------------------------------- templates */

/** Placeholders usable in custom templates: `{{monitor.name}}` … */
export const TEMPLATE_VARS = [
  'event',
  'status',
  'previous_status',
  'status_emoji',
  'title',
  'text',
  'message',
  'monitor.uid',
  'monitor.name',
  'monitor.type',
  'monitor.url',
  'site.id',
  'site.name',
  'latency_ms',
  'down_duration',
  'down_duration_ms',
  'time_iso',
  'time_unix',
  'dashboard_url',
] as const;

export type TemplateVar = (typeof TEMPLATE_VARS)[number];
const TEMPLATE_VAR_SET: ReadonlySet<string> = new Set(TEMPLATE_VARS);
export const TEMPLATE_MAX_BYTES = 4096;
const PLACEHOLDER_RE = /\{\{\s*([a-z_.]{1,40})\s*\}\}/g;

/** Flat, frozen, prototype-less variable map for a message. */
export function templateVars(p: NotifyPayload, m: Message): Readonly<Record<TemplateVar, string>> {
  const v = Object.create(null) as Record<TemplateVar, string>;
  v.event = p.event;
  v.status = p.status ?? '';
  v.previous_status = p.previousStatus ?? '';
  v.status_emoji = m.emoji;
  v.title = m.title;
  v.text = m.text;
  v.message = clean(p.msg, 200);
  v['monitor.uid'] = clean(p.monitor?.uid, 40);
  v['monitor.name'] = clean(p.monitor?.name, 100);
  v['monitor.type'] = clean(p.monitor?.type, 40);
  v['monitor.url'] = clean(p.monitor?.target, 200);
  v['site.id'] = clean(p.monitor?.siteId, 40);
  v['site.name'] = clean(p.monitor?.siteName, 100);
  v.latency_ms = typeof p.latencyMs === 'number' && Number.isFinite(p.latencyMs) ? String(Math.round(p.latencyMs)) : '';
  v.down_duration = typeof p.downtimeMs === 'number' && p.downtimeMs > 0 ? formatDuration(p.downtimeMs) : '';
  v.down_duration_ms = typeof p.downtimeMs === 'number' && Number.isFinite(p.downtimeMs) ? String(Math.round(p.downtimeMs)) : '';
  v.time_iso = m.timeIso;
  v.time_unix = String(Math.floor(Date.parse(m.timeIso) / 1000));
  v.dashboard_url = m.url ?? '';
  return Object.freeze(v);
}

/** Single-pass substitution; unknown placeholders render empty (they are rejected at save time). */
export function renderTemplate(tpl: string, vars: Readonly<Record<string, string>>, escape: (s: string) => string): string {
  return tpl.replace(PLACEHOLDER_RE, (_all, name: string) => (TEMPLATE_VAR_SET.has(name) ? escape(vars[name] ?? '') : ''));
}

/** JSON string content (without the surrounding quotes). */
export function jsonStringEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/**
 * Problems of a user template, or null. For JSON bodies every placeholder must sit inside a
 * JSON string: the template is rendered with hostile sample values and must still parse.
 */
export function templateProblem(tpl: string, contentType: 'json' | 'form' | 'text'): string | null {
  if (Buffer.byteLength(tpl, 'utf8') > TEMPLATE_MAX_BYTES) return `the template must be at most ${TEMPLATE_MAX_BYTES} bytes`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(tpl)) return 'the template contains control characters';
  for (const m of tpl.matchAll(PLACEHOLDER_RE)) {
    if (!TEMPLATE_VAR_SET.has(m[1] as string)) return `unknown placeholder {{${m[1]}}} (allowed: ${TEMPLATE_VARS.map((v) => `{{${v}}}`).join(', ')})`;
  }
  if (/\{\{(?!\s*[a-z_.]{1,40}\s*\}\})/.test(tpl)) return 'malformed placeholder (use {{name}})';
  if (contentType === 'json') {
    const hostile = Object.create(null) as Record<string, string>;
    for (const k of TEMPLATE_VARS) hostile[k] = '"}],\\\n{{x}}';
    const empty = Object.create(null) as Record<string, string>;
    for (const k of TEMPLATE_VARS) empty[k] = '';
    try {
      JSON.parse(renderTemplate(tpl, hostile, jsonStringEscape));
      JSON.parse(renderTemplate(tpl, empty, jsonStringEscape));
    } catch {
      return 'the template must be valid JSON with every placeholder inside a string, e.g. {"text": "{{title}}"}';
    }
  }
  return null;
}
