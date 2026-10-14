// Discord webhook with an embed. Mentions are disabled twice: `allowed_mentions: {parse: []}`
// (Discord never pings, whatever the text) and Markdown/mention escaping of all dynamic text.
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { postJson } from '../http.js';
import { escapeMarkdown, type Message } from '../render.js';
import { checkUrl, optStr, str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  {
    key: 'webhookUrl',
    label: 'Webhook URL',
    kind: 'password',
    secret: true,
    required: true,
    placeholder: 'https://discord.com/api/webhooks/123/abc',
    help: 'Channel settings → Integrations → Webhooks. Stored encrypted.',
  },
  { key: 'username', label: 'Bot name', kind: 'text', maxLength: 80, placeholder: 'PTR Uptime' },
  { key: 'threadId', label: 'Thread ID', kind: 'text', maxLength: 20, help: 'Optional: post into this thread / forum post.' },
];

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function discordBody(m: Message, username: string | undefined): Record<string, unknown> {
  return {
    ...(username ? { username: clip(username, 80) } : {}),
    content: '',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: clip(escapeMarkdown(m.title), 256),
        description: clip(escapeMarkdown(m.summary), 4000),
        color: m.colorInt,
        timestamp: m.timeIso,
        ...(m.url ? { url: m.url } : {}),
        fields: m.facts
          .filter((f) => f.label !== 'Time (UTC)')
          .slice(0, 10)
          .map((f) => ({ name: clip(escapeMarkdown(f.label), 256), value: clip(escapeMarkdown(f.value), 1024) || '-', inline: f.value.length < 40 })),
        footer: { text: 'PTR Analytics' },
      },
    ],
  };
}

export const discord: ProviderDefinition<Config, Secrets> = {
  id: 'discord',
  label: 'Discord',
  category: 'chat',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    r.secrets['webhookUrl'] = checkUrl(r.secrets['webhookUrl'] ?? '', v, 'webhookUrl', 'Webhook URL', {
      hosts: ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'],
      pathPrefix: '/api/webhooks/',
      httpsOnly: true,
    });
    const thread = optStr(r.config, 'threadId');
    if (thread !== undefined && !/^\d{1,20}$/.test(thread)) throw new ValidationError('Thread ID must be a number', 'threadId');
    const name = optStr(r.config, 'username');
    if (name !== undefined && /discord|clyde|[@#:`]/i.test(name)) throw new ValidationError('Bot name contains words or characters Discord does not allow', 'username');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const u = new URL(str(ctx.secrets, 'webhookUrl'));
    u.searchParams.set('wait', 'true');
    const thread = optStr(ctx.config, 'threadId');
    if (thread) u.searchParams.set('thread_id', thread);
    const res = await postJson(ctx, u.toString(), discordBody(ctx.message, optStr(ctx.config, 'username')));
    return { httpStatus: res.httpStatus };
  },
};
