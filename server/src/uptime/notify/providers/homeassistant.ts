// Home Assistant: POST /api/services/notify/<service> with a long-lived access token.
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { joinUrl, postJson } from '../http.js';
import { plain } from '../render.js';
import { str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  { key: 'url', label: 'Home Assistant URL', kind: 'url', required: true, placeholder: 'https://homeassistant.example.com' },
  { key: 'token', label: 'Long-lived access token', kind: 'password', secret: true, required: true, help: 'Profile → Security. Stored encrypted.' },
  { key: 'service', label: 'Notify service', kind: 'text', default: 'persistent_notification', maxLength: 64, placeholder: 'mobile_app_my_phone' },
];

export const homeassistant: ProviderDefinition<Config, Secrets> = {
  id: 'homeassistant',
  label: 'Home Assistant',
  category: 'push',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    r.config['url'] = str(r.config, 'url').replace(/\/+$/, '');
    if (!/^[a-z0-9_]{1,64}$/.test(str(r.config, 'service'))) throw new ValidationError('Notify service must look like mobile_app_my_phone', 'service');
    if (/[\s"]/.test(r.secrets['token'] ?? '')) throw new ValidationError('Token contains invalid characters', 'token');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const m = ctx.message;
    const res = await postJson(
      ctx,
      joinUrl(str(ctx.config, 'url'), `/api/services/notify/${str(ctx.config, 'service')}`),
      { title: plain(m.title), message: plain(m.text) },
      { authorization: `Bearer ${str(ctx.secrets, 'token')}` },
    );
    return { httpStatus: res.httpStatus };
  },
};
