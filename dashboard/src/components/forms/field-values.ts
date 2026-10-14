// Pure helpers behind <FieldDefForm>: initial values, visibility (showIf / hosted),
// client-side validation and the payload sent to the API.
//
// Value shapes per kind:
//   text | url | host | textarea | select  -> string
//   number                                 -> number | undefined (empty input)
//   boolean                                -> boolean
//   list | statuscodes                     -> string[]
//   keyvalue                               -> Array<{ key: string; value: string }>
// Secret fields (`secret: true`, kind `password`) are never prefilled:
//   undefined | ""  -> keep the stored value (omitted from the payload)
//   null            -> clear the stored value (sent as null)
//   string          -> replace the stored value
// Secret key/value fields (e.g. `secretHeaders`): the names are stored in the config, the
// values are write-only (`secretsSet` lists "<field>.<name>"). Rows are prefilled with the
// names and an empty value; a row with value "" keeps that stored value, `[]`/null clears all,
// undefined (field omitted) keeps everything.
import type { FieldDef } from '@/api/uptime';

export type FieldValues = Record<string, unknown>;
export interface KeyValueRow {
  key: string;
  value: string;
}

export function isSecretField(f: FieldDef): boolean {
  return f.secret === true || f.kind === 'password';
}

/** Whether a stored secret exists for the field (or, for key/value secrets, for one of its rows). */
export function hasStoredSecret(key: string, secretsSet: readonly string[]): boolean {
  return secretsSet.some((s) => s === key || s.startsWith(`${key}.`));
}

/** Stored value exists for row `name` of a secret key/value field. */
export function isRowSecretSet(key: string, name: string, secretsSet: readonly string[]): boolean {
  return name !== '' && (secretsSet.includes(`${key}.${name}`) || secretsSet.includes(`${key}.${name.toLowerCase()}`));
}

const STATUS_CODE_RE = /^[1-5]\d{2}(?:-[1-5]\d{2})?$/;

export function isStatusCodeRange(v: string): boolean {
  if (!STATUS_CODE_RE.test(v)) return false;
  const [a, b] = v.split('-').map(Number);
  return b === undefined || (a !== undefined && a <= b);
}

function emptyValue(f: FieldDef): unknown {
  switch (f.kind) {
    case 'boolean':
      return false;
    case 'list':
    case 'statuscodes':
    case 'keyvalue':
      return [];
    case 'number':
      return undefined;
    case 'select':
      return f.options?.[0]?.value ?? '';
    default:
      return '';
  }
}

/** Coerces a stored/default value to the shape the editor for `f` expects (or undefined). */
function coerce(f: FieldDef, v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  switch (f.kind) {
    case 'boolean':
      return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case 'list':
    case 'statuscodes':
      if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
      if (typeof v === 'string') return v.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
      return undefined;
    case 'keyvalue':
      if (Array.isArray(v)) {
        return v
          .filter((r): r is Record<string, unknown> | string => (typeof r === 'object' && r !== null) || typeof r === 'string')
          .map((r) =>
            typeof r === 'string'
              ? { key: r, value: '' }
              : { key: String(r.key ?? r.name ?? ''), value: typeof r.value === 'string' ? r.value : r.value === undefined || r.value === null ? '' : String(r.value) },
          );
      }
      if (typeof v === 'object') {
        return Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value ?? '') }));
      }
      return undefined;
    case 'select': {
      const s = String(v);
      return f.options && f.options.length > 0 && !f.options.some((o) => o.value === s) ? undefined : s;
    }
    default:
      return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
  }
}

/**
 * Editor values for `fields` from a stored config (edit) or the field defaults (create).
 * Secret fields always start empty (undefined = keep).
 */
