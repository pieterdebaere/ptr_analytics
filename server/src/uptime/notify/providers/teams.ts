// Microsoft Teams via a Workflows ("Post to a channel when a webhook request is received")
// webhook, as an Adaptive Card. Text blocks render a Markdown subset: everything is escaped.
import type { FieldDef, ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { postJson } from '../http.js';
import { escapeMarkdown, type Message } from '../render.js';
import { checkUrl, str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  {
    key: 'webhookUrl',
    label: 'Workflow webhook URL',
    kind: 'password',
    secret: true,
    required: true,
    placeholder: 'https://prod-00.westeurope.logic.azure.com:443/workflows/…',
    help: 'Teams → Workflows → "Post to a channel when a webhook request is received". Stored encrypted.',
  },
];

export function teamsBody(m: Message): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [
    {
      type: 'Container',
      style: m.severity === 'down' ? 'attention' : m.severity === 'up' ? 'good' : m.severity === 'warning' ? 'warning' : 'emphasis',
      bleed: true,
      items: [{ type: 'TextBlock', text: escapeMarkdown(m.title), weight: 'Bolder', size: 'Medium', wrap: true }],
    },
    { type: 'TextBlock', text: escapeMarkdown(m.summary), wrap: true },
    { type: 'FactSet', facts: m.facts.map((f) => ({ title: escapeMarkdown(f.label), value: escapeMarkdown(f.value) })) },
  ];
  if (m.url) body.push({ type: 'ActionSet', actions: [{ type: 'Action.OpenUrl', title: 'Open dashboard', url: m.url }] });
  return {
    type: 'message',
    summary: escapeMarkdown(m.title).slice(0, 200),
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', msteams: { width: 'Full' }, body },
      },
    ],
  };
}

export const teams: ProviderDefinition<Config, Secrets> = {
  id: 'teams',
  label: 'Microsoft Teams',
  category: 'chat',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    r.secrets['webhookUrl'] = checkUrl(r.secrets['webhookUrl'] ?? '', v, 'webhookUrl', 'Workflow webhook URL', { httpsOnly: true });
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const res = await postJson(ctx, str(ctx.secrets, 'webhookUrl'), teamsBody(ctx.message));
    return { httpStatus: res.httpStatus };
  },
};
