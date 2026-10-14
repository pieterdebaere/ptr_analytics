// Authenticated uptime API (docs/SPEC.md §8.3): monitor types, overview, monitors CRUD and
// actions, history (heartbeats, stats, events, outages). Tags, maintenance windows and the SSE
// stream are registered from sibling modules.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { accessibleSites, assertSiteAccess } from '../../auth/access.js';
import { requireAuth } from '../../auth/guard.js';
import type { Site } from '../../data/sites.js';
import type { User } from '../../data/users.js';
import { HttpError, badRequest, conflict, notFound, tooMany } from '../../lib/errors.js';
import { isPlainObject, objectBody } from '../../lib/body.js';
import { sha256Hex } from '../../lib/ids.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { cleanText } from '../../lib/text.js';
import { rejectCrossSiteFetch } from '../../routes/stats.js';
import { resolvePeriod } from '../../stats/period.js';
import { MonitorRepo, type MonitorInsert, type MonitorPatch, type MonitorRecord } from '../data/monitors.js';
import { TagRepo } from '../data/tags.js';
import { schedulePurgeMonitors } from '../data/purge.js';
import { processorFor } from '../engine/processor.js';
import { isUnderMaintenance } from '../maintenance/index.js';
import { checkersOf, uptimeRuntime } from '../runtime.js';
import { heartbeatSeries, listEvents, listOutages, periodStats, recentUptimes, totalsFor } from '../stats.js';
import type { CheckerDefinition } from '../types.js';
import { maintenanceRoutes } from './maintenances.js';
import {
  FieldError,
  bool,
  fieldErrorHandler,
  int,
  limitParam,
  line,
  monitorFor,
  requireUser,
  text,
  uidList,
} from './shared.js';
import { streamRoutes } from './stream.js';
import { tagRoutes } from './tags.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyChecker = CheckerDefinition<any, any>;

const MAX_INTERVAL_S = 86_400;
const MIN_TIMEOUT_MS = 500;
const MAX_TAGS_PER_MONITOR = 20;

export interface Limits {
  minIntervalS: number;
  maxTimeoutMs: number;
  maxRetries: number;
  monitorsPerSite: number | null;
  maxChannelsPerMonitor: number;
}

export function limitsFor(ctx: AppContext, user: User): Limits {
  const cfg = ctx.config.uptime;
  const member = user.role === 'member';
  return {
    minIntervalS: member ? cfg.memberMinIntervalS : cfg.minIntervalS,
    maxTimeoutMs: member ? 30_000 : 60_000,
    maxRetries: member ? 5 : 10,
    monitorsPerSite: member ? cfg.memberMonitorsPerSite : null,
    maxChannelsPerMonitor: member ? 5 : 50,
  };
}

const limitReached = (what: string): HttpError => new HttpError(402, `${what} limit reached`, 'limit_reached');

// ---------------------------------------------------------------- JSON

export interface MonitorJson {
  uid: string;
  siteId: string;
  parentUid: string | null;
  type: string;
  name: string;
  description: string | null;
  active: boolean;
  intervalS: number;
  retryIntervalS: number;
  maxRetries: number;
  resendEvery: number;
  timeoutMs: number;
  upsideDown: boolean;
  certNotify: boolean;
  domainNotify: boolean;
  config: Record<string, unknown>;
  secretsSet: string[];
  target: string | null;
  tags: Array<{ uid: string; name: string; color: string; value: string }>;
  channelUids: string[];
  publicId: string | null;
  pushUrl: string | null;
  manualStatus: number | null;
  state: { status: number; since: number | null; lastCheckAt: number | null; latencyMs: number | null; msg: string | null };
  uptime24h: number | null;
  uptime30d: number | null;
  tls: { notAfter: number | null; daysLeft: number | null; issuer: string | null; valid: boolean } | null;
  createdAt: number;
  updatedAt: number;
}

function targetOf(def: AnyChecker | undefined, config: Record<string, unknown>): string | null {
  try {
    return def ? def.target(config) : null;
  } catch {
    return null;
  }
}

