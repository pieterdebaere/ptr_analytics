// Account security (docs/SPEC.md §8.3): two-factor authentication (TOTP + recovery codes),
// API keys, and the Prometheus /metrics endpoint (API key with the `metrics` scope).
//
// Every change that could lock the owner out or outlive a stolen session needs re-auth:
// MFA setup / enable need the account password (+ the new code), disable / regenerate need
// password + a current factor, creating an API key needs the password (+ a current factor
// when MFA is on). Enabling / disabling MFA revokes the account's other sessions and all its
// API keys; the owner is e-mailed about every such change (when mail is configured).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PASSWORD_MAX, mailboxKey } from '../config.js';
import type { AppContext } from '../context.js';
import { API_KEYS_PER_USER, API_KEY_SCOPES, apiKeyState, authenticateApiKey, requestApiKey, type ApiKeyScope } from '../auth/api-keys.js';
import { currentUser, mfaPolicyApplies, mfaSetupRequired, requireAuth } from '../auth/guard.js';
import {
  beginMfaSetup,
  confirmMfaSetup,
  deleteMfa,
  dropChallenges,
  isMfaEnabled,
  mfaGate,
  mfaLimits,
  mfaStatus,
  recordMfaFailure,
  recordMfaSuccess,
  regenerateRecoveryCodes,
  verifySecondFactor,
} from '../auth/mfa.js';
import { notifySecurity } from '../auth/notices.js';
import type { User } from '../data/users.js';
import { field, objectBody, type JsonObject } from '../lib/body.js';
import { clientIp, rateLimitKey } from '../lib/client-ip.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
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

/**
 * Sites whose monitors /metrics exports for a key (spec §8.4: "only the key owner's
 * monitors"): the user's own sites; admins and viewers also the operator's sites (no owner).
 * Every tenant only with the explicit `metrics:all` scope on an admin's key.
 */
export function metricsSiteIds(ctx: AppContext, user: User, allTenants: boolean): string[] {
  if (allTenants && user.role === 'admin') return ctx.sites.list().map((s) => s.id);
  if (user.role === 'member') return ctx.sites.listByOwner(user.id).map((s) => s.id);
  if (user.role === 'admin' || user.role === 'viewer') {
    return ctx.sites
      .list()
      .filter((s) => s.ownerId === null || s.ownerId === user.id)
      .map((s) => s.id);
  }
  return [];
}

