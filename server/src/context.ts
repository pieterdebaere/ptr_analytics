import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { AuthSessionRepo } from './auth/sessions.js';
import { UserTokenRepo } from './auth/tokens.js';
import { BillingService } from './billing/service.js';
import { HttpStripeClient, type StripeClient } from './billing/stripe.js';
import { Mailer, smtpTransport, type MailTransport } from './mail.js';
import { SiteRepo } from './data/sites.js';
import { UserRepo, type User } from './data/users.js';
import { GeoService } from './geo/geo.js';
import { IngestStore } from './ingest/store.js';
import { RateLimiter } from './lib/rate-limit.js';
import { SaltStore } from './lib/salts.js';
import { StatsQueries } from './stats/queries.js';
import { VitalsQueries } from './stats/vitals.js';

export type Clock = () => number;

export interface AppContext {
  config: Config;
  db: DB;
  now: Clock;
  log: FastifyBaseLogger;
  version: string;
  users: UserRepo;
  sites: SiteRepo;
  authSessions: AuthSessionRepo;
  userTokens: UserTokenRepo;
  /** Outgoing mail (hosted mode), null when SIGNUP_ENABLED is off. */
  mailer: Mailer | null;
  billing: BillingService;
  salts: SaltStore;
  geo: GeoService;
  ingest: IngestStore;
  stats: StatsQueries;
  vitals: VitalsQueries;
  limits: {
    ingest: RateLimiter | null;
    loginIp: RateLimiter;
    loginEmailIp: RateLimiter;
    loginEmail: RateLimiter;
    /** Sign-up / forgot-password requests per client IP and per email address. */
    signupIp: RateLimiter;
    signupEmail: RateLimiter;
    forgotIp: RateLimiter;
    forgotEmail: RateLimiter;
    /** verify / reset token submissions per client IP. */
    tokenIp: RateLimiter;
  };
}

export interface ContextOptions {
  /** Mail transport (tests capture mail); default: SMTP from SMTP_URL. */
  mailTransport?: MailTransport;
  /** Stripe client (tests inject a fake); default: REST client when STRIPE_SECRET_KEY is set. */
  stripe?: StripeClient;
}

const LOGIN_WINDOW_MS = 15 * 60_000;
/** Attempts per (email, client IP) per window; the counter resets on success. */
const LOGIN_MAX_PER_EMAIL_IP = 10;
/**
 * Attempts per email across all IPs. Much higher than the per-(email, IP) limit so that a
 * single attacker cannot lock the real owner out, while a distributed brute force still hits it.
 */
const LOGIN_MAX_PER_EMAIL = 100;
/** Attempts per client IP per window (higher: several users may share an IP). */
const LOGIN_MAX_PER_IP = 30;

/**
 * GEOIP_HEADER is only honoured when a reverse proxy is configured (TRUST_PROXY not false):
 * without a proxy any client could simply send the header. The proxy/CDN in front MUST set
 * or overwrite this header on every request (never pass a client-supplied value through),
 * e.g. Cloudflare's `CF-IPCountry`, or `proxy_set_header X-Country $geoip2_country;` in nginx.
 */
export function effectiveGeoipHeader(config: Config): string | null {
  return config.trustProxy === false ? null : config.geoipHeader;
}

const HOUR_MS = 3_600_000;

export function createContext(
  config: Config,
  db: DB,
  now: Clock,
  log: FastifyBaseLogger,
  version: string,
  options: ContextOptions = {},
): AppContext {
  const users = new UserRepo(db);
  const sites = new SiteRepo(db);
  const cloud = config.cloud;
  let mailer: Mailer | null = null;
  if (cloud.signupEnabled && cloud.smtpUrl && cloud.mailFrom) {
    mailer = new Mailer(options.mailTransport ?? smtpTransport(cloud.smtpUrl), cloud.mailFrom, log);
  }
  const stripe = options.stripe ?? (cloud.stripeSecretKey ? new HttpStripeClient(cloud.stripeSecretKey) : null);
  return {
    config,
    db,
    now,
    log,
    version,
    users,
    sites,
    authSessions: new AuthSessionRepo(db),
    userTokens: new UserTokenRepo(db),
    mailer,
    billing: new BillingService({ config, db, users, sites, log }, stripe),
    salts: new SaltStore(db),
    geo: new GeoService(config.geoipDbPath, effectiveGeoipHeader(config), log),
    ingest: new IngestStore(db),
    stats: new StatsQueries(db),
    vitals: new VitalsQueries(db),
    limits: {
      ingest: config.ingestRateLimit > 0 ? new RateLimiter(config.ingestRateLimit, 60_000, now, 100_000) : null,
      loginIp: new RateLimiter(LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS, now, 20_000),
      loginEmailIp: new RateLimiter(LOGIN_MAX_PER_EMAIL_IP, LOGIN_WINDOW_MS, now, 20_000),
      loginEmail: new RateLimiter(LOGIN_MAX_PER_EMAIL, LOGIN_WINDOW_MS, now, 20_000),
      signupIp: new RateLimiter(10, HOUR_MS, now, 20_000),
      signupEmail: new RateLimiter(3, HOUR_MS, now, 20_000),
      forgotIp: new RateLimiter(10, HOUR_MS, now, 20_000),
      forgotEmail: new RateLimiter(3, HOUR_MS, now, 20_000),
      tokenIp: new RateLimiter(30, 15 * 60_000, now, 20_000),
    },
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    authTokenHash: string | null;
  }
}
