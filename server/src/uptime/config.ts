// Uptime monitoring configuration (docs/SPEC.md §8.1). Parsed once by loadConfig().
import { isIP } from 'node:net';

type Env = Record<string, string | undefined>;

export type PrivateTargetsPolicy = 'allow' | 'deny';

export interface UptimeConfig {
  /** UPTIME_ENABLED (default true): turn the whole feature off. */
  enabled: boolean;
  /** Minimum interval for admins/viewers (self-hosted) and for members (hosted). */
  minIntervalS: number;
  memberMinIntervalS: number;
  /** Global number of checks in flight. */
  checkConcurrency: number;
  /** SSRF policy for private / loopback / ULA targets. Forced to 'deny' in hosted mode. */
  privateTargets: PrivateTargetsPolicy;
  /** Link-local / cloud metadata (169.254.0.0/16, fe80::/10, fd00:ec2::254 …). Always denied unless true (self-hosted only). */
  allowMetadata: boolean;
  /** CIDRs or hostnames always allowed / always denied (deny wins). */
  targetAllowlist: string[];
  targetDenylist: string[];
  /** Max response body bytes read by HTTP-like checks. */
  maxBodyBytes: number;
  rawRetentionHours: number;
  /** Events, outages and daily stats; 0 = forever. */
  retentionDays: number;
  /** Absolute path of the ping binary; null disables the `ping` type. */
  pingBinary: string | null;
  /** Docker monitor type (self-hosted only); socket path or http(s) URL of a docker socket proxy. */
  dockerEnabled: boolean;
  dockerHost: string | null;
  /** SECRETS_KEY (base64, 32 bytes) or null = generated key file `<DATA_DIR>/secrets.key` (0600). */
  secretsKey: Buffer | null;
  secretsKeyFile: string | null;
  /** Hosted-mode limits. */
  memberMonitorsPerSite: number;
  memberStatusPagesPerSite: number;
  memberNotifyPerHour: number;
  memberChannels: number;
  /** REQUIRE_MFA_FOR_ADMINS: admins must enrol TOTP before using the dashboard. */
  requireMfaForAdmins: boolean;
  /** User-Agent for outgoing checks. */
  userAgent: string;
}

export class UptimeConfigError extends Error {
  override name = 'ConfigError';
}

function str(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function bool(env: Env, key: string, def: boolean): boolean {
  const raw = str(env, key);
  if (raw === undefined) return def;
  const v = raw.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new UptimeConfigError(`${key} must be "true" or "false"`);
}

function int(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = str(env, key);
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw)) throw new UptimeConfigError(`${key} must be an integer between ${min} and ${max}`);
  const n = Number(raw);
  if (n < min || n > max) throw new UptimeConfigError(`${key} must be an integer between ${min} and ${max}`);
  return n;
}

const HOST_RE = /^(?=.{1,253}$)(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function cidrOrHostList(env: Env, key: string): string[] {
  const raw = str(env, key);
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const p = part.trim().toLowerCase();
    if (!p) continue;
    const [ip, bits] = p.split('/');
    const isCidr = ip !== undefined && isIP(ip) !== 0 && (bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (isIP(ip) === 4 ? 32 : 128)));
    if (!isCidr && !HOST_RE.test(p)) throw new UptimeConfigError(`${key}: "${part.trim()}" is not an IP, CIDR or hostname`);
    out.push(p);
  }
  return out;
}

export function loadUptimeConfig(env: Env, opts: { hosted: boolean; version: string; publicUrl: string | null }): UptimeConfig {
  const privateRaw = (str(env, 'UPTIME_PRIVATE_TARGETS') ?? (opts.hosted ? 'deny' : 'allow')).toLowerCase();
  if (privateRaw !== 'allow' && privateRaw !== 'deny') throw new UptimeConfigError('UPTIME_PRIVATE_TARGETS must be "allow" or "deny"');
  if (opts.hosted && privateRaw === 'allow') {
    throw new UptimeConfigError('UPTIME_PRIVATE_TARGETS=allow is not permitted with SIGNUP_ENABLED (members could probe your private network)');
  }
  const allowMetadata = bool(env, 'UPTIME_ALLOW_METADATA', false);
  if (opts.hosted && allowMetadata) throw new UptimeConfigError('UPTIME_ALLOW_METADATA is not permitted with SIGNUP_ENABLED');

  let secretsKey: Buffer | null = null;
  const keyRaw = str(env, 'SECRETS_KEY');
  if (keyRaw !== undefined) {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(keyRaw)) throw new UptimeConfigError('SECRETS_KEY must be 32 random bytes, base64 encoded (e.g. `openssl rand -base64 32`)');
    secretsKey = Buffer.from(keyRaw, 'base64');
  }
  const secretsKeyFile = str(env, 'SECRETS_KEY_FILE') ?? null;

  const ping = env['UPTIME_PING_BINARY'] === undefined ? '/bin/ping' : (str(env, 'UPTIME_PING_BINARY') ?? null);
  if (ping !== null && !ping.startsWith('/')) throw new UptimeConfigError('UPTIME_PING_BINARY must be an absolute path (or empty to disable ping)');

  const dockerEnabled = bool(env, 'UPTIME_DOCKER_ENABLED', false);
  if (opts.hosted && dockerEnabled) throw new UptimeConfigError('UPTIME_DOCKER_ENABLED is not permitted with SIGNUP_ENABLED');
  const dockerHost = str(env, 'UPTIME_DOCKER_HOST') ?? (dockerEnabled ? '/var/run/docker.sock' : null);

  const minIntervalS = int(env, 'UPTIME_MIN_INTERVAL_S', 20, 5, 86_400);
  const memberMinIntervalS = Math.max(minIntervalS, int(env, 'MEMBER_MIN_INTERVAL_S', 60, 5, 86_400));

  return {
    enabled: bool(env, 'UPTIME_ENABLED', true),
    minIntervalS,
    memberMinIntervalS,
    checkConcurrency: int(env, 'UPTIME_CHECK_CONCURRENCY', 64, 1, 2048),
    privateTargets: privateRaw,
    allowMetadata,
    targetAllowlist: cidrOrHostList(env, 'UPTIME_TARGET_ALLOWLIST'),
    targetDenylist: cidrOrHostList(env, 'UPTIME_TARGET_DENYLIST'),
    maxBodyBytes: int(env, 'UPTIME_MAX_BODY_BYTES', 1_048_576, 1024, 16 * 1_048_576),
    rawRetentionHours: int(env, 'UPTIME_RAW_RETENTION_HOURS', 48, 25, 24 * 30),
    retentionDays: int(env, 'UPTIME_RETENTION_DAYS', 400, 0, 100_000),
    pingBinary: ping,
    dockerEnabled,
    dockerHost,
    secretsKey,
    secretsKeyFile,
    memberMonitorsPerSite: int(env, 'MEMBER_MONITORS_PER_SITE', 10, 0, 10_000),
    memberStatusPagesPerSite: int(env, 'MEMBER_STATUS_PAGES_PER_SITE', 1, 0, 1000),
    memberNotifyPerHour: int(env, 'MEMBER_NOTIFY_PER_HOUR', 120, 1, 1_000_000),
    memberChannels: int(env, 'MEMBER_NOTIFY_CHANNELS', 10, 0, 1000),
    requireMfaForAdmins: bool(env, 'REQUIRE_MFA_FOR_ADMINS', false),
    userAgent: `PTR-Uptime/${opts.version}${opts.publicUrl ? ` (+${opts.publicUrl}/uptime-bot)` : ''}`,
  };
}
