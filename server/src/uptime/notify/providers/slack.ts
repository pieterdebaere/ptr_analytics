// Slack incoming webhook (Block Kit). The webhook URL embeds a token: stored as a secret and
// restricted to Slack's webhook hosts. All dynamic text is mrkdwn-escaped (`&<>`), so monitor
// names or target errors can never produce `<!channel>`/`<@U…>` mentions or links.
import type { FieldDef, ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { postJson } from '../http.js';
import { escapeSlack } from '../render.js';
import { bool, checkUrl, str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  {
    key: 'webhookUrl',
    label: 'Webhook URL',
    kind: 'password',
    secret: true,
    required: true,
    placeholder: 'https://hooks.slack.com/services/T000/B000/XXXX',
    help: 'Slack → Apps → Incoming Webhooks. Stored encrypted.',
  },
  { key: 'notifyChannel', label: 'Mention @channel on down', kind: 'boolean', default: false },
];

/** Slack Block Kit payload (exported for tests). */
export function slackBody(m: ReturnType<typeof ext>['message'], mentionChannel: boolean): Record<string, unknown> {
  const t = escapeSlack(m.title);
  const header = t.length > 150 ? `${t.slice(0, 149)}…` : t;
  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: escapeSlack(m.summary) } },
  ];
  const facts = m.facts.filter((f) => f.label !== 'Time (UTC)').slice(0, 10);
  if (facts.length > 0) {
    blocks.push({ type: 'section', fields: facts.map((f) => ({ type: 'mrkdwn', text: `*${escapeSlack(f.label)}*\n${escapeSlack(f.value)}` })) });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `PTR Analytics · ${escapeSlack(m.timeIso)}` }] });
  if (m.url) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open dashboard' }, url: m.url }] });
  const mention = mentionChannel && m.severity === 'down' ? '<!channel> ' : '';
  // Blocks inside an attachment get the coloured side bar; `text` is the notification fallback.
  return { text: `${mention}${escapeSlack(m.title)}`, attachments: [{ color: m.color, blocks }] };
}

export const slack: ProviderDefinition<Config, Secrets> = {
  id: 'slack',
  label: 'Slack',
  category: 'chat',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    r.secrets['webhookUrl'] = checkUrl(r.secrets['webhookUrl'] ?? '', v, 'webhookUrl', 'Webhook URL', {
      hosts: ['hooks.slack.com', 'hooks.slack-gov.com'],
      pathPrefix: '/',
      httpsOnly: true,
    });
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const res = await postJson(ctx, str(ctx.secrets, 'webhookUrl'), slackBody(ctx.message, bool(ctx.config, 'notifyChannel')));
    return { httpStatus: res.httpStatus };
  },
};