export function monitorsJson(ctx: AppContext, list: readonly MonitorRecord[]): MonitorJson[] {
  if (list.length === 0) return [];
  const repo = new MonitorRepo(ctx.db);
  const ids = list.map((m) => m.id);
  const states = repo.states(ids);
  const tags = repo.tagsFor(ids);
  const channels = repo.channelUidsFor(ids);
  const tls = repo.tls(ids);
  const now = ctx.now();
  const uptimes = recentUptimes(ctx.db, ids, now);
  const parentIds = [...new Set(list.map((m) => m.parentId).filter((x): x is number => x !== null))];
  const parentUids = new Map<number, string>();
  for (const p of parentIds.length > 0 ? repo.byIds(parentIds) : []) parentUids.set(p.id, p.uid);
  const checkers = checkersOf(ctx);
  return list.map((m) => {
    const st = states.get(m.id);
    const t = tls.get(m.id);
    const u = uptimes.get(m.id);
    return {
      uid: m.uid,
      siteId: m.siteId,
      parentUid: m.parentId !== null ? (parentUids.get(m.parentId) ?? null) : null,
      type: m.type,
      name: m.name,
      description: m.description,
      active: m.active,
      intervalS: m.intervalS,
      retryIntervalS: m.retryIntervalS,
      maxRetries: m.maxRetries,
      resendEvery: m.resendEvery,
      timeoutMs: m.timeoutMs,
      upsideDown: m.upsideDown,
      certNotify: m.certNotify,
      domainNotify: m.domainNotify,
      config: m.config,
      secretsSet: m.secretKeys,
      target: targetOf(checkers.get(m.type), m.config),
      tags: tags.get(m.id) ?? [],
      channelUids: channels.get(m.id) ?? [],
      publicId: m.publicId,
      pushUrl: null,
      manualStatus: m.type === 'manual' ? m.manualStatus : null,
      state: {
        status: st?.status ?? -1,
        since: st?.lastChangeAt ?? null,
        lastCheckAt: st?.lastCheckAt ?? null,
        latencyMs: st?.lastLatencyMs ?? null,
        msg: st?.lastMsg ?? null,
      },
      uptime24h: u?.uptime24h ?? null,
      uptime30d: u?.uptime30d ?? null,
      tls: t
        ? {
            notAfter: t.notAfter,
            daysLeft: t.notAfter !== null ? Math.floor((t.notAfter - now) / 86_400_000) : null,
            issuer: t.issuer,
            valid: t.valid,
          }
        : null,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  });
}

// ---------------------------------------------------------------- input

interface ParsedMonitor {
  fields: Omit<MonitorInsert, 'siteId' | 'secrets' | 'secretKeys' | 'pushTokenHash'>;
  /** undefined = keep stored secrets. */
  secrets: Record<string, string> | undefined;
  tags: Array<{ tagId: number; value: string }> | undefined;
  channelIds: number[] | undefined;
}

function decryptSecrets(ctx: AppContext, m: MonitorRecord): Record<string, string> {
  if (!m.secrets) return {};
  try {
    return ctx.secretBox().open(m.secrets, `monitor:${m.uid}`);
  } catch {
    return {};
  }
}

function sealSecrets(ctx: AppContext, uid: string, secrets: Record<string, string>): { blob: Buffer | null; keys: string[] } {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) if (typeof v === 'string' && v !== '') clean[k] = v;
  const keys = Object.keys(clean).sort();
  if (keys.length === 0) return { blob: null, keys };
  return { blob: ctx.secretBox().seal(clean, `monitor:${uid}`), keys };
}

