// Raster logo validation by content (ANALYSIS §8.7.4): PNG, JPEG or WebP detected by magic
// bytes and structurally parsed end to end (PNG: every chunk with a correct CRC up to IEND at
// the very end; JPEG: every segment and the entropy-coded scans up to EOI at the very end;
// WebP: every RIFF chunk up to the declared size), sane dimensions; SVG and anything with
// embedded markup (HTML/SVG/XML polyglots) is refused. The declared Content-Type is never
// trusted. Defence in depth only: logos are always served with the sniffed raster type,
// nosniff and a sandboxing CSP.

export const MAX_LOGO_BYTES = 512 * 1024;
export const MAX_LOGO_DIMENSION = 2048;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface SniffedImage {
  mime: ImageMime;
  width: number;
  height: number;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Markup that turns an "image" into an HTML/SVG/XML polyglot if ever sniffed as a document. */
// Only tags of 3+ letters: shorter patterns would match random compressed bytes too often.
const MARKUP_RE =
  /<(?:script|html|svg|body|head|meta|style|iframe|frame|object|embed|img|image|video|audio|form|link|base|math|template|a\s+href|!doctype|!--|\?xml|!\[cdata\[)|javascript:|vbscript:|\bon(?:error|load|click|focus|mouse\w+|pointer\w+|animation\w+|begin|end)\s*=/i;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC-32 (PNG / zlib polynomial). */
export function crc32(b: Buffer): number {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = (CRC_TABLE[(c ^ (b[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function png(b: Buffer): SniffedImage | null {
  if (b.length < 8 + 25 + 12 || !b.subarray(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let first = true;
  let chunks = 0;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || len > b.length || off + 12 + len > b.length) return null;
    if (crc32(b.subarray(off + 4, off + 8 + len)) !== b.readUInt32BE(off + 8 + len)) return null;
    if (first) {
      if (type !== 'IHDR' || len !== 13) return null;
      width = b.readUInt32BE(off + 8);
      height = b.readUInt32BE(off + 12);
      first = false;
    }
    off += 12 + len;
    if (++chunks > 10_000) return null;
    if (type === 'IEND') return off === b.length ? { mime: 'image/png', width, height } : null;
  }
  return null;
}

function jpeg(b: Buffer): SniffedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
  let off = 2;
  let width = 0;
  let height = 0;
  let scans = 0;
  while (off + 2 <= b.length) {
    if (b[off] !== 0xff) return null;
    const marker = b[off + 1] as number;
    if (marker === 0xff) {
      off++;
      continue;
    }
    if (marker === 0xd9) {
      // EOI: only valid after a scan, and only as the very last bytes.
      return scans > 0 && off + 2 === b.length && width > 0 && height > 0 ? { mime: 'image/jpeg', width, height } : null;
    }
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2;
      continue;
    }
    if (off + 4 > b.length) return null;
    const len = b.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > b.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 7) return null;
      height = b.readUInt16BE(off + 5);
      width = b.readUInt16BE(off + 7);
    }
    off += 2 + len;
    if (marker === 0xda) {
      // Start of scan: entropy-coded data up to the next marker. Inside it, 0xFF is only
      // followed by 0x00 (stuffing), a restart marker or fill bytes; anything else starts the
      // next segment (progressive JPEGs have several scans).
      if (width === 0 || height === 0) return null;
      scans++;
      while (off < b.length) {
        if (b[off] !== 0xff) {
          off++;
          continue;
        }
        const next = b[off + 1];
        if (next === undefined) return null;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          off += 2;
          continue;
        }
        if (next === 0xff) {
          off++;
          continue;
        }
        break;
      }
    }
  }
  return null;
}

/** Every RIFF chunk (fourcc, LE size, data, pad byte) must line up exactly with the file end. */
function riffChunksValid(b: Buffer): boolean {
  let off = 12;
  let chunks = 0;
  while (off < b.length) {
    if (off + 8 > b.length || ++chunks > 1000) return false;
    if (!/^[A-Z0-9 ]{4}$/i.test(b.toString('latin1', off, off + 4))) return false;
    const size = b.readUInt32LE(off + 4);
    const next = off + 8 + size + (size & 1);
    if (next > b.length + (size & 1)) return false;
    off = next;
  }
  return off === b.length || off === b.length + 1;
}

function webp(b: Buffer): SniffedImage | null {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  if (b.readUInt32LE(4) + 8 !== b.length || !riffChunksValid(b)) return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + b.readUIntLE(24, 3);
    const height = 1 + b.readUIntLE(27, 3);
    return { mime: 'image/webp', width, height };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/**
 * Identify a logo upload. Returns null for anything that is not a well-formed PNG, JPEG or
 * WebP within the size/dimension limits, and for files carrying markup (SVG, HTML polyglots).
 */
export function sniffImage(b: Buffer): SniffedImage | null {
  if (b.length === 0 || b.length > MAX_LOGO_BYTES) return null;
  const img = png(b) ?? jpeg(b) ?? webp(b);
  if (!img) return null;
  if (img.width < 1 || img.height < 1 || img.width > MAX_LOGO_DIMENSION || img.height > MAX_LOGO_DIMENSION) return null;
  if (MARKUP_RE.test(b.toString('latin1'))) return null;
  return img;
}
