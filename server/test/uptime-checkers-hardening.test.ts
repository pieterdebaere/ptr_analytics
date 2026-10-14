// Checker-side regression tests for the SSRF / checker security review (L3, L4, L5).
import { describe, expect, it } from 'vitest';
import { CHECKERS } from '../src/uptime/checkers/registry.js';
import type { CheckContext, HttpRequestOptions, HttpResponse, SafeNet } from '../src/uptime/types.js';
import { memberCtx, uptimeConfig, vctx } from './uptime-net-fixtures.js';

const def = (t: string) => CHECKERS.get(t)!;

/** SafeNet stub that records request options and answers 200 "ok". */
function recordingNet(seen: HttpRequestOptions[]): SafeNet {
  const fail = (): never => {
    throw new Error('not used');
  };
  return {
    resolve: fail,
    connect: fail,
    dnsQuery: fail,
    udp: fail,
    assertAllowed: fail,
    async request(o) {
      seen.push(o);
      const res: HttpResponse = {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: Buffer.from('ok'),
        truncated: false,
        url: o.url,
        redirects: 0,
        timings: { dnsMs: 0, connectMs: 0, tlsMs: 0, ttfbMs: 0, totalMs: 0 },
        remoteAddress: '93.184.216.34',
      };
      return res;
    },
  };
}

describe('L5: header values are validated at save with the node:http rule', () => {
  it('rejects control characters and non-Latin-1 characters in (secret) header values', () => {
    for (const type of ['http', 'keyword', 'json', 'websocket']) {
      const extra = type === 'keyword' ? { keyword: 'ok' } : {};
      const url = type === 'websocket' ? 'wss://example.com/' : 'https://example.com/';
      for (const value of ['a\u0001b', 'a\u001bb', 'a\u007fb', 'price €', 'a b']) {
        expect(() => def(type).validate({ url, ...extra, headers: [{ key: 'X-Test', value }] }, vctx()), `${type} ${JSON.stringify(value)}`).toThrow(/not allowed in HTTP headers/);
        expect(() => def(type).validate({ url, ...extra, secretHeaders: [{ key: 'X-Key', value }] }, vctx()), `${type} secret ${JSON.stringify(value)}`).toThrow(/not allowed in HTTP headers/);
      }
      // Tab and Latin-1 are accepted (node:http accepts them too).
      expect(() => def(type).validate({ url, ...extra, headers: [{ key: 'X-Test', value: 'a\tb café' }] }, vctx())).not.toThrow();
    }
    expect(() => def('http').validate({ url: 'https://example.com/', headers: [{ key: 'X(Y)', value: 'x' }] }, vctx())).toThrow(/header name/);
    expect(() => def('http').validate({ url: 'https://example.com/', authMethod: 'bearer', bearerToken: 't€' }, vctx())).toThrow(/bearerToken/);
  });
});

describe('L4: allowDowngrade option', () => {
  it('is off by default, settable by self-hosted admins and refused for hosted members', () => {
    expect(def('http').fields.find((f) => f.key === 'allowDowngrade')).toMatchObject({ kind: 'boolean', default: false, selfHostedOnly: true });
    expect((def('http').validate({ url: 'https://example.com/' }, vctx()).config as { allowDowngrade: boolean }).allowDowngrade).toBe(false);
    expect((def('keyword').validate({ url: 'https://example.com/', keyword: 'x', allowDowngrade: true }, vctx()).config as { allowDowngrade: boolean }).allowDowngrade).toBe(true);
    for (const type of ['http', 'keyword', 'json']) {
      const extra = type === 'keyword' ? { keyword: 'ok' } : {};
      expect(() => def(type).validate({ url: 'https://example.com/', ...extra, allowDowngrade: true }, memberCtx()), type).toThrow(/allowDowngrade/);
      expect(() => def(type).validate({ url: 'https://example.com/', ...extra, allowDowngrade: false }, memberCtx()), type).not.toThrow();
    }
  });

  it('is passed to SafeNet.request (false unless enabled)', async () => {
    const uptime = uptimeConfig();
    for (const allowDowngrade of [false, true]) {
      const seen: HttpRequestOptions[] = [];
      const v = def('http').validate({ url: 'https://example.com/', allowDowngrade }, vctx());
      const ctx: CheckContext = {
        monitorUid: 'm',
        config: v.config,
        secrets: v.secrets,
        timeoutMs: 1000,
        signal: AbortSignal.timeout(1000),
        net: recordingNet(seen),
        userAgent: 'ua',
        maxBodyBytes: uptime.maxBodyBytes,
        uptime,
      };
      expect((await def('http').check!(ctx)).status).toBe('up');
      expect(seen[0]?.allowDowngrade).toBe(allowDowngrade);
    }
  });
});

describe('L3: member request bodies', () => {
  it('limits the request body of members to 16 KiB (bytes, not characters)', () => {
    const big = JSON.stringify({ a: 'x'.repeat(16 * 1024) });
    expect(() => def('http').validate({ url: 'https://example.com/', method: 'POST', body: big }, memberCtx())).toThrow(/body must be at most 16 KiB/);
    expect(() => def('http').validate({ url: 'https://example.com/', method: 'POST', body: big }, vctx())).not.toThrow();
    const multibyte = JSON.stringify({ a: 'é'.repeat(9000) }); // ~18 KB in UTF-8, ~9 k characters
    expect(() => def('keyword').validate({ url: 'https://example.com/', keyword: 'x', method: 'POST', body: multibyte }, memberCtx())).toThrow(/16 KiB/);
    expect(() => def('http').validate({ url: 'https://example.com/', method: 'POST', body: '{"ok":true}' }, memberCtx())).not.toThrow();
  });
});
