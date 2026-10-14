// Helpers shared by the authenticated uptime routes: tenancy, input parsing, JSON shapes.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { canAccessSite } from '../../auth/access.js';
import type { User } from '../../data/users.js';
import { HttpError, badRequest, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { hasUnsafeChars } from '../../lib/text.js';
import { MonitorRepo, type MonitorRecord } from '../data/monitors.js';
import { ValidationError } from '../types.js';

export type Access = 'read' | 'manage';

/** 400 with the offending field: `{error, field}` (spec §8.3, checker ValidationError). */
export class FieldError extends HttpError {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(400, message);
    this.name = 'FieldError';
  }
}

/** Plugin error handler: FieldError / ValidationError → `400 {error, field}`; everything else goes up. */
export function fieldErrorHandler(err: Error, _request: FastifyRequest, reply: FastifyReply): unknown {
  if (err instanceof FieldError || err instanceof ValidationError) {
    const field = (err as FieldError | ValidationError).field;
    return reply.code(400).send(field === undefined ? { error: err.message } : { error: err.message, field });
  }
  throw err;
}

export function requireUser(request: FastifyRequest): User {
  if (!request.user) throw unauthorized();
  return request.user;
}

export function assertCanManage(user: User): void {
  if (user.role === 'viewer') throw forbidden('read-only account');
}

/** Monitor for the user, or 404 (unknown / other tenant) / 403 (viewer + manage). */
export function monitorFor(ctx: AppContext, user: User, uid: unknown, access: Access): MonitorRecord {
  if (access === 'manage') assertCanManage(user);
  if (typeof uid !== 'string') throw notFound('monitor not found');
  const m = new MonitorRepo(ctx.db).byUid(uid);
  if (!m) throw notFound('monitor not found');
  const site = ctx.sites.byId(m.siteId);
  if (!site || !canAccessSite(user, site, access)) throw notFound('monitor not found');
  return m;
}

/** Owner id for objects created by this user (tags, maintenances): members own theirs, admins create operator objects. */
export function ownerForNew(user: User): number | null {
  return user.role === 'member' ? user.id : null;
}

/** May the user see an owner-scoped object (tag, maintenance)? */
export function canSeeOwned(user: User, ownerId: number | null): boolean {
  if (user.role === 'admin' || user.role === 'viewer') return true;
  return user.role === 'member' && ownerId === user.id;
}

export function canManageOwned(user: User, ownerId: number | null): boolean {
  if (user.role === 'admin') return true;
  return user.role === 'member' && ownerId === user.id;
}

/** List scope for owner-scoped objects. */
export function ownerScope(user: User): number | 'all' {
  return user.role === 'member' ? user.id : 'all';
}

// ---------------------------------------------------------------- input parsing

export function str(v: unknown, field: string, opts: { min?: number; max: number; nullable?: boolean; trim?: boolean }): string | null {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
    if (opts.nullable) return null;
    throw new FieldError(`${field} is required`, field);
  }
  if (typeof v !== 'string') throw new FieldError(`invalid ${field}`, field);
  const s = opts.trim === false ? v : v.trim();
  if (s.length < (opts.min ?? 1) || s.length > opts.max) throw new FieldError(`${field} must be ${opts.min ?? 1}..${opts.max} characters`, field);
  return s;
}

/** Single-line text: no control / format characters. */
export function line(v: unknown, field: string, opts: { min?: number; max: number; nullable?: boolean }): string | null {
  const s = str(v, field, opts);
  if (s !== null && hasUnsafeChars(s)) throw new FieldError(`${field} contains invalid characters`, field);
  return s;
}

/** Multi-line text: newlines and tabs allowed, other control characters refused. */
export function text(v: unknown, field: string, max: number): string | null {
  const s = str(v, field, { max, nullable: true });
  if (s === null) return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(s)) throw new FieldError(`${field} contains invalid characters`, field);
  return s;
}

export function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new FieldError(`${field} must be an integer between ${min} and ${max}`, field);
  return v;
}

export function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new FieldError(`${field} must be true or false`, field);
  return v;
}

export function uidList(v: unknown, field: string, max: number): string[] {
  if (!Array.isArray(v) || v.length > max) throw new FieldError(`${field} must be an array of at most ${max} ids`, field);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !/^[a-z0-9]{12}$/.test(x)) throw new FieldError(`invalid id in ${field}`, field);
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

export function limitParam(q: Record<string, unknown>, def: number, max: number): number {
  const raw = q['limit'];
  if (raw === undefined) return def;
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw)) throw badRequest('invalid limit');
  const n = Number(raw);
  if (n < 1 || n > max) throw badRequest('invalid limit');
  return n;
}
