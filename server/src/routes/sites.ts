import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAdmin, requireAuth } from '../auth/guard.js';
import type { Site } from '../data/sites.js';
import { field, objectBody } from '../lib/body.js';
import { normalizeDomainList } from '../lib/domains.js';
import { badRequest, notFound } from '../lib/errors.js';
import { SITE_ID_RE } from '../lib/ids.js';

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function parseName(v: unknown): string {
  if (typeof v !== 'string') throw badRequest('name must be 1..100 characters');
  const name = v.trim();
  if (name.length < 1 || name.length > 100 || CONTROL_RE.test(name)) throw badRequest('name must be 1..100 characters');
  return name;
}

function parseDomains(v: unknown): string[] {
  const d = normalizeDomainList(v);
  if (!d) {
    throw badRequest('domains must be a list of 1..20 hostnames (e.g. example.com, *.example.com, localhost)');
  }
  return d;
}

/** Look up a site from a route param, 404 if missing. */
export function loadSite(ctx: AppContext, id: unknown): Site {
  if (typeof id !== 'string' || !SITE_ID_RE.test(id)) throw notFound('site not found');
  const site = ctx.sites.byId(id);
  if (!site) throw notFound('site not found');
  return site;
}

export async function siteRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const auth = requireAuth(ctx);
  const admin = [auth, requireAdmin()];

  app.get('/api/sites', { preHandler: auth }, async () => ({ sites: ctx.sites.list() }));

  app.post('/api/sites', { preHandler: admin }, async (request, reply) => {
    const body = objectBody(request.body);
    const site = ctx.sites.create(parseName(field(body, 'name')), parseDomains(field(body, 'domains')), ctx.now());
    return reply.code(201).send({ site });
  });

  app.get<{ Params: { id: string } }>('/api/sites/:id', { preHandler: auth }, async (request) => ({
    site: loadSite(ctx, request.params.id),
  }));

  app.patch<{ Params: { id: string } }>('/api/sites/:id', { preHandler: admin }, async (request) => {
    const site = loadSite(ctx, request.params.id);
    const body = objectBody(request.body);
    const patch: { name?: string; domains?: string[] } = {};
    const name = field(body, 'name');
    const domains = field(body, 'domains');
    if (name !== undefined) patch.name = parseName(name);
    if (domains !== undefined) patch.domains = parseDomains(domains);
    const updated = ctx.sites.update(site.id, patch);
    if (!updated) throw notFound('site not found');
    return { site: updated };
  });

  app.delete<{ Params: { id: string } }>('/api/sites/:id', { preHandler: admin }, async (request, reply) => {
    const site = loadSite(ctx, request.params.id);
    ctx.sites.delete(site.id);
    return reply.code(204).send();
  });
}
