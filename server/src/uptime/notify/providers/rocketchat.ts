// Rocket.Chat incoming webhook integration.
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { postJson } from '../http.js';
import { escapeMarkdown } from '../render.js';
import { checkUrl, optStr, str, validateFields, type Config, type Secrets } from './common.js';
import { SLUG_RE } from './mattermost.js';

const FIELDS: readonly FieldDef[] = [
  { key: 'webhookUrl', label: 'Webhook URL', kind: 'password', secret: true, required: true, placeholder: 'https://chat.example.com/hooks/xxx/yyy', help: 'Stored encrypted.' },
  { key: 'channel', label: 'Channel override', kind: 'text', maxLength: 64, placeholder: '#general' },
  { key: 'username', label: 'Username override', kind: 'text', maxLength: 64 },
];

export const rocketchat: ProviderDefinition<Config, Secrets> = {
  id: 'rocketchat',
  label: 'Rocket.Chat',
  category: 'chat',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    r.secrets['webhookUrl'] = checkUrl(r.secrets['webhookUrl'] ?? '', v, 'webhookUrl', 'Webhook URL', { pathPrefix: '/hooks/' });
    const ch = optStr(r.config, 'channel');
    if (ch !== undefined && !/^[#@]?[a-z0-9][a-z0-9._-]{0,63}$/i.test(ch)) throw new ValidationError('Channel must look like #general', 'channel');
    const un = optStr(r.config, 'username');
    if (un !== undefined && !SLUG_RE.test(un)) throw new ValidationError('Username may only contain letters, digits, ".", "_" and "-"', 'username');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const m = ctx.message;
    const channel = optStr(ctx.config, 'channel');
    const username = optStr(ctx.config, 'username');
    const res = await postJson(ctx, str(ctx.secrets, 'webhookUrl'), {
      ...(channel ? { channel } : {}),
      ...(username ? { alias: username } : {}),
      text: escapeMarkdown(m.title),
      attachments: [
        {
          title: escapeMarkdown(m.headline),
          ...(m.url ? { title_link: m.url } : {}),
          text: escapeMarkdown(m.text),
          color: m.color,
          ts: m.timeIso,
        },
      ],
    });
    return { httpStatus: res.httpStatus };
  },
};
