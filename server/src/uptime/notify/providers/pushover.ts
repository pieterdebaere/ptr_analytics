// Pushover (fixed host api.pushover.net), form-encoded, plain text (html flag off).
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { postForm } from '../http.js';
import { plain } from '../render.js';
import { optStr, str, validateFields, type Config, type Secrets } from './common.js';

export const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

const FIELDS: readonly FieldDef[] = [
  { key: 'userKey', label: 'User or group key', kind: 'password', secret: true, required: true },
  { key: 'appToken', label: 'Application API token', kind: 'password', secret: true, required: true, help: 'Stored encrypted.' },
  {
    key: 'priority',
    label: 'Priority for down alerts',
    kind: 'select',
    default: '1',
    options: [
      { value: '-2', label: 'Lowest' },
      { value: '-1', label: 'Low' },
      { value: '0', label: 'Normal' },
      { value: '1', label: 'High' },
      { value: '2', label: 'Emergency (repeat until acknowledged)' },
    ],
  },
  { key: 'sound', label: 'Sound', kind: 'text', maxLength: 32, placeholder: 'siren' },
  { key: 'device', label: 'Device', kind: 'text', maxLength: 25, help: 'Optional: only this device.' },
];

const KEY_RE = /^[A-Za-z0-9]{30}$/;

export const pushover: ProviderDefinition<Config, Secrets> = {
  id: 'pushover',
  label: 'Pushover',
  category: 'push',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    if (!KEY_RE.test(r.secrets['userKey'] ?? '')) throw new ValidationError('User key must be 30 letters and digits', 'userKey');
    if (!KEY_RE.test(r.secrets['appToken'] ?? '')) throw new ValidationError('API token must be 30 letters and digits', 'appToken');
    for (const k of ['sound', 'device']) {
      const s = optStr(r.config, k);
      if (s !== undefined && !/^[A-Za-z0-9_-]+$/.test(s)) throw new ValidationError(`${k === 'sound' ? 'Sound' : 'Device'} may only contain letters, digits, "-" and "_"`, k);
    }
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const m = ctx.message;
    const priority = m.severity === 'down' ? str(ctx.config, 'priority') || '1' : '0';
    const res = await postForm(ctx, PUSHOVER_URL, {
      token: str(ctx.secrets, 'appToken'),
      user: str(ctx.secrets, 'userKey'),
      title: plain(m.title).slice(0, 250),
      message: plain(m.text).slice(0, 1024),
      priority,
      ...(priority === '2' ? { retry: 60, expire: 3600 } : {}),
      timestamp: Math.floor(Date.parse(m.timeIso) / 1000),
      url: m.url,
      url_title: m.url ? 'Open dashboard' : undefined,
      sound: optStr(ctx.config, 'sound'),
      device: optStr(ctx.config, 'device'),
    });
    return { httpStatus: res.httpStatus };
  },
};
