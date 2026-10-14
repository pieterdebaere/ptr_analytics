// Twilio SMS (fixed host api.twilio.com), the member's own account (never operator-paid).
// One request per recipient (≤ 5), short plain text.
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { basicAuth, postForm } from '../http.js';
import { plain } from '../render.js';
import { E164_RE, list, optStr, str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  { key: 'accountSid', label: 'Account SID', kind: 'text', required: true, maxLength: 34, placeholder: 'AC…' },
  { key: 'authToken', label: 'Auth token (or API key secret)', kind: 'password', secret: true, required: true, help: 'Stored encrypted.' },
  { key: 'apiKeySid', label: 'API key SID', kind: 'text', maxLength: 34, placeholder: 'SK… (optional)', group: 'Advanced' },
  { key: 'from', label: 'From', kind: 'text', required: true, maxLength: 34, placeholder: '+15017122661 or MG… (messaging service)' },
  { key: 'to', label: 'To', kind: 'list', required: true, max: 5, maxLength: 16, help: 'Phone numbers in international format, one per line.' },
];

export function twilioUrl(sid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
}

export const twilio: ProviderDefinition<Config, Secrets> = {
  id: 'twilio',
  label: 'Twilio SMS',
  category: 'sms',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    if (!/^AC[0-9a-f]{32}$/.test(str(r.config, 'accountSid'))) throw new ValidationError('Account SID must look like AC followed by 32 hex digits', 'accountSid');
    const key = optStr(r.config, 'apiKeySid');
    if (key !== undefined && !/^SK[0-9a-f]{32}$/.test(key)) throw new ValidationError('API key SID must look like SK followed by 32 hex digits', 'apiKeySid');
    if (!/^[A-Za-z0-9]{16,128}$/.test(r.secrets['authToken'] ?? '')) throw new ValidationError('Auth token contains invalid characters', 'authToken');
    const from = str(r.config, 'from');
    if (!E164_RE.test(from) && !/^MG[0-9a-f]{32}$/.test(from)) throw new ValidationError('From must be a phone number (+…) or a messaging service SID (MG…)', 'from');
    const to = list(r.config, 'to');
    if (to.length === 0) throw new ValidationError('To is required', 'to');
    for (const n of to) if (!E164_RE.test(n)) throw new ValidationError(`"${n}" is not a phone number in international format`, 'to');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const m = ctx.message;
    const sid = str(ctx.config, 'accountSid');
    const auth = basicAuth(optStr(ctx.config, 'apiKeySid') ?? sid, str(ctx.secrets, 'authToken'));
    const from = str(ctx.config, 'from');
    const body = plain(m.summary).slice(0, 300);
    let httpStatus = 0;
    for (const to of list(ctx.config, 'to')) {
      const res = await postForm(ctx, twilioUrl(sid), { To: to, ...(from.startsWith('MG') ? { MessagingServiceSid: from } : { From: from }), Body: body }, { authorization: auth });
      httpStatus = res.httpStatus;
    }
    return { httpStatus };
  },
};
