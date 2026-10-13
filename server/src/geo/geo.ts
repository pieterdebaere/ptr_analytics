import fs from 'node:fs/promises';
import { Reader, type CountryResponse } from 'maxmind';
import type { FastifyBaseLogger } from 'fastify';

const COUNTRY_RE = /^[A-Z]{2}$/;
const IGNORED_CODES = new Set(['XX', 'T1']);

export function normalizeCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toUpperCase();
  if (!COUNTRY_RE.test(v) || IGNORED_CODES.has(v)) return null;
  return v;
}

/** Parse an mmdb buffer and sanity-check it (throws when unusable). */
export function openCountryReader(buf: Buffer): Reader<CountryResponse> {
  const reader = new Reader<CountryResponse>(buf);
  // A lookup must not throw on a valid database.
  reader.get('1.1.1.1');
  return reader;
}

/**
 * Country lookup: a trusted proxy header (when configured) takes precedence, otherwise a
 * MaxMind-format country database (DB-IP Lite / GeoLite2 Country) if present.
 */
export class GeoService {
  private reader: Reader<CountryResponse> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly header: string | null,
    private readonly log: FastifyBaseLogger,
  ) {}

  get enabled(): boolean {
    return this.header !== null || this.reader !== null;
  }

  get hasDatabase(): boolean {
    return this.reader !== null;
  }

  /** (Re)load the database file. Missing/invalid files leave geo lookups disabled. */
  async load(): Promise<boolean> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.dbPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`GeoIP: cannot read ${this.dbPath}: ${(err as Error).message}`);
      }
      return false;
    }
    try {
      this.reader = openCountryReader(buf);
      this.log.info(`GeoIP: loaded ${this.dbPath} (${this.reader.metadata.databaseType})`);
      return true;
    } catch (err) {
      this.log.warn(`GeoIP: ${this.dbPath} is not a valid MaxMind database: ${(err as Error).message}`);
      return false;
    }
  }

  lookup(ip: string, headers: Record<string, string | string[] | undefined>): string | null {
    if (this.header !== null) {
      const h = headers[this.header];
      const fromHeader = normalizeCountry(Array.isArray(h) ? h[0] : h);
      if (fromHeader) return fromHeader;
    }
    if (this.reader === null) return null;
    try {
      const res = this.reader.get(ip);
      return normalizeCountry(res?.country?.iso_code ?? res?.registered_country?.iso_code);
    } catch {
      return null;
    }
  }
}
