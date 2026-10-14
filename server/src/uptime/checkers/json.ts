// `json`: HTTP request + restricted JSON path evaluation (jsonpath.ts) compared with an expected
// value. The actual value is never put into the message (response data stays private).
import { ValidationError, type CheckerDefinition } from '../types.js';
import { codeAccepted, down, guarded, oneOf, str, up } from './common.js';
import { HTTP_FIELDS, httpCertHost, httpExtra, httpTarget, performHttp, statusLine, validateHttp, type HttpConfig, type HttpSecrets } from './http.js';
import { JSON_OPERATORS, JsonPathError, compareJson, evaluateJsonPath, parseJsonPath, type JsonOperator } from './jsonpath.js';

export interface JsonConfig extends HttpConfig {
  jsonPath: string;
  jsonOperator: JsonOperator;
  expectedValue: string;
}

export const jsonChecker: CheckerDefinition<JsonConfig, HttpSecrets> = {
  type: 'json',
  label: 'HTTP(S) – JSON query',
  description: 'Requests a URL, evaluates a JSON path on the response and compares it with an expected value.',
  category: 'web',
  fields: [
    ...HTTP_FIELDS.slice(0, 1),
    {
      key: 'jsonPath',
      label: 'JSON path',
      kind: 'text',
      required: true,
      default: '$',
      maxLength: 255,
      placeholder: '$.status',
      group: 'Response',
      help: 'Subset: $.a.b, $["key"], $.items[0], $.items[-1], $.items.length(). No expressions.',
    },
    {
      key: 'jsonOperator',
      label: 'Condition',
      kind: 'select',
      default: '==',
      group: 'Response',
      options: JSON_OPERATORS.map((o) => ({ value: o, label: o })),
    },
    { key: 'expectedValue', label: 'Expected value', kind: 'text', maxLength: 255, group: 'Response', showIf: { key: 'jsonOperator', equals: JSON_OPERATORS.filter((o) => o !== 'exists') } },
    ...HTTP_FIELDS.slice(1),
  ],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    const base = validateHttp(input, ctx);
    const jsonPath = str(input, 'jsonPath', { required: true, max: 255, def: '$' });
    try {
      parseJsonPath(jsonPath);
    } catch (err) {
      throw new ValidationError(`jsonPath: ${(err as Error).message}`, 'jsonPath');
    }
    const jsonOperator = oneOf(input, 'jsonOperator', JSON_OPERATORS, '==');
    const expectedValue = str(input, 'expectedValue', { max: 255, trim: false });
    if (['<', '<=', '>', '>='].includes(jsonOperator) && !Number.isFinite(Number(expectedValue.trim())) ) {
      throw new ValidationError('expectedValue must be a number for this condition', 'expectedValue');
    }
    if (expectedValue.trim() === '' && ['<', '<=', '>', '>=', 'contains'].includes(jsonOperator)) throw new ValidationError('expectedValue is required', 'expectedValue');
    return { config: { ...base.config, jsonPath, jsonOperator, expectedValue: jsonOperator === 'exists' ? '' : expectedValue }, secrets: base.secrets };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const res = await performHttp(ctx, ctx.maxBodyBytes);
      const extra = httpExtra(res);
      const sl = statusLine(res);
      if (!codeAccepted(res.status, ctx.config.acceptedStatusCodes)) return down(sl, extra);
      if (res.truncated) return down(`${sl}, response too large for JSON evaluation`, extra);
      let doc: unknown;
      try {
        doc = JSON.parse(res.body.toString('utf8'));
      } catch {
        return down(`${sl}, response is not valid JSON`, extra);
      }
      let segs;
      try {
        segs = parseJsonPath(ctx.config.jsonPath);
      } catch (err) {
        if (err instanceof JsonPathError) return down(`Invalid JSON path: ${err.message}`, extra);
        throw err;
      }
      const r = evaluateJsonPath(doc, segs);
      const cmp = compareJson(r.found, r.value, ctx.config.jsonOperator, ctx.config.expectedValue);
      const label = ctx.config.jsonPath.slice(0, 80);
      return cmp.ok ? up(`${sl}, JSON query passes (${label}: ${cmp.reason})`, extra) : down(`${sl}, JSON query failed (${label}: ${cmp.reason})`, extra);
    });
  },
  target: httpTarget,
  certHost: httpCertHost,
};
