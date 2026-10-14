// PagerDuty Events API v2: down/resend → trigger, up → resolve (same dedup key per monitor, so
// UP resolves the incident opened by DOWN). Certificate/domain notices use their own dedup keys.
// A test sends a trigger followed by a resolve of a one-off key.
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext, type NotifySendContext } from '../context.js';
import { postJson } from '../http.js';
import { clean } from '../render.js';
import { bool, str, validateFields, type Config, type Secrets } from './common.js';

export const PAGERDUTY_URLS: Record<string, string> = {
  us: 'https://events.pagerduty.com/v2/enqueue',
  eu: 'https://events.eu.pagerduty.com/v2/enqueue',
};

const FIELDS: readonly FieldDef[] = [
  { key: 'routingKey', label: 'Integration (routing) key', kind: 'password', secret: true, required: true, help: 'Service → Integrations → Events API v2. Stored encrypted.' },
  {
    key: 'region',
    label: 'Region',
    kind: 'select',
    default: 'us',
    options: [
      { value: 'us', label: 'US (events.pagerduty.com)' },
      { value: 'eu', label: 'EU (events.eu.pagerduty.com)' },
    ],
  },
  {
    key: 'severity',
    label: 'Severity',
    kind: 'select',
    default: 'critical',
    options: [
      { value: 'critical', label: 'Critical' },
      { value: 'error', label: 'Error' },
      { value: 'warning', label: 'Warning' },
      { value: 'info', label: 'Info' },
    ],
  },
  { key: 'autoResolve', label: 'Resolve the incident when the monitor is up again', kind: 'boolean', default: true },
];

export function dedupKey(ctx: NotifySendContext<Config, Secrets>): string {
  const uid = clean(ctx.payload.monitor?.uid, 40) || 'none';
  if (ctx.payload.event === 'cert') return `ptr-uptime/${uid}/cert`;
  if (ctx.payload.event === 'domain') return `ptr-uptime/${uid}/domain`;
  if (ctx.payload.event === 'test') return `ptr-uptime/test/${ctx.deliveryId}`;
  return `ptr-uptime/${uid}`;
}

export const pagerduty: ProviderDefinition<Config, Secrets> = {
  id: 'pagerduty',
  label: 'PagerDuty',
  category: 'incident',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    if (!/^[A-Za-z0-9]{32}$/.test(r.secrets['routingKey'] ?? '')) throw new ValidationError('Integration key must be 32 letters and digits', 'routingKey');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const m = ctx.message;
    const url = PAGERDUTY_URLS[str(ctx.config, 'region')] ?? (PAGERDUTY_URLS['us'] as string);
    const key = dedupKey(ctx);
    const event = ctx.payload.event;
    if (event === 'maint_start' || event === 'maint_end') return {};
    if (event === 'up' && !bool(ctx.config, 'autoResolve')) return {};
    const common = { routing_key: str(ctx.secrets, 'routingKey'), dedup_key: key };
    if (event === 'up') {
      const res = await postJson(ctx, url, { ...common, event_action: 'resolve' });
      return { httpStatus: res.httpStatus };
    }
    const severity = event === 'cert' || event === 'domain' ? 'warning' : event === 'test' ? 'info' : str(ctx.config, 'severity') || 'critical';
    const res = await postJson(ctx, url, {
      ...common,
      event_action: 'trigger',
      client: 'PTR Analytics',
      ...(m.url ? { client_url: m.url } : {}),
      payload: {
        summary: m.summary.slice(0, 1024),
        source: (clean(ctx.payload.monitor?.target, 200) || m.monitorName || 'PTR Analytics').slice(0, 255),
        severity,
        timestamp: m.timeIso,
        ...(m.monitorName ? { component: m.monitorName } : {}),
        ...(ctx.payload.monitor ? { group: clean(ctx.payload.monitor.siteName, 100), class: clean(ctx.payload.monitor.type, 40) } : {}),
        custom_details: Object.fromEntries(m.facts.map((f) => [f.label, f.value])),
      },
    });
    if (event === 'test') {
      // Close the test incident right away.
      await postJson(ctx, url, { ...common, event_action: 'resolve' });
    }
    return { httpStatus: res.httpStatus };
  },
};
