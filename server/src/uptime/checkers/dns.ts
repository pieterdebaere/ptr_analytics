// `dns`: queries a record set from a specific resolver (IP literal; public IPs only for hosted
// members) with our own wire-format client and compares it with expected values.
import { ValidationError, type CheckerDefinition } from '../types.js';
import { QUERY_TYPES, parseIp } from '../net/index.js';
import { normalizeQueryName } from '../net/dns-wire.js';
import { formatIp } from '../net/ip.js';
import { clip, down, guarded, list, ms, oneOf, policyFor, port, str, up } from './common.js';

export interface DnsConfig {
  host: string;
  recordType: (typeof QUERY_TYPES)[number];
  resolver: string;
  port: number;
  expected: string[];
  matchMode: 'any' | 'all' | 'none';
}

/** Normalises a record value for comparison: lower case, collapsed blanks, no trailing dots. */
export function normalizeRecordValue(type: string, value: string): string {
  if (type === 'A' || type === 'AAAA') {
    const ip = parseIp(value.trim());
    return ip ? formatIp(ip) : value.trim().toLowerCase();
  }
  if (type === 'TXT') return value;
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((p) => (p.length > 1 && p.endsWith('.') ? p.slice(0, -1) : p))
    .join(' ')
    .toLowerCase();
}

function matches(type: string, value: string, expected: string): boolean {
  const v = normalizeRecordValue(type, value);
  const e = normalizeRecordValue(type, expected);
  if (v === e) return true;
  // MX / SRV: allow comparing the target name only.
  if (type === 'MX' || type === 'SRV') return v.split(' ').pop() === e;
  return false;
}

export const dnsChecker: CheckerDefinition<DnsConfig, Record<string, never>> = {
  type: 'dns',
  label: 'DNS record',
  description: 'Queries a DNS record from a resolver and optionally compares the answer with expected values.',
  category: 'network',
  fields: [
    { key: 'host', label: 'Name to query', kind: 'text', required: true, maxLength: 253, placeholder: 'example.com', group: 'Query', help: 'For PTR records an IP address.' },
    {
      key: 'recordType',
      label: 'Record type',
      kind: 'select',
      default: 'A',
      group: 'Query',
      options: QUERY_TYPES.map((t) => ({ value: t, label: t })),
    },
    { key: 'resolver', label: 'Resolver (IP address)', kind: 'text', required: true, default: '1.1.1.1', maxLength: 45, group: 'Query' },
    { key: 'port', label: 'Resolver port', kind: 'number', default: 53, min: 1, max: 65535, group: 'Query' },
    {
      key: 'expected',
      label: 'Expected values',
      kind: 'list',
      group: 'Expectation',
      help: 'One per line, e.g. 93.184.216.34 or "10 mail.example.com" (MX: the host name alone also matches). Empty: any answer is UP.',
    },
    {
      key: 'matchMode',
      label: 'Match',
      kind: 'select',
      default: 'any',
      group: 'Expectation',
      options: [
        { value: 'any', label: 'At least one expected value is present' },
        { value: 'all', label: 'All expected values are present' },
        { value: 'none', label: 'None of the expected values is present' },
      ],
    },
  ],
  defaults: { intervalS: 300, timeoutMs: 5_000, retries: 1 },
  hosted: 'restricted',
  validate(input, ctx) {
    const recordType = oneOf(input, 'recordType', QUERY_TYPES, 'A');
    const hostRaw = str(input, 'host', { required: true, max: 253 });
    let host: string;
    if (recordType === 'PTR' && parseIp(hostRaw)) host = formatIp(parseIp(hostRaw)!);
    else {
      const n = normalizeQueryName(hostRaw);
      if (!n) throw new ValidationError('host must be a valid DNS name', 'host');
      host = n;
    }
    const resolverRaw = str(input, 'resolver', { required: true, max: 47, def: '1.1.1.1' });
    const rip = parseIp(resolverRaw);
    if (!rip) throw new ValidationError('resolver must be an IP address', 'resolver');
    if (!policyFor(ctx).checkIp(rip).ok) throw new ValidationError('target not allowed', 'resolver');
    const expected = list(input, 'expected', { maxItems: 50, maxLength: 1024 });
    return {
      config: {
        host,
        recordType,
        resolver: formatIp(rip),
        port: port(input, 'port', 53),
        expected,
        matchMode: oneOf(input, 'matchMode', ['any', 'all', 'none'] as const, 'any'),
      },
      secrets: {},
    };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const c = ctx.config;
      const r = await ctx.net.dnsQuery({ server: c.resolver, port: c.port, name: c.host, type: c.recordType, signal: ctx.signal });
      const extra = { latencyMs: ms(r.latencyMs), meta: { rcode: r.rcode } };
      if (r.rcode !== 'NOERROR') return down(`DNS ${r.rcode}`, extra);
      const answers = r.answers.filter((a) => a.type === c.recordType);
      const summary = clip(answers.map((a) => a.value).join(' | '), 150);
      if (c.expected.length === 0) {
        return answers.length > 0 ? up(`Records: ${summary}`, extra) : down(`No ${c.recordType} records`, extra);
      }
      const present = c.expected.filter((e) => answers.some((a) => matches(c.recordType, a.value, e)));
      if (c.matchMode === 'any') return present.length > 0 ? up(`Records: ${summary}`, extra) : down(`No expected record found. Records: ${summary || 'none'}`, extra);
      if (c.matchMode === 'all') {
        const missing = c.expected.length - present.length;
        return missing === 0 ? up(`Records: ${summary}`, extra) : down(`${missing} expected record(s) missing. Records: ${summary || 'none'}`, extra);
      }
      return present.length === 0 ? up(`Records: ${summary || 'none'}`, extra) : down(`Unwanted record present. Records: ${summary}`, extra);
    });
  },
  target: (c) => `${c.host} ${c.recordType} @${c.resolver}`,
};
