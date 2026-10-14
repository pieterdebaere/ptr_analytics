import { securityRoutes } from './routes/security.js';
import { registerUptime } from './uptime/index.js';
import fs from 'node:fs';
import type { Socket } from 'node:net';
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
import type { StripeClient } from './billing/stripe.js';
import type { MailTransport } from './mail.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import { billingRoutes, billingWebhookRoutes } from './routes/billing.js';
import { exportRoutes } from './routes/export.js';
import { ingestRoutes } from './routes/ingest.js';
import { siteRoutes } from './routes/sites.js';
import { staticRoutes } from './routes/static.js';
import { statsRoutes } from './routes/stats.js';
import { userRoutes } from './routes/users.js';
import { statsService, type StatsServiceOptions } from './stats/service.js';
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
  /** Destination for log lines instead of stdout (tests). */
  logStream?: { write(msg: string): void };
  /** Mail transport instead of SMTP_URL (tests capture outgoing mail). */
  mailTransport?: MailTransport;
  /** Stripe client instead of the REST client (tests; no network). */
  stripe?: StripeClient;
  /** Overrides for the stats service limits (tests). */
  statsOptions?: Partial<StatsServiceOptions>;
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

/** Whole request (headers + body) must arrive within this time; slow-body clients are cut off. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Request headers must arrive within this time. */
export const HEADERS_TIMEOUT_MS = 10_000;
/** Socket inactivity timeout. */
export const CONNECTION_TIMEOUT_MS = 30_000;
/**
 * Idle keep-alive connections are closed after this time. Slightly above the 60 s idle
 * timeout common in reverse proxies / load balancers, so the proxy closes idle upstream
 * connections first (avoids races where it reuses a connection we are closing).
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * Translate TRUST_PROXY for Fastify. Fastify 5.12 deliberately ignores a numeric
 * `trustProxy` (fails closed), so a hop count is re-implemented here with proxy-addr
 * semantics: n trusts the n closest hops. This is kept because "one reverse proxy in front"
 * is the most common deployment, but it is only safe when the port is reachable *solely*
 * through that proxy: a client connecting directly is itself the first "trusted" hop and
 * can choose its X-Forwarded-For address freely. Prefer a list of proxy IPs/CIDRs.
 */
function toFastifyTrustProxy(t: Config['trustProxy']): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof t === 'number') return (_address: string, hop: number) => hop < t;
  return t;
}

/**
 * Replaces Fastify's default `clientError` handler, which logs the parser error (including
 * `rawPacket`, i.e. raw request bytes with cookies/headers) at trace level. This one logs
 * nothing: it answers 408/400 when possible and closes the connection.
 */
export function clientErrorHandler(err: NodeJS.ErrnoException, socket: Socket): void {
  if (err.code === 'ECONNRESET' || socket.destroyed) return;
  const timeout = err.code === 'ERR_HTTP_REQUEST_TIMEOUT' || err.code === 'ERR_HTTP_HEADERS_TIMEOUT';
  const status = timeout ? '408 Request Timeout' : err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}

