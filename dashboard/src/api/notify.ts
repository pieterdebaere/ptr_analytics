// Typed client for notification providers and channels (docs/SPEC.md §8.3).
// Responses are parsed defensively; every string stays untrusted (render via displayText).
import { request } from './client';
import { parseFieldDefs, type FieldDef } from './uptime';

export type ProviderCategory = 'chat' | 'push' | 'incident' | 'email' | 'sms' | 'webhook' | 'other';

export const PROVIDER_CATEGORIES: readonly ProviderCategory[] = ['chat', 'push', 'incident', 'email', 'sms', 'webhook', 'other'];

export const PROVIDER_CATEGORY_LABELS: Record<ProviderCategory, string> = {
  chat: 'Chat',
  push: 'Push notifications',
  incident: 'Incident management',
  email: 'E-mail',
  sms: 'SMS & phone',
  webhook: 'Webhooks',
  other: 'Other',
};

export interface NotificationProvider {
  id: string;
  label: string;
  category: ProviderCategory;
  fields: FieldDef[];
  /** false: refused for members in hosted mode. */
  hostedAllowed: boolean;
  /** `{{variable}}` names usable in custom templates (webhook). */
  templateVars: string[];
  /** Ready-made configs (webhook): prefill the form only. */
  presets: WebhookPreset[];
}

export interface WebhookPreset {
  id: string;
  label: string;
  help: string;
  /** Header names to add as empty (secret) rows. */
  headerNames: string[];
  config: Record<string, unknown>;
}

export interface EmailRecipient {
  address: string;
  verified: boolean;
  unsubscribed: boolean;
}

export interface NotificationChannel {
  uid: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
  secretsSet: string[];
  isDefault: boolean;
  active: boolean;
  /** E-mail double opt-in (hosted mode); true for other providers. */
  verified: boolean;
  consecutiveFailures: number;
  /** Switched off automatically after too many failed deliveries. */
  autoDisabled: boolean;
  monitorCount: number;
  /** E-mail channels: double opt-in state per address. */
  recipients: EmailRecipient[];
}

export interface ChannelInput {
  /** E-mail: send the confirmation link again to unconfirmed recipients. */
  resendVerification?: boolean;
  type?: string;
  name?: string;
  config?: Record<string, unknown>;
  isDefault?: boolean;
  active?: boolean;
  /** One-shot: link the channel to all of the owner's existing monitors. */
  applyToExisting?: boolean;
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

export type DeliveryEvent = 'down' | 'up' | 'resend' | 'cert' | 'domain' | 'maint_start' | 'maint_end' | 'test' | string;

export interface DeliveryLogEntry {
  ts: number;
  event: DeliveryEvent;
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  monitorUid: string | null;
}

/* ------------------------------------------------------------------ parsing */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseCategory(v: unknown): ProviderCategory {
  return (PROVIDER_CATEGORIES as readonly unknown[]).includes(v) ? (v as ProviderCategory) : 'other';
}

export function parseProvider(raw: unknown): NotificationProvider | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id,
    label: str(raw.label, raw.id),
    category: parseCategory(raw.category),
    fields: parseFieldDefs(raw.fields),
    // `hosted: 'disabled'` is the server-side spelling of the same flag
    hostedAllowed: raw.hostedAllowed === false || raw.hosted === 'disabled' ? false : true,
    templateVars: arr(raw.templateVars)
      .filter((v): v is string => typeof v === 'string' && /^[a-z_.]{1,40}$/.test(v))
      .slice(0, 50),
    presets: arr(raw.presets)
      .filter(isObj)
      .filter((p) => typeof p.id === 'string' && typeof p.label === 'string' && isObj(p.config))
      .slice(0, 50)
      .map((p) => ({
        id: str(p.id),
        label: str(p.label),
        help: str(p.help),
        headerNames: arr(p.headerNames).filter((h): h is string => typeof h === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(h)),
        config: p.config as Record<string, unknown>,
      })),
  };
}

export function parseChannel(raw: unknown): NotificationChannel | null {
  if (!isObj(raw) || typeof raw.uid !== 'string' || !raw.uid) return null;
  return {
    uid: raw.uid,
    type: str(raw.type),
    name: str(raw.name, raw.uid),
    config: isObj(raw.config) ? raw.config : {},
    secretsSet: arr(raw.secretsSet).filter((s): s is string => typeof s === 'string'),
    isDefault: raw.isDefault === true,
    active: raw.active !== false,
    verified: raw.verified !== false,
    consecutiveFailures: Math.max(0, Math.floor(num(raw.consecutiveFailures))),
    autoDisabled: raw.autoDisabled === true,
    monitorCount: Math.max(0, Math.floor(num(raw.monitorCount))),
    recipients: arr(raw.recipients)
      .filter(isObj)
      .filter((r) => typeof r.address === 'string')
      .map((r) => ({ address: str(r.address), verified: r.verified === true, unsubscribed: r.unsubscribed === true })),
  };
}

