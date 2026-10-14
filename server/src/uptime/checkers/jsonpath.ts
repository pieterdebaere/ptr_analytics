// Restricted JSON path subset for the `json` monitor (no JSONata, no eval, no regex, no recursion):
//   $                 the document
//   .name / ['name']  object member (own properties only)
//   [3] / [-1]        array element (negative = from the end)
//   .length()         length of an array / string, number of keys of an object (last segment only)
// At most 32 segments, 255 characters.

export type Segment = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'length' };

export class JsonPathError extends Error {
  override name = 'JsonPathError';
}

export const JSON_OPERATORS = ['==', '!=', '<', '<=', '>', '>=', 'contains', 'exists'] as const;
export type JsonOperator = (typeof JSON_OPERATORS)[number];

export function parseJsonPath(input: string): Segment[] {
  let s = input.trim();
  if (s.length === 0 || s.length > 255) throw new JsonPathError('path must be 1–255 characters');
  if (!s.startsWith('$')) s = s.startsWith('[') ? `$${s}` : `$.${s}`;
  const segs: Segment[] = [];
  let i = 1;
  while (i < s.length) {
    if (segs.length >= 32) throw new JsonPathError('path is too deep (max 32 segments)');
    if (segs.some((x) => x.kind === 'length')) throw new JsonPathError('length() must be the last segment');
    const c = s[i];
    if (c === '.') {
      const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(s.slice(i + 1));
      if (!m) throw new JsonPathError(`invalid member name at position ${i + 1}`);
      i += 1 + m[0].length;
      if (m[0] === 'length' && s.startsWith('()', i)) {
        i += 2;
        segs.push({ kind: 'length' });
      } else {
        segs.push({ kind: 'key', key: m[0] });
      }
    } else if (c === '[') {
      const rest = s.slice(i + 1);
      const num = /^(-?\d{1,9})\]/.exec(rest);
      if (num) {
        segs.push({ kind: 'index', index: Number(num[1]) });
        i += 1 + num[0].length;
        continue;
      }
      const q = rest[0];
      if (q !== '"' && q !== "'") throw new JsonPathError(`expected index or quoted name at position ${i + 1}`);
      let j = 1;
      let key = '';
      for (;;) {
        if (j >= rest.length) throw new JsonPathError('unterminated quoted name');
        const ch = rest[j]!;
        if (ch === '\\') {
          const nx = rest[j + 1];
          if (nx !== q && nx !== '\\') throw new JsonPathError('invalid escape in quoted name');
          key += nx;
          j += 2;
          continue;
        }
        if (ch === q) break;
        key += ch;
        j++;
      }
      if (rest[j + 1] !== ']') throw new JsonPathError('expected ]');
      segs.push({ kind: 'key', key });
      i += 1 + j + 2;
    } else {
      throw new JsonPathError(`unexpected character at position ${i}`);
    }
  }
  return segs;
}

export function evaluateJsonPath(doc: unknown, segs: Segment[]): { found: boolean; value: unknown } {
  let cur: unknown = doc;
  for (const seg of segs) {
    if (seg.kind === 'length') {
      if (typeof cur === 'string' || Array.isArray(cur)) return { found: true, value: cur.length };
      if (cur && typeof cur === 'object') return { found: true, value: Object.keys(cur).length };
      return { found: false, value: undefined };
    }
    if (seg.kind === 'index') {
      if (!Array.isArray(cur)) return { found: false, value: undefined };
      const idx = seg.index < 0 ? cur.length + seg.index : seg.index;
      if (idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
      continue;
    }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg.key)) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[seg.key];
  }
  return { found: true, value: cur };
}

function asString(v: unknown): string | null {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v.trim())) return Number(v);
  return null;
}

/** Compares without echoing the value (response bodies never go into messages). */
export function compareJson(found: boolean, value: unknown, op: JsonOperator, expected: string): { ok: boolean; reason: string } {
  if (op === 'exists') return found ? { ok: true, reason: 'path exists' } : { ok: false, reason: 'path not found' };
  if (!found) return { ok: false, reason: 'path not found' };
  if (op === 'contains') {
    if (typeof value === 'string') return { ok: value.includes(expected), reason: value.includes(expected) ? 'value contains the expected text' : 'value does not contain the expected text' };
    if (Array.isArray(value)) {
      const ok = value.some((el) => asString(el) === expected);
      return { ok, reason: ok ? 'array contains the expected value' : 'array does not contain the expected value' };
    }
    return { ok: false, reason: 'value is not a string or array' };
  }
  if (op === '==' || op === '!=') {
    const s = asString(value);
    if (s === null) return { ok: false, reason: 'value is an object or array' };
    const en = asNumber(expected);
    const eq = typeof value === 'number' && en !== null ? value === en : s === expected;
    const ok = op === '==' ? eq : !eq;
    return { ok, reason: ok ? `value ${op} expected` : `value ${op === '==' ? '!=' : '=='} expected` };
  }
  const a = asNumber(value);
  const b = asNumber(expected);
  if (a === null) return { ok: false, reason: 'value is not a number' };
  if (b === null) return { ok: false, reason: 'expected value is not a number' };
  const ok = op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  return { ok, reason: ok ? `value ${op} ${b}` : `value is not ${op} ${b}` };
}
