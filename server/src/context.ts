import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { AuthSessionRepo } from './auth/sessions.js';
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
  salts: SaltStore;
  geo: GeoService;
  ingest: IngestStore;
  stats: StatsQueries;
  vitals: VitalsQueries;
  limits: {
    ingest: RateLimiter | null;
    loginIp: RateLimiter;
    loginEmail: RateLimiter;
  };
}

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 10;

export function createContext(config: Config, db: DB, now: Clock, log: FastifyBaseLogger, version: string): AppContext {
  return {
    config,
    db,
    now,
    log,
    version,
    users: new UserRepo(db),
    sites: new SiteRepo(db),
    authSessions: new AuthSessionRepo(db),
    salts: new SaltStore(db),
    geo: new GeoService(config.geoipDbPath, config.geoipHeader, log),
    ingest: new IngestStore(db),
    stats: new StatsQueries(db),
    vitals: new VitalsQueries(db),
    limits: {
      ingest: config.ingestRateLimit > 0 ? new RateLimiter(config.ingestRateLimit, 60_000, now, 100_000) : null,
      loginIp: new RateLimiter(LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, now, 20_000),
      loginEmail: new RateLimiter(LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, now, 20_000),
    },
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    authTokenHash: string | null;
  }
}
