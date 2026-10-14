import { describe, expect, it } from 'vitest';
import {
  QrTooLongError,
  alignmentPositions,
  encodeQr,
  formatBits,
  gfMultiply,
  maskBit,
  numDataCodewords,
  rsDivisor,
  rsRemainder,
  versionBits,
  versionFor,
  type QrCode,
} from '../components/security/qr';

/* ---------------- independent read-back helpers (ISO 18004 layout) ---------------- */

function readFormat(qr: QrCode): { first: number; second: number } {
  const m = (x: number, y: number) => (qr.modules[y]![x] ? 1 : 0);
  let first = 0;
  const firstPos: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i++) firstPos.push([8, i]);
  firstPos.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) firstPos.push([14 - i, 8]);
  firstPos.forEach(([x, y], i) => (first |= m(x, y) << i));
  let second = 0;
  const s = qr.size;
  for (let i = 0; i < 8; i++) second |= m(s - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) second |= m(8, s - 15 + i) << i;
  return { first, second };
}

/** Function-module map computed independently for versions 1–6 (no version info blocks). */
function functionMap(version: number): boolean[][] {
  const size = version * 4 + 17;
  const f = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) f[y]![x] = true;
  };
  mark(0, 0, 9, 9); // finder + separator + format
  mark(size - 8, 0, 8, 9);
  mark(0, size - 8, 9, 8);
  mark(6, 0, 1, size);
  mark(0, 6, size, 1);
  // only version 2–6: one alignment pattern at (size-7, size-7)
  if (version >= 2) mark(size - 9, size - 9, 5, 5);
  return f;
}

function readCodewords(qr: QrCode, fn: boolean[][], mask: number): number[] {
  const size = qr.size;
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y]![x]) continue;
        bits.push((qr.modules[y]![x] ? 1 : 0) ^ (maskBit(mask, x, y) ? 1 : 0));
      }
    }
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

function syndromesZero(codeword: readonly number[], eccLen: number): boolean {
  let alpha = 1;
  for (let i = 0; i < eccLen; i++) {
    let s = 0;
    for (const b of codeword) s = gfMultiply(s, alpha) ^ b;
    if (s !== 0) return false;
    alpha = gfMultiply(alpha, 2);
  }
  return true;
}

function decodeBytes(data: readonly number[], version: number): Uint8Array {
  const bits: number[] = [];
  for (const b of data) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  let p = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bits[p++]!;
    return v;
  };
  expect(take(4)).toBe(0b0100); // byte mode
  const len = take(version <= 9 ? 8 : 16);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = take(8);
  return out;
}

/* ---------------------------------------------------------------- tests */

describe('Reed–Solomon', () => {
  it('matches the published "HELLO WORLD" 1-M example', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('produces valid code words (all syndromes zero) for random data', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    for (const ecc of [7, 10, 16, 18, 22, 26, 30]) {
      const data = Array.from({ length: 40 }, rnd);
      const cw = data.concat(rsRemainder(data, rsDivisor(ecc)));
      expect(syndromesZero(cw, ecc)).toBe(true);
      cw[3] = cw[3]! ^ 1;
      expect(syndromesZero(cw, ecc)).toBe(false);
    }
  });
});

describe('tables', () => {
  it('has the ISO data capacities for level M', () => {
    // data code words per version, error correction level M (ISO/IEC 18004 table 7)
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(numDataCodewords)).toEqual([16, 28, 44, 64, 86, 108, 124, 154, 182, 216]);
    expect(versionFor(14)).toBe(1);
    expect(versionFor(15)).toBe(2);
    expect(versionFor(213)).toBe(10);
    expect(versionFor(214, 1, 10)).toBe(-1);
  });

  it('has the ISO alignment pattern positions', () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(10)).toEqual([6, 28, 50]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
  });

  it('computes the known format and version information words', () => {
    // level M = 00: mask 0 → 101010000010010, mask 5 → 100000011001110 (ISO table C.1)
    expect(formatBits(0)).toBe(0b101010000010010);
    expect(formatBits(5)).toBe(0b100000011001110);
    // version 7 → 000111110010010100 (ISO table D.1)
    expect(versionBits(7)).toBe(0b000111110010010100);
    expect(versionBits(10)).toBe(0b001010010011010011);
  });
});

