// Account security (docs/SPEC.md §8.3): two-factor authentication (TOTP + recovery codes),
// API keys, and the Prometheus /metrics endpoint (API key with the `metrics` scope).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PASSWORD_MAX, mailboxKey } from '../config.js';
import type { AppContext } from '../context.js';
import { accessibleSites } from '../auth/access.js';
import { API_KEYS_PER_USER, API_KEY_SCOPES, apiKeyState, authenticateApiKey, type ApiKeyScope } from '../auth/api-keys.js';
import { currentUser, mfaSetupRequired, requireAuth } from '../auth/guard.js';
import {
  beginMfaSetup,
  confirmMfaSetup,
  deleteMfa,
  dropChallenges,
  mfaLimits,
  mfaStatus,
  regenerateRecoveryCodes,
  verifySecondFactor,
} from '../auth/mfa.js';
import type { User } from '../data/users.js';
import { field, objectBody, type JsonObject } from '../lib/body.js';
import { clientIp, rateLimitKey } from '../lib/client-ip.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { verifyPassword } from '../lib/password.js';
import { certDaysLeft, monitorsForSites, tagsFor, uptimeRatios } from '../uptime/status/data.js';

const DAY = 86_400_000;

const invalidCode = (): HttpError => new HttpError(400, 'invalid code', 'invalid_code');

/* ------------------------------------------------------------- prometheus */

