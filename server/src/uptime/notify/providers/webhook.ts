// Generic webhook: POST/PUT a JSON default payload, or a custom body template with
// `{{placeholder}}` substitution (no expressions), as JSON / form / text. Optional custom
// headers (secret), Basic auth and an HMAC-SHA256 signature header:
//
//   X-PTR-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
//
// Receivers recompute the HMAC over `${t}.${body}` with the shared secret, compare in constant
// time and reject old timestamps (e.g. > 5 minutes) to prevent replays.
import { createHmac } from 'node:crypto';
import { ValidationError, type FieldDef, type NotifyPayload, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { basicAuth, formEncode, httpSend } from '../http.js';
import { jsonStringEscape, renderTemplate, templateProblem, templateVars, type Message } from '../render.js';
import { TEMPLATE_HELP, headerList, optStr, str, validateFields, type Config, type Secrets } from './common.js';

export const SIGNATURE_HEADER = 'X-PTR-Signature';

const FIELDS: readonly FieldDef[] = [
  { key: 'url', label: 'Webhook URL', kind: 'url', required: true, placeholder: 'https://example.com/hooks/uptime', group: 'Request' },
  {
    key: 'method',
    label: 'Method',
    kind: 'select',
    default: 'POST',
    options: [
      { value: 'POST', label: 'POST' },
      { value: 'PUT', label: 'PUT' },
    ],
    group: 'Request',
  },
  {
    key: 'contentType',
    label: 'Body format',
    kind: 'select',
    default: 'json',
    options: [
      { value: 'json', label: 'JSON (application/json)' },
      { value: 'form', label: 'Form (application/x-www-form-urlencoded)' },
      { value: 'text', label: 'Plain text' },
    ],
    group: 'Request',
  },
  {
    key: 'bodyTemplate',
    label: 'Custom body template',
    kind: 'textarea',
    maxLength: 4096,
    help: `Leave empty for the default payload. ${TEMPLATE_HELP}. JSON: placeholders must be inside strings. Form: key=value lines.`,
    group: 'Request',
  },
  {
    key: 'headers',
    label: 'Additional headers',
    kind: 'keyvalue',
    secret: true,
    help: 'Stored encrypted, never shown again.',
    group: 'Authentication',
  },
  { key: 'basicAuthUser', label: 'Basic auth user', kind: 'text', maxLength: 200, group: 'Authentication' },
  { key: 'basicAuthPassword', label: 'Basic auth password', kind: 'password', secret: true, group: 'Authentication' },
  {
    key: 'signingSecret',
    label: 'Signing secret (HMAC-SHA256)',
    kind: 'password',
    secret: true,
    maxLength: 256,
    help: `Adds ${SIGNATURE_HEADER}: t=<unix time>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>.`,
    group: 'Authentication',
  },
];

type ContentType = 'json' | 'form' | 'text';

/** Default JSON document (stable, documented shape). */
export function defaultPayload(p: NotifyPayload, m: Message): Record<string, unknown> {
  return {
    event: p.event,
    status: p.status,
    previousStatus: p.previousStatus,
    title: m.title,
    text: m.text,
    message: m.summary,
    time: m.timeIso,
    ts: p.ts,
    monitor: p.monitor
      ? { uid: p.monitor.uid, name: m.monitorName, type: p.monitor.type, target: p.monitor.target, siteId: p.monitor.siteId, siteName: p.monitor.siteName }
      : null,
    latencyMs: p.latencyMs ?? null,
    downtimeMs: p.downtimeMs ?? null,
    cert: p.cert ?? null,
    domain: p.domain ?? null,
    maintenance: p.maintenance ?? null,
    dashboardUrl: m.url,
  };
}

/** Render the body for a content type (exported for tests). */
export function renderBody(contentType: ContentType, template: string | undefined, p: NotifyPayload, m: Message): string {
  const vars = templateVars(p, m);
  if (template) {
    if (contentType === 'json') return renderTemplate(template, vars, jsonStringEscape);
    if (contentType === 'form') {
      // One key=value pair per line; keys are literal, values are templates (URL encoded).
      const sp = new URLSearchParams();
      for (const line of template.split('\n')) {
        const i = line.indexOf('=');
        if (i <= 0) continue;
        sp.append(line.slice(0, i).trim(), renderTemplate(line.slice(i + 1), vars, (s) => s));
      }
      return sp.toString();
    }
    return renderTemplate(template, vars, (s) => s);
  }
  if (contentType === 'json') return JSON.stringify(defaultPayload(p, m));
  if (contentType === 'form') {
    return formEncode({
      event: p.event,
      status: p.status ?? '',
      title: m.title,
      text: m.text,
      monitor_uid: p.monitor?.uid ?? '',
      monitor_name: m.monitorName ?? '',
      monitor_url: vars['monitor.url'],
      site_name: vars['site.name'],
      time: m.timeIso,
      dashboard_url: m.url ?? '',
    });
  }
  return `${m.title}\n${m.text}`;
}

/** `t=…,v1=…` signature value for a body (exported for receivers' tests / docs). */
export function signatureHeader(secret: string, body: string, unixSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${unixSeconds}.${body}`, 'utf8').digest('hex');
  return `t=${unixSeconds},v1=${v1}`;
}

const CONTENT_TYPES: Record<ContentType, string> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
  text: 'text/plain; charset=utf-8',
};

export const webhook: ProviderDefinition<Config, Secrets> = {
  id: 'webhook',
  label: 'Webhook',
  category: 'webhook',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    const ct = str(r.config, 'contentType') as ContentType;
    const tpl = optStr(r.config, 'bodyTemplate');
    if (tpl !== undefined) {
      const problem = templateProblem(tpl, ct);
      if (problem) throw new ValidationError(problem, 'bodyTemplate');
    }
    if (r.secrets['basicAuthPassword'] && !optStr(r.config, 'basicAuthUser')) {
      throw new ValidationError('Basic auth user is required with a password', 'basicAuthUser');
    }
    if (optStr(r.config, 'basicAuthUser')?.includes(':')) throw new ValidationError('Basic auth user must not contain ":"', 'basicAuthUser');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const ct = (str(ctx.config, 'contentType') || 'json') as ContentType;
    const body = renderBody(ct, optStr(ctx.config, 'bodyTemplate'), ctx.payload, ctx.message);
    const headers: Record<string, string> = { 'content-type': CONTENT_TYPES[ct] ?? CONTENT_TYPES.json };
    const custom = ctx.secrets['headers'] ? headerList(JSON.parse(ctx.secrets['headers']) as unknown, FIELDS[4] as FieldDef) : [];
    for (const h of custom) headers[h.key.toLowerCase()] = h.value;
    const user = optStr(ctx.config, 'basicAuthUser');
    if (user) headers['authorization'] = basicAuth(user, ctx.secrets['basicAuthPassword'] ?? '');
    const secret = ctx.secrets['signingSecret'];
    // Signed at send time (not event time): receivers reject stale timestamps.
    if (secret) headers[SIGNATURE_HEADER.toLowerCase()] = signatureHeader(secret, body, Math.floor(Date.now() / 1000));
    const url = str(ctx.config, 'url');
    const method = str(ctx.config, 'method') === 'PUT' ? 'PUT' : 'POST';
    const res = await httpSend(ctx, { url, method, headers, body });
    return { httpStatus: res.httpStatus };
  },
};
