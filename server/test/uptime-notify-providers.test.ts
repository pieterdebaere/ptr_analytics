import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadUptimeConfig } from '../src/uptime/config.js';
import type { NotifySendContext, OutgoingNotifyMail } from '../src/uptime/notify/context.js';
import { redactError, secretValues } from '../src/uptime/notify/redact.js';
import { buildMessage, escapeMarkdown, renderTemplate, templateProblem, templateVars, jsonStringEscape } from '../src/uptime/notify/render.js';
import { PROVIDERS, WEBHOOK_PRESETS } from '../src/uptime/notify/providers/registry.js';
import { SIGNATURE_HEADER, renderBody } from '../src/uptime/notify/providers/webhook.js';
import { telegramHtml } from '../src/uptime/notify/providers/telegram.js';
import { ValidationError, type NotifyPayload, type ValidateContext } from '../src/uptime/types.js';
import { FakeNet, HOSTILE_NAME, downPayload, upPayload } from './uptime-notify-fakes.js';

const uptime = loadUptimeConfig({}, { hosted: false, version: '1.0.0', publicUrl: null });
const ADMIN: ValidateContext = { hosted: false, role: 'admin', config: uptime };
const MEMBER: ValidateContext = { hosted: true, role: 'member', config: uptime };

function provider(id: string) {
  const p = PROVIDERS.get(id);
  if (!p) throw new Error(`no provider ${id}`);
  return p;
}

async function send(
  id: string,
  input: Record<string, unknown>,
  payload: NotifyPayload = downPayload(),
  opts: { net?: FakeNet; v?: ValidateContext; email?: NotifySendContext['email'] } = {},
): Promise<{ net: FakeNet; result: { httpStatus?: number } }> {
  const p = provider(id);
  const { config, secrets } = p.validate(input, opts.v ?? ADMIN);
  const net = opts.net ?? new FakeNet();
  const message = buildMessage(payload);
  const ctx: NotifySendContext = {
    config,
    secrets,
    payload,
    title: message.title,
    text: message.text,
    net,
    signal: new AbortController().signal,
    userAgent: 'PTR-Uptime/test',
    message,
    deliveryId: 'chan-42',
    ...(opts.email ? { email: opts.email } : {}),
  };
  const result = await p.send(ctx);
  return { net, result };
}

/** No dynamic content may produce a mention, markup or a bidi override. */
function assertNeutral(text: string, opts: { markup?: boolean } = {}): void {
  expect(text).not.toMatch(/@(everyone|here|channel|all|room)\b/);
  expect(text).not.toContain('\u202E');
  if (opts.markup !== false) {
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('<b>');
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<@U123>');
  }
}

describe('provider registry', () => {
  it('has every tier-1 provider with complete field definitions', () => {
    const ids = [...PROVIDERS.keys()];
    for (const id of [
      'email',
      'webhook',
      'slack',
      'discord',
      'telegram',
      'teams',
      'googlechat',
      'mattermost',
      'rocketchat',
      'matrix',
      'zulip',
      'signal',
      'ntfy',
      'gotify',
      'pushover',
      'pushbullet',
      'homeassistant',
      'pagerduty',
      'opsgenie',
      'twilio',
    ]) {
      expect(ids).toContain(id);
    }
    for (const p of PROVIDERS.values()) {
      expect(p.label).toBeTruthy();
      expect(p.fields.length).toBeGreaterThan(0);
      for (const f of p.fields) {
        expect(f.key).toMatch(/^[a-zA-Z]+$/);
        expect(f.label).toBeTruthy();
        // Token-ish fields are always secret.
        if (/token|password|apikey|secret|webhookurl|routingkey|authtoken|userkey/i.test(f.key) && !/Sid$/.test(f.key)) expect(f.secret, `${p.id}.${f.key}`).toBe(true);
        if (f.kind === 'select') expect(f.options?.length).toBeGreaterThan(0);
      }
    }
  });

  it('webhook presets are valid templates', () => {
    for (const p of WEBHOOK_PRESETS) expect(templateProblem(p.config.bodyTemplate, p.config.contentType), p.id).toBeNull();
  });
});