describe('encodeQr', () => {
  it('has finder patterns, separators, timing patterns and the dark module', () => {
    const qr = encodeQr('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP');
    const s = qr.size;
    expect(s).toBe(qr.version * 4 + 17);
    const finder = (x0: number, y0: number) => {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          expect(qr.modules[y0 + dy]![x0 + dx]).toBe(ring !== 2);
        }
      }
    };
    finder(0, 0);
    finder(s - 7, 0);
    finder(0, s - 7);
    // separators are light
    for (let i = 0; i < 8; i++) {
      expect(qr.modules[7]![i]).toBe(false);
      expect(qr.modules[i]![7]).toBe(false);
      expect(qr.modules[7]![s - 1 - i]).toBe(false);
      expect(qr.modules[s - 8]![i]).toBe(false);
    }
    for (let i = 8; i < s - 8; i++) {
      expect(qr.modules[6]![i]).toBe(i % 2 === 0);
      expect(qr.modules[i]![6]).toBe(i % 2 === 0);
    }
    expect(qr.modules[s - 8]![8]).toBe(true);
  });

  it('writes both format information copies with level M and the chosen mask', () => {
    for (const text of ['a', 'Hello, world!', 'otpauth://totp/PTR%20Analytics:admin%40example.com?secret=ABCDEFGHIJKLMNOP']) {
      const qr = encodeQr(text);
      const { first, second } = readFormat(qr);
      expect(first).toBe(second);
      const data = (first ^ 0x5412) >> 10;
      expect(data >> 3).toBe(0); // level M
      expect(data & 7).toBe(qr.mask);
      expect(first).toBe(formatBits(qr.mask));
    }
  });

  it('round-trips data through the matrix for versions 1–3 (every mask)', () => {
    const cases: Array<[string, number]> = [
      ['https://x.io', 1],
      ['otpauth://totp/a?s=JBSW', 2],
      ['otpauth://totp/a:b?secret=JBSWY3DPEHPK3PXP', 3],
    ];
    for (const [text, version] of cases) {
      for (let mask = 0; mask < 8; mask++) {
        const qr = encodeQr(text, { forceMask: mask });
        expect(qr.version).toBe(version);
        const fn = functionMap(version);
        expect(qr.isFunction).toEqual(fn);
        const cw = readCodewords(qr, fn, mask);
        const total = [26, 44, 70][version - 1]!;
        const ecc = [10, 16, 26][version - 1]!;
        const block = cw.slice(0, total);
        expect(syndromesZero(block, ecc)).toBe(true);
        expect(new TextDecoder().decode(decodeBytes(block.slice(0, total - ecc), version))).toBe(text);
      }
    }
  });

  it('round-trips a version 5 code with two interleaved blocks', () => {
    const text = 'otpauth://totp/PTR%20Analytics:someone%40example.com?secret=JBSWY3DPEHPK3PXP';
    const qr = encodeQr(text);
    expect(qr.version).toBe(5);
    const fn = functionMap(5);
    expect(qr.isFunction).toEqual(fn);
    const cw = readCodewords(qr, fn, qr.mask);
    // 5-M: 2 blocks × (43 data + 24 ecc), interleaved byte by byte
    const blocks: number[][] = [[], []];
    for (let i = 0; i < 134; i++) blocks[i % 2]!.push(cw[i]!);
    const data: number[] = [];
    for (const b of blocks) {
      const codeword = b.slice(0, 43).concat(b.slice(43));
      expect(syndromesZero(codeword, 24)).toBe(true);
      data.push(...b.slice(0, 43));
    }
    expect(new TextDecoder().decode(decodeBytes(data, 5))).toBe(text);
  });

  it('encodes UTF-8 and fits a long otpauth URI into version ≤ 10', () => {
    const uri = `otpauth://totp/${encodeURIComponent('PTR Analytics')}:${encodeURIComponent('very.long.address+tag@sub.example-company.com')}?secret=${'A'.repeat(52)}&issuer=PTR%20Analytics&algorithm=SHA1&digits=6&period=30`;
    const qr = encodeQr(uri);
    expect(qr.version).toBeLessThanOrEqual(10);
    expect(qr.version).toBeGreaterThanOrEqual(7);
    // version information block (bottom-left copy) is present for v ≥ 7
    const bits = versionBits(qr.version);
    for (let i = 0; i < 18; i++) {
      expect(qr.modules[qr.size - 11 + (i % 3)]![Math.floor(i / 3)]).toBe(((bits >> i) & 1) === 1);
    }
    expect(encodeQr('é€').version).toBe(1);
  });

  it('rejects input that does not fit', () => {
    expect(() => encodeQr('x'.repeat(300), { maxVersion: 10 })).toThrow(QrTooLongError);
  });
});
