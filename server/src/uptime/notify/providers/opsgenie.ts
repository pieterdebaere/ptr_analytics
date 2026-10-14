// Opsgenie Alert API v2: down/resend → create alert with alias = monitor uid; up → close by alias.
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { postJson } from '../http.js';
import { clean } from '../render.js';
import { bool, str, validateFields, type Config, type Secrets } from './common.js';

export const OPSGENIE_URLS: Record<string, string> = {
  us: 'https://api.opsgenie.com/v2/alerts',
  eu: 'https://api.eu.opsgenie.com/v2/alerts',
};

const FIELDS: readonly FieldDef[] = [
  { key: 'apiKey', label: 'API key', kind: 'password', secret: true, required: true, help: 'API integration key. Stored encrypted.' },
  {
    key: 'region',
    label: 'Region',
    kind: 'select',
    default: 'us',
    options: [
      { value: 'us', label: 'US' },
      { value: 'eu', label: 'EU' },
    ],
  },
  {
    key: 'priority',
    label: 'Priority',
    kind: 'select',
    default: 'P3',
    options: ['P1', 'P2', 'P3', 'P4', 'P5'].map((p) => ({ value: p, label: p })),
  },
  { key: 'autoClose', label: 'Close the alert when the monitor is up again', kind: 'boolean', default: true },
];

export const opsgenie: ProviderDefinition<Config, Secrets> = {
  id: 'opsgenie',
  label: 'Opsgenie',
  category: 'incident',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    if (!/^[A-Za-z0-9-]{20,64}$/.test(r.secrets['apiKey'] ?? '')) throw new ValidationError('API key looks invalid', 'apiKey');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const m = ctx.message;
    const event = ctx.payload.event;
    if (event === 'maint_start' || event === 'maint_end') return {};
    if (event === 'up' && !bool(ctx.config, 'autoClose')) return {};
    const url = OPSGENIE_URLS[str(ctx.config, 'region')] ?? (OPSGENIE_URLS['us'] as string);
    const headers = { authorization: `GenieKey ${str(ctx.secrets, 'apiKey')}` };
    const uid = clean(ctx.payload.monitor?.uid, 40) || 'none';
    const alias = event === 'test' ? `ptr-test-${ctx.deliveryId}` : event === 'cert' || event === 'domain' ? `ptr-${uid}-${event}` : `ptr-${uid}`;
    const close = (): Promise<{ httpStatus: number }> =>
      postJson(ctx, `${url}/${encodeURIComponent(alias)}/close?identifierType=alias`, { source: 'PTR Analytics', note: m.summary.slice(0, 25_000) }, headers);
    if (event === 'up') return { httpStatus: (await close()).httpStatus };
    const res = await postJson(
      ctx,
      url,
      {
        message: m.title.slice(0, 130),
        alias,
        description: m.text.slice(0, 15_000),
        source: 'PTR Analytics',
        priority: event === 'test' ? 'P5' : str(ctx.config, 'priority') || 'P3',
        ...(m.monitorName ? { entity: m.monitorName.slice(0, 512) } : {}),
        tags: ['ptr-uptime'],
        details: Object.fromEntries(m.facts.map((f) => [f.label, f.value.slice(0, 1000)])),
      },
      headers,
    );
    if (event === 'test') await close();
    return { httpStatus: res.httpStatus };
  },
};