describe('rendering and escaping', () => {
  it('cleans hostile values and builds a plain message', () => {
    const m = buildMessage(downPayload());
    expect(m.title).toBe('🔴 <b>@everyone</b> is down');
    expect(m.summary).not.toContain('\u202E');
    expect(m.summary).not.toContain('\n');
    expect(m.severity).toBe('down');
    const up = buildMessage(upPayload());
    expect(up.summary).toContain('after 2m 5s');
    expect(up.facts.find((f) => f.label === 'Response time')?.value).toBe('123 ms');
  });

  it('markdown escaping neutralises formatting and mentions', () => {
    expect(escapeMarkdown('<@123> *x* @everyone')).toBe('\\<@\u200b123\\> \\*x\\* @\u200beveryone');
  });

  it('templates: single pass, allow-list, JSON-safe', () => {
    const p = downPayload({ monitor: { ...downPayload().monitor!, name: '{{dashboard_url}}"},"x":"' } });
    const vars = templateVars(p, buildMessage(p));
    const out = renderTemplate('{"name": "{{monitor.name}}"}', vars, jsonStringEscape);
    expect(JSON.parse(out)).toEqual({ name: '{{dashboard_url}}"},"x":"' });
    expect(templateProblem('{"a": {{latency_ms}}}', 'json')).toMatch(/inside a string/);
    expect(templateProblem('{"a": "{{constructor}}"}', 'json')).toMatch(/unknown placeholder/);
    expect(templateProblem('{"a": "{{ monitor.name | upcase }}"}', 'json')).toMatch(/malformed/);
    expect(templateProblem('{% include "/etc/passwd" %}', 'text')).toBeNull(); // literal text, no tags exist
    expect(templateProblem('x'.repeat(5000), 'text')).toMatch(/at most/);
    expect(templateProblem('{"text": "{{title}}"}', 'json')).toBeNull();
  });

  it('redacts secrets, URLs and tokens from errors', () => {
    const secrets = { botToken: '123456789:AAHsecretsecretsecretsecretsecret', webhookUrl: 'https://hooks.slack.com/services/T0/B0/abcdef12SECRET' };
    const err = new Error(
      'connect ECONNREFUSED https://api.telegram.org/bot123456789:AAHsecretsecretsecretsecretsecret/sendMessage ' +
        'body echoed abcdef12SECRET Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc ?token=zzz&x=1 ' +
        'x'.repeat(400),
    );
    const out = redactError(err, secretValues(secrets));
    expect(out).not.toContain('AAHsecret');
    expect(out).not.toContain('abcdef12SECRET');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('zzz');
    expect(out).toContain('https://api.telegram.org/…');
    expect(out.length).toBeLessThanOrEqual(300);
  });
});

