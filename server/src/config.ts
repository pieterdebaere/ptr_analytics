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
  /** NODE_ENV === 'production' (only used for startup warnings). */
  production: boolean;
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
  /** Hosted ("cloud") mode, spec section 6. Everything is off by default. */
  cloud: CloudConfig;
}

export interface CloudConfig {
  signupEnabled: boolean;
  /** nodemailer connection URL (contains credentials: never log it). */
  smtpUrl: string | null;
  mailFrom: string | null;
  memberSiteLimit: number;
  billingEnabled: boolean;
  /** Secrets: never log them. */
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
  stripePriceId: string | null;
  stripeAutomaticTax: boolean;
  freeSites: number;
  pricePerSiteCents: number;
  /** ISO 4217, lower case. */
  priceCurrency: string;
  termsUrl: string | null;
  privacyUrl: string | null;
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
  if (/^\d+$/.test(v)) {
    const hops = parseInt10('TRUST_PROXY', v, 0, 100);
    return hops === 0 ? false : hops;
  }
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

/** The placeholder from the old example env file; refused so it never ends up in production. */
export const EXAMPLE_ADMIN_PASSWORD = 'change-me-to-a-long-random-password';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/** Parse and validate configuration from environment variables. Throws ConfigError. */
export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): Config {
  const port = parseInt10('PORT', str(env, 'PORT') ?? '3000', 0, 65535);
  // Loopback by default (put a reverse proxy in front); the Docker image sets HOST=0.0.0.0.
  const host = str(env, 'HOST') ?? '127.0.0.1';
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
  // Only one of ADMIN_EMAIL / ADMIN_PASSWORD set is not fatal here: operators commonly
  // remove the password after the first start. bootstrapAdmin() reports it when it matters.
  if (adminEmail !== null && !isValidEmail(adminEmail)) {
    throw new ConfigError('ADMIN_EMAIL is not a valid email address');
  }
  if (adminPassword !== null && (adminPassword.length < PASSWORD_MIN || adminPassword.length > PASSWORD_MAX)) {
    throw new ConfigError(`ADMIN_PASSWORD must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters long`);
  }
  if (adminPassword !== null && adminPassword.trim() === EXAMPLE_ADMIN_PASSWORD) {
    throw new ConfigError('ADMIN_PASSWORD is still the example value; choose a long random password');
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

  const cloud = loadCloudConfig(env, publicUrl);

  const trackerFile = path.resolve(cwd, str(env, 'TRACKER_FILE') ?? path.join(PACKAGE_DIR, '..', 'tracker', 'dist', 'script.js'));
  const dashboardDir = path.resolve(cwd, str(env, 'DASHBOARD_DIR') ?? path.join(PACKAGE_DIR, '..', 'dashboard', 'dist'));

  return {
    port,
    host,
    dataDir,
    publicUrl,
    trustProxy,
    cookieSecure,
    production: str(env, 'NODE_ENV') === 'production',
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
    cloud,
  };
}

function optBool(env: Env, key: string, def: boolean): boolean {
  const raw = str(env, key);
  return raw === undefined ? def : parseBool(key, raw);
}

function optUrl(env: Env, key: string): string | null {
  const raw = str(env, key);
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${key} must be an absolute http(s) URL`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || raw.length > 2048) {
    throw new ConfigError(`${key} must be an absolute http(s) URL without credentials`);
  }
  return url.href;
}

/** A display name + address as nodemailer accepts it, without header-injection characters. */
function parseMailFrom(value: string): string {
  if (value.length > 320 || /[\r\n\p{Cc}\p{Cf}]/u.test(value)) throw new ConfigError('MAIL_FROM is not a valid sender');
  const m = /<([^<>]+)>\s*$/.exec(value);
  const address = (m ? m[1] : value)?.trim() ?? '';
  if (!isValidEmail(address)) throw new ConfigError('MAIL_FROM must be an address such as "PTR Analytics <no-reply@example.com>"');
  return value;
}

function parseSmtpUrl(value: string): string {
  // Never echo the value: it usually contains the SMTP password.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('SMTP_URL must be a URL such as smtps://user:pass@smtp.example.com:465');
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') throw new ConfigError('SMTP_URL must use smtp:// or smtps://');
  if (!url.hostname) throw new ConfigError('SMTP_URL must contain a host');
  return value;
}

/** Hosted-mode settings (spec 6.1). Fails fast on incomplete combinations; never echoes secrets. */
export function loadCloudConfig(env: Env, publicUrl: string | null): CloudConfig {
  const signupEnabled = optBool(env, 'SIGNUP_ENABLED', false);
  const billingEnabled = optBool(env, 'BILLING_ENABLED', false);
  const smtpRaw = str(env, 'SMTP_URL');
  const smtpUrl = smtpRaw === undefined ? null : parseSmtpUrl(smtpRaw);
  const fromRaw = str(env, 'MAIL_FROM');
  const mailFrom = fromRaw === undefined ? null : parseMailFrom(fromRaw);

  if (signupEnabled) {
    const missing = [smtpUrl ? null : 'SMTP_URL', mailFrom ? null : 'MAIL_FROM', publicUrl ? null : 'PUBLIC_URL'].filter(
      (k): k is string => k !== null,
    );
    if (missing.length > 0) {
      throw new ConfigError(`SIGNUP_ENABLED=true requires ${missing.join(', ')} (email verification is mandatory)`);
    }
  }

  const stripeSecretKey = str(env, 'STRIPE_SECRET_KEY') ?? null;
  const stripeWebhookSecret = str(env, 'STRIPE_WEBHOOK_SECRET') ?? null;
  const stripePriceId = str(env, 'STRIPE_PRICE_ID') ?? null;
  if (stripeSecretKey !== null && !/^(sk|rk)_[A-Za-z0-9_]{8,250}$/.test(stripeSecretKey)) {
    throw new ConfigError('STRIPE_SECRET_KEY must be a Stripe secret (sk_...) or restricted (rk_...) key');
  }
  if (stripeWebhookSecret !== null && !/^whsec_[A-Za-z0-9+/=_-]{8,250}$/.test(stripeWebhookSecret)) {
    throw new ConfigError('STRIPE_WEBHOOK_SECRET must be a webhook signing secret (whsec_...)');
  }
  if (stripePriceId !== null && !/^price_[A-Za-z0-9_]{4,250}$/.test(stripePriceId)) {
    throw new ConfigError('STRIPE_PRICE_ID must be a Stripe price id (price_...)');
  }
  if (billingEnabled) {
    if (!signupEnabled) throw new ConfigError('BILLING_ENABLED=true requires SIGNUP_ENABLED=true');
    const missing = [
      stripeSecretKey ? null : 'STRIPE_SECRET_KEY',
      stripeWebhookSecret ? null : 'STRIPE_WEBHOOK_SECRET',
      stripePriceId ? null : 'STRIPE_PRICE_ID',
    ].filter((k): k is string => k !== null);
    if (missing.length > 0) throw new ConfigError(`BILLING_ENABLED=true requires ${missing.join(', ')}`);
  }

  const currency = (str(env, 'PRICE_CURRENCY') ?? 'eur').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new ConfigError('PRICE_CURRENCY must be a 3-letter ISO currency code (e.g. eur)');

  return {
    signupEnabled,
    smtpUrl,
    mailFrom,
    memberSiteLimit: parseInt10('MEMBER_SITE_LIMIT', str(env, 'MEMBER_SITE_LIMIT') ?? '10', 0, 100_000),
    billingEnabled,
    stripeSecretKey,
    stripeWebhookSecret,
    stripePriceId,
    stripeAutomaticTax: optBool(env, 'STRIPE_AUTOMATIC_TAX', false),
    freeSites: parseInt10('FREE_SITES', str(env, 'FREE_SITES') ?? '1', 0, 1000),
    pricePerSiteCents: parseInt10('PRICE_PER_SITE_CENTS', str(env, 'PRICE_PER_SITE_CENTS') ?? '100', 0, 100_000_000),
    priceCurrency: currency,
    termsUrl: optUrl(env, 'TERMS_URL'),
    privacyUrl: optUrl(env, 'PRIVACY_URL'),
  };
}

export function isValidEmail(email: string): boolean {
  // No whitespace, control (Cc) or format (Cf, e.g. bidi overrides) characters.
  return email.length <= 254 && /^[^\s@\p{Cc}\p{Cf}]+@[^\s@\p{Cc}\p{Cf}]+\.[^\s@\p{Cc}\p{Cf}]+$/u.test(email);
}
