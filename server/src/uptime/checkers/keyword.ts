// `keyword`: HTTP request + (case-insensitive) substring search in the first maxBodyBytes of the
// body. Messages only say found / not found — the body is never echoed.
import { ValidationError, type CheckerDefinition } from '../types.js';
import { bool, codeAccepted, down, guarded, str, up } from './common.js';
import { HTTP_FIELDS, httpCertHost, httpExtra, httpTarget, performHttp, statusLine, validateHttp, type HttpConfig, type HttpSecrets } from './http.js';

export interface KeywordConfig extends HttpConfig {
  keyword: string;
  caseSensitive: boolean;
  invertKeyword: boolean;
}

export const keywordChecker: CheckerDefinition<KeywordConfig, HttpSecrets> = {
  type: 'keyword',
  label: 'HTTP(S) – keyword',
  description: 'Requests a URL and checks that the response contains (or does not contain) a keyword.',
  category: 'web',
  fields: [
    ...HTTP_FIELDS.slice(0, 1),
    { key: 'keyword', label: 'Keyword', kind: 'text', required: true, maxLength: 255, group: 'Response', help: 'Plain text, no regular expressions.' },
    { key: 'caseSensitive', label: 'Case sensitive', kind: 'boolean', default: true, group: 'Response' },
    { key: 'invertKeyword', label: 'Invert (DOWN when the keyword is found)', kind: 'boolean', default: false, group: 'Response' },
    ...HTTP_FIELDS.slice(1),
  ],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    const base = validateHttp(input, ctx);
    const keyword = str(input, 'keyword', { required: true, max: 255, trim: false });
    if (keyword.trim() === '') throw new ValidationError('keyword is required', 'keyword');
    return {
      config: { ...base.config, keyword, caseSensitive: bool(input, 'caseSensitive', true), invertKeyword: bool(input, 'invertKeyword') },
      secrets: base.secrets,
    };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const res = await performHttp(ctx, ctx.maxBodyBytes);
      const extra = httpExtra(res);
      const sl = statusLine(res);
      if (!codeAccepted(res.status, ctx.config.acceptedStatusCodes)) return down(sl, extra);
      const c = ctx.config;
      const text = res.body.toString('utf8');
      const found = c.caseSensitive ? text.includes(c.keyword) : text.toLowerCase().includes(c.keyword.toLowerCase());
      const where = res.truncated ? ` (first ${Math.round(res.body.length / 1024)} KiB searched)` : '';
      if (c.invertKeyword) return found ? down(`${sl}, keyword found${where}`, extra) : up(`${sl}, keyword not found${where}`, extra);
      return found ? up(`${sl}, keyword found`, extra) : down(`${sl}, keyword not found${where}`, extra);
    });
  },
  target: httpTarget,
  certHost: httpCertHost,
};
