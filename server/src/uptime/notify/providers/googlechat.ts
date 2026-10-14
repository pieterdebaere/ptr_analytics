// Google Chat incoming webhook with a cardsV2 card. Card text accepts an HTML subset and plain
// text accepts `<users/all>` mentions: everything is HTML-escaped.
import type { FieldDef, ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { postJson } from '../http.js';
import { escapeHtml, neutralizeMentions, type Message } from '../render.js';
import { checkUrl, str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  {
    key: 'webhookUrl',
    label: 'Webhook URL',
    kind: 'password',
    secret: true,
    required: true,
    placeholder: 'https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…',
    help: 'Space → Apps & integrations → Webhooks. Stored encrypted.',
  },
];

export function googleChatBody(m: Message, deliveryId: string): Record<string, unknown> {
  const e = (s: string): string => escapeHtml(neutralizeMentions(s));
  const widgets: Array<Record<string, unknown>> = [
    { textParagraph: { text: e(m.summary) } },
    ...m.facts.map((f) => ({ decoratedText: { topLabel: e(f.label), text: e(f.value), wrapText: true } })),
  ];
  if (m.url) widgets.push({ buttonList: { buttons: [{ text: 'Open dashboard', onClick: { openLink: { url: m.url } } }] } });
  return {
    fallbackText: e(m.title),
    cardsV2: [{ cardId: `ptr-${deliveryId}`.slice(0, 60), card: { header: { title: e(m.title), subtitle: 'PTR Analytics' }, sections: [{ widgets }] } }],
  };
}

export const googlechat: ProviderDefinition<Config, Secrets> = {
  id: 'googlechat',
  label: 'Google Chat',
  category: 'chat',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    r.secrets['webhookUrl'] = checkUrl(r.secrets['webhookUrl'] ?? '', v, 'webhookUrl', 'Webhook URL', {
      hosts: ['chat.googleapis.com'],
      pathPrefix: '/v1/spaces/',
      httpsOnly: true,
    });
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const res = await postJson(ctx, str(ctx.secrets, 'webhookUrl'), googleChatBody(ctx.message, ctx.deliveryId), {
      'content-type': 'application/json; charset=UTF-8',
    });
    return { httpStatus: res.httpStatus };
  },
};
