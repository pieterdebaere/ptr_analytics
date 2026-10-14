// Tags API (docs/SPEC.md §8.3): `{uid, name, color}`; members manage their own tags, admins the
// operator tags (and may edit any), viewers read.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { conflict, notFound } from '../../lib/errors.js';
import { objectBody } from '../../lib/body.js';
import { TagRepo, type TagRecord } from '../data/tags.js';
import { FieldError, assertCanManage, canManageOwned, canSeeOwned, line, ownerForNew, ownerScope, requireUser } from './shared.js';

const MAX_TAGS_PER_OWNER = 200;
const COLOR_RE = /^#[0-9a-f]{6}$/;

function parseColor(v: unknown): string {
  if (typeof v !== 'string') throw new FieldError('color must be #rrggbb', 'color');
  const c = v.toLowerCase();
  if (!COLOR_RE.test(c)) throw new FieldError('color must be #rrggbb', 'color');
  return c;
}

export function tagJson(t: TagRecord, admin: boolean): { uid: string; name: string; color: string; ownerId?: number | null } {
  return admin ? { uid: t.uid, name: t.name, color: t.color, ownerId: t.ownerId } : { uid: t.uid, name: t.name, color: t.color };
}

export async function tagRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const repo = new TagRepo(ctx.db);

  const find = (uid: string, user: ReturnType<typeof requireUser>, manage: boolean): TagRecord => {
    if (manage) assertCanManage(user);
    const t = repo.byUid(uid);
    if (!t || !canSeeOwned(user, t.ownerId) || (manage && !canManageOwned(user, t.ownerId))) throw notFound('tag not found');
    return t;
  };

  app.get('/api/tags', async (request) => {
    const user = requireUser(request);
    return { tags: repo.list(ownerScope(user)).map((t) => tagJson(t, user.role === 'admin')) };
  });

  app.post('/api/tags', async (request, reply) => {
    const user = requireUser(request);
    assertCanManage(user);
    const body = objectBody(request.body);
    const name = line(body['name'], 'name', { max: 50 }) as string;
    const color = parseColor(body['color']);
    const owner = ownerForNew(user);
    const t = ctx.db.transaction(() => {
      if (repo.countByOwner(owner) >= MAX_TAGS_PER_OWNER) throw conflict('tag limit reached');
      if (repo.nameTaken(owner, name)) throw conflict('a tag with this name already exists');
      return repo.create(owner, name, color);
    })();
    return reply.code(201).send({ tag: tagJson(t, user.role === 'admin') });
  });

  app.patch<{ Params: { uid: string } }>('/api/tags/:uid', async (request) => {
    const user = requireUser(request);
    const t = find(request.params.uid, user, true);
    const body = objectBody(request.body);
    const patch: { name?: string; color?: string } = {};
    if (body['name'] !== undefined) patch.name = line(body['name'], 'name', { max: 50 }) as string;
    if (body['color'] !== undefined) patch.color = parseColor(body['color']);
    if (patch.name !== undefined && repo.nameTaken(t.ownerId, patch.name, t.id)) throw conflict('a tag with this name already exists');
    repo.update(t.id, patch);
    return { tag: tagJson({ ...t, ...patch }, user.role === 'admin') };
  });

  app.delete<{ Params: { uid: string } }>('/api/tags/:uid', async (request, reply) => {
    const user = requireUser(request);
    const t = find(request.params.uid, user, true);
    repo.delete(t.id);
    return reply.code(204).send();
  });
}
