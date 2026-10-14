// Maintenance windows API (docs/SPEC.md §8.3). Owner-scoped like tags; linked monitors and status
// pages must belong to the same owner.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { conflict, notFound, tooMany } from '../../lib/errors.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { isPlainObject, objectBody } from '../../lib/body.js';
import { isValidTimeZone, parseLocalDate } from '../../lib/time.js';
import { MaintenanceRepo, type MaintenanceInput, type MaintenanceRecord } from '../data/maintenance.js';
import { MonitorRepo } from '../data/monitors.js';
import { CronError, parseCron } from '../maintenance/cron.js';
import { maintenanceInfo } from '../maintenance/index.js';
import { STRATEGIES, cronCombinations, parseHHMM, zonedTime, type DayOfMonth, type Strategy } from '../maintenance/windows.js';
import { uptimeRuntime } from '../runtime.js';
import {
  FieldError,
  assertCanManage,
  bool,
  canManageOwned,
  canSeeOwned,
  int,
  line,
  ownerForNew,
  ownerScope,
  requireUser,
  text,
  uidList,
} from './shared.js';

const MAX_PER_OWNER = 100;
/** Cron windows per member (each is evaluated by the engine and on every list). */
const MAX_CRON_PER_OWNER = 20;
/** A cron schedule may match at most this many hour×minute combinations per day. */
export const MAX_CRON_COMBINATIONS = 60;
/** Per-user request budgets (per minute) of the maintenance API. */
const READS_PER_MIN = 120;
const WRITES_PER_MIN = 30;
const MAX_LINKS = 500;
const MAX_DURATION_S = 31 * 86_400;

export interface MaintenanceJson {
  uid: string;
  title: string;
  description: string | null;
  active: boolean;
  strategy: Strategy;
  tz: string;
  startsAt: number | null;
  endsAt: number | null;
  timeStart: string | null;
  timeEnd: string | null;
  weekdays: number[];
  daysOfMonth: DayOfMonth[];
  intervalDays: number | null;
  cron: string | null;
  durationS: number | null;
  monitorUids: string[];
  statusPageUids: string[];
  status: string;
  nextWindow: { start: number; end: number } | null;
  ownerId?: number | null;
  createdAt: number;
  updatedAt: number;
}

export function maintenancesJson(ctx: AppContext, list: readonly MaintenanceRecord[], admin: boolean): MaintenanceJson[] {
  const repo = new MaintenanceRepo(ctx.db);
  const ids = list.map((m) => m.id);
  const monitors = repo.monitorUids(ids);
  const pages = repo.statusPageUids(ids);
  const now = ctx.now();
  return list.map((m) => {
    const info = maintenanceInfo(m, now);
    return {
      uid: m.uid,
      title: m.title,
      description: m.description,
      active: m.active,
      strategy: m.strategy,
      tz: m.tz,
      startsAt: m.startsAt,
      endsAt: m.endsAt,
      timeStart: m.timeStart,
      timeEnd: m.timeEnd,
      weekdays: m.weekdays,
      daysOfMonth: m.daysOfMonth,
      intervalDays: m.intervalDays,
      cron: m.cron,
      durationS: m.durationS,
      monitorUids: monitors.get(m.id) ?? [],
      statusPageUids: pages.get(m.id) ?? [],
      status: info.status,
      nextWindow: info.nextWindow,
      ...(admin ? { ownerId: m.ownerId } : {}),
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  });
}

/** ms epoch, or a local 'YYYY-MM-DDTHH:MM' (or 'YYYY-MM-DD') interpreted in tz. */
function parseInstant(v: unknown, field: string, tz: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > 253_402_300_799_000) throw new FieldError(`invalid ${field}`, field);
    return v;
  }
  if (typeof v !== 'string' || v.length > 16) throw new FieldError(`invalid ${field}`, field);
  const date = parseLocalDate(v.slice(0, 10));
  if (!date) throw new FieldError(`invalid ${field}`, field);
  let h = 0;
  let mi = 0;
  if (v.length > 10) {
    if (v[10] !== 'T') throw new FieldError(`invalid ${field}`, field);
    const t = parseHHMM(v.slice(11));
    if (!t) throw new FieldError(`invalid ${field}`, field);
    h = t.h;
    mi = t.mi;
  }
  return zonedTime(date.y, date.m, date.d, h, mi, tz);
}

function parseTime(v: unknown, field: string): string {
  if (typeof v !== 'string' || !parseHHMM(v)) throw new FieldError(`${field} must be HH:MM`, field);
  return v;
}

