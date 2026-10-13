import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { Site } from '../data/sites.js';
import type { User } from '../data/users.js';
import { HttpError, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { SITE_ID_RE } from '../lib/ids.js';

/**
 * Tenancy (spec 6.2) — the single place that decides who may see or change a site:
 * * admin: every site, read + manage;
 * * viewer: every site, read only (manage -> 403, as before hosted mode existed);
 * * member: only sites it owns (`owner_id = user.id`), read + manage; any other site -> 404,
 *   indistinguishable from a site that does not exist (no IDOR / no existence oracle).
 */
export type SiteAccess = 'read' | 'manage';

export function canAccessSite(user: User, site: Site, access: SiteAccess): boolean {
  switch (user.role) {
    case 'admin':
      return true;
    case 'viewer':
      return access === 'read';
    case 'member':
      return site.ownerId === user.id;
    default:
      return false;
  }
}

/** Load a site for the current user, or throw 404 (unknown / not accessible) / 403 (viewer manage). */
export function assertSiteAccess(ctx: AppContext, user: User | null, siteId: unknown, access: SiteAccess): Site {
  if (!user) throw unauthorized();
  if (access === 'manage' && user.role === 'viewer') throw forbidden('admin role required');
  if (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId)) throw notFound('site not found');
  const site = ctx.sites.byId(siteId);
  if (!site || !canAccessSite(user, site, access)) throw notFound('site not found');
  return site;
}

/** Shorthand for route handlers: the request's user must be able to access `:id`. */
export function siteFromRequest(ctx: AppContext, request: FastifyRequest, siteId: unknown, access: SiteAccess = 'read'): Site {
  return assertSiteAccess(ctx, request.user, siteId, access);
}

/** Every site the user can read (overview, site list, live map). */
export function accessibleSites(ctx: AppContext, user: User): Site[] {
  if (user.role === 'admin' || user.role === 'viewer') return ctx.sites.list();
  if (user.role === 'member') return ctx.sites.listByOwner(user.id);
  return [];
}

/** Who may create sites: admins (operator sites) and members (their own, within the allowance). */
export function assertCanCreateSites(user: User | null): User {
  if (!user) throw unauthorized();
  if (user.role !== 'admin' && user.role !== 'member') throw forbidden('admin role required');
  return user;
}

/** Site JSON for a user: `ownerId` is only shown to admins. */
export function siteJson(site: Site, user: User): Omit<Site, 'ownerId'> & { ownerId?: number | null } {
  const { ownerId, ...rest } = site;
  return user.role === 'admin' ? { ...rest, ownerId } : rest;
}

export function requireMember(user: User | null): User {
  if (!user) throw unauthorized();
  if (user.role !== 'member') throw new HttpError(403, 'only available for member accounts');
  return user;
}