export function initialFieldValues(fields: readonly FieldDef[], config?: Record<string, unknown> | null): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    if (isSecretField(f)) {
      // key/value secrets: names are not secret -> rows with empty (= keep) values
      const rows = f.kind === 'keyvalue' && config ? coerce(f, config[f.key]) : undefined;
      out[f.key] = Array.isArray(rows) && rows.length > 0 ? rows.map((r: KeyValueRow) => ({ key: r.key, value: '' })) : undefined;
      continue;
    }
    const stored = config ? coerce(f, config[f.key]) : undefined;
    const def = coerce(f, f.default);
    out[f.key] = stored !== undefined ? stored : def !== undefined ? def : emptyValue(f);
  }
  return out;
}

function matches(v: unknown, equals: ReadonlyArray<string | number | boolean>): boolean {
  return equals.some((e) => e === v || (v !== undefined && v !== null && typeof v !== 'object' && String(e) === String(v)));
}

/**
 * Whether a field is shown: not `selfHostedOnly` in hosted mode, and its `showIf`
 * condition holds (the controlling field must itself be visible).
 */
export function isFieldVisible(field: FieldDef, fields: readonly FieldDef[], values: FieldValues, hosted = false, depth = 0): boolean {
  if (hosted && field.selfHostedOnly) return false;
  if (!field.showIf) return true;
  if (depth > 8) return false;
  const ctrl = fields.find((f) => f.key === field.showIf!.key);
  if (ctrl && !isFieldVisible(ctrl, fields, values, hosted, depth + 1)) return false;
  return matches(values[field.showIf.key], field.showIf.equals);
}

export function visibleFields(fields: readonly FieldDef[], values: FieldValues, hosted = false): FieldDef[] {
  return fields.filter((f) => isFieldVisible(f, fields, values, hosted));
}

function cleanRows(rows: unknown): KeyValueRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is KeyValueRow => typeof r === 'object' && r !== null)
    .map((r) => ({ key: String(r.key ?? '').trim(), value: String(r.value ?? '') }))
    .filter((r) => r.key !== '' || r.value !== '');
}

function cleanList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
}

/**
 * The `config` payload for the API: only visible fields, normalised values, and the
 * write-only secret semantics (keep = omitted, clear = null).
 */
export function fieldValuesToConfig(fields: readonly FieldDef[], values: FieldValues, hosted = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of visibleFields(fields, values, hosted)) {
    const v = values[f.key];
    if (isSecretField(f)) {
      if (v === null) out[f.key] = null;
      else if (f.kind === 'keyvalue') {
        if (Array.isArray(v)) out[f.key] = cleanRows(v);
      } else if (typeof v === 'string' && v !== '') out[f.key] = v;
      continue;
    }
    switch (f.kind) {
      case 'number':
        if (typeof v === 'number' && Number.isFinite(v)) out[f.key] = v;
        break;
      case 'boolean':
        out[f.key] = v === true;
        break;
      case 'list':
      case 'statuscodes':
        out[f.key] = cleanList(v);
        break;
      case 'keyvalue':
        out[f.key] = cleanRows(v);
        break;
      case 'url':
      case 'host':
        out[f.key] = typeof v === 'string' ? v.trim() : '';
        break;
      default:
        out[f.key] = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
    }
  }
  return out;
}