describe('webhook', () => {
  it('posts the default JSON payload with custom headers, basic auth and HMAC signature', async () => {
    const { net } = await send('webhook', {
      url: 'https://hooks.example.com/uptime',
      headers: [{ key: 'X-Api-Key', value: 'k-123' }],
      basicAuthUser: 'bob',
      basicAuthPassword: 'pw',
      signingSecret: 'whsec-shared-secret',
    });
    const r = net.last;
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://hooks.example.com/uptime');
    expect(r.maxRedirects).toBe(0);
    expect(r.headers?.['content-type']).toBe('application/json');
    expect(r.headers?.['x-api-key']).toBe('k-123');
    expect(r.headers?.['authorization']).toBe(`Basic ${Buffer.from('bob:pw').toString('base64')}`);
    expect(r.headers?.['user-agent']).toBe('PTR-Uptime/test');
    const body = JSON.parse(r.bodyText) as Record<string, any>;
    expect(body.event).toBe('down');
    expect(body.monitor.name).toBe(HOSTILE_NAME); // machine-readable: raw (cleaned) value, JSON-encoded
    expect(body.monitor.uid).toBe('mon000000001');

    // Receiver-side verification example (documented in the field help).
    const sig = r.headers?.[SIGNATURE_HEADER.toLowerCase()] as string;
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
    expect(m).not.toBeNull();
    const [, t, v1] = m as unknown as [string, string, string];
    const expected = createHmac('sha256', 'whsec-shared-secret').update(`${t}.${r.bodyText}`).digest();
    expect(timingSafeEqual(expected, Buffer.from(v1, 'hex'))).toBe(true);
    expect(Math.abs(Number(t) - Date.now() / 1000)).toBeLessThan(300);
  });

  it('renders custom templates per content type with escaping', async () => {
    const tpl = '{"text": "{{title}}", "who": "{{monitor.name}}", "msg": "{{message}}"}';
    const { net } = await send('webhook', { url: 'https://h.example.com/', bodyTemplate: tpl, method: 'PUT' });
    expect(net.last.method).toBe('PUT');
    const body = JSON.parse(net.last.bodyText) as Record<string, string>;
    expect(body.who).toBe(HOSTILE_NAME);
    expect(body.msg).not.toContain('\u202E');

    const form = renderBody('form', 'title={{title}}\nmonitor={{monitor.name}}', downPayload(), buildMessage(downPayload()));
    expect(new URLSearchParams(form).get('monitor')).toBe(HOSTILE_NAME);
    const { net: n2 } = await send('webhook', { url: 'https://h.example.com/', contentType: 'text' });
    expect(n2.last.headers?.['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('validates URLs, templates and headers', () => {
    const p = provider('webhook');
    expect(() => p.validate({ url: 'http://h.example.com/' }, MEMBER)).toThrow(/https/);
    expect(() => p.validate({ url: 'https://10.0.0.1/' }, MEMBER)).toThrow(/hostname/);
    expect(() => p.validate({ url: 'https://user:pw@h.example.com/' }, ADMIN)).toThrow(/credentials/);
    expect(() => p.validate({ url: 'ftp://h.example.com/' }, ADMIN)).toThrow(/http/);
    expect(() => p.validate({ url: 'https://h.example.com/', bodyTemplate: '{"a": {{title}}}' }, ADMIN)).toThrow(ValidationError);
    expect(() => p.validate({ url: 'https://h.example.com/', headers: [{ key: 'Host', value: 'x' }] }, ADMIN)).toThrow(/cannot be set/);
    expect(() => p.validate({ url: 'https://h.example.com/', headers: [{ key: 'X-A', value: 'a\r\nB: c' }] }, ADMIN)).toThrow(/invalid value/);
    expect(p.validate({ url: 'http://192.168.1.5:8080/hook' }, ADMIN).config['url']).toBe('http://192.168.1.5:8080/hook');
  });

  it('secret fields are kept when omitted, cleared with null', () => {
    const p = provider('webhook');
    const existing = { signingSecret: 'old', basicAuthPassword: 'pw' };
    const kept = p.validate({ url: 'https://h.example.com/', basicAuthUser: 'u', signingSecret: '' }, { ...ADMIN, existingSecrets: existing });
    expect(kept.secrets).toEqual({ signingSecret: 'old', basicAuthPassword: 'pw' });
    const cleared = p.validate({ url: 'https://h.example.com/', basicAuthUser: 'u', signingSecret: null }, { ...ADMIN, existingSecrets: existing });
    expect(cleared.secrets).toEqual({ basicAuthPassword: 'pw' });
  });
});

describe('chat providers', () => {
  it('slack: blocks, escaped mrkdwn, only our own @channel mention', async () => {
    const url = 'https://hooks.slack.com/services/T000/B000/XXXXSECRET';
    const { net } = await send('slack', { webhookUrl: url, notifyChannel: true });
    expect(net.last.url).toBe(url);
    expect(net.last.method).toBe('POST');
    const body = net.json() as { text: string; attachments: Array<{ color: string; blocks: unknown[] }> };
    expect(body.text.startsWith('<!channel> ')).toBe(true);
    expect(body.attachments[0]?.color).toBe('#e01e5a');
    const blocks = JSON.stringify(body.attachments[0]?.blocks);
    assertNeutral(blocks);
    expect(blocks).toContain('&lt;b&gt;@\u200beveryone&lt;/b&gt;');
    expect(blocks).toContain('&lt;!channel&gt;');
    expect(() => provider('slack').validate({ webhookUrl: 'https://evil.example.com/services/x' }, ADMIN)).toThrow(/hooks.slack.com/);
  });

  it('discord: embed with colour, mentions disabled and escaped', async () => {
    const { net } = await send('discord', { webhookUrl: 'https://discord.com/api/webhooks/1/tok', threadId: '42', username: 'Uptime' });
    const u = new URL(net.last.url);
    expect(u.pathname).toBe('/api/webhooks/1/tok');
    expect(u.searchParams.get('thread_id')).toBe('42');
    expect(u.searchParams.get('wait')).toBe('true');
    const body = net.json() as { allowed_mentions: unknown; embeds: Array<{ color: number; title: string; description: string }> };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0]?.color).toBe(0xe01e5a);
    assertNeutral(net.last.bodyText);
    expect(body.embeds[0]?.title).toContain('\\<b\\>@\u200beveryone\\</b\\>');
    const up = await send('discord', { webhookUrl: 'https://discord.com/api/webhooks/1/tok' }, upPayload());
    expect((up.net.json() as { embeds: Array<{ color: number }> }).embeds[0]?.color).toBe(0x2eb886);
    expect(() => provider('discord').validate({ webhookUrl: 'https://discord.com/other/1' }, ADMIN)).toThrow();
  });

  it('telegram: bot API URL, HTML parse mode with escaping, thread id', async () => {
    const token = '123456789:AAH-abcdefghijklmnopqrstuvwxyz012345';
    const { net } = await send('telegram', { botToken: token, chatId: '-100123', threadId: 7, silent: true });
    expect(net.last.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    const body = net.json() as Record<string, unknown>;
    expect(body.chat_id).toBe(-100123);
    expect(body.parse_mode).toBe('HTML');
    expect(body.message_thread_id).toBe(7);
    expect(body.disable_notification).toBe(true);
    expect(body.text).toContain('<b>🔴 &lt;b&gt;@\u200beveryone&lt;/b&gt; is down</b>');
    assertNeutral(String(body.text).replace(/<\/?b>|<a href="[^"]*">|<\/a>/g, ''));
    expect(() => provider('telegram').validate({ botToken: token, chatId: 'abc def' }, ADMIN)).toThrow(/Chat ID/);
    expect(() => provider('telegram').validate({ botToken: token, chatId: '1', serverUrl: 'https://tg.example.com' }, MEMBER)).toThrow(/not available/);
  });

  it('telegram: &/"-heavy names never produce a cut entity or an unbalanced tag (L3)', () => {
    const amp = '&'.repeat(100);
    const quot = '"'.repeat(200);
    const payloads: NotifyPayload[] = [];
    // Shift the entity boundaries across the old 4000-character cut.
    for (let n = 0; n < 12; n++) {
      payloads.push(
        downPayload({
          monitor: { uid: 'mon000000001', name: '&'.repeat(90 + n), type: 'http', target: `https://example.com/?${'&q="x"'.repeat(33)}`, siteId: 's', siteName: '"'.repeat(100) },
          msg: '"'.repeat(200),
        }),
      );
    }
    payloads.push(
      downPayload({ monitor: { uid: 'mon000000001', name: amp, type: 'http', target: `https://example.com/?${'&q="x"'.repeat(60)}`, siteId: 's', siteName: quot }, msg: quot }),
      downPayload({ monitor: { uid: 'mon000000001', name: `${'"&<>'.repeat(40)}`, type: 'http', target: '&'.repeat(300), siteId: 's', siteName: '&'.repeat(150) }, msg: '<&>"\''.repeat(80) }),
      { ...downPayload({ event: 'cert', msg: null }), cert: { daysLeft: 3, notAfter: Date.UTC(2026, 6, 1), subject: '&"'.repeat(150), host: '&'.repeat(253) } },
    );
    for (const p of payloads) {
      const html = telegramHtml(buildMessage(p));
      // Every '&' starts a complete entity; no '<' or '>' outside our own tags.
      expect(html.replace(/&(amp|lt|gt|quot|#39);/g, '')).not.toContain('&');
      const withoutTags = html.replace(/<\/?b>|<a href="[^"<>]*">|<\/a>/g, '');
      expect(withoutTags).not.toMatch(/[<>]/);
      expect((html.match(/<b>/g) ?? []).length).toBe((html.match(/<\/b>/g) ?? []).length);
      expect((html.match(/<a /g) ?? []).length).toBe((html.match(/<\/a>/g) ?? []).length);
      // Visible text (after entity parsing) stays within Telegram's limit.
      const visible = withoutTags.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      expect(Array.from(visible).length).toBeLessThanOrEqual(4096);
      expect(html).toContain('<b>Reason:</b>'.replace('Reason', p.event === 'cert' ? 'Subject' : 'Reason'));
    }
    // A message far beyond the budget is cut on the plain text, never inside an entity.
    const huge = telegramHtml({ ...buildMessage(payloads[0] as NotifyPayload), summary: '&'.repeat(5000) });
    expect(huge.replace(/&amp;/g, '')).not.toContain('&');
    expect(huge.startsWith('<b>')).toBe(true);
    expect(huge).toContain('…');
  });

  it('teams: adaptive card', async () => {
    const { net } = await send('teams', { webhookUrl: 'https://prod-01.westeurope.logic.azure.com/workflows/abc?sig=x' });
    const body = net.json() as { type: string; attachments: Array<{ contentType: string; content: { type: string; body: unknown[] } }> };
    expect(body.type).toBe('message');
    expect(body.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(body.attachments[0]?.content.type).toBe('AdaptiveCard');
    assertNeutral(net.last.bodyText);
  });

  it('google chat: cardsV2, HTML escaped', async () => {
    const { net } = await send('googlechat', { webhookUrl: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t' });
    const body = net.json() as { cardsV2: Array<{ card: { header: { title: string } } }> };
    expect(body.cardsV2[0]?.card.header.title).toContain('&lt;b&gt;');
    assertNeutral(net.last.bodyText);
    expect(() => provider('googlechat').validate({ webhookUrl: 'https://evil.example.com/v1/spaces/x' }, ADMIN)).toThrow();
  });

  it('mattermost and rocket.chat: attachments, markdown escaped', async () => {
    const mm = await send('mattermost', { webhookUrl: 'https://mm.example.com/hooks/abc', channel: 'alerts', username: 'uptime' });
    const b = mm.net.json() as { channel: string; username: string; attachments: Array<{ color: string; title: string }> };
    expect(b.channel).toBe('alerts');
    expect(b.attachments[0]?.color).toBe('#e01e5a');
    assertNeutral(mm.net.last.bodyText);
    const rc = await send('rocketchat', { webhookUrl: 'https://rc.example.com/hooks/abc/def', channel: '#ops' });
    expect((rc.net.json() as { channel: string }).channel).toBe('#ops');
    assertNeutral(rc.net.last.bodyText);
    expect(() => provider('mattermost').validate({ webhookUrl: 'https://mm.example.com/hooks/abc', channel: 'a b' }, ADMIN)).toThrow();
  });

  it('matrix: PUT v3 send with transaction id, m.mentions and escaped HTML', async () => {
    const { net } = await send('matrix', { homeserverUrl: 'https://matrix.example.org/', accessToken: 'syt_secret', roomId: '!room:example.org' });
    expect(net.last.method).toBe('PUT');
    expect(net.last.url).toBe('https://matrix.example.org/_matrix/client/v3/rooms/!room%3Aexample.org/send/m.room.message/ptr.chan-42');
    expect(net.last.headers?.['authorization']).toBe('Bearer syt_secret');
    const body = net.json() as Record<string, string>;
    expect(body.msgtype).toBe('m.text');
    expect(body['m.mentions']).toEqual({});
    assertNeutral(body.formatted_body as string);
    assertNeutral(body.body as string, { markup: false });
    expect(() => provider('matrix').validate({ homeserverUrl: 'https://m.example.org', accessToken: 'x', roomId: '#alias:example.org' }, ADMIN)).toThrow(/Room ID/);
  });

  it('zulip: stream message, basic auth, escaped markdown', async () => {
    const { net } = await send('zulip', { siteUrl: 'https://org.zulipchat.com', botEmail: 'Bot@org.zulipchat.com', apiKey: 'abcdef123', stream: 'alerts', topic: 'web' });
    expect(net.last.url).toBe('https://org.zulipchat.com/api/v1/messages');
    expect(net.last.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    expect(net.last.headers?.['authorization']).toBe(`Basic ${Buffer.from('bot@org.zulipchat.com:abcdef123').toString('base64')}`);
    const form = new URLSearchParams(net.last.bodyText);
    expect(form.get('type')).toBe('stream');
    expect(form.get('to')).toBe('alerts');
    expect(form.get('topic')).toBe('web');
    assertNeutral(form.get('content') ?? '');
  });

  it('signal: recipients list', async () => {
    const { net } = await send('signal', { url: 'https://signal.example.com/v2/send', number: '+32470000000', recipients: '+32470000001\ngroup.abcdefghij' });
    expect(net.json()).toMatchObject({ number: '+32470000000', recipients: ['+32470000001', 'group.abcdefghij'] });
    assertNeutral(String(net.json().message), { markup: false });
    expect(() => provider('signal').validate({ url: 'https://s.example.com/v2/send', number: '0470', recipients: ['+3247'] }, ADMIN)).toThrow();
  });
});

describe('push providers', () => {
  it('ntfy: JSON publish, priority, token auth', async () => {
    const { net } = await send('ntfy', { topic: 'my-alerts', priority: '5', auth: 'token', token: 'tk_secret' });
    expect(net.last.url).toBe('https://ntfy.sh/');
    expect(net.last.headers?.['authorization']).toBe('Bearer tk_secret');
    expect(net.json()).toMatchObject({ topic: 'my-alerts', priority: 5, tags: ['red_circle'] });
    assertNeutral(net.last.bodyText, { markup: false });
    const up = await send('ntfy', { serverUrl: 'https://ntfy.example.com/', topic: 't1', auth: 'basic', username: 'u', password: 'p' }, upPayload());
    expect(up.net.last.url).toBe('https://ntfy.example.com/');
    expect(up.net.last.headers?.['authorization']).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(up.net.json()).toMatchObject({ priority: 3, tags: ['white_check_mark'] });
    expect(() => provider('ntfy').validate({ topic: 'a b' }, ADMIN)).toThrow(/Topic/);
    expect(() => provider('ntfy').validate({ topic: 'x', auth: 'token' }, ADMIN)).toThrow(/required/);
  });

  it('gotify: token header, never in the URL', async () => {
    const { net } = await send('gotify', { serverUrl: 'https://gotify.example.com/', appToken: 'AbCdEf123', priority: 9 });
    expect(net.last.url).toBe('https://gotify.example.com/message');
    expect(net.last.headers?.['x-gotify-key']).toBe('AbCdEf123');
    expect(net.json()).toMatchObject({ priority: 9 });
  });

  it('pushover: fixed host, form encoded', async () => {
    const key = 'u'.repeat(30);
    const tok = 'a'.repeat(30);
    const { net } = await send('pushover', { userKey: key, appToken: tok, priority: '2', sound: 'siren' });
    expect(net.last.url).toBe('https://api.pushover.net/1/messages.json');
    const form = new URLSearchParams(net.last.bodyText);
    expect(form.get('user')).toBe(key);
    expect(form.get('token')).toBe(tok);
    expect(form.get('priority')).toBe('2');
    expect(form.get('retry')).toBe('60');
    expect(form.get('sound')).toBe('siren');
    expect(form.get('html')).toBeNull();
    assertNeutral(form.get('message') ?? '', { markup: false });
  });

  it('pushbullet: Access-Token header', async () => {
    const { net } = await send('pushbullet', { accessToken: 'o.abcdefgh12345' });
    expect(net.last.url).toBe('https://api.pushbullet.com/v2/pushes');
    expect(net.last.headers?.['access-token']).toBe('o.abcdefgh12345');
    expect(net.json()).toMatchObject({ type: 'link', url: 'https://analytics.example.com/sites/site00000001/uptime' });
  });

  it('home assistant: notify service with bearer token', async () => {
    const { net } = await send('homeassistant', { url: 'https://ha.example.com/', token: 'eyJ.ha.token', service: 'mobile_app_phone' });
    expect(net.last.url).toBe('https://ha.example.com/api/services/notify/mobile_app_phone');
    expect(net.last.headers?.['authorization']).toBe('Bearer eyJ.ha.token');
    expect(net.json()).toHaveProperty('title');
    expect(() => provider('homeassistant').validate({ url: 'https://ha.example.com', token: 't', service: '../x' }, ADMIN)).toThrow();
  });

  it('twilio: one form request per recipient with basic auth', async () => {
    const sid = `AC${'0'.repeat(32)}`;
    const { net } = await send('twilio', { accountSid: sid, authToken: 'tokentokentoken12345', from: '+15017122661', to: ['+32470000001', '+32470000002'] });
    expect(net.requests).toHaveLength(2);
    expect(net.last.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
    expect(net.last.headers?.['authorization']).toBe(`Basic ${Buffer.from(`${sid}:tokentokentoken12345`).toString('base64')}`);
    const form = new URLSearchParams(net.last.bodyText);
    expect(form.get('To')).toBe('+32470000002');
    expect(form.get('From')).toBe('+15017122661');
    expect((form.get('Body') ?? '').length).toBeLessThanOrEqual(300);
  });
});

describe('incident providers', () => {
  const routingKey = 'R'.repeat(32);

  it('pagerduty: trigger on down, resolve on up with the same dedup key', async () => {
    const down = await send('pagerduty', { routingKey, region: 'eu', severity: 'error' });
    expect(down.net.last.url).toBe('https://events.eu.pagerduty.com/v2/enqueue');
    const d = down.net.json() as Record<string, any>;
    expect(d.event_action).toBe('trigger');
    expect(d.routing_key).toBe(routingKey);
    expect(d.dedup_key).toBe('ptr-uptime/mon000000001');
    expect(d.payload.severity).toBe('error');
    const up = await send('pagerduty', { routingKey }, upPayload());
    const u = up.net.json() as Record<string, any>;
    expect(up.net.last.url).toBe('https://events.pagerduty.com/v2/enqueue');
    expect(u).toEqual({ routing_key: routingKey, dedup_key: 'ptr-uptime/mon000000001', event_action: 'resolve' });
    const noResolve = await send('pagerduty', { routingKey, autoResolve: false }, upPayload());
    expect(noResolve.net.requests).toHaveLength(0);
    const test = await send('pagerduty', { routingKey }, { ...downPayload(), event: 'test', monitor: null });
    expect(test.net.requests.map((r) => (JSON.parse(r.bodyText) as { event_action: string }).event_action)).toEqual(['trigger', 'resolve']);
  });

  it('opsgenie: create with alias, close by alias', async () => {
    const apiKey = 'abcd1234-abcd-1234-abcd-1234abcd1234';
    const down = await send('opsgenie', { apiKey, priority: 'P2' });
    expect(down.net.last.url).toBe('https://api.opsgenie.com/v2/alerts');
    expect(down.net.last.headers?.['authorization']).toBe(`GenieKey ${apiKey}`);
    expect(down.net.json()).toMatchObject({ alias: 'ptr-mon000000001', priority: 'P2', source: 'PTR Analytics' });
    const up = await send('opsgenie', { apiKey, region: 'eu' }, upPayload());
    expect(up.net.last.url).toBe('https://api.eu.opsgenie.com/v2/alerts/ptr-mon000000001/close?identifierType=alias');
  });
});

describe('email provider', () => {
  it('sends one mail per confirmed recipient with List-Unsubscribe headers and escaped HTML', async () => {
    const sent: OutgoingNotifyMail[] = [];
    await send('email', { to: 'a@example.com\nB@Example.com' }, downPayload(), {
      email: {
        channelName: 'Ops',
        recipients: [
          { address: 'a@example.com', unsubscribeUrl: 'https://analytics.example.com/api/notification-channels/unsubscribe?token=tok' },
          { address: 'b@example.com', unsubscribeUrl: null },
        ],
        send: async (m) => {
          sent.push(m);
        },
      },
    });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.headers['List-Unsubscribe']).toBe('<https://analytics.example.com/api/notification-channels/unsubscribe?token=tok>');
    expect(sent[0]?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(sent[1]?.headers['List-Unsubscribe']).toBeUndefined();
    expect(sent[0]?.html).not.toContain('<b>@everyone');
    expect(sent[0]?.html).toContain('&#60;b&#62;');
    expect(sent[0]?.html).not.toContain('<script>');
    expect(sent[0]?.text).toContain('unsubscribe');
  });

  it('validates recipients and refuses custom SMTP for members', () => {
    const p = provider('email');
    expect(p.validate({ to: ['a@example.com'] }, MEMBER).config).toEqual({ to: ['a@example.com'] });
    expect(() => p.validate({ to: 'a@x.com,b@x.com,c@x.com,d@x.com,e@x.com,f@x.com' }, ADMIN)).toThrow(/at most 5/);
    expect(() => p.validate({ to: ['Eve <eve@example.com>'] }, ADMIN)).toThrow(/plain/);
    expect(() => p.validate({ to: ['a@example.com'], smtpUrl: 'smtps://u:p@smtp.example.com' }, MEMBER)).toThrow(/not available/);
    expect(() => p.validate({ to: ['a@example.com'], smtpUrl: 'smtps://u:p@smtp.example.com' }, ADMIN)).toThrow(/Sender/);
    const ok = p.validate({ to: ['a@example.com'], smtpUrl: 'smtps://u:p@smtp.example.com:465', from: 'up@example.com' }, ADMIN);
    expect(ok.secrets['smtpUrl']).toBe('smtps://u:p@smtp.example.com:465');
  });
});

describe('error responses', () => {
  it('non-2xx answers become classified delivery errors', async () => {
    const net = new FakeNet();
    net.handler = () => ({ status: 429, headers: { 'retry-after': '90' }, body: '{"description":"Too Many Requests: retry later"}' });
    await expect(send('telegram', { botToken: '123456789:AAH-abcdefghijklmnopqrstuvwxyz012345', chatId: '1' }, downPayload(), { net })).rejects.toMatchObject({
      name: 'DeliveryError',
      opts: { httpStatus: 429, retryable: true, retryAfterMs: 90_000 },
    });
    net.handler = () => ({ status: 404, body: '<html>not found</html>' });
    await expect(send('webhook', { url: 'https://h.example.com/' }, downPayload(), { net })).rejects.toMatchObject({ opts: { httpStatus: 404, retryable: false } });
  });
});
