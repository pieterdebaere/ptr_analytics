// Gotify: POST /message with the application token in the X-Gotify-Key header (never in the URL).
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { joinUrl, postJson } from '../http.js';
import { plain } from '../render.js';
import { int, str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  { key: 'serverUrl', label: 'Server URL', kind: 'url', required: true, placeholder: 'https://gotify.example.com' },
  { key: 'appToken', label: 'Application token', kind: 'password', secret: true, required: true, help: 'Stored encrypted.' },
  { key: 'priority', label: 'Priority', kind: 'number', default: 8, min: 0, max: 10 },
];

export const gotify: ProviderDefinition<Config, Secrets> = {
  id: 'gotify',
  label: 'Gotify',
  category: 'push',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    r.config['serverUrl'] = str(r.config, 'serverUrl').replace(/\/+$/, '');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(r.secrets['appToken'] ?? '')) throw new ValidationError('Application token contains invalid characters', 'appToken');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const m = ctx.message;
    const res = await postJson(
      ctx,
      joinUrl(str(ctx.config, 'serverUrl'), '/message'),
      {
        title: plain(m.title),
        message: plain(m.text),
        priority: m.severity === 'down' ? int(ctx.config, 'priority', 8) : Math.min(int(ctx.config, 'priority', 8), 5),
        extras: { 'client::display': { contentType: 'text/plain' }, ...(m.url ? { 'client::notification': { click: { url: m.url } } } : {}) },
      },
      { 'x-gotify-key': str(ctx.secrets, 'appToken') },
    );
    return { httpStatus: res.httpStatus };
  },
};