function isBlank(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** Client-side checks mirroring the FieldDef constraints. Returns `{key: message}`. */
export function validateFieldValues(
  fields: readonly FieldDef[],
  values: FieldValues,
  opts: { hosted?: boolean; secretsSet?: readonly string[] } = {},
): Record<string, string> {
  const errors: Record<string, string> = {};
  const secretsSet = new Set(opts.secretsSet ?? []);
  for (const f of visibleFields(fields, values, opts.hosted)) {
    const v = values[f.key];
    if (isSecretField(f)) {
      const stored = hasStoredSecret(f.key, [...secretsSet]);
      if (f.kind === 'keyvalue') {
        const rows = v === undefined ? null : cleanRows(v);
        if (f.required && (v === null || (rows !== null && rows.length === 0) || (rows === null && !stored))) errors[f.key] = `${f.label} is required.`;
        else if (rows?.some((r) => r.key === '')) errors[f.key] = 'Every entry needs a name.';
        else if (rows?.some((r) => r.value === '' && !isRowSecretSet(f.key, r.key, [...secretsSet]))) errors[f.key] = 'Enter a value for every new entry.';
        continue;
      }
      const keeps = (v === undefined || v === '') && stored;
      if (f.required && !keeps && (v === null || isBlank(v))) {
        errors[f.key] = `${f.label} is required.`;
      } else if (typeof v === 'string' && f.maxLength !== undefined && v.length > f.maxLength) {
        errors[f.key] = `At most ${f.maxLength} characters.`;
      }
      continue;
    }
    if (f.kind === 'boolean') continue;
    if (f.kind === 'number') {
      if (v === undefined || v === null || v === '') {
        if (f.required) errors[f.key] = `${f.label} is required.`;
        continue;
      }
      if (typeof v !== 'number' || !Number.isFinite(v)) errors[f.key] = 'Enter a number.';
      else if (f.min !== undefined && v < f.min) errors[f.key] = `Must be at least ${f.min}.`;
      else if (f.max !== undefined && v > f.max) errors[f.key] = `Must be at most ${f.max}.`;
      continue;
    }
    if (f.kind === 'list' || f.kind === 'statuscodes') {
      const list = cleanList(v);
      if (f.required && list.length === 0) errors[f.key] = `${f.label} is required.`;
      else if (f.kind === 'statuscodes') {
        const bad = list.find((s) => !isStatusCodeRange(s));
        if (bad !== undefined) errors[f.key] = `“${bad.slice(0, 20)}” is not a status code or range (e.g. 200-299).`;
      } else if (f.max !== undefined && list.length > f.max) errors[f.key] = `At most ${f.max} entries.`;
      continue;
    }
    if (f.kind === 'keyvalue') {
      const rows = cleanRows(v);
      if (f.required && rows.length === 0) errors[f.key] = `${f.label} is required.`;
      else if (rows.some((r) => r.key === '')) errors[f.key] = 'Every entry needs a name.';
      continue;
    }
    const s = typeof v === 'string' ? v : '';
    if (f.required && s.trim() === '') {
      errors[f.key] = `${f.label} is required.`;
      continue;
    }
    if (s === '') continue;
    if (f.maxLength !== undefined && s.length > f.maxLength) {
      errors[f.key] = `At most ${f.maxLength} characters.`;
      continue;
    }
    if (f.kind === 'url') {
      try {
        const u = new URL(s.trim());
        if (!u.host && !/^[a-z][a-z0-9+.-]*:/.test(u.protocol)) errors[f.key] = 'Enter a valid URL.';
      } catch {
        errors[f.key] = 'Enter a valid URL (including https://).';
      }
    } else if (f.kind === 'host') {
      if (/[\s/]/.test(s.trim())) errors[f.key] = 'Enter a host name or IP address only (no scheme or path).';
    } else if (f.kind === 'select' && f.options && f.options.length > 0 && !f.options.some((o) => o.value === s)) {
      errors[f.key] = 'Pick one of the options.';
    }
  }
  return errors;
}

/** Fields grouped for rendering: ungrouped first, then groups in order of first appearance. */
export function groupFields(fields: readonly FieldDef[]): Array<{ group: string | null; fields: FieldDef[] }> {
  const out: Array<{ group: string | null; fields: FieldDef[] }> = [];
  const ungrouped = fields.filter((f) => !f.group);
  if (ungrouped.length) out.push({ group: null, fields: ungrouped });
  for (const f of fields) {
    if (!f.group) continue;
    let g = out.find((x) => x.group === f.group);
    if (!g) {
      g = { group: f.group, fields: [] };
      out.push(g);
    }
    g.fields.push(f);
  }
  return out;
}
