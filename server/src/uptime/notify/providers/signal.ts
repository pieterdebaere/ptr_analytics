// Signal via signal-cli-rest-api (https://github.com/bbernhard/signal-cli-rest-api): POST /v2/send.
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { basicAuth, postJson } from '../http.js';
import { plain } from '../render.js';
import { E164_RE, list, optStr, str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  { key: 'url', label: 'API endpoint', kind: 'url', required: true, placeholder: 'https://signal-api.example.com/v2/send' },
  { key: 'number', label: 'Sender number', kind: 'text', required: true, maxLength: 16, placeholder: '+32470123456' },
  { key: 'recipients', label: 'Recipients', kind: 'list', required: true, max: 10, maxLength: 120, help: 'Phone numbers (+32…) or group ids (group.…), one per line.' },
  { key: 'basicAuthUser', label: 'Basic auth user', kind: 'text', maxLength: 100, group: 'Authentication', help: 'If the API sits behind a reverse proxy with authentication.' },
  { key: 'basicAuthPassword', label: 'Basic auth password', kind: 'password', secret: true, group: 'Authentication' },
];

export const signal: ProviderDefinition<Config, Secrets> = {
  id: 'signal',
  label: 'Signal (signal-cli REST API)',
  category: 'chat',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    if (!E164_RE.test(str(r.config, 'number'))) throw new ValidationError('Sender number must be in international format (+…)', 'number');
    for (const rcpt of list(r.config, 'recipients')) {
      if (!E164_RE.test(rcpt) && !/^group\.[A-Za-z0-9+/=_-]{8,100}$/.test(rcpt)) throw new ValidationError(`Recipient "${rcpt.slice(0, 40)}" is not a phone number or group id`, 'recipients');
    }
    if (list(r.config, 'recipients').length === 0) throw new ValidationError('Recipients is required', 'recipients');
    if (optStr(r.config, 'basicAuthUser')?.includes(':')) throw new ValidationError('Basic auth user must not contain ":"', 'basicAuthUser');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const m = ctx.message;
    const user = optStr(ctx.config, 'basicAuthUser');
    const res = await postJson(
      ctx,
      str(ctx.config, 'url'),
      { message: plain(`${m.title}\n${m.text}${m.url ? `\n${m.url}` : ''}`), number: str(ctx.config, 'number'), recipients: list(ctx.config, 'recipients') },
      user ? { authorization: basicAuth(user, str(ctx.secrets, 'basicAuthPassword')) } : {},
    );
    return { httpStatus: res.httpStatus };
  },
};
