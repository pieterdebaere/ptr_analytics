// Minimal DNS wire format (RFC 1035) encoder/decoder for the `dns` monitor. The decoder treats
// every response as hostile: all reads are bounds-checked, compression pointers must point
// strictly backwards (no loops), names are capped at 255 bytes, record counts at 512.
import { formatIp, ipFromBytes, parseIp } from './ip.js';

export const RR_TYPES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, OPT: 41, CAA: 257 };
const TYPE_NAMES: Record<number, string> = Object.fromEntries(Object.entries(RR_TYPES).map(([k, v]) => [v, k]));
export const QUERY_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'CAA', 'PTR'] as const;
export type QueryType = (typeof QUERY_TYPES)[number];
export const RCODES = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED', 'YXDOMAIN', 'YXRRSET', 'NXRRSET', 'NOTAUTH', 'NOTZONE'];

export class DnsParseError extends Error {
  override name = 'DnsParseError';
}

/** Validates/normalises a query name (labels ≤ 63 bytes, total ≤ 253 chars; `_` allowed). */
export function normalizeQueryName(input: string): string | null {
  let n = input.trim().toLowerCase();
  if (n.endsWith('.')) n = n.slice(0, -1);
  if (n.length === 0 || n.length > 253) return null;
  for (const l of n.split('.')) if (!/^[a-z0-9_*](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l)) return null;
  return n;
}

/** Reverse-lookup name for an IP literal (in-addr.arpa / ip6.arpa) or null. */
export function reverseName(ipText: string): string | null {
  const ip = parseIp(ipText);
  if (!ip) return null;
  if (ip.family === 4) {
    const v = Number(ip.value);
    return `${v & 255}.${(v >>> 8) & 255}.${(v >>> 16) & 255}.${(v >>> 24) & 255}.in-addr.arpa`;
  }
  const nibbles: string[] = [];
  for (let i = 0; i < 32; i++) nibbles.push(((ip.value >> BigInt(i * 4)) & 0xfn).toString(16));
  return `${nibbles.join('.')}.ip6.arpa`;
}

