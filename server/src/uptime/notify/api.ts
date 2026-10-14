// Notification channel API (docs/SPEC.md §8.3).
//
//   GET    /api/notification-providers
//   GET    /api/notification-channels                 POST (create)
//   GET    /api/notification-channels/:uid            PATCH, DELETE
//   POST   /api/notification-channels/:uid/test       POST /api/notification-channels/test (unsaved)
//   GET    /api/notification-channels/:uid/log?limit
//   GET    /api/notification-channels/verify?token=   (public: e-mail double opt-in)
//   GET|POST /api/notification-channels/unsubscribe?token= (public: one-click unsubscribe, RFC 8058)
//
// Secrets are write-only: responses carry `secretsSet`; in `config`, an omitted or "" secret
// keeps the stored value and `null` clears it.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../../context.js';
import type { User } from '../../data/users.js';
import { currentUser, requireAuth } from '../../auth/guard.js';
import { field, isPlainObject, objectBody } from '../../lib/body.js';
import { clientIp, rateLimitKey } from '../../lib/client-ip.js';
import { HttpError, badRequest, forbidden, tooMany } from '../../lib/errors.js';
import { hasUnsafeChars } from '../../lib/text.js';
import { ValidationError, type NotifyPayload, type ProviderDefinition, type ValidateContext } from '../types.js';
import {
  AUTO_DISABLE_AFTER,
  type ChannelRow,
  applyToExisting,
  channelFor,
  countOwned,
  isHostedMemberUser,
  listVisible,
  monitorCounts,
  newUid,
  openSecrets,
  ownerFor,
  parseConfig,
  sealSecrets,
  softDelete,
} from './channels.js';
import { deliver, savedTarget, type DeliverTarget } from './deliver.js';
import { TOKEN_RE, confirmToken, deliveryRecipients, recipientStatus, resendVerification, syncRecipients, unsubscribeToken } from './email.js';
import { PROVIDERS, WEBHOOK_PRESETS } from './providers/registry.js';
import { TEMPLATE_VARS, escapeHtml } from './render.js';
import { isHosted, notifyState } from './state.js';

type Provider = ProviderDefinition<Record<string, unknown>, Record<string, string>>;

const LOG_LIMIT_MAX = 200;

/* ------------------------------------------------------------------ helpers */

function parseName(v: unknown): string {
  if (typeof v !== 'string') throw badRequest('name must be 1..100 characters');
  const s = v.trim();
  if (s.length < 1 || s.length > 100 || hasUnsafeChars(s)) throw badRequest('name must be 1..100 characters');
  return s;
}

function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = field(body, key);
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw badRequest(`${key} must be true or false`);
  return v;
}

function providerFor(type: unknown, user: User, ctx: AppContext): Provider {
  const p = typeof type === 'string' ? PROVIDERS.get(type) : undefined;
  if (!p) throw badRequest('unknown notification channel type');
  if (p.hosted === 'disabled' && isHostedMemberUser(ctx, user)) throw badRequest('this notification type is not available on this server');
  return p as Provider;
}

/** Validate a provider config; ValidationError → 400 {error, field}. */
function validateConfig(ctx: AppContext, provider: Provider, user: User, raw: unknown, existingSecrets?: Record<string, string>) {
  if (raw !== undefined && !isPlainObject(raw)) throw badRequest('config must be an object');
  const v: ValidateContext = {
    hosted: isHosted(ctx),
    role: user.role,
    config: ctx.config.uptime,
    ...(existingSecrets ? { existingSecrets } : {}),
  };
  try {
    return provider.validate((raw ?? {}) as Record<string, unknown>, v);
  } catch (err) {
    if (err instanceof ValidationError) throw new FieldError(err.message, err.field);
    throw err;
  }
}

class FieldError extends HttpError {
  constructor(
    message: string,
    readonly field: string | undefined,
  ) {
    super(400, message, 'invalid_field');
  }
}

function safeSecretKeys(ctx: AppContext, row: ChannelRow): string[] {
  if (!row.secrets) return [];
  try {
    return Object.keys(openSecrets(ctx, row)).sort();
  } catch {
    return [];
  }
}

