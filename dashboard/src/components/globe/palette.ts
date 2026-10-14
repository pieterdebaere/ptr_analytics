// Theme colours read from CSS variables at runtime and normalised to RGBA so
// the canvas can derive alpha variants (CSS may use oklch, hex, rgb, ...).

export interface RGBA {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

export interface GlobePalette {
  dark: boolean;
  background: RGBA;
  foreground: RGBA;
  muted: RGBA;
  border: RGBA;
  accent: RGBA;
}

const LIGHT_FALLBACK: GlobePalette = {
  dark: false,
  background: { r: 255, g: 255, b: 255, a: 1 },
  foreground: { r: 10, g: 10, b: 10, a: 1 },
  muted: { r: 115, g: 115, b: 115, a: 1 },
  border: { r: 229, g: 229, b: 229, a: 1 },
  accent: { r: 23, g: 23, b: 23, a: 1 },
};

export function rgba(c: RGBA, alpha = 1): string {
  const a = Math.max(0, Math.min(1, c.a * alpha));
  return `rgba(${c.r},${c.g},${c.b},${Math.round(a * 1000) / 1000})`;
}

export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  const u = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
    a: a.a + (b.a - a.a) * u,
  };
}

/** WCAG relative luminance (0..1). */
export function luminance(c: RGBA): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

export function contrastRatio(a: RGBA, b: RGBA): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Parses `#rgb`, `#rrggbb(aa)` and `rgb()/rgba()` strings (what the canvas serialises to). */
export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex?.[1]) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const v = h.split('').map((x) => Number.parseInt(x + x, 16));
      return { r: v[0] ?? 0, g: v[1] ?? 0, b: v[2] ?? 0, a: v[3] === undefined ? 1 : v[3] / 255 };
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
      return { r: v[0] ?? 0, g: v[1] ?? 0, b: v[2] ?? 0, a: h.length === 8 ? (v[3] ?? 255) / 255 : 1 };
    }
    return null;
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m?.[1]) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const num = (p: string | undefined, max: number) => {
      if (p === undefined) return Number.NaN;
      return p.endsWith('%') ? (Number.parseFloat(p) / 100) * max : Number.parseFloat(p);
    };
    const r = num(parts[0], 255);
    const g = num(parts[1], 255);
    const b = num(parts[2], 255);
    const a = parts[3] === undefined ? 1 : num(parts[3], 1);
    if ([r, g, b, a].some((x) => !Number.isFinite(x))) return null;
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
  }
  return null;
}

let probe: CanvasRenderingContext2D | null | undefined;

function probeContext(): CanvasRenderingContext2D | null {
  if (probe !== undefined) return probe;
  probe = null;
  try {
    if (typeof document !== 'undefined' && !/jsdom/i.test(globalThis.navigator?.userAgent ?? '')) {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      probe = c.getContext('2d', { willReadFrequently: true });
    }
  } catch {
    probe = null;
  }
  return probe;
}

/**
 * Converts any CSS colour the browser understands (oklch, lab, color-mix, ...)
 * to sRGB by painting it on a 1×1 canvas. Returns null if unsupported.
 */
export function resolveColor(css: string): RGBA | null {
  const value = css.trim();
  if (!value) return null;
  const direct = parseColor(value);
  if (direct) return direct;
  const ctx = probeContext();
  if (!ctx) return null;
  try {
    // Sentinel: if the browser rejects the colour, fillStyle keeps this.
    ctx.fillStyle = '#010203';
    ctx.fillStyle = value;
    const serialised = String(ctx.fillStyle);
    if (serialised === '#010203') return null;
    const parsed = parseColor(serialised);
    if (parsed) return parsed;
    // Wide-gamut colours serialise as-is (oklch(...)): paint and read back.
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const a = (d[3] ?? 0) / 255;
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    // getImageData is un-premultiplied already.
    return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0, a };
  } catch {
    return null;
  }
}

function readVar(style: CSSStyleDeclaration, name: string): RGBA | null {
  const v = style.getPropertyValue(name);
  return v ? resolveColor(v) : null;
}

/** Resolves `var(--x)` / plain CSS colours against the element's computed style. */
function resolveUserColor(style: CSSStyleDeclaration, value: string | undefined): RGBA | null {
  if (!value) return null;
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value.trim());
  if (m?.[1]) return readVar(style, m[1]) ?? (m[2] ? resolveColor(m[2]) : null);
  return resolveColor(value);
}

/**
 * Reads the palette from CSS variables visible at `el` (`--background`,
 * `--foreground`, `--muted-foreground`, `--border`, accent `--chart-1`).
 * The accent falls back to the foreground when it has too little contrast
 * with the background (e.g. a light grey chart colour on a white page).
 */
export function readPalette(el: Element | null, accentOverride?: string): GlobePalette {
  if (!el || typeof getComputedStyle !== 'function') return LIGHT_FALLBACK;
  let style: CSSStyleDeclaration;
  try {
    style = getComputedStyle(el);
  } catch {
    return LIGHT_FALLBACK;
  }
  const background = readVar(style, '--background') ?? LIGHT_FALLBACK.background;
  const foreground = readVar(style, '--foreground') ?? LIGHT_FALLBACK.foreground;
  const muted = readVar(style, '--muted-foreground') ?? mix(background, foreground, 0.5);
  let border = readVar(style, '--border') ?? mix(background, foreground, 0.12);
  // Borders may be translucent (dark theme: white / 10%): flatten onto the background.
  if (border.a < 1) border = { ...mix(background, { ...border, a: 1 }, border.a), a: 1 };
  const dark = luminance(background) < 0.4;

  let accent = resolveUserColor(style, accentOverride) ?? readVar(style, '--chart-1');
  if (!accent || accent.a === 0 || (!accentOverride && contrastRatio(accent, background) < 2.2)) accent = foreground;
  return { dark, background, foreground, muted, border, accent };
}

export function paletteKey(p: GlobePalette): string {
  return [p.background, p.foreground, p.muted, p.border, p.accent].map((c) => rgba(c)).join('|');
}
