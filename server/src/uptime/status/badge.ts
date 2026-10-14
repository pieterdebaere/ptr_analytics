// Shields-style SVG badges without dependencies (ANALYSIS §5.3, §8.7.5). All text is
// XML-escaped and length limited; colours only come from a fixed palette; widths are
// computed from a Verdana advance-width table.

export const BADGE_STYLES = ['flat', 'flat-square', 'for-the-badge'] as const;
export type BadgeStyle = (typeof BADGE_STYLES)[number];

export const PALETTE = {
  green: '#4c1',
  yellowgreen: '#a4a61d',
  yellow: '#dfb317',
  orange: '#fe7d37',
  red: '#e05d44',
  blue: '#007ec6',
  maintenance: '#1747f5',
  grey: '#9f9f9f',
  label: '#555',
} as const;
export type BadgeColor = keyof typeof PALETTE;

export const MAX_BADGE_TEXT = 64;

// Verdana advance widths (font units, 2048 per em) for U+0020..U+007E.
const VERDANA = [
  720, 806, 940, 1716, 1302, 2223, 1486, 550, 909, 909, 1302, 1716, 745, 930, 745, 1269, // ' '..'/'
  1302, 1302, 1302, 1302, 1302, 1302, 1302, 1302, 1302, 1302, 909, 909, 1716, 1716, 1716, 1112, // '0'..'?'
  2043, 1401, 1405, 1430, 1580, 1294, 1178, 1583, 1540, 862, 931, 1418, 1141, 1736, 1532, 1608, // '@'..'O'
  1238, 1608, 1424, 1401, 1255, 1499, 1401, 2025, 1403, 1255, 1403, 909, 1269, 909, 1716, 1302, // 'P'..'_'
  1302, 1229, 1271, 1067, 1271, 1219, 720, 1271, 1293, 562, 676, 1186, 562, 1985, 1293, 1235, // '`'..'o'
  1271, 1271, 874, 1067, 807, 1293, 1186, 1669, 1186, 1186, 1048, 1302, 909, 1302, 1716, // 'p'..'~'
];
const DEFAULT_WIDTH = 1302;

/** Rendered width in px of `text` in Verdana at `size` px. */
export function textWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    units += c >= 0x20 && c <= 0x7e ? (VERDANA[c - 0x20] as number) : c > 0x2e80 ? 2048 : DEFAULT_WIDTH;
  }
  return (units / 2048) * size;
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);
}

// eslint-disable-next-line no-control-regex
const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿\ud800-\udfff]/;

/** Validate a user-supplied label: ≤ 64 code points, no control / bidi / format characters. */
export function validLabel(v: string): boolean {
  return [...v].length <= MAX_BADGE_TEXT && !UNSAFE_RE.test(v);
}

function clip(s: string): string {
  const cps = [...s.replace(new RegExp(UNSAFE_RE.source, 'g'), '')];
  return cps.length > MAX_BADGE_TEXT ? `${cps.slice(0, MAX_BADGE_TEXT - 1).join('')}…` : cps.join('');
}

export interface BadgeSpec {
  label: string;
  message: string;
  color: BadgeColor;
  style: BadgeStyle;
}

/** Render a badge. Every piece of text is escaped; colours come from PALETTE only. */
export function renderBadge(spec: BadgeSpec): string {
  const big = spec.style === 'for-the-badge';
  const label = clip(big ? spec.label.toUpperCase() : spec.label);
  const message = clip(big ? spec.message.toUpperCase() : spec.message);
  const color = PALETTE[spec.color] ?? PALETTE.grey;
  const fontSize = big ? 10 : 11;
  const height = big ? 28 : 20;
  const pad = big ? 12 : 6;
  const spacing = big ? 1.25 : 0;
  const w = (t: string): number => Math.round(textWidth(t, fontSize) + spacing * [...t].length);
  const lw = label === '' ? 0 : w(label) + pad * 2;
  const mw = w(message) + pad * 2;
  const total = lw + mw;
  const aria = escapeXml(label === '' ? message : `${label}: ${message}`);
  const l = escapeXml(label);
  const m = escapeXml(message);
  const font = 'font-family="Verdana,Geneva,DejaVu Sans,sans-serif"';
  const ls = big ? ' letter-spacing="1.25"' : '';
  const weight = big ? ' font-weight="bold"' : '';
  const rx = spec.style === 'flat' ? 3 : 0;
  const ty = big ? 18 : 14;
  const shadow = spec.style === 'flat';
  const text = (x: number, s: string): string =>
    (shadow ? `<text x="${x}" y="${ty + 1}" fill="#010101" fill-opacity=".3">${s}</text>` : '') + `<text x="${x}" y="${ty}">${s}</text>`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${height}" role="img" aria-label="${aria}">`,
    `<title>${aria}</title>`,
  ];
  if (shadow) {
    parts.push(
      '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>',
    );
  }
  parts.push(
    `<clipPath id="r"><rect width="${total}" height="${height}" rx="${rx}" fill="#fff"/></clipPath>`,
    '<g clip-path="url(#r)">',
    lw > 0 ? `<rect width="${lw}" height="${height}" fill="${PALETTE.label}"/>` : '',
    `<rect x="${lw}" width="${mw}" height="${height}" fill="${color}"/>`,
    shadow ? `<rect width="${total}" height="${height}" fill="url(#s)"/>` : '',
    '</g>',
    `<g fill="#fff" text-anchor="middle" ${font} font-size="${fontSize}"${weight}${ls}>`,
    lw > 0 ? text(lw / 2, l) : '',
    text(lw + mw / 2, m),
    '</g></svg>',
  );
  return parts.join('');
}

/** Colour for an uptime ratio. */
export function uptimeColor(ratio: number | null): BadgeColor {
  if (ratio === null) return 'grey';
  if (ratio >= 0.999) return 'green';
  if (ratio >= 0.99) return 'yellowgreen';
  if (ratio >= 0.95) return 'yellow';
  if (ratio >= 0.9) return 'orange';
  return 'red';
}

/** "99.95%" — never rounds a non-perfect uptime up to 100%. */
export function formatPercent(ratio: number): string {
  const p = Math.floor(ratio * 10000) / 100;
  return `${p === 100 ? '100' : p.toFixed(2)}%`;
}