function channelJson(ctx: AppContext, row: ChannelRow, monitorCount: number) {
  const recipients = row.type === 'email' ? recipientStatus(ctx, row.id) : null;
  return {
    uid: row.uid,
    type: row.type,
    name: row.name,
    config: parseConfig(row),
    secretsSet: safeSecretKeys(ctx, row),
    isDefault: row.is_default === 1,
    active: row.active === 1,
    verified: recipients === null ? true : recipients.length > 0 && recipients.every((r) => r.verified && !r.unsubscribed),
    ...(recipients !== null ? { recipients } : {}),
    consecutiveFailures: row.consecutive_failures,
    autoDisabled: row.active === 0 && row.consecutive_failures >= AUTO_DISABLE_AFTER,
    monitorCount,
    operator: row.owner_id === null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function oneJson(ctx: AppContext, uid: string) {
  const row = ctx.db.prepare('SELECT * FROM notify_channels WHERE uid = ?').get(uid) as ChannelRow;
  return channelJson(ctx, row, monitorCounts(ctx, [row.id]).get(row.id) ?? 0);
}

function testPayload(ctx: AppContext): NotifyPayload {
  return {
    event: 'test',
    ts: ctx.now(),
    monitor: null,
    status: null,
    previousStatus: null,
    msg: null,
    dashboardUrl: ctx.config.publicUrl ? `${ctx.config.publicUrl}/` : null,
  };
}

function hitTestLimits(ctx: AppContext, user: User): void {
  const st = notifyState(ctx);
  const key = String(user.id);
  if (st.testMinute.isLimited(key) || st.testHour.isLimited(key)) throw tooMany('too many test notifications, try again later');
  st.testMinute.hit(key);
  st.testHour.hit(key);
}

function logTest(ctx: AppContext, channelId: number, ok: boolean, httpStatus: number | null, error: string | null): void {
  ctx.db
    .prepare("INSERT INTO notify_log (channel_id, monitor_id, ts, event, ok, http_status, error) VALUES (?, NULL, ?, 'test', ?, ?, ?)")
    .run(channelId, ctx.now(), ok ? 1 : 0, httpStatus, error);
}

function assertCanManage(user: User): void {
  if (user.role === 'viewer') throw forbidden('admin role required');
  if (user.role !== 'admin' && user.role !== 'member') throw forbidden();
  if (user.role === 'member' && !user.emailVerified) throw forbidden('verify your e-mail address first');
}

function page(reply: FastifyReply, status: number, title: string, paragraphs: string[], form?: { action: string; button: string }): FastifyReply {
  const body =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head><body><main>` +
    `<h1>${escapeHtml(title)}</h1>` +
    paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('') +
    (form
      ? `<form method="post" action="${escapeHtml(form.action)}"><input type="hidden" name="List-Unsubscribe" value="One-Click">` +
        `<button type="submit">${escapeHtml(form.button)}</button></form>`
      : '') +
    '<p>PTR Analytics</p></main></body></html>';
  return reply.code(status).header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(body);
}

function queryToken(q: unknown): string {
  const t = q && typeof q === 'object' ? (q as Record<string, unknown>)['token'] : undefined;
  return typeof t === 'string' ? t : '';
}

/* ------------------------------------------------------------------- routes */

export async function notifyRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const auth = requireAuth(ctx);

  // Field errors carry the offending field for the form.
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof FieldError) return reply.code(400).send({ error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}) });
    throw err;
  });

  // One-click unsubscribe posts `List-Unsubscribe=One-Click` as a form (RFC 8058); the body is ignored.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('multipart/form-data', { parseAs: 'string', bodyLimit: 4096 }, (_req, body, done) => done(null, body));

  app.get('/api/notification-providers', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const member = isHostedMemberUser(ctx, user);
    return {
      providers: [...PROVIDERS.values()].map((p) => ({
        id: p.id,
        label: p.label,
        category: p.category,
        fields: member ? p.fields.filter((f) => !f.selfHostedOnly) : p.fields,
        hostedAllowed: p.hosted === 'allowed',
        ...(p.id === 'webhook' ? { presets: WEBHOOK_PRESETS, templateVars: TEMPLATE_VARS } : {}),
      })),
      limits: { channels: user.role === 'member' ? ctx.config.uptime.memberChannels : null },
    };
  });

  app.get('/api/notification-channels', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const rows = listVisible(ctx, user);
    const counts = monitorCounts(ctx, rows.map((r) => r.id));
    return { channels: rows.map((r) => channelJson(ctx, r, counts.get(r.id) ?? 0)) };
  });

  app.post('/api/notification-channels', { preHandler: auth }, async (request, reply) => {
    const user = currentUser(request);
    assertCanManage(user);
    const body = objectBody(request.body);
    const provider = providerFor(field(body, 'type'), user, ctx);
    const name = parseName(field(body, 'name'));
    const isDefault = optBool(body, 'isDefault') ?? false;
    const active = optBool(body, 'active') ?? true;
    const apply = optBool(body, 'applyToExisting') ?? false;
    const { config, secrets } = validateConfig(ctx, provider, user, field(body, 'config'));
    const owner = ownerFor(user);
    const now = ctx.now();
    const uid = newUid(ctx);
    const sealed = sealSecrets(ctx, uid, secrets);
    const row = ctx.db.transaction(() => {
      if (owner !== null && countOwned(ctx, owner) >= ctx.config.uptime.memberChannels) {
        throw new HttpError(409, 'notification channel limit reached', 'limit_reached');
      }
      ctx.db
        .prepare(
          `INSERT INTO notify_channels (uid, owner_id, type, name, config, secrets, is_default, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(uid, owner, provider.id, name, JSON.stringify(config), sealed, isDefault ? 1 : 0, active ? 1 : 0, now, now);
      const created = ctx.db.prepare('SELECT * FROM notify_channels WHERE uid = ?').get(uid) as ChannelRow;
      if (apply) applyToExisting(ctx, created, user.role === 'member');
      return created;
    })();
    if (provider.id === 'email') {
      syncRecipients(ctx, row, config['to'] as string[], { requireOptIn: isHostedMemberUser(ctx, user), inviter: user });
    }
    return reply.code(201).send({ channel: oneJson(ctx, uid) });
  });

  // Static paths before `/:uid` (find-my-way prefers static segments anyway).
  app.get('/api/notification-channels/verify', async (request, reply) => {
    if (!ctx.limits.tokenIp.hit(rateLimitKey(clientIp(request)))) return page(reply, 429, 'Too many attempts', ['Please try again later.']);
    const done = confirmToken(ctx, queryToken(request.query));
    if (!done) return page(reply, 400, 'Link invalid or expired', ['This confirmation link is invalid, was already used or has expired.']);
    return page(reply, 200, 'Address confirmed', [
      `${done.address} will now receive uptime alerts of the notification channel "${done.channelName}".`,
      'Every alert contains a link to unsubscribe.',
    ]);
  });

  app.get('/api/notification-channels/unsubscribe', async (request, reply) => {
    const token = queryToken(request.query);
    if (!TOKEN_RE.test(token)) return page(reply, 400, 'Link invalid', ['This unsubscribe link is invalid.']);
    return page(reply, 200, 'Unsubscribe from uptime alerts', ['Do you want to stop receiving these uptime alert e-mails?'], {
      action: `/api/notification-channels/unsubscribe?token=${encodeURIComponent(token)}`,
      button: 'Unsubscribe',
    });
  });

  app.post('/api/notification-channels/unsubscribe', async (request, reply) => {
    if (!ctx.limits.tokenIp.hit(rateLimitKey(clientIp(request)))) return page(reply, 429, 'Too many attempts', ['Please try again later.']);
    const ok = unsubscribeToken(ctx, queryToken(request.query));
    if (!ok) return page(reply, 400, 'Link invalid', ['This unsubscribe link is invalid.']);
    return page(reply, 200, 'Unsubscribed', ['You will not receive these uptime alert e-mails any more.']);
  });

  app.post('/api/notification-channels/test', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    assertCanManage(user);
    const body = objectBody(request.body);
    const uid = field(body, 'uid');
    const saved = uid === undefined || uid === null ? null : channelFor(ctx, user, uid, 'manage');
    const provider = providerFor(field(body, 'type') ?? saved?.type, user, ctx);
    if (saved && saved.type !== provider.id) throw badRequest('type cannot be changed');
    const nameRaw = field(body, 'name');
    const name = nameRaw === undefined ? (saved?.name ?? 'Test') : parseName(nameRaw);
    const existing = saved ? openSecrets(ctx, saved) : undefined;
    const { config, secrets } = validateConfig(ctx, provider, user, field(body, 'config'), existing);
    const hostedMember = saved ? saved.owner_id !== null && isHostedMemberUser(ctx, user) : isHostedMemberUser(ctx, user);
    const target: DeliverTarget = { provider, row: saved, name, config, secrets, hostedMember };
    if (provider.id === 'email') {
      const to = config['to'] as string[];
      if (hostedMember) {
        // Only addresses that already confirmed the opt-in.
        const confirmed = saved ? deliveryRecipients(ctx, saved).filter((r) => to.includes(r.address)) : [];
        if (confirmed.length === 0) return { ok: false, error: 'no confirmed recipients yet: save the channel and confirm the e-mail link first' };
        target.directRecipients = confirmed.map((r) => r.address);
      } else {
        target.directRecipients = to;
      }
    }
    hitTestLimits(ctx, user);
    const r = await deliver(ctx, target, testPayload(ctx), { deliveryId: `test-${newUid(ctx)}` });
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'delivery failed' };
  });

  app.get<{ Params: { uid: string } }>('/api/notification-channels/:uid', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const row = channelFor(ctx, user, request.params.uid, 'read');
    return { channel: channelJson(ctx, row, monitorCounts(ctx, [row.id]).get(row.id) ?? 0) };
  });

  app.patch<{ Params: { uid: string } }>('/api/notification-channels/:uid', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const row = channelFor(ctx, user, request.params.uid, 'manage');
    assertCanManage(user);
    const body = objectBody(request.body);
    const type = field(body, 'type');
    if (type !== undefined && type !== row.type) throw badRequest('type cannot be changed');
    const provider = providerFor(row.type, user, ctx);
    const nameRaw = field(body, 'name');
    const name = nameRaw === undefined ? row.name : parseName(nameRaw);
    const isDefault = optBool(body, 'isDefault');
    const active = optBool(body, 'active');
    const apply = optBool(body, 'applyToExisting') ?? false;
    const resend = optBool(body, 'resendVerification') ?? false;
    const rawConfig = field(body, 'config');
    let configJson = row.config;
    let sealed = row.secrets;
    let newConfig: Record<string, unknown> | null = null;
    if (rawConfig !== undefined) {
      const { config, secrets } = validateConfig(ctx, provider, user, rawConfig, openSecrets(ctx, row));
      newConfig = config;
      configJson = JSON.stringify(config);
      sealed = sealSecrets(ctx, row.uid, secrets);
    }
    const reactivate = active === true && row.active === 0;
    ctx.db.transaction(() => {
      ctx.db
        .prepare(
          `UPDATE notify_channels SET name = ?, config = ?, secrets = ?, is_default = ?, active = ?,
             consecutive_failures = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(
          name,
          configJson,
          sealed,
          isDefault === undefined ? row.is_default : isDefault ? 1 : 0,
          active === undefined ? row.active : active ? 1 : 0,
          reactivate ? 0 : row.consecutive_failures,
          ctx.now(),
          row.id,
        );
      if (apply) applyToExisting(ctx, row, row.owner_id !== null && user.role === 'member');
    })();
    if (row.type === 'email') {
      const fresh = { ...row, name };
      if (newConfig) syncRecipients(ctx, fresh, newConfig['to'] as string[], { requireOptIn: isHostedMemberUser(ctx, user), inviter: user });
      if (resend) resendVerification(ctx, fresh, user);
    }
    return { channel: oneJson(ctx, row.uid) };
  });

  app.delete<{ Params: { uid: string } }>('/api/notification-channels/:uid', { preHandler: auth }, async (request, reply) => {
    const user = currentUser(request);
    const row = channelFor(ctx, user, request.params.uid, 'manage');
    softDelete(ctx, row);
    return reply.code(204).send();
  });

  app.post<{ Params: { uid: string } }>('/api/notification-channels/:uid/test', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const row = channelFor(ctx, user, request.params.uid, 'manage');
    assertCanManage(user);
    const provider = providerFor(row.type, user, ctx);
    const hostedMember = row.owner_id !== null && isHostedMemberUser(ctx, user);
    let secrets: Record<string, string>;
    try {
      secrets = openSecrets(ctx, row);
    } catch {
      return { ok: false, error: 'cannot decrypt the channel secrets' };
    }
    if (provider.id === 'email' && deliveryRecipients(ctx, row).length === 0) {
      return { ok: false, error: 'no confirmed recipients yet' };
    }
    hitTestLimits(ctx, user);
    const r = await deliver(ctx, savedTarget(provider, row, secrets, hostedMember), testPayload(ctx), { deliveryId: `test-${newUid(ctx)}` });
    logTest(ctx, row.id, r.ok, r.httpStatus, r.error);
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'delivery failed' };
  });

  app.get<{ Params: { uid: string }; Querystring: { limit?: string } }>(
    '/api/notification-channels/:uid/log',
    { preHandler: auth },
    async (request) => {
      const user = currentUser(request);
      const row = channelFor(ctx, user, request.params.uid, 'read');
      const raw = request.query.limit;
      const limit = raw === undefined ? 50 : /^\d{1,4}$/.test(raw) ? Math.min(Math.max(Number(raw), 1), LOG_LIMIT_MAX) : NaN;
      if (!Number.isFinite(limit)) throw badRequest('limit must be 1..200');
      const entries = ctx.db
        .prepare(
          `SELECT l.ts, l.event, l.ok, l.http_status, l.error, m.uid AS monitor_uid FROM notify_log l
           LEFT JOIN monitors m ON m.id = l.monitor_id
           WHERE l.channel_id = ? ORDER BY l.ts DESC, l.id DESC LIMIT ?`,
        )
        .all(row.id, limit) as Array<{ ts: number; event: string; ok: number; http_status: number | null; error: string | null; monitor_uid: string | null }>;
      return {
        entries: entries.map((e) => ({ ts: e.ts, event: e.event, ok: e.ok === 1, httpStatus: e.http_status, error: e.error, monitorUid: e.monitor_uid })),
      };
    },
  );
}
