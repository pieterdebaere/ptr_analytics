// Shared contract of the uptime module (docs/SPEC.md §8). Owners:
//   engine / scheduler / API ............ uptime/engine/*, uptime/api/*, uptime/stats.ts, uptime/runtime.ts
//   network layer, secrets, checkers ..... uptime/net/*, uptime/secrets.ts, uptime/checkers/*
//   notifications ........................ uptime/notify/*
//   status pages, badges ................. uptime/status/*
// Change this file only in a backwards-compatible way (add optional members).
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { UptimeConfig } from './config.js';

/* ------------------------------------------------------------------ statuses */

export const STATUS = { UNKNOWN: -1, DOWN: 0, UP: 1, PENDING: 2, MAINTENANCE: 3 } as const;
export type Status = (typeof STATUS)[keyof typeof STATUS];
export type StatusName = 'unknown' | 'down' | 'up' | 'pending' | 'maintenance';

export function statusName(s: number): StatusName {
  switch (s) {
    case 0:
      return 'down';
    case 1:
      return 'up';
    case 2:
      return 'pending';
    case 3:
      return 'maintenance';
    default:
      return 'unknown';
  }
}

/* ------------------------------------------------------------- form metadata */

/**
 * Declarative description of a configuration field. The dashboard renders monitor and
 * notification-channel forms from these definitions (GET /api/uptime/types,
 * GET /api/notification-providers), so the server stays the single source of truth.
 */
export interface FieldDef {
  key: string;
  label: string;
  kind:
    | 'text'
    | 'url'
    | 'host'
    | 'number'
    | 'boolean'
    | 'select'
    | 'textarea'
    | 'password' //  secret: write-only, never returned by the API
    | 'list' //      array of strings (one per line in the UI)
    | 'keyvalue' //  array of {key, value} (headers); values may be secret when `secret`
    | 'statuscodes'; // e.g. ["200-299", "301"]
  required?: boolean;
  /** Stored encrypted in `secrets`, write-only in the API (UI shows "•••• set"). */
  secret?: boolean;
  default?: unknown;
  options?: ReadonlyArray<{ value: string; label: string }>;
  min?: number;
  max?: number;
  maxLength?: number;
  placeholder?: string;
  help?: string;
  /** Show only when another field has one of these values. */
  showIf?: { key: string; equals: ReadonlyArray<string | number | boolean> };
  /** Group fields in the UI ("Request", "Authentication", "Advanced", …). */
  group?: string;
  /** Field is ignored / forbidden in hosted mode for members. */
  selfHostedOnly?: boolean;
}

export class ValidationError extends Error {
  override name = 'ValidationError';
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export interface ValidateContext {
  hosted: boolean;
  role: 'admin' | 'viewer' | 'member';
  config: UptimeConfig;
  /** Current secrets when updating: a secret field sent as `undefined`/`""` keeps the stored value. */
  existingSecrets?: Record<string, string>;
}

/* ------------------------------------------------------------------- checkers */

export interface TlsInfo {
  valid: boolean;
  hostnameOk: boolean;
  subject: string | null;
  issuer: string | null;
  sans: string[];
  notBefore: number | null;
  notAfter: number | null;
  fingerprint256: string | null;
  chain: Array<{ subject: string | null; issuer: string | null; notAfter: number | null; fingerprint256: string | null }>;
  /** Error text when invalid (expired, self-signed, hostname mismatch …). */
  error?: string;
}

export interface CheckResult {
  status: 'up' | 'down';
  latencyMs?: number;
  /** Short human readable message (≤ 200 chars, no secrets, no response bodies of private data). */
  msg: string;
  tls?: TlsInfo;
  /** Domain expiry (ms epoch) when the checker looked it up. */
  domainExpiresAt?: number | null;
  meta?: Record<string, string | number | boolean | null>;
}

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  maxRedirects?: number;
  /** Accept invalid certificates (the certificate is still captured). */
  ignoreTls?: boolean;
  family?: 4 | 6 | 0;
  maxBodyBytes: number;
  signal: AbortSignal;
  /** Client certificate (mTLS), PEM. */
  clientCert?: { cert: string; key: string; ca?: string };
  /** Follow https → http redirects (default false; always false for hosted members). */
  allowDowngrade?: boolean;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  /** At most maxBodyBytes; `truncated` tells whether more was available. */
  body: Buffer;
  truncated: boolean;
  /** Final URL after redirects. */
  url: string;
  redirects: number;
  timings: { dnsMs: number; connectMs: number; tlsMs: number; ttfbMs: number; totalMs: number };
  tls?: TlsInfo;
  remoteAddress: string;
}

