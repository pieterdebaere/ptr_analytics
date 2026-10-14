// Mattermost incoming webhook (Slack-compatible attachment). Markdown-escaped, mentions
// (`@channel`, `@all`, `@here`, `@user`) neutralised.
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { postJson } from '../http.js';
import { escapeMarkdown, type Message } from '../render.js';
import { checkUrl, optStr, str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  { key: 'webhookUrl', label: 'Webhook URL', kind: 'password', secret: true, required: true, placeholder: 'https://mattermost.example.com/hooks/xxx', help: 'Stored encrypted.' },
  { key: 'channel', label: 'Channel override', kind: 'text', maxLength: 64, placeholder: 'town-square' },
  { key: 'username', label: 'Username override', kind: 'text', maxLength: 64, placeholder: 'PTR Uptime' },
];

export function attachmentBody(m: Message): Record<string, unknown> {
  return {
    fallback: escapeMarkdown(m.title),
    color: m.color,
    title: escapeMarkdown(m.title),
    ...(m.url ? { title_link: m.url } : {}),
    text: escapeMarkdown(m.summary),
    fields: m.facts.map((f) => ({ title: escapeMarkdown(f.label), value: escapeMarkdown(f.value), short: f.value.length < 40 })),
    footer: 'PTR Analytics',
  };
}

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export const mattermost: ProviderDefinition<Config, Secrets> = {
  id: 'mattermost',
  label: 'Mattermost',
  category: 'chat',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    r.secrets['webhookUrl'] = checkUrl(r.secrets['webhookUrl'] ?? '', v, 'webhookUrl', 'Webhook URL', { pathPrefix: '/hooks/' });
    for (const k of ['channel', 'username']) {
      const s = optStr(r.config, k);
      if (s !== undefined && !SLUG_RE.test(s)) throw new ValidationError(`${k === 'channel' ? 'Channel' : 'Username'} may only contain letters, digits, ".", "_" and "-"`, k);
    }
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const channel = optStr(ctx.config, 'channel');
    const username = optStr(ctx.config, 'username');
    const res = await postJson(ctx, str(ctx.secrets, 'webhookUrl'), {
      ...(channel ? { channel } : {}),
      ...(username ? { username } : {}),
      text: '',
      attachments: [attachmentBody(ctx.message)],
    });
    return { httpStatus: res.httpStatus };
  },
};
