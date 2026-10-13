import type { FastifyInstance } from 'fastify';
import { PASSWORD_MAX, PASSWORD_MIN, isValidEmail } from '../config.js';
import type { AppContext } from '../context.js';
import { currentUser, requireAdmin, requireAuth } from '../auth/guard.js';
import { ROLES, type Role } from '../data/users.js';
import { field, objectBody } from '../lib/body.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { validPassword } from './auth.js';

function parseId(raw: unknown): number {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,14}$/.test(raw)) throw notFound();
  return Number(raw);
}

function parseRole(v: unknown): Role {
  if (typeof v !== 'string' || !(ROLES as readonly string[]).includes(v)) throw badRequest('role must be "admin" or "viewer"');
  return v as Role;
}

export async function userRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const preHandler = [requireAuth(ctx), requireAdmin()];

  app.get('/api/users', { preHandler }, async () => ({ users: ctx.users.list() }));

  app.post('/api/users', { preHandler }, async (request, reply) => {
    const body = objectBody(request.body);
    const emailRaw = field(body, 'email');
    const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';
    if (!isValidEmail(email)) throw badRequest('invalid email');
    const password = field(body, 'password');
    if (!validPassword(password)) throw badRequest(`password must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters`);
    const role = parseRole(field(body, 'role') ?? 'viewer');
    const hash = await hashPassword(password);
    const user = ctx.users.create(email, hash, role, ctx.now());
    if (!user) throw conflict('a user with this email already exists');
    return reply.code(201).send({ user });
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', { preHandler }, async (request) => {
    const me = currentUser(request);
    const id = parseId(request.params.id);
    const target = ctx.users.byId(id);
    if (!target) throw notFound('user not found');
    const body = objectBody(request.body);
    const roleRaw = field(body, 'role');
    const passwordRaw = field(body, 'password');
    const role = roleRaw === undefined ? undefined : parseRole(roleRaw);
    if (passwordRaw !== undefined && !validPassword(passwordRaw)) {
      throw badRequest(`password must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters`);
    }
    const newHash = passwordRaw === undefined ? undefined : await hashPassword(passwordRaw as string);

    const tx = ctx.db.transaction(() => {
      if (role !== undefined && role !== target.role) {
        if (target.role === 'admin' && ctx.users.countAdmins() <= 1) throw conflict('the last admin cannot be demoted');
        ctx.users.setRole(id, role);
      }
      if (newHash !== undefined) {
        ctx.users.setPasswordHash(id, newHash);
        // A password change invalidates the user's other sessions.
        ctx.authSessions.deleteForUser(id, id === me.id ? (request.authTokenHash ?? undefined) : undefined);
      }
    });
    tx();
    return { user: ctx.users.byId(id) };
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', { preHandler }, async (request, reply) => {
    const me = currentUser(request);
    const id = parseId(request.params.id);
    if (id === me.id) throw badRequest('you cannot delete yourself');
    const tx = ctx.db.transaction(() => {
      const target = ctx.users.byId(id);
      if (!target) throw notFound('user not found');
      if (target.role === 'admin' && ctx.users.countAdmins() <= 1) throw conflict('the last admin cannot be deleted');
      ctx.users.delete(id);
    });
    tx();
    return reply.code(204).send();
  });
}
