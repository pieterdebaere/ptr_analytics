// Matrix client-server API v3: PUT /_matrix/client/v3/rooms/{room}/send/m.room.message/{txn}.
// The transaction id is derived from the delivery id, so a retried request is deduplicated by
// the homeserver. `m.mentions: {}` disables legacy body-based mentions (`@room`); the plain
// body is mention-neutralised and the HTML body escaped.
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { joinUrl, postJson } from '../http.js';
import { escapeHtml, neutralizeMentions, type Message } from '../render.js';
import { str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  { key: 'homeserverUrl', label: 'Homeserver URL', kind: 'url', required: true, placeholder: 'https://matrix.example.org' },
  { key: 'accessToken', label: 'Access token', kind: 'password', secret: true, required: true, help: 'Token of the bot account. Stored encrypted.' },
  { key: 'roomId', label: 'Internal room ID', kind: 'text', required: true, maxLength: 255, placeholder: '!abcdefg:example.org', help: 'Room settings → Advanced. The bot must be a member.' },
];

export function matrixBody(m: Message): Record<string, unknown> {
  const plainLines = [m.title, m.summary, ...m.facts.filter((f) => f.label !== 'Monitor').map((f) => `${f.label}: ${f.value}`)];
  if (m.url) plainLines.push(m.url);
  const html = [
    `<strong>${escapeHtml(neutralizeMentions(m.title))}</strong>`,
    escapeHtml(neutralizeMentions(m.summary)),
    ...m.facts.filter((f) => f.label !== 'Monitor').map((f) => `<em>${escapeHtml(f.label)}:</em> ${escapeHtml(neutralizeMentions(f.value))}`),
    ...(m.url ? [`<a href="${escapeHtml(m.url)}">Open dashboard</a>`] : []),
  ].join('<br>');
  return {
    msgtype: 'm.text',
    body: neutralizeMentions(plainLines.join('\n')),
    format: 'org.matrix.custom.html',
    formatted_body: html,
    'm.mentions': {},
  };
}

export const matrix: ProviderDefinition<Config, Secrets> = {
  id: 'matrix',
  label: 'Matrix',
  category: 'chat',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    r.config['homeserverUrl'] = str(r.config, 'homeserverUrl').replace(/\/+$/, '');
    if (!/^![A-Za-z0-9._=\-/+]{1,200}:[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(str(r.config, 'roomId'))) {
      throw new ValidationError('Room ID must look like !abcdefg:example.org (not a #alias)', 'roomId');
    }
    if (/[\s"]/.test(r.secrets['accessToken'] ?? '')) throw new ValidationError('Access token contains invalid characters', 'accessToken');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const room = encodeURIComponent(str(ctx.config, 'roomId'));
    const txn = encodeURIComponent(`ptr.${ctx.deliveryId}`);
    const url = joinUrl(str(ctx.config, 'homeserverUrl'), `/_matrix/client/v3/rooms/${room}/send/m.room.message/${txn}`);
    const res = await postJson(ctx, url, matrixBody(ctx.message), { authorization: `Bearer ${str(ctx.secrets, 'accessToken')}` }, 'PUT');
    return { httpStatus: res.httpStatus };
  },
};
