import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, Writable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { FastifyBaseLogger } from 'fastify';
import { openCountryReader } from './geo.js';

export const DBIP_HOST = 'download.db-ip.com';
export const DBIP_URL = (month: string): string => `https://${DBIP_HOST}/free/dbip-country-lite-${month}.mmdb.gz`;
export const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export type FetchFn = (url: string, init?: { signal?: AbortSignal; redirect?: 'error' | 'follow' | 'manual' }) => Promise<Response>;

/** `YYYY-MM` of the current UTC month and the month before. */
export function candidateMonths(now: number): string[] {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const fmt = (yy: number, mm: number): string => {
    const t = new Date(Date.UTC(yy, mm, 1));
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  return [fmt(y, m), fmt(y, m - 1)];
}

class ByteLimit extends Transform {
  private total = 0;
  constructor(
    private readonly max: number,
    private readonly what: string,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.total += chunk.length;
    if (this.total > this.max) {
      cb(new Error(`${this.what} exceeds ${this.max} bytes`));
      return;
    }
    cb(null, chunk);
  }
}

/** Download one URL and gunzip it into memory, with size caps. */
async function download(url: string, fetchFn: FetchFn, maxBytes: number): Promise<Buffer> {
  // Redirects are refused: the database must come from the pinned https origin.
  const res = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'error' });
  if (res.url !== '') {
    const final = new URL(res.url);
    if (final.protocol !== 'https:' || final.hostname !== DBIP_HOST) throw new Error(`unexpected final URL ${final.origin}`);
  }
  if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`);
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  const chunks: Buffer[] = [];
  await pipeline(
    body,
    new ByteLimit(MAX_COMPRESSED_BYTES, 'compressed download'),
    createGunzip(),
    new ByteLimit(maxBytes, 'decompressed database'),
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    }),
  );
  return Buffer.concat(chunks);
}

function describeError(err: unknown): string {
  const e = err as Error & { cause?: { code?: unknown } };
  const code = typeof e?.cause?.code === 'string' ? ` (${e.cause.code})` : '';
  return `${e?.message ?? String(err)}${code}`;
}

export interface DownloadOptions {
  fetchFn?: FetchFn;
  now?: number;
  maxBytes?: number;
}

/**
 * Download the DB-IP "IP to Country Lite" database (CC BY 4.0) into `dest`.
 * Tries the current month, then the previous month. The download is decompressed in memory
 * (size capped), verified with the MaxMind reader (must be a Country database), written to
 * a temp file in the same directory, then atomically renamed.
 * Never throws: returns false and logs on failure.
 */
export async function downloadGeoDatabase(dest: string, log: FastifyBaseLogger, opts: DownloadOptions = {}): Promise<boolean> {
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const maxBytes = opts.maxBytes ?? MAX_DECOMPRESSED_BYTES;
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
  } catch (err) {
    log.warn(`GeoIP download: cannot create directory: ${(err as Error).message}`);
    return false;
  }
  for (const month of candidateMonths(opts.now ?? Date.now())) {
    const url = DBIP_URL(month);
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const buf = await download(url, fetchFn, maxBytes);
      // Verify in memory before anything touches the disk.
      const reader = openCountryReader(buf);
      const type = reader.metadata.databaseType;
      if (!/country/i.test(type)) throw new Error(`unexpected database type "${type}"`);
      await fsp.writeFile(tmp, buf, { mode: 0o644, flag: 'wx' });
      await fsp.rename(tmp, dest);
      log.info(`GeoIP: downloaded DB-IP Country Lite ${month} (CC BY 4.0, https://db-ip.com)`);
      return true;
    } catch (err) {
      log.warn(`GeoIP download from ${url} failed: ${describeError(err)}`);
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
  return false;
}

/** Age of a file in ms, or null if it does not exist. */
export async function fileAge(file: string, now: number): Promise<number | null> {
  try {
    const st = await fsp.stat(file);
    return now - st.mtimeMs;
  } catch {
    return null;
  }
}
