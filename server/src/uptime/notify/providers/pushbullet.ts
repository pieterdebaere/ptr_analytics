// Pushbullet: note push, token in the Access-Token header.
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { postJson } from '../http.js';
import { plain } from '../render.js';
import { str, validateFields, type Config, type Secrets } from './common.js';

export const PUSHBULLET_URL = 'https://api.pushbullet.com/v2/pushes';

const FIELDS: readonly FieldDef[] = [
  { key: 'accessToken', label: 'Access token', kind: 'password', secret: true, required: true, help: 'Settings → Account → Create access token. Stored encrypted.' },
];

export const pushbullet: ProviderDefinition<Config, Secrets> = {
  id: 'pushbullet',
  label: 'Pushbullet',
  category: 'push',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(r.secrets['accessToken'] ?? '')) throw new ValidationError('Access token contains invalid characters', 'accessToken');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const m = ctx.message;
    const res = await postJson(
      ctx,
      PUSHBULLET_URL,
      m.url ? { type: 'link', title: plain(m.title), body: plain(m.text), url: m.url } : { type: 'note', title: plain(m.title), body: plain(m.text) },
      { 'access-token': str(ctx.secrets, 'accessToken') },
    );
    return { httpStatus: res.httpStatus };
  },
};
