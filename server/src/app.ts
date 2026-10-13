import fs from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import Fastify, { LogController, type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { PACKAGE_DIR, type Config } from './config.js';
import { createContext, type AppContext, type Clock } from './context.js';
import { openDatabase, type DB } from './db/index.js';
import { downloadGeoDatabase, fileAge, type FetchFn } from './geo/download.js';
import { runCleanup } from './jobs/cleanup.js';
import { HttpError } from './lib/errors.js';
import { hashPassword } from './lib/password.js';
import { requireAuth } from './auth/guard.js';
import { authRoutes } from './routes/auth.js';
import { exportRoutes } from './routes/export.js';
import { ingestRoutes } from './routes/ingest.js';
import { siteRoutes } from './routes/sites.js';
import { staticRoutes } from './routes/static.js';
import { statsRoutes } from './routes/stats.js';
import { userRoutes } from './routes/users.js';
import { applySecurityHeaders, registerCsrfCheck, registerSecurityHeaders } from './security.js';

export interface BuildOptions {
  /** Database file; defaults to `<DATA_DIR>/analytics.db`. Use ':memory:' in tests. */
  dbPath?: string;
  /** Injected clock (ms epoch) for tests. */
  now?: Clock;
  /** Fastify logger; default true (pino at config.logLevel). */
  logger?: boolean;
  /** Start hourly cleanup + GeoIP auto-download timers (default false; index.ts enables). */
  backgroundJobs?: boolean;
  /** fetch implementation for the GeoIP download (tests). */
  fetchFn?: FetchFn;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GEOIP_MAX_AGE_STARTUP = 35 * DAY;
const GEOIP_MAX_AGE_REFRESH = 30 * DAY;

const GENERIC_MESSAGES: Record<number, string> = {
  400: 'bad request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not found',
  405: 'method not allowed',
  406: 'not acceptable',
  413: 'payload too large',
  415: 'unsupported media type',
  429: 'too many requests',
};

/** proxy-addr semantics: a hop count n trusts the n closest hops. */
function toFastifyTrustProxy(t: Config['trustProxy']): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof t === 'number') return (_address: string, hop: number) => hop < t;
  return t;
}

export function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when no users exist. */
export async function bootstrapAdmin(ctx: AppContext): Promise<void> {
  if (ctx.users.count() > 0) return;
  const { adminEmail, adminPassword } = ctx.config;
  if (adminEmail && adminPassword) {
    const user = ctx.users.create(adminEmail, await hashPassword(adminPassword), 'admin', ctx.now());
    if (user) ctx.log.info(`Created admin user ${user.email} from ADMIN_EMAIL/ADMIN_PASSWORD.`);
    return;
  }
  ctx.log.warn(
    'No users exist yet. Create an admin with `npm run cli -- create-user you@example.com admin` ' +
      '(or `node server/dist/cli.js create-user you@example.com admin`), ' +
      'or set ADMIN_EMAIL and ADMIN_PASSWORD and restart.',
  );
}

export async function buildApp(config: Config, options: BuildOptions = {}): Promise<FastifyInstance> {
  const now = options.now ?? Date.now;
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            // Never log client addresses or headers.
            serializers: {
              req: (req: { method?: string; url?: string }) => ({ method: req.method, url: req.url?.split('?')[0] }),
            },
          },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: toFastifyTrustProxy(config.trustProxy),
    bodyLimit: 64 * 1024,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    return503OnClosing: true,
    routerOptions: { maxParamLength: 200 },
    // Malformed URLs / content-type errors raised by the router: generic JSON body,
    // and the onSend hook still adds the security headers.
    frameworkErrors: (_err, request, reply) => {
      // Runs before routing, so the onSend hook does not apply: set the headers here.
      const r = reply as unknown as FastifyReply;
      applySecurityHeaders(request as unknown as FastifyRequest, r, config);
      void r.code(400).send({ error: 'bad request' });
    },
  });

  const dbPath = options.dbPath ?? path.join(config.dataDir, 'analytics.db');
  let db: DB;
  try {
    db = openDatabase(dbPath);
  } catch (err) {
    await app.close();
    throw err;
  }
  const ctx = createContext(config, db, now, app.log, readVersion());
  app.decorate('ctx', ctx);
  app.decorateRequest('user', null);
  app.decorateRequest('authTokenHash', null);

  const timers: NodeJS.Timeout[] = [];
  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t);
    if (db.open) db.close();
  });

  // hook: false -> cookies are never parsed globally; only auth routes read the session
  // cookie explicitly, so /api/event ignores cookies entirely (same-site beacons may carry one).
  await app.register(fastifyCookie, { hook: false });
  // Only /api/event accepts text/plain (registered inside its own encapsulated context).
  app.removeContentTypeParser('text/plain');

  registerSecurityHeaders(app, config);
  registerCsrfCheck(app, config);

  app.setErrorHandler((err: FastifyError | HttpError, request, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if ('validation' in err && err.validation) return reply.code(400).send({ error: 'invalid request' });
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: GENERIC_MESSAGES[status] ?? 'bad request' });
    request.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'internal error' });
  });

  await ctx.geo.load();
  await bootstrapAdmin(ctx);
  if (!config.publicUrl) {
    ctx.log.warn('PUBLIC_URL is not set. It is strongly recommended (CSRF origin checks, install snippet).');
  }

  await app.register(ingestRoutes, { ctx });
  await app.register(authRoutes, { ctx });
  await app.register(userRoutes, { ctx });
  await app.register(siteRoutes, { ctx });
  await app.register(statsRoutes, { ctx });
  await app.register(exportRoutes, { ctx });
  app.get('/api/config', { preHandler: requireAuth(ctx) }, async () => ({
    publicUrl: config.publicUrl,
    version: ctx.version,
    geoip: ctx.geo.enabled,
  }));
  // Root-level: owns the not-found handler and static files.
  await staticRoutes(app, { ctx });

  if (options.backgroundJobs) {
    const cleanup = (): void => {
      try {
        runCleanup(ctx);
      } catch (err) {
        ctx.log.error({ err }, 'cleanup job failed');
      }
    };
    cleanup();
    timers.push(setInterval(cleanup, HOUR).unref());

    if (config.geoipAutoDownload) {
      const refresh = async (maxAge: number): Promise<void> => {
        const age = await fileAge(config.geoipDbPath, now());
        if (age !== null && age < maxAge) return;
        const opts = options.fetchFn ? { fetchFn: options.fetchFn } : {};
        if (await downloadGeoDatabase(config.geoipDbPath, ctx.log, opts)) await ctx.geo.load();
      };
      // Never block startup or crash on download failures.
      void refresh(GEOIP_MAX_AGE_STARTUP).catch((err: unknown) => ctx.log.warn({ err }, 'GeoIP refresh failed'));
      timers.push(
        setInterval(() => {
          void refresh(GEOIP_MAX_AGE_REFRESH).catch((err: unknown) => ctx.log.warn({ err }, 'GeoIP refresh failed'));
        }, DAY).unref(),
      );
    }
  }

  return app;
}
