// Test doubles for the notification module: a recording SafeNet and payload builders.
import type { HttpRequestOptions, HttpResponse, NotifyPayload, SafeNet } from '../src/uptime/types.js';

export interface RecordedRequest extends HttpRequestOptions {
  bodyText: string;
}

export type FakeReply = Partial<Omit<HttpResponse, 'body'>> & { body?: string | Buffer };

/** SafeNet that records every request and answers from `handler` (default: 200 {"ok":true}). */
export class FakeNet implements SafeNet {
  requests: RecordedRequest[] = [];
  handler: (req: RecordedRequest) => FakeReply | Error | Promise<FakeReply | Error> = () => ({ status: 200, body: '{"ok":true}' });

  async request(opts: HttpRequestOptions): Promise<HttpResponse> {
    const rec: RecordedRequest = { ...opts, bodyText: opts.body === undefined ? '' : Buffer.isBuffer(opts.body) ? opts.body.toString('utf8') : opts.body };
    this.requests.push(rec);
    const r = await this.handler(rec);
    if (r instanceof Error) throw r;
    const body = r.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body);
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      truncated: false,
      url: opts.url,
      redirects: 0,
      timings: { dnsMs: 0, connectMs: 0, tlsMs: 0, ttfbMs: 0, totalMs: 0 },
      remoteAddress: '203.0.113.10',
      ...r,
      body,
    };
  }

  async resolve(): Promise<never> {
    throw new Error('not implemented in FakeNet');
  }
  async connect(): Promise<never> {
    throw new Error('not implemented in FakeNet');
  }
  async dnsQuery(): Promise<never> {
    throw new Error('not implemented in FakeNet');
  }
  async udp(): Promise<never> {
    throw new Error('not implemented in FakeNet');
  }
  assertAllowed(): void {}

  get last(): RecordedRequest {
    const r = this.requests[this.requests.length - 1];
    if (!r) throw new Error('no request recorded');
    return r;
  }

  json(i = this.requests.length - 1): Record<string, unknown> {
    const r = this.requests[i];
    if (!r) throw new Error('no request recorded');
    return JSON.parse(r.bodyText) as Record<string, unknown>;
  }
}

export const HOSTILE_NAME = '<b>@everyone</b>';
export const HOSTILE_MSG = '<!channel> <@U123> *bold* _x_ @here [link](http://evil.example) ‮gnp.exe\n<script>';

export function downPayload(over: Partial<NotifyPayload> = {}): NotifyPayload {
  return {
    event: 'down',
    ts: Date.UTC(2026, 5, 15, 12, 0, 0),
    monitor: { uid: 'mon000000001', name: HOSTILE_NAME, type: 'http', target: 'https://example.com/', siteId: 'site00000001', siteName: 'Example' },
    status: 'down',
    previousStatus: 'up',
    msg: HOSTILE_MSG,
    latencyMs: null,
    dashboardUrl: 'https://analytics.example.com/sites/site00000001/uptime',
    ...over,
  };
}

export function upPayload(over: Partial<NotifyPayload> = {}): NotifyPayload {
  return downPayload({ event: 'up', status: 'up', previousStatus: 'down', msg: '200 OK', latencyMs: 123, downtimeMs: 125_000, ...over });
}

export const TEST_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