function parseInput(body: Record<string, unknown>, existing: MaintenanceRecord | null): MaintenanceInput {
  const pick = (k: string, fallback: unknown): unknown => (Object.prototype.hasOwnProperty.call(body, k) ? body[k] : fallback);
  const title = line(pick('title', existing?.title), 'title', { max: 150 }) as string;
  const description = text(pick('description', existing?.description ?? null), 'description', 5000);
  const active = bool(pick('active', existing?.active ?? true), 'active');
  const strategyRaw = pick('strategy', existing?.strategy);
  if (typeof strategyRaw !== 'string' || !(STRATEGIES as readonly string[]).includes(strategyRaw)) throw new FieldError('invalid strategy', 'strategy');
  const strategy = strategyRaw as Strategy;
  const tzRaw = pick('tz', existing?.tz ?? 'UTC');
  if (typeof tzRaw !== 'string' || tzRaw.length > 64 || !isValidTimeZone(tzRaw)) throw new FieldError('invalid tz', 'tz');
  const tz = tzRaw;
  const input: MaintenanceInput = {
    title,
    description,
    active,
    strategy,
    tz,
    startsAt: null,
    endsAt: null,
    timeStart: null,
    timeEnd: null,
    weekdays: [],
    daysOfMonth: [],
    intervalDays: null,
    cron: null,
    durationS: null,
  };
  if (strategy === 'manual') return input;
  input.startsAt = parseInstant(pick('startsAt', existing?.startsAt ?? null), 'startsAt', tz);
  input.endsAt = parseInstant(pick('endsAt', existing?.endsAt ?? null), 'endsAt', tz);
  if (input.startsAt !== null && input.endsAt !== null && input.endsAt <= input.startsAt) throw new FieldError('endsAt must be after startsAt', 'endsAt');
  switch (strategy) {
    case 'single':
      if (input.startsAt === null) throw new FieldError('startsAt is required', 'startsAt');
      if (input.endsAt === null) throw new FieldError('endsAt is required', 'endsAt');
      return input;
    case 'weekly':
    case 'monthly':
    case 'interval': {
      input.timeStart = parseTime(pick('timeStart', existing?.timeStart), 'timeStart');
      input.timeEnd = parseTime(pick('timeEnd', existing?.timeEnd), 'timeEnd');
      if (strategy === 'weekly') {
        const raw = pick('weekdays', existing?.weekdays);
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > 7) throw new FieldError('weekdays must list 1..7 days (0 = Sunday)', 'weekdays');
        const days = new Set<number>();
        for (const d of raw) days.add(int(d, 'weekdays', 0, 6));
        input.weekdays = [...days].sort((a, b) => a - b);
      } else if (strategy === 'monthly') {
        const raw = pick('daysOfMonth', existing?.daysOfMonth);
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) throw new FieldError('daysOfMonth must list days 1..31 or "L"', 'daysOfMonth');
        const days: DayOfMonth[] = [];
        for (const d of raw) {
          const v: DayOfMonth = d === 'L' ? 'L' : int(d, 'daysOfMonth', 1, 31);
          if (!days.includes(v)) days.push(v);
        }
        input.daysOfMonth = days;
      } else {
        input.intervalDays = int(pick('intervalDays', existing?.intervalDays), 'intervalDays', 1, 3650);
        if (input.startsAt === null) throw new FieldError('startsAt (first day) is required', 'startsAt');
      }
      return input;
    }
    case 'cron': {
      const cron = pick('cron', existing?.cron);
      if (typeof cron !== 'string') throw new FieldError('cron is required', 'cron');
      try {
        const spec = parseCron(cron);
        if (cronCombinations(spec) > MAX_CRON_COMBINATIONS) {
          throw new CronError(`cron may match at most ${MAX_CRON_COMBINATIONS} times per day (hour × minute combinations)`);
        }
      } catch (err) {
        throw new FieldError(err instanceof CronError ? err.message : 'invalid cron expression', 'cron');
      }
      input.cron = cron.trim();
      input.durationS = int(pick('durationS', existing?.durationS), 'durationS', 60, MAX_DURATION_S);
      return input;
    }
  }
}

