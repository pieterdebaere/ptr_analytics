// ntfy: JSON publishing to the server root (topic in the body). Plain text (no Markdown).
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext } from '../context.js';
import { basicAuth, postJson } from '../http.js';
import { plain } from '../render.js';
import { optStr, str, validateFields, type Config, type Secrets } from './common.js';

const FIELDS: readonly FieldDef[] = [
  { key: 'serverUrl', label: 'Server URL', kind: 'url', default: 'https://ntfy.sh', placeholder: 'https://ntfy.sh' },
  { key: 'topic', label: 'Topic', kind: 'text', required: true, maxLength: 64, help: 'Anyone who knows a topic on ntfy.sh can read it: pick a long random name or use access control.' },
  {
    key: 'priority',
    label: 'Priority for down alerts',
    kind: 'select',
    default: '4',
    options: [
      { value: '1', label: 'Min' },
      { value: '2', label: 'Low' },
      { value: '3', label: 'Default' },
      { value: '4', label: 'High' },
      { value: '5', label: 'Urgent' },
    ],
  },
  {
    key: 'auth',
    label: 'Authentication',
    kind: 'select',
    default: 'none',
    options: [
      { value: 'none', label: 'None' },
      { value: 'token', label: 'Access token' },
      { value: 'basic', label: 'Username and password' },
    ],
    group: 'Authentication',
  },
  { key: 'token', label: 'Access token', kind: 'password', secret: true, required: true, showIf: { key: 'auth', equals: ['token'] }, group: 'Authentication' },
  { key: 'username', label: 'Username', kind: 'text', required: true, maxLength: 100, showIf: { key: 'auth', equals: ['basic'] }, group: 'Authentication' },
  { key: 'password', label: 'Password', kind: 'password', secret: true, required: true, showIf: { key: 'auth', equals: ['basic'] }, group: 'Authentication' },
];

const TAGS: Record<string, string> = { down: 'red_circle', up: 'white_check_mark', warning: 'warning', info: 'information_source' };

export const ntfy: ProviderDefinition<Config, Secrets> = {
  id: 'ntfy',
  label: 'ntfy',
  category: 'push',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    r.config['serverUrl'] = str(r.config, 'serverUrl').replace(/\/+$/, '');
    if (!/^[-_A-Za-z0-9]{1,64}$/.test(str(r.config, 'topic'))) throw new ValidationError('Topic may only contain letters, digits, "-" and "_"', 'topic');
    if (optStr(r.config, 'username')?.includes(':')) throw new ValidationError('Username must not contain ":"', 'username');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    const m = ctx.message;
    const priority = m.severity === 'down' ? Number(str(ctx.config, 'priority') || '4') : 3;
    const headers: Record<string, string> = {};
    const auth = str(ctx.config, 'auth');
    if (auth === 'token') headers['authorization'] = `Bearer ${str(ctx.secrets, 'token')}`;
    if (auth === 'basic') headers['authorization'] = basicAuth(str(ctx.config, 'username'), str(ctx.secrets, 'password'));
    const res = await postJson(
      ctx,
      `${str(ctx.config, 'serverUrl') || 'https://ntfy.sh'}/`,
      {
        topic: str(ctx.config, 'topic'),
        title: plain(m.title).slice(0, 250),
        message: plain(m.text).slice(0, 3500),
        priority: Math.min(5, Math.max(1, Number.isInteger(priority) ? priority : 3)),
        tags: [TAGS[m.severity] ?? 'information_source'],
        ...(m.url ? { click: m.url } : {}),
      },
      headers,
    );
    return { httpStatus: res.httpStatus };
  },
};