export function encodeQuery(id: number, name: string, type: string, opts: { rd?: boolean; edns?: number } = {}): Buffer {
  const qtype = RR_TYPES[type];
  if (qtype === undefined) throw new Error(`unsupported record type ${type}`);
  const labels = name === '' ? [] : name.split('.');
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(opts.rd === false ? 0 : 0x0100, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(opts.edns ? 1 : 0, 10);
  parts.push(header);
  for (const l of labels) {
    const b = Buffer.from(l, 'ascii');
    if (b.length === 0 || b.length > 63) throw new Error('invalid label');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  const q = Buffer.alloc(4);
  q.writeUInt16BE(qtype, 0);
  q.writeUInt16BE(1, 2);
  parts.push(q);
  if (opts.edns) {
    // OPT pseudo-RR: root name, type 41, class = UDP payload size, ttl 0, rdlen 0
    const opt = Buffer.alloc(11);
    opt.writeUInt8(0, 0);
    opt.writeUInt16BE(41, 1);
    opt.writeUInt16BE(opts.edns, 3);
    parts.push(opt);
  }
  return Buffer.concat(parts);
}

export interface DnsRecord {
  name: string;
  type: string;
  ttl: number;
  value: string;
}

export interface DnsMessage {
  id: number;
  qr: boolean;
  tc: boolean;
  rcode: string;
  question: { name: string; type: number } | null;
  answers: DnsRecord[];
}

class Cursor {
  constructor(
    readonly buf: Buffer,
    public off: number,
  ) {}
  need(n: number): void {
    if (n < 0 || this.off + n > this.buf.length) throw new DnsParseError('truncated message');
  }
  u8(): number {
    this.need(1);
    return this.buf[this.off++]!;
  }
  u16(): number {
    this.need(2);
    const v = (this.buf[this.off]! << 8) | this.buf[this.off + 1]!;
    this.off += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = ((this.buf[this.off]! << 24) >>> 0) + ((this.buf[this.off + 1]! << 16) | (this.buf[this.off + 2]! << 8) | this.buf[this.off + 3]!);
    this.off += 4;
    return v >>> 0;
  }
  bytes(n: number): Buffer {
    this.need(n);
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }
}

function printable(b: Buffer): string {
  let s = '';
  for (const c of b) s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : `\\${c.toString().padStart(3, '0')}`;
  return s;
}

/** Reads a (possibly compressed) domain name starting at c.off; advances c past it. */
function readName(c: Cursor): string {
  const labels: string[] = [];
  let off = c.off;
  let jumped = false;
  let total = 0;
  let hops = 0;
  for (;;) {
    if (off >= c.buf.length) throw new DnsParseError('name out of bounds');
    const len = c.buf[off]!;
    if (len === 0) {
      off += 1;
      break;
    }
    const kind = len & 0xc0;
    if (kind === 0xc0) {
      if (off + 1 >= c.buf.length) throw new DnsParseError('pointer out of bounds');
      const ptr = ((len & 0x3f) << 8) | c.buf[off + 1]!;
      if (ptr >= off) throw new DnsParseError('forward compression pointer');
      if (++hops > 64) throw new DnsParseError('too many compression pointers');
      if (!jumped) c.off = off + 2;
      jumped = true;
      off = ptr;
      continue;
    }
    if (kind !== 0) throw new DnsParseError('unsupported label type');
    if (off + 1 + len > c.buf.length) throw new DnsParseError('label out of bounds');
    total += len + 1;
    if (total > 255) throw new DnsParseError('name too long');
    labels.push(printable(c.buf.subarray(off + 1, off + 1 + len)));
    off += 1 + len;
  }
  if (!jumped) c.off = off;
  return labels.length === 0 ? '.' : labels.join('.');
}

function rdataValue(type: number, c: Cursor, end: number): string | null {
  const name = (): string => readName(c);
  switch (type) {
    case 1:
    case 28: {
      const want = type === 1 ? 4 : 16;
      if (end - c.off !== want) throw new DnsParseError('bad address length');
      return formatIp(ipFromBytes(c.bytes(want))!);
    }
    case 2:
    case 5:
    case 12:
      return name();
    case 15: {
      const pref = c.u16();
      return `${pref} ${name()}`;
    }
    case 16: {
      const parts: string[] = [];
      while (c.off < end) {
        const l = c.u8();
        if (c.off + l > end) throw new DnsParseError('TXT string out of bounds');
        parts.push(c.bytes(l).toString('utf8'));
      }
      return parts.join('');
    }
    case 6: {
      const mname = name();
      const rname = name();
      const nums = [c.u32(), c.u32(), c.u32(), c.u32(), c.u32()];
      return `${mname} ${rname} ${nums.join(' ')}`;
    }
    case 33: {
      const prio = c.u16();
      const weight = c.u16();
      const port = c.u16();
      return `${prio} ${weight} ${port} ${name()}`;
    }
    case 257: {
      const flags = c.u8();
      const tl = c.u8();
      if (tl === 0 || c.off + tl > end) throw new DnsParseError('bad CAA tag');
      const tag = printable(c.bytes(tl));
      const value = printable(c.bytes(end - c.off));
      return `${flags} ${tag} "${value}"`;
    }
    default:
      return null;
  }
}

export function parseMessage(buf: Buffer): DnsMessage {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new DnsParseError('message too short');
  const c = new Cursor(buf, 0);
  const id = c.u16();
  const flags = c.u16();
  const qd = c.u16();
  const an = c.u16();
  c.u16(); // ns
  c.u16(); // ar
  if (qd > 1) throw new DnsParseError('unexpected question count');
  if (an > 512) throw new DnsParseError('too many answers');
  let question: DnsMessage['question'] = null;
  if (qd === 1) {
    const qname = readName(c);
    const qtype = c.u16();
    c.u16();
    question = { name: qname, type: qtype };
  }
  const answers: DnsRecord[] = [];
  for (let i = 0; i < an; i++) {
    const rname = readName(c);
    const type = c.u16();
    c.u16(); // class
    const ttl = c.u32();
    const rdlen = c.u16();
    c.need(rdlen);
    const end = c.off + rdlen;
    const sub = new Cursor(buf.subarray(0, end), c.off);
    const value = rdataValue(type, sub, end);
    if (value !== null && sub.off !== end) throw new DnsParseError('rdata length mismatch');
    c.off = end;
    const tn = TYPE_NAMES[type];
    if (value !== null && tn) answers.push({ name: rname, type: tn, ttl: ttl > 0x7fffffff ? 0 : ttl, value });
  }
  const rc = flags & 0x0f;
  return {
    id,
    qr: (flags & 0x8000) !== 0,
    tc: (flags & 0x0200) !== 0,
    rcode: RCODES[rc] ?? `RCODE${rc}`,
    question,
    answers,
  };
}