export function parseLogEntry(raw: unknown): DeliveryLogEntry | null {
  if (!isObj(raw)) return null;
  const ts = numOrNull(raw.ts);
  if (ts === null) return null;
  return {
    ts,
    event: str(raw.event, 'unknown'),
    ok: raw.ok === true || raw.ok === 1,
    httpStatus: numOrNull(raw.httpStatus),
    error: typeof raw.error === 'string' ? raw.error : null,
    monitorUid: typeof raw.monitorUid === 'string' ? raw.monitorUid : null,
  };
}

function parseTest(raw: unknown): TestResult {
  if (!isObj(raw)) return { ok: false, error: 'Invalid response from server.' };
  const ok = raw.ok === true;
  return ok ? { ok } : { ok, error: typeof raw.error === 'string' && raw.error ? raw.error.slice(0, 500) : 'Sending failed.' };
}

function channelFrom(raw: unknown): NotificationChannel {
  const c = parseChannel(isObj(raw) ? (raw.channel ?? raw) : null);
  if (!c) throw new Error('Invalid response from server.');
  return c;
}

const notNull = <T>(v: T | null): v is T => v !== null;

/* ------------------------------------------------------------------ client */

const chPath = (uid: string) => `/notification-channels/${encodeURIComponent(uid)}`;

export const notifyApi = {
  providers: (signal?: AbortSignal) =>
    request<unknown>('GET', '/notification-providers', { signal }).then((r) =>
      arr(isObj(r) ? r.providers : r)
        .map(parseProvider)
        .filter(notNull),
    ),
  listChannels: (signal?: AbortSignal) =>
    request<unknown>('GET', '/notification-channels', { signal }).then((r) =>
      arr(isObj(r) ? r.channels : r)
        .map(parseChannel)
        .filter(notNull),
    ),
  getChannel: (uid: string, signal?: AbortSignal) => request<unknown>('GET', chPath(uid), { signal }).then(channelFrom),
  /** Validation errors carry `ApiError.field` (config key) — show them next to the input. */
  createChannel: (body: ChannelInput) => request<unknown>('POST', '/notification-channels', { body }).then(channelFrom),
  updateChannel: (uid: string, body: ChannelInput) => request<unknown>('PATCH', chPath(uid), { body }).then(channelFrom),
  /**
   * E-mail: sends the opt-in link again to unconfirmed recipients. `verificationSent` = mails
   * actually sent (never to addresses that unsubscribed / declined; rate limited per address).
   */
  resendVerification: (uid: string) =>
    request<unknown>('PATCH', chPath(uid), { body: { resendVerification: true } }).then((r) => ({
      channel: channelFrom(r),
      verificationSent: isObj(r) && typeof r.verificationSent === 'number' && r.verificationSent >= 0 ? Math.floor(r.verificationSent) : null,
    })),
  deleteChannel: (uid: string) => request<void>('DELETE', chPath(uid)),
  /** Sends a test message through a saved channel (rate limited). */
  testChannel: (uid: string) => request<unknown>('POST', `${chPath(uid)}/test`).then(parseTest),
  /** Sends a test message for an unsaved channel form. With `uid`, stored secrets fill omitted secret fields. */
  testUnsaved: (body: ChannelInput & { uid?: string }) =>
    request<unknown>('POST', '/notification-channels/test', { body }).then(parseTest),
  log: (uid: string, limit = 50, signal?: AbortSignal) =>
    request<unknown>('GET', `${chPath(uid)}/log`, { query: new URLSearchParams({ limit: String(limit) }), signal }).then((r) =>
      arr(isObj(r) ? r.entries : r)
        .map(parseLogEntry)
        .filter(notNull),
    ),
};

export const DELIVERY_EVENT_LABELS: Record<string, string> = {
  down: 'Down',
  up: 'Up',
  resend: 'Still down',
  cert: 'Certificate expiry',
  domain: 'Domain expiry',
  maint_start: 'Maintenance started',
  maint_end: 'Maintenance ended',
  test: 'Test',
};

export function deliveryEventLabel(e: string): string {
  return DELIVERY_EVENT_LABELS[e] ?? 'Other';
}
