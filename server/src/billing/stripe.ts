import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stripe subscription fields we use (everything else is ignored). */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  created: number;
  cancelAtPeriodEnd: boolean;
  items: Array<{ id: string; priceId: string | null; quantity: number }>;
}

export interface CheckoutParams {
  customerId: string;
  priceId: string;
  quantity: number;
  successUrl: string;
  cancelUrl: string;
  userId: number;
  automaticTax: boolean;
}

/**
 * The Stripe operations used by billing. The HTTP implementation talks to the REST API with
 * `fetch`; tests inject a fake.
 */
export interface StripeClient {
  createCustomer(p: { email: string; userId: number }): Promise<{ id: string }>;
  createCheckoutSession(p: CheckoutParams): Promise<{ url: string }>;
  createPortalSession(p: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** All subscriptions of a customer (any status), newest first. */
  listSubscriptions(customerId: string): Promise<StripeSubscription[]>;
  retrieveSubscription(id: string): Promise<StripeSubscription>;
  updateSubscription(
    id: string,
    p: {
      item?: { id: string; quantity: number };
      cancelAtPeriodEnd?: boolean;
      prorationBehavior?: 'create_prorations' | 'always_invoice' | 'none';
      paymentBehavior?: 'pending_if_incomplete' | 'allow_incomplete' | 'error_if_incomplete';
    },
  ): Promise<StripeSubscription>;
  /** Cancel immediately. */
  cancelSubscription(id: string): Promise<void>;
  /** Delete a customer (also invalidates its open Checkout sessions). */
  deleteCustomer(id: string): Promise<void>;
}

/** A failed Stripe call. Carries only non-secret diagnostics (never the request or key). */
export class StripeError extends Error {
  override name = 'StripeError';
  constructor(
    readonly status: number,
    readonly type: string | undefined,
    readonly code: string | undefined,
  ) {
    super(`Stripe API error (status ${status}${type ? `, ${type}` : ''}${code ? `, ${code}` : ''})`);
  }
}

const ID_RE = /^[A-Za-z0-9_]{1,255}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Id of an expandable field (a string id, or an object with `id`). */
export function idOf(v: unknown): string | null {
  const id = typeof v === 'string' ? v : isObj(v) ? str(v['id']) : null;
  return id !== null && ID_RE.test(id) ? id : null;
}

function bad(): StripeError {
  return new StripeError(0, 'invalid_response', undefined);
}

export function parseSubscription(v: unknown): StripeSubscription {
  if (!isObj(v)) throw bad();
  const id = idOf(v['id']);
  const customer = idOf(v['customer']);
  const status = str(v['status']);
  if (id === null || customer === null || status === null) throw bad();
  const itemsRaw = isObj(v['items']) && Array.isArray(v['items']['data']) ? (v['items']['data'] as unknown[]) : [];
  const items: StripeSubscription['items'] = [];
  for (const it of itemsRaw) {
    if (!isObj(it)) continue;
    const itemId = idOf(it['id']);
    if (itemId === null) continue;
    const quantity = typeof it['quantity'] === 'number' && Number.isSafeInteger(it['quantity']) ? it['quantity'] : 0;
    items.push({ id: itemId, priceId: isObj(it['price']) ? idOf(it['price']['id']) : idOf(it['price']), quantity });
  }
  return {
    id,
    customer,
    status,
    created: typeof v['created'] === 'number' ? v['created'] : 0,
    cancelAtPeriodEnd: v['cancel_at_period_end'] === true,
    items,
  };
}

function httpsUrl(v: unknown): string {
  const s = str(v);
  if (s === null) throw bad();
  try {
    if (new URL(s).protocol !== 'https:') throw bad();
  } catch {
    throw bad();
  }
  return s;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Stripe REST client (form-encoded requests, `Authorization: Bearer`). */
export class HttpStripeClient implements StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly fetchFn: FetchLike = fetch,
    private readonly baseUrl = 'https://api.stripe.com',
    private readonly timeoutMs = 15_000,
  ) {}

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string> = {}): Promise<unknown> {
    const body = new URLSearchParams(params).toString();
    const url = method === 'GET' && body ? `${this.baseUrl}${path}?${body}` : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Stripe-Version': '2024-06-20',
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = body;
    }
    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch {
      // network error / timeout: never include the request (it carries the key in headers)
      throw new StripeError(0, 'network_error', undefined);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new StripeError(res.status, 'invalid_response', undefined);
    }
    if (!res.ok) {
      const err = isObj(json) && isObj(json['error']) ? json['error'] : {};
      throw new StripeError(res.status, str(err['type']) ?? undefined, str(err['code']) ?? undefined);
    }
    return json;
  }

  async createCustomer(p: { email: string; userId: number }): Promise<{ id: string }> {
    const r = await this.request('POST', '/v1/customers', { email: p.email, 'metadata[user_id]': String(p.userId) });
    const id = isObj(r) ? idOf(r['id']) : null;
    if (id === null) throw bad();
    return { id };
  }

  async createCheckoutSession(p: CheckoutParams): Promise<{ url: string }> {
    const params: Record<string, string> = {
      mode: 'subscription',
      customer: p.customerId,
      'line_items[0][price]': p.priceId,
      'line_items[0][quantity]': String(p.quantity),
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
      client_reference_id: String(p.userId),
      'subscription_data[metadata][user_id]': String(p.userId),
      allow_promotion_codes: 'false',
    };
    if (p.automaticTax) {
      params['automatic_tax[enabled]'] = 'true';
      // Stripe Tax needs the customer's address; let Checkout collect and save it.
      params['customer_update[address]'] = 'auto';
      params['customer_update[name]'] = 'auto';
      params['billing_address_collection'] = 'required';
    }
    const r = await this.request('POST', '/v1/checkout/sessions', params);
    return { url: httpsUrl(isObj(r) ? r['url'] : null) };
  }

  async createPortalSession(p: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const r = await this.request('POST', '/v1/billing_portal/sessions', { customer: p.customerId, return_url: p.returnUrl });
    return { url: httpsUrl(isObj(r) ? r['url'] : null) };
  }

  async listSubscriptions(customerId: string): Promise<StripeSubscription[]> {
    const r = await this.request('GET', '/v1/subscriptions', { customer: customerId, status: 'all', limit: '20' });
    if (!isObj(r) || !Array.isArray(r['data'])) throw bad();
    return (r['data'] as unknown[]).map(parseSubscription);
  }

  async retrieveSubscription(id: string): Promise<StripeSubscription> {
    if (!ID_RE.test(id)) throw bad();
    return parseSubscription(await this.request('GET', `/v1/subscriptions/${id}`));
  }

  async updateSubscription(
    id: string,
    p: Parameters<StripeClient['updateSubscription']>[1],
  ): Promise<StripeSubscription> {
    if (!ID_RE.test(id)) throw bad();
    const params: Record<string, string> = {};
    if (p.item) {
      params['items[0][id]'] = p.item.id;
      params['items[0][quantity]'] = String(p.item.quantity);
    }
    if (p.cancelAtPeriodEnd !== undefined) params['cancel_at_period_end'] = String(p.cancelAtPeriodEnd);
    if (p.prorationBehavior) params['proration_behavior'] = p.prorationBehavior;
    if (p.paymentBehavior) params['payment_behavior'] = p.paymentBehavior;
    return parseSubscription(await this.request('POST', `/v1/subscriptions/${id}`, params));
  }

  async cancelSubscription(id: string): Promise<void> {
    if (!ID_RE.test(id)) throw bad();
    try {
      await this.request('DELETE', `/v1/subscriptions/${id}`);
    } catch (err) {
      // Already cancelled / gone: nothing left to cancel.
      if (err instanceof StripeError && err.status === 404) return;
      throw err;
    }
  }

  async deleteCustomer(id: string): Promise<void> {
    if (!ID_RE.test(id)) throw bad();
    try {
      await this.request('DELETE', `/v1/customers/${id}`);
    } catch (err) {
      if (err instanceof StripeError && err.status === 404) return;
      throw err;
    }
  }
}

