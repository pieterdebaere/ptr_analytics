// Zulip: POST /api/v1/messages (stream message), Basic auth with the bot's e-mail + API key.
// Zulip Markdown: escaped, and `@**all**`-style mentions neutralised.
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { basicAuth, joinUrl, postForm } from '../http.js';
import { escapeMarkdown } from '../render.js';
import { checkEmails, str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  { key: 'siteUrl', label: 'Zulip server URL', kind: 'url', required: true, placeholder: 'https://yourorg.zulipchat.com' },
  { key: 'botEmail', label: 'Bot e-mail', kind: 'text', required: true, maxLength: 254, placeholder: 'uptime-bot@yourorg.zulipchat.com' },
  { key: 'apiKey', label: 'Bot API key', kind: 'password', secret: true, required: true, help: 'Stored encrypted.' },
  { key: 'stream', label: 'Channel (stream)', kind: 'text', required: true, maxLength: 60, placeholder: 'alerts' },
  { key: 'topic', label: 'Topic', kind: 'text', maxLength: 60, default: 'Uptime' },
];

export const zulip: ProviderDefinition<Config, Secrets> = {
  id: 'zulip',
  label: 'Zulip',
  category: 'chat',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    r.config['siteUrl'] = str(r.config, 'siteUrl').replace(/\/+$/, '');
    r.config['botEmail'] = (checkEmails([str(r.config, 'botEmail')], 'botEmail', 'Bot e-mail')[0] as string);
    if (/[\s:]/.test(r.secrets['apiKey'] ?? '')) throw new ValidationError('API key contains invalid characters', 'apiKey');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const m = ctx.message;
    const lines = [`**${escapeMarkdown(m.title)}**`, escapeMarkdown(m.summary), ...m.facts.filter((f) => f.label !== 'Monitor').map((f) => `* ${escapeMarkdown(f.label)}: ${escapeMarkdown(f.value)}`)];
    if (m.url) lines.push(`[Open dashboard](${m.url})`);
    const res = await postForm(
      ctx,
      joinUrl(str(ctx.config, 'siteUrl'), '/api/v1/messages'),
      { type: 'stream', to: str(ctx.config, 'stream'), topic: str(ctx.config, 'topic') || 'Uptime', content: lines.join('\n') },
      { authorization: basicAuth(str(ctx.config, 'botEmail'), str(ctx.secrets, 'apiKey')) },
    );
    return { httpStatus: res.httpStatus };
  },
};
