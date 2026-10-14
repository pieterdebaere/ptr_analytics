// Extended send context passed by the notifier to providers. The shared ProviderSendContext
// (uptime/types.ts) stays the contract; the notifier adds the structured message, a delivery id
// (idempotency keys, e.g. Matrix transaction ids) and the e-mail delivery hooks.
import { randomBytes } from 'node:crypto';
import type { ProviderSendContext } from '../types.js';
import { buildMessage, type Message } from './render.js';

export interface EmailRecipient {
  address: string;
  /** One-click unsubscribe URL (PUBLIC_URL based) or null when PUBLIC_URL is not configured. */
  unsubscribeUrl: string | null;
}

export interface OutgoingNotifyMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export interface EmailDelivery {
  /** Channel name (cleaned) for the footer. */
  channelName: string;
  /** Confirmed, subscribed recipients. */
  recipients: EmailRecipient[];
  send(mail: OutgoingNotifyMail): Promise<void>;
}

export interface NotifySendContext<C = Record<string, unknown>, S = Record<string, string>> extends ProviderSendContext<C, S> {
  message: Message;
  /** Stable per outbox row (same across retries). */
  deliveryId: string;
  email?: EmailDelivery;
}

/** The extended context (fills the extras when a provider is called with a bare ProviderSendContext). */
export function ext<C, S>(ctx: ProviderSendContext<C, S>): NotifySendContext<C, S> {
  const x = ctx as Partial<NotifySendContext<C, S>> & ProviderSendContext<C, S>;
  return {
    ...x,
    message: x.message ?? buildMessage(ctx.payload),
    deliveryId: x.deliveryId ?? randomBytes(8).toString('hex'),
    ...(x.email ? { email: x.email } : {}),
  };
}