/** Configuration warnings / notices logged at startup (exported for tests). */
export function startupMessages(config: Config): { warn: string[]; info: string[] } {
  const warn: string[] = [];
  const info: string[] = [];
  if (!config.publicUrl) {
    warn.push('PUBLIC_URL is not set. It is strongly recommended (CSRF origin checks, install snippet).');
  }
  if (config.geoipHeader !== null && config.trustProxy === false) {
    warn.push(
      `GEOIP_HEADER (${config.geoipHeader}) is ignored because TRUST_PROXY=false: without a reverse proxy that ` +
        'overwrites it, any client could set it. Configure TRUST_PROXY to enable it.',
    );
  }
  if (config.production && !config.cookieSecure) {
    warn.push(
      'NODE_ENV=production but session cookies are not marked Secure (COOKIE_SECURE=false or PUBLIC_URL is not https). ' +
        'Serve the dashboard over HTTPS and set PUBLIC_URL=https://... (or COOKIE_SECURE=true).',
    );
  }
  if (config.cloud.signupEnabled) {
    info.push(
      `Hosted mode: public sign-up is enabled${config.cloud.billingEnabled ? ' with Stripe billing' : ''} ` +
        `(members get ${config.cloud.billingEnabled ? `${config.cloud.freeSites} free site(s)` : `up to ${config.cloud.memberSiteLimit} site(s)`}).`,
    );
    if (config.trustProxy === false) {
      warn.push(
        'SIGNUP_ENABLED with TRUST_PROXY=false: if this server runs behind a reverse proxy, ALL clients share ONE ' +
          'rate-limit bucket (the proxy address), so one abusive client can block sign-up, login and password reset ' +
          'for everybody. Set TRUST_PROXY to your proxy (hop count or IPs/CIDRs).',
      );
    }
    const smtp = config.cloud.smtpUrl?.toLowerCase() ?? '';
    if (smtp.startsWith('smtp:') && config.cloud.smtpAllowInsecure) {
      warn.push(
        'SMTP_URL uses smtp:// and SMTP_ALLOW_INSECURE=true: mail (with verification and password-reset links) and the ' +
          'SMTP password may travel in cleartext. Use smtps:// or remove SMTP_ALLOW_INSECURE (STARTTLS is then required).',
      );
    }
    if (config.cloud.allowInsecurePublicUrl && !config.publicUrl?.startsWith('https://')) {
      warn.push('ALLOW_INSECURE_PUBLIC_URL=true: hosted mode over plain http is for local development only.');
    }
  }
  if (typeof config.trustProxy === 'number') {
    info.push(
      `TRUST_PROXY=${config.trustProxy}: trusting the ${config.trustProxy} closest proxy hop(s) for the client IP. ` +
        `The port (${config.port}) must only be reachable through the proxy, otherwise clients can spoof ` +
        'X-Forwarded-For. Prefer a comma separated list of proxy IPs/CIDRs.',
    );
  } else if (config.trustProxy === true) {
    info.push(
      'TRUST_PROXY=true: X-Forwarded-For is trusted from any peer. The port must only be reachable through the proxy; ' +
        'prefer a comma separated list of proxy IPs/CIDRs.',
    );
  }
  return { warn, info };
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
  const { adminEmail, adminPassword } = ctx.config;
  const onlyOne = (adminEmail === null) !== (adminPassword === null);
  if (ctx.users.count() > 0) {
    if (onlyOne) {
      ctx.log.warn('Only one of ADMIN_EMAIL / ADMIN_PASSWORD is set; ignored because users already exist.');
    }
    return;
  }
  if (onlyOne) {
    ctx.log.error(
      'No users exist and only one of ADMIN_EMAIL / ADMIN_PASSWORD is set: both are needed to create the first admin. ' +
        'Set both and restart, or use `npm run cli -- create-user you@example.com admin`.',
    );
    return;
  }
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
            ...(options.logStream ? { stream: options.logStream } : {}),
            // Never log client addresses or headers.
            serializers: {
              req: (req: { method?: string; url?: string }) => ({ method: req.method, url: req.url?.split('?')[0] }),
            },
          },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: toFastifyTrustProxy(config.trustProxy),
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    clientErrorHandler,
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

  // Fastify sets requestTimeout after creating the server, so Node's headersTimeout keeps its
  // 60 s default; tighten it explicitly (must be <= requestTimeout).
  app.server.headersTimeout = HEADERS_TIMEOUT_MS;

  const dbPath = options.dbPath ?? path.join(config.dataDir, 'analytics.db');
  let db: DB;
  try {
    db = openDatabase(dbPath, { warn: (msg) => app.log.warn(msg) });
  } catch (err) {
    await app.close();
    throw err;
  }
  const ctx = createContext(config, db, now, app.log, readVersion(), {
    ...(options.mailTransport ? { mailTransport: options.mailTransport } : {}),
    ...(options.stripe ? { stripe: options.stripe } : {}),
  });
  app.decorate('ctx', ctx);
  app.decorateRequest('user', null);
  app.decorateRequest('authTokenHash', null);

  const timers: NodeJS.Timeout[] = [];
  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t);
    await ctx.mailer?.close();
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
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send(err.code === undefined ? { error: err.message } : { error: err.message, code: err.code });
    }
    if ('validation' in err && err.validation) return reply.code(400).send({ error: 'invalid request' });
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: GENERIC_MESSAGES[status] ?? 'bad request' });
    request.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'internal error' });
  });

  await ctx.geo.load();
  await bootstrapAdmin(ctx);
  // Allowance settings (FREE_SITES, MEMBER_SITE_LIMIT, BILLING_ENABLED) may have changed.
  ctx.billing.recomputeAll();
  const messages = startupMessages(config);
  for (const m of messages.warn) ctx.log.warn(m);
  for (const m of messages.info) ctx.log.info(m);

  if (options.statsOptions) statsService(ctx, options.statsOptions);
  await app.register(ingestRoutes, { ctx });
  await app.register(authRoutes, { ctx });
  await app.register(accountRoutes, { ctx });
  await app.register(billingRoutes, { ctx });
  await app.register(billingWebhookRoutes, { ctx });
  await app.register(userRoutes, { ctx });
  await app.register(siteRoutes, { ctx });
  await app.register(statsRoutes, { ctx });
  await app.register(exportRoutes, { ctx });
  await app.register(securityRoutes, { ctx });
  await registerUptime(app, ctx, { backgroundJobs: options.backgroundJobs ?? false });
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
        void runCleanup(ctx);
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