export interface ResolvedTarget {
  host: string;
  /** Every address the name resolved to, all of them checked against the policy. */
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

/**
 * SSRF-safe network primitives (implemented in uptime/net). Checkers MUST use these and never
 * `node:net` / `node:http` / `dns.lookup` directly: every destination is resolved, every address
 * is checked against the target policy and the connection goes to exactly the checked address
 * (no second resolution → no DNS rebinding). Redirects are re-checked hop by hop.
 */
export interface SafeNet {
  resolve(host: string, opts: { family?: 4 | 6 | 0; signal: AbortSignal }): Promise<ResolvedTarget>;
  connect(opts: {
    host: string;
    port: number;
    family?: 4 | 6 | 0;
    signal: AbortSignal;
    /** Upgrade to TLS right away (servername = host unless an IP). */
    tls?: { servername?: string; rejectUnauthorized: boolean; alpn?: string[]; cert?: string; key?: string; ca?: string };
  }): Promise<{ socket: Socket | TLSSocket; remoteAddress: string; connectMs: number; tlsMs: number }>;
  request(opts: HttpRequestOptions): Promise<HttpResponse>;
  /** DNS query against a specific resolver (UDP/TCP 53), checked against the policy. */
  dnsQuery(opts: { server: string; port?: number; name: string; type: string; signal: AbortSignal }): Promise<{ answers: Array<{ type: string; value: string; ttl: number }>; rcode: string; latencyMs: number }>;
  /** Single UDP request/response (NTP, …), destination checked. */
  udp(opts: { host: string; port: number; payload: Buffer; signal: AbortSignal; family?: 4 | 6 | 0 }): Promise<{ data: Buffer; remoteAddress: string; latencyMs: number }>;
  /** Throws TargetDeniedError when the address is not allowed (for code paths like ping that use an IP literal). */
  assertAllowed(address: string): void;
}

export class TargetDeniedError extends Error {
  override name = 'TargetDeniedError';
}

export interface CheckContext<C = Record<string, unknown>, S = Record<string, string>> {
  monitorUid: string;
  config: C;
  secrets: S;
  timeoutMs: number;
  signal: AbortSignal;
  net: SafeNet;
  userAgent: string;
  maxBodyBytes: number;
  uptime: UptimeConfig;
}

export type CheckerCategory = 'web' | 'network' | 'protocol' | 'passive' | 'infrastructure';

export interface CheckerDefinition<C = Record<string, unknown>, S = Record<string, string>> {
  type: string;
  label: string;
  description: string;
  category: CheckerCategory;
  fields: readonly FieldDef[];
  /** Defaults for new monitors of this type. */
  defaults?: { intervalS?: number; timeoutMs?: number; retries?: number };
  /** allowed: members may use it; restricted: allowed with extra limits; disabled: admins of self-hosted installs only. */
  hosted: 'allowed' | 'restricted' | 'disabled';
  /** Whether the type is usable with this configuration (ping binary present, docker enabled, …). */
  available?(cfg: UptimeConfig): boolean;
  /** Normalise + validate user input; throws ValidationError. Secret fields go to `secrets`. */
  validate(input: Record<string, unknown>, ctx: ValidateContext): { config: C; secrets: S };
  /** Absent for engine-driven types (push, group, manual). */
  check?(ctx: CheckContext<C, S>): Promise<CheckResult>;
  /** Display target without secrets (URL, host:port, record name …). */
  target(config: C): string | null;
  /** Hostname/IP used for TLS-certificate and domain-expiry tracking, when meaningful. */
  certHost?(config: C): string | null;
}

/* -------------------------------------------------------------- notifications */

export type NotifyEvent = 'down' | 'up' | 'resend' | 'cert' | 'domain' | 'maint_start' | 'maint_end' | 'test';

/** JSON stored in notify_outbox.payload (written by the engine, read by the dispatcher). No secrets. */
export interface NotifyPayload {
  event: NotifyEvent;
  ts: number;
  monitor: {
    uid: string;
    name: string;
    type: string;
    target: string | null;
    siteId: string;
    siteName: string;
  } | null;
  status: StatusName | null;
  previousStatus: StatusName | null;
  msg: string | null;
  latencyMs?: number | null;
  /** Outage duration for "up" events. */
  downtimeMs?: number | null;
  cert?: { daysLeft: number; notAfter: number; subject: string | null; host: string | null };
  domain?: { daysLeft: number; expiresAt: number; domain: string };
  maintenance?: { uid: string; title: string };
  /** Deep link into the dashboard (PUBLIC_URL based) or null. */
  dashboardUrl: string | null;
}

export interface ProviderSendContext<C = Record<string, unknown>, S = Record<string, string>> {
  config: C;
  secrets: S;
  payload: NotifyPayload;
  /** Rendered default title/body (plain text); providers may build richer formats. */
  title: string;
  text: string;
  net: SafeNet;
  signal: AbortSignal;
  userAgent: string;
  /** Mail transport for the e-mail provider. */
  sendMail?: (msg: { to: string; subject: string; text: string; html: string }) => Promise<void>;
}

export interface ProviderDefinition<C = Record<string, unknown>, S = Record<string, string>> {
  id: string;
  label: string;
  category: 'chat' | 'push' | 'incident' | 'email' | 'sms' | 'webhook' | 'other';
  fields: readonly FieldDef[];
  /** allowed | disabled in hosted mode (members). */
  hosted: 'allowed' | 'disabled';
  validate(input: Record<string, unknown>, ctx: ValidateContext): { config: C; secrets: S };
  send(ctx: ProviderSendContext<C, S>): Promise<{ httpStatus?: number }>;
}
