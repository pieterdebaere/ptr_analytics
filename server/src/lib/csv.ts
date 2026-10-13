/**
 * Cells a spreadsheet may evaluate as a formula: `= + - @` (also their full-width forms
 * U+FF1D U+FF0B U+FF0D U+FF20, which some spreadsheet apps normalise), tab / CR, and any
 * other leading control character (NUL etc.).
 */
// eslint-disable-next-line no-control-regex
const FORMULA_START = /^[=+\-@\u0000-\u001f\u007f\uff1d\uff0b\uff0d\uff20]/;

/** Escape one CSV cell: neutralise spreadsheet formulas and quote when needed. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(values: ReadonlyArray<string | number | null | undefined>): string {
  return values.map(csvCell).join(',') + '\r\n';
}
