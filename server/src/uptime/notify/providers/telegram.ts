// Telegram Bot API sendMessage with HTML parse mode; every dynamic value is HTML-escaped.
// The bot token is a secret and only ever part of the request URL (redacted from errors).
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { joinUrl, postJson } from '../http.js';
import { escapeHtml, neutralizeMentions, type Message } from '../render.js';
import { bool, checkUrl, optStr, requirePattern, str, validateFields, type Config, type Secrets } from './common.js';

export const TELEGRAM_API = 'https://api.telegram.org';

const FIELDS: readonly FieldDef[] = [
  { key: 'botToken', label: 'Bot token', kind: 'password', secret: true, required: true, placeholder: '123456789:AA…', help: 'From @BotFather. Stored encrypted.' },
  { key: 'chatId', label: 'Chat ID', kind: 'text', required: true, maxLength: 64, placeholder: '-1001234567890 or @channelname' },
  { key: 'threadId', label: 'Topic (message thread) ID', kind: 'number', min: 1, max: 2_147_483_647 },
  { key: 'silent', label: 'Send silently', kind: 'boolean', default: false },
  { key: 'serverUrl', label: 'Bot API server', kind: 'url', placeholder: TELEGRAM_API, selfHostedOnly: true, group: 'Advanced', help: 'Self-hosted Bot API server (optional).' },
];

/** Visible characters per message (Telegram allows 4096 after entity parsing). */
export const TELEGRAM_TEXT_BUDGET = 4000;

/**
 * Telegram HTML. The length budget is applied to the plain (unescaped) text, field by field and
 * on code-point boundaries, and only then is each piece escaped and wrapped in its tags: the
 * result never ends in a cut entity (`&quo`) or an unclosed tag, which Telegram would reject
 * ("can't parse entities") and so lose the alert.
 */
export function telegramHtml(m: Message): string {
  let budget = TELEGRAM_TEXT_BUDGET;
  const take = (s: string): string => {
    const cps = Array.from(neutralizeMentions(s));
    const out = cps.length <= budget ? cps : cps.slice(0, Math.max(0, budget - 1)).concat(budget > 0 ? ['…'] : []);
    budget = Math.max(0, budget - out.length);
    return escapeHtml(out.join(''));
  };
  const lines: string[] = [];
  const push = (line: string): void => {
    lines.push(line);
    budget = Math.max(0, budget - 1); // the newline
  };
  push(`<b>${take(m.title)}</b>`);
  push(take(m.summary));
  for (const f of m.facts) {
    if (f.label === 'Monitor' || budget <= 0) continue;
    const label = take(`${f.label}:`);
    const value = take(` ${f.value}`);
    push(`<b>${label}</b>${value}`);
  }
  if (m.url && budget >= 'Open dashboard'.length) push(`<a href="${escapeHtml(m.url)}">${take('Open dashboard')}</a>`);
  return lines.filter((l, i) => i < 2 || l !== '<b></b>').join('\n');
}

export const telegram: ProviderDefinition<Config, Secrets> = {
  id: 'telegram',
  label: 'Telegram',
  category: 'chat',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    requirePattern(r.secrets['botToken'], /^\d{3,20}:[A-Za-z0-9_-]{20,80}$/, 'botToken', 'Bot token must look like 123456789:AA…');
    const chat = str(r.config, 'chatId');
    if (!/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/.test(chat)) throw new ValidationError('Chat ID must be a number or @channelname', 'chatId');
    const server = optStr(r.config, 'serverUrl');
    if (server !== undefined) r.config['serverUrl'] = checkUrl(server, v, 'serverUrl', 'Bot API server').replace(/\/+$/, '');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const server = optStr(ctx.config, 'serverUrl') ?? TELEGRAM_API;
    const chat = str(ctx.config, 'chatId');
    const body: Record<string, unknown> = {
      chat_id: /^-?\d+$/.test(chat) ? Number(chat) : chat,
      text: telegramHtml(ctx.message),
      parse_mode: 'HTML',
      disable_notification: bool(ctx.config, 'silent'),
      link_preview_options: { is_disabled: true },
    };
    if (typeof ctx.config['threadId'] === 'number') body['message_thread_id'] = ctx.config['threadId'];
    const res = await postJson(ctx, joinUrl(server, `/bot${str(ctx.secrets, 'botToken')}/sendMessage`), body);
    return { httpStatus: res.httpStatus };
  },
};