function parseMonitorInput(ctx: AppContext, user: User, body: Record<string, unknown>, site: Site, existing: MonitorRecord | null): ParsedMonitor {
  const limits = limitsFor(ctx, user);
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;

  // type
  let type: string;
  if (has('type')) {
    if (typeof body['type'] !== 'string') throw new FieldError('invalid type', 'type');
    type = body['type'];
  } else if (existing) type = existing.type;
  else throw new FieldError('type is required', 'type');
  const def = checkersOf(ctx).get(type);
  if (!def) throw new FieldError('unknown monitor type', 'type');
  const typeChanged = existing !== null && existing.type !== type;
  if (existing === null || typeChanged) {
    if (def.available && !def.available(ctx.config.uptime)) throw new FieldError('this monitor type is not available on this server', 'type');
    if (user.role === 'member' && def.hosted === 'disabled') throw new FieldError('this monitor type is not available', 'type');
  }

  const name = has('name') ? (line(body['name'], 'name', { max: 100 }) as string) : existing ? existing.name : (line(undefined, 'name', { max: 100 }) as string);
  const description = has('description') || body['description'] === null ? text(body['description'], 'description', 500) : (existing?.description ?? null);
  const active = has('active') ? bool(body['active'], 'active') : (existing?.active ?? true);

  const defaults = def.defaults ?? {};
  const intervalS = has('intervalS')
    ? int(body['intervalS'], 'intervalS', limits.minIntervalS, MAX_INTERVAL_S)
    : existing && !typeChanged
      ? Math.max(existing.intervalS, limits.minIntervalS)
      : Math.min(MAX_INTERVAL_S, Math.max(limits.minIntervalS, defaults.intervalS ?? 60));
  const retryIntervalS = has('retryIntervalS')
    ? int(body['retryIntervalS'], 'retryIntervalS', limits.minIntervalS, MAX_INTERVAL_S)
    : existing
      ? Math.max(existing.retryIntervalS, limits.minIntervalS)
      : intervalS;
  const maxRetries = has('maxRetries')
    ? int(body['maxRetries'], 'maxRetries', 0, limits.maxRetries)
    : Math.min(existing?.maxRetries ?? defaults.retries ?? 0, limits.maxRetries);
  const resendEvery = has('resendEvery') ? int(body['resendEvery'], 'resendEvery', 0, 1000) : (existing?.resendEvery ?? 0);
  const maxTimeout = Math.max(MIN_TIMEOUT_MS, Math.min(limits.maxTimeoutMs, Math.floor(intervalS * 800)));
  const timeoutMs = has('timeoutMs')
    ? int(body['timeoutMs'], 'timeoutMs', MIN_TIMEOUT_MS, maxTimeout)
    : Math.min(maxTimeout, existing?.timeoutMs ?? defaults.timeoutMs ?? 10_000);
  const upsideDown = has('upsideDown') ? bool(body['upsideDown'], 'upsideDown') : (existing?.upsideDown ?? false);
  const certNotify = has('certNotify') ? bool(body['certNotify'], 'certNotify') : (existing?.certNotify ?? true);
  const domainNotify = has('domainNotify') ? bool(body['domainNotify'], 'domainNotify') : (existing?.domainNotify ?? false);

  // type specific configuration (+ write-only secrets)
  let config: Record<string, unknown> = existing && !typeChanged ? existing.config : {};
  let secrets: Record<string, string> | undefined;
  if (has('config') || existing === null || typeChanged) {
    const input = has('config') ? body['config'] : {};
    if (!isPlainObject(input)) throw new FieldError('config must be an object', 'config');
    const existingSecrets = existing && !typeChanged ? decryptSecrets(ctx, existing) : undefined;
    const validated = def.validate(input, {
      hosted: ctx.config.cloud.signupEnabled,
      role: user.role,
      config: ctx.config.uptime,
      ...(existingSecrets ? { existingSecrets } : {}),
    });
    config = validated.config;
    secrets = validated.secrets;
  }

  // parent group (same site, type group, no cycles)
  let parentId = existing?.parentId ?? null;
  if (has('parentUid') || body['parentUid'] === null) {
    const pu = body['parentUid'];
    if (pu === null || pu === undefined || pu === '') parentId = null;
    else {
      if (typeof pu !== 'string') throw new FieldError('invalid parentUid', 'parentUid');
      const repo = new MonitorRepo(ctx.db);
      const parent = repo.byUid(pu);
      if (!parent || parent.siteId !== site.id) throw new FieldError('parent group not found on this site', 'parentUid');
      if (parent.type !== 'group') throw new FieldError('the parent must be a group monitor', 'parentUid');
      if (existing) {
        if (parent.id === existing.id) throw new FieldError('a monitor cannot be its own parent', 'parentUid');
        const parents = repo.parentMap();
        let cur: number | null | undefined = parent.id;
        for (let depth = 0; cur !== null && cur !== undefined; depth++) {
          if (cur === existing.id || depth > 32) throw new FieldError('this would create a cycle of groups', 'parentUid');
          cur = parents.get(cur);
        }
      }
      parentId = parent.id;
    }
  }

  // tags (same owner as the site)
  let tags: ParsedMonitor['tags'];
  if (has('tags')) {
    const raw = body['tags'];
    if (!Array.isArray(raw) || raw.length > MAX_TAGS_PER_MONITOR) throw new FieldError(`tags must be an array of at most ${MAX_TAGS_PER_MONITOR}`, 'tags');
    const parsed: Array<{ uid: string; value: string }> = [];
    for (const t of raw) {
      if (!isPlainObject(t) || typeof t['uid'] !== 'string') throw new FieldError('invalid tag', 'tags');
      const value = t['value'] === undefined || t['value'] === null ? '' : (line(t['value'], 'tags', { max: 50, nullable: true }) ?? '');
      parsed.push({ uid: t['uid'], value });
    }
    const found = new Map(new TagRepo(ctx.db).byUids(parsed.map((p) => p.uid)).map((t) => [t.uid, t]));
    tags = parsed.map((p) => {
      const tag = found.get(p.uid);
      if (!tag || tag.ownerId !== site.ownerId) throw new FieldError('unknown tag', 'tags');
      return { tagId: tag.id, value: p.value };
    });
  }

  // notification channels (same owner as the site)
  let channelIds: number[] | undefined;
  if (has('channelUids')) {
    const uids = uidList(body['channelUids'], 'channelUids', limits.maxChannelsPerMonitor);
    const found = new Map(new MonitorRepo(ctx.db).channelsByUid(uids).map((c) => [c.uid, c]));
    channelIds = uids.map((u) => {
      const c = found.get(u);
      if (!c || c.ownerId !== site.ownerId) throw new FieldError('unknown notification channel', 'channelUids');
      return c.id;
    });
  }

  return {
    fields: {
      parentId,
      type,
      name,
      description,
      active,
      intervalS,
      retryIntervalS,
      maxRetries,
      resendEvery,
      timeoutMs,
      upsideDown,
      certNotify,
      domainNotify,
      config,
    },
    secrets,
    tags,
    channelIds,
  };
}

function newPushToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

export function pushUrl(ctx: AppContext, token: string): string {
  return `${ctx.config.publicUrl ?? ''}/api/push/${token}`;
}

function newPublicId(): string {
  return randomBytes(12).toString('base64url');
}

// ---------------------------------------------------------------- routes

type UidRoute = { Params: { uid: string } };

export async function monitorRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const repo = new MonitorRepo(ctx.db);
  const checkLimitUser = new RateLimiter(20, 60_000, ctx.now, 10_000);
  const checkLimitMonitor = new RateLimiter(1, 10_000, ctx.now, 10_000);

  app.setErrorHandler(fieldErrorHandler);
  app.addHook('onRequest', rejectCrossSiteFetch);
  app.addHook('preHandler', requireAuth(ctx));

  const engine = () => uptimeRuntime(ctx).engine;
  const changed = (id: number): void => {
    try {
      engine()?.monitorChanged(id);
    } catch (err) {
      ctx.log.warn({ err }, 'uptime: engine notification failed');
    }
  };
  const one = (m: MonitorRecord): MonitorJson => monitorsJson(ctx, [m])[0] as MonitorJson;
  const reload = (id: number): MonitorRecord => {
    const m = repo.byId(id);
    if (!m) throw notFound('monitor not found');
    return m;
  };

  app.get('/api/uptime/types', async (request) => {
    const user = requireUser(request);
    const cfg = ctx.config.uptime;
    const limits = limitsFor(ctx, user);
    const types = [...checkersOf(ctx).values()].map((d) => ({
      type: d.type,
      label: d.label,
      description: d.description,
      category: d.category,
      fields: d.fields,
      defaults: d.defaults ?? {},
      available: d.available ? d.available(cfg) : true,
      hostedAllowed: d.hosted !== 'disabled',
    }));
    return {
      types,
      limits: {
        minIntervalS: limits.minIntervalS,
        maxTimeoutMs: limits.maxTimeoutMs,
        maxRetries: limits.maxRetries,
        monitorsPerSite: limits.monitorsPerSite,
      },
    };
  });

  app.get('/api/uptime/overview', async (request) => {
    const user = requireUser(request);
    const sites = accessibleSites(ctx, user);
    const monitors = repo.list(sites.map((s) => s.id));
    const json = monitorsJson(ctx, monitors);
    const bySite = new Map<string, { siteId: string; total: number; up: number; down: number; pending: number; maintenance: number; paused: number; up_ms: number; total_ms: number }>();
    for (const s of sites) bySite.set(s.id, { siteId: s.id, total: 0, up: 0, down: 0, pending: 0, maintenance: 0, paused: 0, up_ms: 0, total_ms: 0 });
    const suspended = new Set(sites.filter((s) => s.suspended).map((s) => s.id));
    for (const m of json) {
      const row = bySite.get(m.siteId);
      if (!row) continue;
      row.total++;
      if (!m.active || suspended.has(m.siteId)) row.paused++;
      else if (m.state.status === 1) row.up++;
      else if (m.state.status === 0) row.down++;
      else if (m.state.status === 3) row.maintenance++;
      else row.pending++;
    }
    // 30-day uptime per site: time-weighted over all its monitors
    const dayStart = Math.floor(ctx.now() / 86_400_000) * 86_400_000;
    const totals = totalsFor(ctx.db, 'monitor_stats_day', monitors.map((m) => m.id), dayStart - 29 * 86_400_000, dayStart + 86_400_000);
    for (const m of monitors) {
      const t = totals.get(m.id);
      const row = bySite.get(m.siteId);
      if (!t || !row) continue;
      row.up_ms += t.up_ms;
      row.total_ms += t.up_ms + t.down_ms + t.pending_ms;
    }
    return {
      sites: [...bySite.values()].map(({ up_ms, total_ms, ...r }) => ({ ...r, uptime30d: total_ms > 0 ? up_ms / total_ms : null })),
      monitors: json,
    };
  });

  app.get<{ Params: { siteId: string } }>('/api/sites/:siteId/monitors', async (request) => {
    const user = requireUser(request);
    const site = assertSiteAccess(ctx, user, request.params.siteId, 'read');
    return { monitors: monitorsJson(ctx, repo.list([site.id])) };
  });

  app.post<{ Params: { siteId: string } }>('/api/sites/:siteId/monitors', async (request, reply) => {
    const user = requireUser(request);
    const site = assertSiteAccess(ctx, user, request.params.siteId, 'manage');
    const body = objectBody(request.body);
    const limits = limitsFor(ctx, user);
    const parsed = parseMonitorInput(ctx, user, body, site, null);
    const push = parsed.fields.type === 'push' ? newPushToken() : null;
    const now = ctx.now();
    const created = ctx.db.transaction(() => {
      if (limits.monitorsPerSite !== null && repo.countBySite(site.id) >= limits.monitorsPerSite) throw limitReached('monitor');
      const m = repo.insert({ ...parsed.fields, siteId: site.id, secrets: null, secretKeys: [], pushTokenHash: push?.hash ?? null }, now);
      if (parsed.secrets && Object.keys(parsed.secrets).length > 0) {
        const sealed = sealSecrets(ctx, m.uid, parsed.secrets);
        repo.setSecrets(m.id, sealed.blob, sealed.keys, now);
      }
      if (parsed.tags) repo.setTags(m.id, parsed.tags);
      repo.setChannels(m.id, parsed.channelIds ?? repo.defaultChannelIds(site.ownerId));
      return m;
    })();
    changed(created.id);
    const json = one(reload(created.id));
    if (push) json.pushUrl = pushUrl(ctx, push.token);
    return reply.code(201).send({ monitor: json });
  });

  app.get<UidRoute>('/api/monitors/:uid', async (request) => {
    const m = monitorFor(ctx, requireUser(request), request.params.uid, 'read');
    return { monitor: one(m) };
  });

  app.patch<UidRoute>('/api/monitors/:uid', async (request) => {
    const user = requireUser(request);
    const m = monitorFor(ctx, user, request.params.uid, 'manage');
    const site = ctx.sites.byId(m.siteId);
    if (!site) throw notFound('monitor not found');
    const body = objectBody(request.body);
    const parsed = parseMonitorInput(ctx, user, body, site, m);
    const now = ctx.now();
    let push: { token: string; hash: string } | null = null;
    ctx.db.transaction(() => {
      const patch: MonitorPatch = { ...parsed.fields };
      if (parsed.fields.type === 'push' && m.type !== 'push') {
        push = newPushToken();
        patch.pushTokenHash = push.hash;
      } else if (parsed.fields.type !== 'push' && m.type === 'push') patch.pushTokenHash = null;
      if (parsed.fields.type !== 'manual' && m.type === 'manual') repo.setManual(m.id, null, null, now);
      repo.update(m.id, patch, now);
      if (parsed.secrets !== undefined) {
        const sealed = sealSecrets(ctx, m.uid, parsed.secrets);
        repo.setSecrets(m.id, sealed.blob, sealed.keys, now);
      }
      if (parsed.tags) repo.setTags(m.id, parsed.tags);
      if (parsed.channelIds) repo.setChannels(m.id, parsed.channelIds);
    })();
    changed(m.id);
    const json = one(reload(m.id));
    if (push) json.pushUrl = pushUrl(ctx, (push as { token: string }).token);
    return { monitor: json };
  });

  app.delete<UidRoute>('/api/monitors/:uid', async (request, reply) => {
    const m = monitorFor(ctx, requireUser(request), request.params.uid, 'manage');
    repo.softDelete(m.id, ctx.now());
    changed(m.id);
    schedulePurgeMonitors(ctx);
    return reply.code(204).send();
  });

  for (const action of ['pause', 'resume'] as const) {
    app.post<UidRoute>(`/api/monitors/:uid/${action}`, async (request) => {
      const m = monitorFor(ctx, requireUser(request), request.params.uid, 'manage');
      repo.setActive(m.id, action === 'resume', ctx.now());
      changed(m.id);
      return { monitor: one(reload(m.id)) };
    });
  }

  app.post<UidRoute>('/api/monitors/:uid/clone', async (request, reply) => {
    const user = requireUser(request);
    const m = monitorFor(ctx, user, request.params.uid, 'manage');
    const limits = limitsFor(ctx, user);
    const push = m.type === 'push' ? newPushToken() : null;
    const now = ctx.now();
    const created = ctx.db.transaction(() => {
      if (limits.monitorsPerSite !== null && repo.countBySite(m.siteId) >= limits.monitorsPerSite) throw limitReached('monitor');
      const c = repo.insert(
        {
          siteId: m.siteId,
          parentId: m.parentId,
          type: m.type,
          name: cleanText(`${m.name} (copy)`, 100),
          description: m.description,
          active: m.active,
          intervalS: m.intervalS,
          retryIntervalS: m.retryIntervalS,
          maxRetries: m.maxRetries,
          resendEvery: m.resendEvery,
          timeoutMs: m.timeoutMs,
          upsideDown: m.upsideDown,
          certNotify: m.certNotify,
          domainNotify: m.domainNotify,
          config: m.config,
          secrets: null,
          secretKeys: [],
          pushTokenHash: push?.hash ?? null,
        },
        now,
      );
      if (m.secrets) {
        // re-encrypt: the ciphertext is bound to the monitor uid
        const sealed = sealSecrets(ctx, c.uid, decryptSecrets(ctx, m));
        repo.setSecrets(c.id, sealed.blob, sealed.keys, now);
      }
      repo.setTags(
        c.id,
        (repo.tagsFor([m.id]).get(m.id) ?? []).flatMap((t) => {
          const tag = new TagRepo(ctx.db).byUid(t.uid);
          return tag ? [{ tagId: tag.id, value: t.value }] : [];
        }),
      );
      const channelUids = repo.channelUidsFor([m.id]).get(m.id) ?? [];
      repo.setChannels(c.id, repo.channelsByUid(channelUids).map((ch) => ch.id));
      if (m.type === 'manual') repo.setManual(c.id, m.manualStatus, m.manualMsg, now);
      return c;
    })();
    changed(created.id);
    const json = one(reload(created.id));
    if (push) json.pushUrl = pushUrl(ctx, push.token);
    return reply.code(201).send({ monitor: json });
  });

  app.post<UidRoute>('/api/monitors/:uid/check', async (request, reply) => {
    const user = requireUser(request);
    const m = monitorFor(ctx, user, request.params.uid, 'manage');
    if (!m.active) throw conflict('monitor is paused');
    if (m.type === 'push') throw badRequest('push monitors cannot be checked on demand');
    if (!checkLimitUser.hit(`u${user.id}`) || !checkLimitMonitor.hit(m.uid)) {
      reply.header('Retry-After', '10');
      throw tooMany();
    }
    const e = engine();
    if (!e) throw new HttpError(503, 'monitoring engine is not running');
    if (!e.checkNow(m.id)) throw conflict('monitor is not scheduled (paused or site suspended)');
    return reply.code(202).send({ ok: true });
  });

  app.post<UidRoute>('/api/monitors/:uid/push-token', async (request) => {
    const m = monitorFor(ctx, requireUser(request), request.params.uid, 'manage');
    if (m.type !== 'push') throw badRequest('not a push monitor');
    const push = newPushToken();
    repo.setPushTokenHash(m.id, push.hash, ctx.now());
    return { pushUrl: pushUrl(ctx, push.token) };
  });

  app.post<UidRoute>('/api/monitors/:uid/badges', async (request) => {
    const m = monitorFor(ctx, requireUser(request), request.params.uid, 'manage');
    const body = objectBody(request.body);
    const enabled = bool(body['enabled'], 'enabled');
    if (!enabled) {
      repo.setPublicId(m.id, null, ctx.now());
      return { publicId: null };
    }
    if (m.publicId) return { publicId: m.publicId };
    for (let i = 0; i < 5; i++) {
      const id = newPublicId();
      if (repo.setPublicId(m.id, id, ctx.now())) return { publicId: id };
    }
    throw new Error('could not allocate a badge id');
  });

  // Manual monitors: the status is set by the user.
  app.post<UidRoute>('/api/monitors/:uid/status', async (request) => {
    const m = monitorFor(ctx, requireUser(request), request.params.uid, 'manage');
    if (m.type !== 'manual') throw badRequest('not a manual monitor');
    const body = objectBody(request.body);
    const statuses: Record<string, number> = { down: 0, up: 1, pending: 2 };
    const raw = body['status'];
    const status = typeof raw === 'string' ? statuses[raw] : undefined;
    if (status === undefined) throw new FieldError('status must be up, down or pending', 'status');
    const msg = body['msg'] === undefined ? null : line(body['msg'], 'msg', { max: 200, nullable: true });
    const now = ctx.now();
    repo.setManual(m.id, status, msg, now);
    const e = engine();
    if (e) e.manualChanged(m.id);
    else if (m.active && !m.siteSuspended) {
      const fresh = reload(m.id);
      processorFor(ctx).record(
        fresh,
        { kind: 'custom', status: status as 0 | 1 | 2, msg: msg ?? (status === 1 ? 'Up' : status === 0 ? 'Down' : 'Pending') },
        isUnderMaintenance(ctx.db, m.id, now),
        { ts: now },
      );
      processorFor(ctx).flush();
    }
    return { monitor: one(reload(m.id)) };
  });

  // ---- history ----

  const parseRange = (q: Record<string, unknown>) => {
    const get = (k: string, max: number): string | undefined => {
      const v = q[k];
      if (v === undefined) return undefined;
      if (typeof v !== 'string' || v.length > max) throw badRequest(`invalid ${k}`);
      return v;
    };
    const period = get('period', 16) ?? '24h';
    if (period === '12m') throw badRequest('invalid period');
    return resolvePeriod({ period, from: get('from', 10), to: get('to', 10), tz: get('tz', 64) }, ctx.now());
  };

  app.get<UidRoute & { Querystring: Record<string, unknown> }>('/api/monitors/:uid/heartbeats', async (request) => {
    const m = monitorFor(ctx, requireUser(request), request.params.uid, 'read');
    const range = parseRange(request.query);
    return heartbeatSeries(ctx.db, m.id, range, ctx.now(), ctx.config.uptime.rawRetentionHours);
  });

  app.get<UidRoute & { Querystring: Record<string, unknown> }>('/api/monitors/:uid/stats', async (request) => {
    const m = monitorFor(ctx, requireUser(request), request.params.uid, 'read');
    const q = { period: '30d', ...request.query };
    const range = parseRange(q);
    return periodStats(ctx.db, m.id, range, ctx.now());
  });

  app.get<UidRoute & { Querystring: Record<string, unknown> }>('/api/monitors/:uid/events', async (request) => {
    const m = monitorFor(ctx, requireUser(request), request.params.uid, 'read');
    const rawBefore = request.query['before'];
    let before: number | null = null;
    if (rawBefore !== undefined) {
      if (typeof rawBefore !== 'string' || !/^\d{1,15}$/.test(rawBefore)) throw badRequest('invalid before');
      before = Number(rawBefore);
    }
    return { events: listEvents(ctx.db, m.id, before, limitParam(request.query, 50, 200)) };
  });

  app.get<UidRoute & { Querystring: Record<string, unknown> }>('/api/monitors/:uid/outages', async (request) => {
    const m = monitorFor(ctx, requireUser(request), request.params.uid, 'read');
    return { outages: listOutages(ctx.db, m.id, limitParam(request.query, 50, 200)) };
  });

  await app.register(tagRoutes, { ctx });
  await app.register(maintenanceRoutes, { ctx });
  await app.register(streamRoutes, { ctx });
}

/** For the CLI and other modules: notify a running engine that a monitor changed. */
export function notifyMonitorChanged(ctx: AppContext, id: number): void {
  uptimeRuntime(ctx).engine?.monitorChanged(id);
}
