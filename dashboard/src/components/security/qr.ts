// Minimal QR code encoder (ISO/IEC 18004): byte mode, error correction level M,
// versions 1–40 (the dashboard only needs ~150 byte otpauth:// URIs → versions ≤ 10).
// Pure module, no DOM: returns a boolean module matrix that QrCode.tsx draws as SVG rects.
// Structure follows the well-known reference implementation by Project Nayuki (MIT).

/** Error correction code words per block, level M, index = version. */
const ECC_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28,
] as const;
/** Number of error correction blocks, level M, index = version. */
const NUM_BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38,
  40, 43, 45, 47, 49,
] as const;
/** Format-information bits for error correction level M. */
const ECL_M_FORMAT_BITS = 0;

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

export interface QrCode {
  version: number;
  size: number;
  mask: number;
  /** modules[y][x], true = dark */
  modules: boolean[][];
  /** Function patterns (finders, timing, alignment, format/version info) — exported for tests. */
  isFunction: boolean[][];
}

export class QrTooLongError extends Error {
  override name = 'QrTooLongError';
}

/* --------------------------------------------------------------- GF(256) / RS */

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11D). */
export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Generator polynomial coefficients (highest degree first, leading 1 omitted). */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** Reed–Solomon error correction code words for `data`. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i]! ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

/* ------------------------------------------------------------------ geometry */

export function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Number of 8-bit data code words (excluding ECC) at level M. */
export function numDataCodewords(ver: number): number {
  return Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver]! * NUM_BLOCKS_M[ver]!;
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** 15-bit format information (BCH(15,5) + XOR mask) for level M and the mask. */
export function formatBits(mask: number): number {
  const data = (ECL_M_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version information (BCH(18,6)) for versions ≥ 7. */
export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

/* ------------------------------------------------------------------- encoder */

function charCountBits(ver: number): number {
  return ver <= 9 ? 8 : 16;
}

/** Smallest version (level M, byte mode) that holds `byteLength` bytes, or -1. */
export function versionFor(byteLength: number, minVersion = QR_MIN_VERSION, maxVersion = QR_MAX_VERSION): number {
  for (let v = minVersion; v <= maxVersion; v++) {
    const needed = 4 + charCountBits(v) + byteLength * 8;
    if (byteLength < 1 << charCountBits(v) && needed <= numDataCodewords(v) * 8) return v;
  }
  return -1;
}

/** Data code words (mode, count, bytes, terminator, padding) for byte mode. */
export function dataCodewords(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, charCountBits(ver));
  for (const b of bytes) push(b, 8);
  const capacity = numDataCodewords(ver) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    out.push(b);
  }
  return out;
}

/** Splits into blocks, appends RS code words and interleaves (ISO 18004 §7.6). */
export function addEccAndInterleave(data: readonly number[], ver: number): number[] {
  const numBlocks = NUM_BLOCKS_M[ver]!;
  const blockEccLen = ECC_PER_BLOCK_M[ver]!;
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const div = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const pos = alignmentPositions(this.version);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.drawAlignment(pos[i]!, pos[j]!);
      }
    }
    this.drawFormat(0); // reserve; redrawn with the chosen mask
    this.drawVersion();
  }

  drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  drawFormat(mask: number): void {
    const bits = formatBits(mask);
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(bits, i));
    this.setFunction(8, 7, bit(bits, 6));
    this.setFunction(8, 8, bit(bits, 7));
    this.setFunction(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(bits, i));
    this.setFunction(8, size - 8, true); // the "dark module"
  }

  drawVersion(): void {
    if (this.version < 7) return;
    const bits = versionBits(this.version);
    for (let i = 0; i < 18; i++) {
      const dark = bit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  drawCodewords(data: readonly number[]): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y]![x] && maskBit(mask, x, y)) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  /** Penalty score N1–N4 (ISO 18004 §7.8.3). */
  penalty(): number {
    const { size, modules } = this;
    let score = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // N3: 1:1:3:1:1 finder-like pattern with 4 light modules on either side
      for (let i = 0; i + 11 <= size; i++) {
        const p = [true, false, true, true, true, false, true];
        const core = p.every((v, k) => get(i + k + 4) === v);
        const lightBefore = [0, 1, 2, 3].every((k) => !get(i + k));
        if (core && lightBefore) score += 40;
        const core2 = p.every((v, k) => get(i + k) === v);
        const lightAfter = [7, 8, 9, 10].every((k) => !get(i + k));
        if (core2 && lightAfter) score += 40;
      }
    };
    for (let y = 0; y < size; y++) line((x) => modules[y]![x]!);
    for (let x = 0; x < size; x++) line((y) => modules[y]![x]!);
    for (let y = 0; y + 1 < size; y++) {
      for (let x = 0; x + 1 < size; x++) {
        const c = modules[y]![x];
        if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of modules) for (const m of row) if (m) dark++;
    const total = size * size;
    const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
    score += k * 10;
    return score;
  }
}

export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new RangeError('mask');
  }
}

/**
 * Encodes `text` (UTF-8, byte mode, level M) into a QR code.
 * `forceMask` (0–7) skips the automatic mask selection (tests).
 */
export function encodeQr(text: string, opts: { minVersion?: number; maxVersion?: number; forceMask?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = versionFor(bytes.length, opts.minVersion ?? QR_MIN_VERSION, opts.maxVersion ?? QR_MAX_VERSION);
  if (version < 0) throw new QrTooLongError('Text too long for a QR code.');
  const codewords = addEccAndInterleave(dataCodewords(bytes, version), version);

  const m = new Matrix(version);
  m.drawFunctionPatterns();
  m.drawCodewords(codewords);

  let mask = opts.forceMask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      m.applyMask(candidate);
      m.drawFormat(candidate);
      const p = m.penalty();
      if (p < best) {
        best = p;
        mask = candidate;
      }
      m.applyMask(candidate); // XOR again = undo
    }
  }
  m.applyMask(mask);
  m.drawFormat(mask);
  return { version, size: m.size, mask, modules: m.modules, isFunction: m.isFunction };
}