// eslint-disable-next-line no-control-regex
const LABEL_STRIP_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Escape a label value per the Prometheus text exposition format (\\, \", \n). */
export function promLabel(v: string): string {
  const s = v.replace(LABEL_STRIP_RE, '');
  const cps = [...s];
  const clipped = cps.length > 256 ? cps.slice(0, 256).join('') : s;
  return clipped.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labels(l: Record<string, string>): string {
  return `{${Object.entries(l)
    .map(([k, v]) => `${k}="${promLabel(v)}"`)
    .join(',')}}`;
}

export function renderMetrics(ctx: AppContext, user: User): string {
  const db = ctx.db;
  const now = ctx.now();
  const monitors = monitorsForSites(
    db,
    accessibleSites(ctx, user).map((s) => s.id),
  );
  const ids = monitors.map((m) => m.id);
  const up24 = uptimeRatios(db, ids, now - DAY);
  const up30 = uptimeRatios(db, ids, now - 30 * DAY);
  const certs = certDaysLeft(db, ids, now);
  const tags = tagsFor(db, ids);
  const status: string[] = [];
  const paused: string[] = [];
  const latency: string[] = [];
  const uptime: string[] = [];
  const cert: string[] = [];
  for (const m of monitors) {
    const base: Record<string, string> = {
      monitor_uid: m.uid,
      monitor_name: m.name,
      monitor_type: m.type,
      site_id: m.siteId,
      site_name: m.siteName,
      tags: (tags.get(m.id) ?? []).map((t) => (t.value ? `${t.name}:${t.value}` : t.name)).join(','),
    };
    const l = labels(base);
    status.push(`monitor_status${l} ${m.status}`);
    paused.push(`monitor_paused${l} ${m.active && !m.siteSuspended ? 0 : 1}`);
    if (m.latencyMs !== null) latency.push(`monitor_response_time_ms${l} ${m.latencyMs}`);
    const r24 = up24.get(m.id);
    const r30 = up30.get(m.id);
    if (r24 !== null && r24 !== undefined) uptime.push(`monitor_uptime_ratio${labels({ ...base, window: '24h' })} ${r24}`);
    if (r30 !== null && r30 !== undefined) uptime.push(`monitor_uptime_ratio${labels({ ...base, window: '30d' })} ${r30}`);
    const days = certs.get(m.id);
    if (days !== undefined) cert.push(`monitor_cert_days_remaining${l} ${days}`);
  }
  const block = (name: string, help: string, lines: string[]): string =>
    `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${lines.map((x) => `${x}\n`).join('')}`;
  return [
    block('monitor_status', 'Monitor status (-1 unknown, 0 down, 1 up, 2 pending, 3 maintenance).', status),
    block('monitor_paused', 'Monitor paused (1) or checked (0).', paused),
    block('monitor_response_time_ms', 'Latency of the last check in milliseconds.', latency),
    block('monitor_uptime_ratio', 'Time-weighted uptime ratio over the window.', uptime),
    block('monitor_cert_days_remaining', 'Days until the TLS certificate expires.', cert),
  ].join('');
}

/* ----------------------------------------------------------------- routes */

export async function securityRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const auth = requireAuth(ctx);

  /** Check the account password (login rate limits apply, like a password change). */
  const checkPassword = async (request: FastifyRequest, user: User, body: JsonObject): Promise<void> => {
    const password = field(body, 'password');
    if (typeof password !== 'string' || password.length === 0 || password.length > PASSWORD_MAX) throw badRequest('password is required');
    const ipKey = rateLimitKey(clientIp(request));
    const pairKey = `${mailboxKey(user.email)}\n${ipKey}`;
    const ipOk = ctx.limits.loginIp.hit(ipKey);
    const pairOk = ctx.limits.loginEmailIp.hit(pairKey);
    if (!ipOk || !pairOk) throw new HttpError(429, 'too many failed attempts, try again later');
    const hash = ctx.users.passwordHash(user.id);
    if (hash === null || !(await verifyPassword(password, hash))) throw badRequest('password is incorrect');
    ctx.limits.loginEmailIp.reset(pairKey);
  };

  /** Count a second-factor attempt for this account and client (before checking it). */
  const countFactorAttempt = (request: FastifyRequest, user: User): void => {
    const limits = mfaLimits(ctx);
    const ipOk = limits.ip.hit(rateLimitKey(clientIp(request)));
    const userOk = limits.user.hit(String(user.id));
    if (!ipOk || !userOk) throw new HttpError(429, 'too many attempts, try again later');
  };

  /** Password + current code (or a recovery code) for sensitive MFA changes. */
  const stepUp = async (request: FastifyRequest, user: User): Promise<void> => {
    const body = objectBody(request.body);
    const code = field(body, 'code');
    const recoveryCode = field(body, 'recoveryCode');
    if (typeof code !== 'string' && typeof recoveryCode !== 'string') throw badRequest('code is required');
    await checkPassword(request, user, body);
    countFactorAttempt(request, user);
    if (!verifySecondFactor(ctx, user.id, { code, recoveryCode }).ok) throw invalidCode();
    mfaLimits(ctx).user.reset(String(user.id));
  };

  app.get('/api/auth/mfa', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    return { ...mfaStatus(ctx.db, user.id), required: ctx.config.uptime.requireMfaForAdmins && user.role === 'admin' };
  });

  app.post('/api/auth/mfa/setup', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const res = beginMfaSetup(ctx, user);
    if (!res) throw conflict('two-factor authentication is already enabled');
    return res;
  });

  app.post('/api/auth/mfa/enable', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const code = field(objectBody(request.body), 'code');
    if (typeof code !== 'string') throw badRequest('code is required');
    countFactorAttempt(request, user);
    const st = mfaStatus(ctx.db, user.id);
    if (st.enabled) throw conflict('two-factor authentication is already enabled');
    if (!st.pending) throw conflict('start the setup first');
    const recoveryCodes = confirmMfaSetup(ctx, user.id, code);
    if (!recoveryCodes) throw invalidCode();
    mfaLimits(ctx).user.reset(String(user.id));
    // Sessions opened before MFA existed must not outlive it.
    ctx.authSessions.deleteForUser(user.id, request.authTokenHash ?? undefined);
    return { recoveryCodes };
  });

  app.post('/api/auth/mfa/disable', { preHandler: auth }, async (request, reply) => {
    const user = currentUser(request);
    if (!mfaStatus(ctx.db, user.id).enabled) throw conflict('two-factor authentication is not enabled');
    if (ctx.config.uptime.requireMfaForAdmins && user.role === 'admin') {
      throw conflict('two-factor authentication is mandatory for admins on this server');
    }
    await stepUp(request, user);
    deleteMfa(ctx.db, user.id);
    dropChallenges(ctx, user.id);
    ctx.authSessions.deleteForUser(user.id, request.authTokenHash ?? undefined);
    return reply.code(204).send();
  });

  app.post('/api/auth/mfa/recovery-codes', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    if (!mfaStatus(ctx.db, user.id).enabled) throw conflict('two-factor authentication is not enabled');
    await stepUp(request, user);
    const recoveryCodes = regenerateRecoveryCodes(ctx, user.id);
    if (!recoveryCodes) throw conflict('two-factor authentication is not enabled');
    return { recoveryCodes };
  });

  /* --------------------------------------------------------------- api keys */

  const keys = () => apiKeyState(ctx).repo;

  app.get('/api/api-keys', { preHandler: auth }, async (request) => ({ apiKeys: keys().list(currentUser(request).id) }));

  app.post('/api/api-keys', { preHandler: auth }, async (request, reply) => {
    const user = currentUser(request);
    const body = objectBody(request.body);
    const nameRaw = field(body, 'name');
    // eslint-disable-next-line no-control-regex
    if (typeof nameRaw !== 'string' || nameRaw.trim().length < 1 || nameRaw.trim().length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(nameRaw)) {
      throw badRequest('name must be 1..100 characters');
    }
    const scopesRaw = field(body, 'scopes');
    if (
      !Array.isArray(scopesRaw) ||
      scopesRaw.length === 0 ||
      scopesRaw.length > API_KEY_SCOPES.length ||
      !scopesRaw.every((s) => (API_KEY_SCOPES as readonly unknown[]).includes(s)) ||
      new Set(scopesRaw).size !== scopesRaw.length
    ) {
      throw badRequest('scopes must be a non-empty list of "read" and/or "metrics"');
    }
    const days = field(body, 'expiresInDays');
    if (days !== undefined && days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650)) {
      throw badRequest('expiresInDays must be an integer 1..3650');
    }
    if (keys().countActive(user.id) >= API_KEYS_PER_USER) {
      throw new HttpError(409, `at most ${API_KEYS_PER_USER} API keys per account`, 'limit_reached');
    }
    const now = ctx.now();
    const expiresAt = typeof days === 'number' ? now + days * DAY : null;
    const created = keys().create(user.id, nameRaw.trim(), scopesRaw as ApiKeyScope[], expiresAt, now);
    return reply.code(201).send(created);
  });

  app.delete<{ Params: { uid: string } }>('/api/api-keys/:uid', { preHandler: auth }, async (request, reply) => {
    const user = currentUser(request);
    const uid = request.params.uid;
    if (!/^[a-z0-9]{12}$/.test(uid) || !keys().delete(user.id, uid)) throw notFound('api key not found');
    return reply.code(204).send();
  });

  /* ---------------------------------------------------------------- metrics */

  app.get('/metrics', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    let user: User | null;
    try {
      user = authenticateApiKey(ctx, request, 'metrics');
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 401) reply.header('WWW-Authenticate', 'Bearer');
      throw err;
    }
    if (!user) {
      reply.header('WWW-Authenticate', 'Bearer');
      throw new HttpError(401, 'unauthorized');
    }
    if (mfaSetupRequired(ctx, user)) throw new HttpError(403, 'mfa_required', 'mfa_required');
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics(ctx, user));
  });
}
