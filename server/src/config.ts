import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type TrustProxy = boolean | number | string[];

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Normalised origin (no trailing slash), or null when unset. */
  publicUrl: string | null;
  trustProxy: TrustProxy;
  cookieSecure: boolean;
  adminEmail: string | null;
  adminPassword: string | null;
  retentionDays: number;
  geoipDbPath: string;
  geoipAutoDownload: boolean;
  /** Lower-cased header name, or null. */
  geoipHeader: string | null;
  /** 0 disables the ingest rate limit. */
  ingestRateLimit: number;
  logLevel: LogLevel;
  trackerFile: string;
  dashboardDir: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

/** Directory of the server package (works for both src/ and dist/). */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function parseBool(key: string, value: string): boolean {
  const v = value.toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  throw new ConfigError(`${key} must be "true" or "false" (got "${value}")`);
}

function parseInt10(key: string, value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new ConfigError(`${key} must be an integer between ${min} and ${max} (got "${value}")`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max} (got "${value}")`);
  }
  return n;
}

function isCidrOrIp(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash === -1) return isIP(value) !== 0;
  const ip = value.slice(0, slash);
  const bits = value.slice(slash + 1);
  const version = isIP(ip);
  if (version === 0 || !/^\d{1,3}$/.test(bits)) return false;
  const n = Number(bits);
  return version === 4 ? n <= 32 : n <= 128;
}

export function parseTrustProxy(value: string | undefined): TrustProxy {
  if (value === undefined) return false;
  const v = value.toLowerCase();
  if (v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return parseInt10('TRUST_PROXY', v, 0, 100);
  const parts = value.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) return false;
  for (const p of parts) {
    if (!isCidrOrIp(p)) {
      throw new ConfigError(
        `TRUST_PROXY must be "false", "true", a hop count, or comma separated IPs/CIDRs (invalid entry "${p}")`,
      );
    }
  }
  return parts;
}

export function parsePublicUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`PUBLIC_URL must be an absolute http(s) URL such as https://analytics.example.com (got "${value}")`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`PUBLIC_URL must use http or https (got "${value}")`);
  }
  if (url.username || url.password) throw new ConfigError('PUBLIC_URL must not contain credentials');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError('PUBLIC_URL must be an origin without path, query or fragment (e.g. https://analytics.example.com)');
  }
  return url.origin;
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/** Parse and validate configuration from environment variables. Throws ConfigError. */
export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): Config {
  const port = parseInt10('PORT', str(env, 'PORT') ?? '3000', 0, 65535);
  const host = str(env, 'HOST') ?? '0.0.0.0';
  const dataDir = path.resolve(cwd, str(env, 'DATA_DIR') ?? './data');
  const publicUrl = parsePublicUrl(str(env, 'PUBLIC_URL'));
  const trustProxy = parseTrustProxy(str(env, 'TRUST_PROXY'));

  const cookieSecureRaw = str(env, 'COOKIE_SECURE');
  const cookieSecure =
    cookieSecureRaw !== undefined
      ? parseBool('COOKIE_SECURE', cookieSecureRaw)
      : publicUrl !== null && publicUrl.startsWith('https://');

  const adminEmail = str(env, 'ADMIN_EMAIL') ?? null;
  // Do not trim passwords: whitespace may be intentional.
  const adminPasswordRaw = env['ADMIN_PASSWORD'];
  const adminPassword = adminPasswordRaw === undefined || adminPasswordRaw === '' ? null : adminPasswordRaw;
  if ((adminEmail === null) !== (adminPassword === null)) {
    throw new ConfigError('ADMIN_EMAIL and ADMIN_PASSWORD must be set together');
  }
  if (adminEmail !== null && !isValidEmail(adminEmail)) {
    throw new ConfigError('ADMIN_EMAIL is not a valid email address');
  }
  if (adminPassword !== null && (adminPassword.length < PASSWORD_MIN || adminPassword.length > PASSWORD_MAX)) {
    throw new ConfigError(`ADMIN_PASSWORD must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters long`);
  }

  const retentionDays = parseInt10('RETENTION_DAYS', str(env, 'RETENTION_DAYS') ?? '0', 0, 36500);
  const geoipDbPath = path.resolve(cwd, str(env, 'GEOIP_DB_PATH') ?? path.join(dataDir, 'geoip-country.mmdb'));
  const geoipAutoDownloadRaw = str(env, 'GEOIP_AUTO_DOWNLOAD');
  const geoipAutoDownload =
    geoipAutoDownloadRaw === undefined ? false : parseBool('GEOIP_AUTO_DOWNLOAD', geoipAutoDownloadRaw);

  const geoipHeaderRaw = str(env, 'GEOIP_HEADER');
  let geoipHeader: string | null = null;
  if (geoipHeaderRaw !== undefined) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(geoipHeaderRaw)) {
      throw new ConfigError(`GEOIP_HEADER must be a valid header name (got "${geoipHeaderRaw}")`);
    }
    geoipHeader = geoipHeaderRaw.toLowerCase();
  }

  const ingestRateLimit = parseInt10('INGEST_RATE_LIMIT', str(env, 'INGEST_RATE_LIMIT') ?? '600', 0, 1_000_000);

  const logLevelRaw = (str(env, 'LOG_LEVEL') ?? 'info').toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(logLevelRaw)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${logLevelRaw}")`);
  }
  const logLevel = logLevelRaw as LogLevel;

  const trackerFile = path.resolve(cwd, str(env, 'TRACKER_FILE') ?? path.join(PACKAGE_DIR, '..', 'tracker', 'dist', 'script.js'));
  const dashboardDir = path.resolve(cwd, str(env, 'DASHBOARD_DIR') ?? path.join(PACKAGE_DIR, '..', 'dashboard', 'dist'));

  return {
    port,
    host,
    dataDir,
    publicUrl,
    trustProxy,
    cookieSecure,
    adminEmail: adminEmail === null ? null : adminEmail.toLowerCase(),
    adminPassword,
    retentionDays,
    geoipDbPath,
    geoipAutoDownload,
    geoipHeader,
    ingestRateLimit,
    logLevel,
    trackerFile,
    dashboardDir,
  };
}

export function isValidEmail(email: string): boolean {
  // No whitespace, control (Cc) or format (Cf, e.g. bidi overrides) characters.
  return email.length <= 254 && /^[^\s@\p{Cc}\p{Cf}]+@[^\s@\p{Cc}\p{Cf}]+\.[^\s@\p{Cc}\p{Cf}]+$/u.test(email);
}