export async function maintenanceRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const repo = new MaintenanceRepo(ctx.db);
  const monitors = new MonitorRepo(ctx.db);
  const reads = new RateLimiter(READS_PER_MIN, 60_000, ctx.now, 20_000);
  const writes = new RateLimiter(WRITES_PER_MIN, 60_000, ctx.now, 20_000);
  // Every response evaluates schedules: budget them per user (and API key) like other costly routes.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/maintenances')) return;
    const user = request.user;
    if (!user) return;
    const limiter = request.method === 'GET' || request.method === 'HEAD' ? reads : writes;
    if (!limiter.hit(`u${user.id}`)) {
      reply.header('Retry-After', '60');
      throw tooMany();
    }
  });
  const changed = (): void => {
    try {
      uptimeRuntime(ctx).engine?.maintenanceChanged();
    } catch (err) {
      ctx.log.warn({ err }, 'uptime: engine notification failed');
    }
  };

  const find = (uid: string, user: ReturnType<typeof requireUser>, manage: boolean): MaintenanceRecord => {
    if (manage) assertCanManage(user);
    const m = repo.byUid(uid);
    if (!m || !canSeeOwned(user, m.ownerId) || (manage && !canManageOwned(user, m.ownerId))) throw notFound('maintenance not found');
    return m;
  };

  /** Links: monitors / status pages of the same owner only. */
  const parseLinks = (body: Record<string, unknown>, ownerId: number | null): { monitorIds?: number[]; pageIds?: number[] } => {
    const out: { monitorIds?: number[]; pageIds?: number[] } = {};
    if (body['monitorUids'] !== undefined) {
      const uids = uidList(body['monitorUids'], 'monitorUids', MAX_LINKS);
      const found = new Map(monitors.byUids(uids).map((m) => [m.uid, m]));
      out.monitorIds = uids.map((u) => {
        const m = found.get(u);
        if (!m || m.ownerId !== ownerId) throw new FieldError('unknown monitor', 'monitorUids');
        return m.id;
      });
    }
    if (body['statusPageUids'] !== undefined) {
      const uids = uidList(body['statusPageUids'], 'statusPageUids', MAX_LINKS);
      const found = new Map(repo.statusPagesByUid(uids).map((p) => [p.uid, p]));
      out.pageIds = uids.map((u) => {
        const p = found.get(u);
        if (!p || p.ownerId !== ownerId) throw new FieldError('unknown status page', 'statusPageUids');
        return p.id;
      });
    }
    return out;
  };

  app.get('/api/maintenances', async (request) => {
    const user = requireUser(request);
    return { maintenances: maintenancesJson(ctx, repo.list(ownerScope(user)), user.role === 'admin') };
  });

  app.post('/api/maintenances', async (request, reply) => {
    const user = requireUser(request);
    assertCanManage(user);
    const body = objectBody(request.body);
    const owner = ownerForNew(user);
    const input = parseInput(body, null);
    const links = parseLinks(body, owner);
    const m = ctx.db.transaction(() => {
      if (user.role === 'member' && repo.countByOwner(owner) >= MAX_PER_OWNER) throw conflict('maintenance limit reached');
      if (user.role === 'member' && input.strategy === 'cron' && repo.countCronByOwner(owner) >= MAX_CRON_PER_OWNER) {
        throw conflict('cron maintenance limit reached');
      }
      const created = repo.create(owner, input, ctx.now());
      if (links.monitorIds) repo.setMonitors(created.id, links.monitorIds);
      if (links.pageIds) repo.setStatusPages(created.id, links.pageIds);
      return created;
    })();
    changed();
    return reply.code(201).send({ maintenance: maintenancesJson(ctx, [m], user.role === 'admin')[0] });
  });

  app.get<{ Params: { uid: string } }>('/api/maintenances/:uid', async (request) => {
    const user = requireUser(request);
    return { maintenance: maintenancesJson(ctx, [find(request.params.uid, user, false)], user.role === 'admin')[0] };
  });

  app.patch<{ Params: { uid: string } }>('/api/maintenances/:uid', async (request) => {
    const user = requireUser(request);
    const m = find(request.params.uid, user, true);
    const body = objectBody(request.body);
    if (!isPlainObject(body)) throw new FieldError('invalid body');
    const input = parseInput(body, m);
    const links = parseLinks(body, m.ownerId);
    ctx.db.transaction(() => {
      if (m.ownerId !== null && input.strategy === 'cron' && m.strategy !== 'cron' && repo.countCronByOwner(m.ownerId) >= MAX_CRON_PER_OWNER) {
        throw conflict('cron maintenance limit reached');
      }
      repo.update(m.id, input, ctx.now());
      if (links.monitorIds) repo.setMonitors(m.id, links.monitorIds);
      if (links.pageIds) repo.setStatusPages(m.id, links.pageIds);
    })();
    changed();
    return { maintenance: maintenancesJson(ctx, [repo.byUid(m.uid) as MaintenanceRecord], user.role === 'admin')[0] };
  });

  app.delete<{ Params: { uid: string } }>('/api/maintenances/:uid', async (request, reply) => {
    const user = requireUser(request);
    const m = find(request.params.uid, user, true);
    repo.delete(m.id);
    changed();
    return reply.code(204).send();
  });

  for (const action of ['pause', 'resume'] as const) {
    app.post<{ Params: { uid: string } }>(`/api/maintenances/:uid/${action}`, async (request) => {
      const user = requireUser(request);
      const m = find(request.params.uid, user, true);
      repo.setActive(m.id, action === 'resume', ctx.now());
      changed();
      return { maintenance: maintenancesJson(ctx, [repo.byUid(m.uid) as MaintenanceRecord], user.role === 'admin')[0] };
    });
  }
}
