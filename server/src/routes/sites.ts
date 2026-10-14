import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { accessibleSites, assertCanCreateSites, assertSiteAccess, siteJson } from '../auth/access.js';
import { currentUser, requireAuth } from '../auth/guard.js';
import { field, objectBody } from '../lib/body.js';
import type { User } from '../data/users.js';
import { memberDomainProblem, normalizeDomainList } from '../lib/domains.js';
import { schedulePurge } from '../jobs/purge.js';
import { badRequest, forbidden, notFound, upgradeRequired } from '../lib/errors.js';

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function parseName(v: unknown): string {
  if (typeof v !== 'string') throw badRequest('name must be 1..100 characters');
  const name = v.trim();
  if (name.length < 1 || name.length > 100 || CONTROL_RE.test(name)) throw badRequest('name must be 1..100 characters');
  return name;
}

function parseDomains(v: unknown, user: User): string[] {
  const d = normalizeDomainList(v);
  if (!d) {
    throw badRequest('domains must be a list of 1..20 hostnames (e.g. example.com, *.example.com, localhost)');
  }
  if (user.role === 'member') {
    const problem = memberDomainProblem(d);
    if (problem !== null) throw badRequest(problem);
  }
  return d;
}

export async function siteRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const auth = requireAuth(ctx);

  app.get('/api/sites', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    return { sites: accessibleSites(ctx, user).map((s) => siteJson(s, user)) };
  });

  app.post('/api/sites', { preHandler: auth }, async (request, reply) => {
    const user = assertCanCreateSites(request.user);
    const body = objectBody(request.body);
    const name = parseName(field(body, 'name'));
    const domains = parseDomains(field(body, 'domains'), user);
    const site = ctx.db.transaction(() => {
      // Re-read the role inside the transaction (it may have changed since the session lookup).
      const fresh = ctx.users.byId(user.id);
      if (!fresh) throw notFound();
      if (fresh.role === 'member') {
        const allowance = ctx.billing.allowance(fresh);
        if (allowance !== null && ctx.sites.countByOwner(fresh.id) >= allowance) throw upgradeRequired();
        const created = ctx.sites.create(name, domains, ctx.now(), fresh.id);
        ctx.billing.recompute(fresh.id);
        return ctx.sites.byId(created.id) ?? created;
      }
      if (fresh.role !== 'admin') throw forbidden('admin role required');
      // Admin-created sites are operator sites (no owner): never suspended, never billed.
      return ctx.sites.create(name, domains, ctx.now(), null);
    })();
    return reply.code(201).send({ site: siteJson(site, user) });
  });

  app.get<{ Params: { id: string } }>('/api/sites/:id', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    return { site: siteJson(assertSiteAccess(ctx, user, request.params.id, 'read'), user) };
  });

  app.patch<{ Params: { id: string } }>('/api/sites/:id', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const site = assertSiteAccess(ctx, user, request.params.id, 'manage');
    const body = objectBody(request.body);
    const patch: { name?: string; domains?: string[] } = {};
    const name = field(body, 'name');
    const domains = field(body, 'domains');
    if (name !== undefined) patch.name = parseName(name);
    if (domains !== undefined) patch.domains = parseDomains(domains, user);
    const updated = ctx.sites.update(site.id, patch);
    if (!updated) throw notFound('site not found');
    return { site: siteJson(updated, user) };
  });

  app.delete<{ Params: { id: string } }>('/api/sites/:id', { preHandler: auth }, async (request, reply) => {
    const user = currentUser(request);
    const site = assertSiteAccess(ctx, user, request.params.id, 'manage');
    ctx.db.transaction(() => {
      // Soft delete: gone for every reader at once; the data is purged in the background.
      ctx.sites.delete(site.id, ctx.now());
      // a previously suspended site of the owner may become active again
      if (site.ownerId !== null) ctx.billing.recompute(site.ownerId);
    })();
    schedulePurge(ctx);
    return reply.code(204).send();
  });
}
