// One delivery attempt through a provider: builds the message, wires SafeNet / e-mail,
// enforces the timeout and turns any failure into a redacted, classified result.
import type { AppContext } from '../../context.js';
import type { NotifyPayload, ProviderDefinition } from '../types.js';
import type { ChannelRow } from './channels.js';
import { parseConfig } from './channels.js';
import type { EmailDelivery, NotifySendContext } from './context.js';
import { deliveryRecipients } from './email.js';
import { DeliveryError } from './http.js';
import { redactError, secretValues } from './redact.js';
import { buildMessage, clean } from './render.js';
import { notifyState, safeNetFor, sendViaOperator, sendViaSmtp } from './state.js';

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface DeliverTarget {
  provider: ProviderDefinition<Record<string, unknown>, Record<string, string>>;
  /** Saved channel (for e-mail recipients) or null for unsaved test sends. */
  row: Pick<ChannelRow, 'id' | 'uid' | 'name'> | null;
  name: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  hostedMember: boolean;
  /** Unsaved e-mail tests: send to the configured addresses without unsubscribe links (operators only). */
  directRecipients?: string[];
}

export interface DeliverResult {
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  retryable: boolean;
  retryAfterMs?: number;
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DeliveryError('timed out', { retryable: true }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DeliveryError('timed out', { retryable: true }));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function classify(err: unknown): { retryable: boolean; httpStatus: number | null; retryAfterMs?: number; message: unknown } {
  if (err instanceof DeliveryError) {
    return { retryable: err.opts.retryable, httpStatus: err.opts.httpStatus ?? null, ...(err.opts.retryAfterMs !== undefined ? { retryAfterMs: err.opts.retryAfterMs } : {}), message: err };
  }
  const name = err instanceof Error ? err.name : '';
  if (name === 'TargetDeniedError') return { retryable: false, httpStatus: null, message: 'destination not allowed' };
  if (name === 'ValidationError') return { retryable: false, httpStatus: null, message: err };
  if (name === 'AbortError' || name === 'TimeoutError') return { retryable: true, httpStatus: null, message: 'timed out' };
  // Network errors (ECONNREFUSED, ECONNRESET, DNS …) are transient.
  return { retryable: true, httpStatus: null, message: err };
}

function emailDelivery(ctx: AppContext, t: DeliverTarget, deliveryId: string, signal: AbortSignal): EmailDelivery {
  const recipients = t.directRecipients
    ? t.directRecipients.map((address) => ({ address, unsubscribeUrl: null }))
    : t.row
      ? deliveryRecipients(ctx, t.row)
      : [];
  const smtpUrl = t.hostedMember ? undefined : t.secrets['smtpUrl'];
  const from = typeof t.config['from'] === 'string' ? (t.config['from'] as string) : '';
  return {
    channelName: clean(t.name, 100),
    recipients,
    send: async (mail) => {
      if (smtpUrl && from) await sendViaSmtp(ctx, safeNetFor(ctx, false), smtpUrl, from, mail, signal);
      else sendViaOperator(ctx, mail, `${deliveryId}:${mail.to}`);
    },
  };
}

/** Run one delivery attempt. Never throws. */
export async function deliver(
  ctx: AppContext,
  t: DeliverTarget,
  payload: NotifyPayload,
  opts: { deliveryId: string; stopSignal?: AbortSignal; timeoutMs?: number },
): Promise<DeliverResult> {
  const timeoutMs = opts.timeoutMs ?? notifyState(ctx).overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onStop = (): void => controller.abort();
  opts.stopSignal?.addEventListener('abort', onStop, { once: true });
  const secretList = secretValues(t.secrets);
  try {
    const message = buildMessage(payload);
    const net = safeNetFor(ctx, t.hostedMember);
    const sendCtx: NotifySendContext<Record<string, unknown>, Record<string, string>> = {
      config: t.config,
      secrets: t.secrets,
      payload,
      title: message.title,
      text: message.text,
      net,
      signal: controller.signal,
      userAgent: ctx.config.uptime.userAgent,
      message,
      deliveryId: opts.deliveryId,
      ...(t.provider.id === 'email' ? { email: emailDelivery(ctx, t, opts.deliveryId, controller.signal) } : {}),
    };
    const res = await abortable(t.provider.send(sendCtx), controller.signal);
    return { ok: true, httpStatus: res.httpStatus ?? null, error: null, retryable: false };
  } catch (err) {
    const c = classify(err);
    return {
      ok: false,
      httpStatus: c.httpStatus,
      error: redactError(c.message, secretList),
      retryable: c.retryable,
      ...(c.retryAfterMs !== undefined ? { retryAfterMs: c.retryAfterMs } : {}),
    };
  } finally {
    clearTimeout(timer);
    opts.stopSignal?.removeEventListener('abort', onStop);
  }
}

/** Deliver-target for a saved channel row (secrets already decrypted). */
export function savedTarget(
  provider: DeliverTarget['provider'],
  row: Pick<ChannelRow, 'id' | 'uid' | 'name' | 'config'>,
  secrets: Record<string, string>,
  hostedMember: boolean,
): DeliverTarget {
  return { provider, row, name: row.name, config: parseConfig(row), secrets, hostedMember };
}