export function renderMetrics(ctx: AppContext, user: User, allTenants = false): string {
  const db = ctx.db;
  const now = ctx.now();
  const monitors = monitorsForSites(db, metricsSiteIds(ctx, user, allTenants));
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

  /**
   * Count a second-factor submission for this client and refuse it while the account's
   * progressive lockout is active (auth/mfa.ts). Synchronous with the check that follows.
   */
  const gateFactor = (request: FastifyRequest, user: User): void => {
    if (!mfaLimits(ctx).ip.hit(rateLimitKey(clientIp(request)))) throw new HttpError(429, 'too many attempts, try again later');
    const gate = mfaGate(ctx, user.id);
    if (!gate.ok) {
      throw new HttpError(429, `too many wrong codes, try again in ${Math.ceil(gate.retryAfterMs / 60_000)} min`, 'mfa_locked');
    }
  };

  const factorFailed = (user: User): HttpError => {
    if (recordMfaFailure(ctx, user.id).alert) notifySecurity(ctx, user, { kind: 'mfa-failures' });
    return invalidCode();
  };

  /** A current second factor (code or recovery code) of a user with MFA enabled. */
  const checkFactor = (request: FastifyRequest, user: User, body: JsonObject): void => {
    const code = field(body, 'code');
    const recoveryCode = field(body, 'recoveryCode');
    if (typeof code !== 'string' && typeof recoveryCode !== 'string') throw badRequest('code is required');
    gateFactor(request, user);
    if (!verifySecondFactor(ctx, user.id, { code, recoveryCode }).ok) throw factorFailed(user);
    recordMfaSuccess(ctx, user.id);
  };

  /** Password + current code (or a recovery code) for sensitive MFA changes. */
  const stepUp = async (request: FastifyRequest, user: User): Promise<void> => {
    const body = objectBody(request.body);
    const code = field(body, 'code');
    const recoveryCode = field(body, 'recoveryCode');
    if (typeof code !== 'string' && typeof recoveryCode !== 'string') throw badRequest('code is required');
    await checkPassword(request, user, body);
    checkFactor(request, user, body);
  };

  /** Revoke every API key of the user; returns how many were revoked. */
  const revokeKeys = (user: User): number => apiKeyState(ctx).repo.deleteForUser(user.id);

  app.get('/api/auth/mfa', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    return { ...mfaStatus(ctx.db, user.id), required: mfaPolicyApplies(ctx, user) };
  });

  /** Start enrolment: `{password}` → `{secret, otpauthUrl}` (re-auth: a session alone is not enough). */
  app.post('/api/auth/mfa/setup', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    if (isMfaEnabled(ctx.db, user.id)) throw conflict('two-factor authentication is already enabled');
    await checkPassword(request, user, objectBody(request.body));
    const res = beginMfaSetup(ctx, user);
    if (!res) throw conflict('two-factor authentication is already enabled');
    return res;
  });

  /** Confirm enrolment: `{password, code}` → `{recoveryCodes}`. */
  app.post('/api/auth/mfa/enable', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const body = objectBody(request.body);
    const code = field(body, 'code');
    if (typeof code !== 'string') throw badRequest('code is required');
    const before = mfaStatus(ctx.db, user.id);
    if (before.enabled) throw conflict('two-factor authentication is already enabled');
    if (!before.pending) throw conflict('start the setup first');
    await checkPassword(request, user, body);
    // Everything below is synchronous: no other request interleaves.
    gateFactor(request, user);
    const st = mfaStatus(ctx.db, user.id);
    if (st.enabled) throw conflict('two-factor authentication is already enabled');
    if (!st.pending) throw conflict('start the setup first');
    const recoveryCodes = confirmMfaSetup(ctx, user.id, code);
    if (!recoveryCodes) throw factorFailed(user);
    recordMfaSuccess(ctx, user.id);
    // Sessions and API keys created before MFA existed must not outlive it; this session stays.
    ctx.authSessions.deleteForUser(user.id, request.authTokenHash ?? undefined);
    const apiKeysRevoked = revokeKeys(user);
    notifySecurity(ctx, user, { kind: 'mfa-enabled', apiKeysRevoked });
    return { recoveryCodes, apiKeysRevoked };
  });

  app.post('/api/auth/mfa/disable', { preHandler: auth }, async (request, reply) => {
    const user = currentUser(request);
    if (!mfaStatus(ctx.db, user.id).enabled) throw conflict('two-factor authentication is not enabled');
    if (mfaPolicyApplies(ctx, user)) {
      throw conflict('two-factor authentication is mandatory for your role on this server');
    }
    await stepUp(request, user);
    deleteMfa(ctx.db, user.id);
    dropChallenges(ctx, user.id);
    ctx.authSessions.deleteForUser(user.id, request.authTokenHash ?? undefined);
    const apiKeysRevoked = revokeKeys(user);
    notifySecurity(ctx, user, { kind: 'mfa-disabled', apiKeysRevoked });
    return reply.code(204).send();
  });

  app.post('/api/auth/mfa/recovery-codes', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    if (!mfaStatus(ctx.db, user.id).enabled) throw conflict('two-factor authentication is not enabled');
    await stepUp(request, user);
    const recoveryCodes = regenerateRecoveryCodes(ctx, user.id);
    if (!recoveryCodes) throw conflict('two-factor authentication is not enabled');
    notifySecurity(ctx, user, { kind: 'recovery-codes' });
    return { recoveryCodes };
  });

  /* --------------------------------------------------------------- api keys */

  const keys = () => apiKeyState(ctx).repo;

  app.get('/api/api-keys', { preHandler: auth }, async (request) => ({ apiKeys: keys().list(currentUser(request).id) }));

  /**
   * `{name, scopes, expiresInDays?, password, code?}`: the account password is required, plus
   * a current second factor (code or recoveryCode) when MFA is enabled — a session alone must
   * not be able to mint a long-lived credential.
   */
  app.post('/api/api-keys', { preHandler: auth }, async (request, reply) => {
    const user = currentUser(request);
    const body = objectBody(request.body);
    const nameRaw = field(body, 'name');
    // eslint-disable-next-line no-control-regex
    if (typeof nameRaw !== 'string' || nameRaw.trim().length < 1 || nameRaw.trim().length > 100 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(nameRaw)) {
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
      throw badRequest('scopes must be a non-empty list of "read", "metrics" and/or "metrics:all"');
    }
    if (scopesRaw.includes('metrics:all') && user.role !== 'admin') throw forbidden('the "metrics:all" scope is only available to admins');
    const days = field(body, 'expiresInDays');
    if (days !== undefined && days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650)) {
      throw badRequest('expiresInDays must be an integer 1..3650');
    }
    const mfa = isMfaEnabled(ctx.db, user.id);
    if (mfa && typeof field(body, 'code') !== 'string' && typeof field(body, 'recoveryCode') !== 'string') {
      throw new HttpError(400, 'code is required', 'mfa_code_required');
    }
    if (keys().countActive(user.id) >= API_KEYS_PER_USER) {
      throw new HttpError(409, `at most ${API_KEYS_PER_USER} API keys per account`, 'limit_reached');
    }
    await checkPassword(request, user, body);
    if (mfa) checkFactor(request, user, body);
    // The limit again: the password check awaited.
    if (keys().countActive(user.id) >= API_KEYS_PER_USER) {
      throw new HttpError(409, `at most ${API_KEYS_PER_USER} API keys per account`, 'limit_reached');
    }
    const now = ctx.now();
    const expiresAt = typeof days === 'number' ? now + days * DAY : null;
    const name = nameRaw.trim();
    const scopes = scopesRaw as ApiKeyScope[];
    const created = keys().create(user.id, name, scopes, expiresAt, now);
    notifySecurity(ctx, user, { kind: 'api-key-created', name, scopes });
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
      user = authenticateApiKey(ctx, request, ['metrics', 'metrics:all']);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 401) reply.header('WWW-Authenticate', 'Bearer');
      throw err;
    }
    if (!user) {
      reply.header('WWW-Authenticate', 'Bearer');
      throw new HttpError(401, 'unauthorized');
    }
    if (mfaSetupRequired(ctx, user)) throw new HttpError(403, 'mfa_required', 'mfa_required');
    const allTenants = requestApiKey(request)?.scopes.includes('metrics:all') ?? false;
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics(ctx, user, allTenants));
  });
}