// ---- webhook signatures ----

/** Webhook timestamps may differ from our clock by at most this much (Stripe's default). */
export const WEBHOOK_TOLERANCE_S = 300;
const MAX_SIGNATURE_HEADER = 4096;
const MAX_SIGNATURES = 16;

/**
 * Verify a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=<hex>...]`) for the raw body:
 * HMAC-SHA256 over `${t}.${rawBody}` with the endpoint secret, compared in constant time
 * against every v1 signature; the timestamp must be within the tolerance (both directions).
 */
export function verifyStripeSignature(rawBody: Buffer, header: unknown, secret: string, nowMs: number): boolean {
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_SIGNATURE_HEADER) return false;
  let timestamp: string | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return false;
      timestamp = value;
    } else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value) && signatures.length < MAX_SIGNATURES) {
      signatures.push(Buffer.from(value, 'hex'));
    }
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  let ok = false;
  // Check every candidate (no early exit) so timing does not depend on which one matched.
  for (const sig of signatures) {
    if (sig.length === expected.length && timingSafeEqual(sig, expected)) ok = true;
  }
  return ok;
}

/** Build a valid signature header (tests and local tooling). */
export function signStripePayload(rawBody: string | Buffer, secret: string, timestampS: number): string {
  const sig = createHmac('sha256', secret).update(`${timestampS}.`).update(rawBody).digest('hex');
  return `t=${timestampS},v1=${sig}`;
}
