/**
 * Minimal MaxMind DB writer for tests: an IPv4 database with a single tree node.
 * Addresses 0.0.0.0/1 map to `{country: {iso_code}}`; 128.0.0.0/1 have no data.
 */

function str(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  if (b.length >= 29) throw new Error('string too long for this tiny writer');
  return Buffer.concat([Buffer.from([0x40 | b.length]), b]);
}

function uint(type: 5 | 6, n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.concat([Buffer.from([(type << 5) | bytes.length]), Buffer.from(bytes)]);
}

function uint64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return Buffer.concat([Buffer.from([8, 9 - 7]), b]);
}

function map(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([Buffer.from([0xe0 | entries.length]), ...entries.flatMap(([k, v]) => [str(k), v])]);
}

function array(items: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([items.length, 11 - 7]), ...items]);
}

export function buildCountryMmdb(isoCode = 'DE'): Buffer {
  const nodeCount = 1;
  const dataValue = nodeCount + 16 + 0; // pointer to data offset 0
  const tree = Buffer.alloc(6);
  tree.writeUIntBE(dataValue, 0, 3); // left (first bit 0)
  tree.writeUIntBE(nodeCount, 3, 3); // right: no data
  const data = map([['country', map([['iso_code', str(isoCode)]])]]);
  const metadata = map([
    ['node_count', uint(6, nodeCount)],
    ['record_size', uint(5, 24)],
    ['ip_version', uint(5, 4)],
    ['database_type', str('Test-Country')],
    ['languages', array([str('en')])],
    ['binary_format_major_version', uint(5, 2)],
    ['binary_format_minor_version', uint(5, 0)],
    ['build_epoch', uint64(1_700_000_000)],
    ['description', map([['en', str('test db')]])],
  ]);
  return Buffer.concat([tree, Buffer.alloc(16), data, Buffer.from('ABCDEF4D61784D696E642E636F6D', 'hex'), metadata]);
}
