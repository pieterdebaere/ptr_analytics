// Registry of monitor types (docs/SPEC.md §8.1). Keep the export name.
import type { CheckerDefinition } from '../types.js';
import { httpChecker } from './http.js';
import { keywordChecker } from './keyword.js';
import { jsonChecker } from './json.js';
import { tcpChecker } from './tcp.js';
import { tlsChecker } from './tls.js';
import { dnsChecker } from './dns.js';
import { pushChecker, groupChecker, manualChecker } from './passive.js';
import { pingChecker } from './ping.js';
import { websocketChecker } from './websocket.js';
import { smtpChecker } from './smtp.js';
import { ntpChecker } from './ntp.js';
import { redisChecker } from './redis.js';
import { sshChecker } from './ssh.js';
import { grpcChecker } from './grpc.js';
import { postgresChecker } from './postgres.js';
import { mysqlChecker } from './mysql.js';
import { mongodbChecker } from './mongodb.js';
import { mqttChecker } from './mqtt.js';
import { dockerChecker } from './docker.js';
import { domainChecker } from './domain.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL: Array<CheckerDefinition<any, any>> = [
  httpChecker,
  keywordChecker,
  jsonChecker,
  tcpChecker,
  tlsChecker,
  dnsChecker,
  pushChecker,
  groupChecker,
  manualChecker,
  pingChecker,
  websocketChecker,
  smtpChecker,
  ntpChecker,
  redisChecker,
  sshChecker,
  grpcChecker,
  postgresChecker,
  mysqlChecker,
  mongodbChecker,
  mqttChecker,
  dockerChecker,
  domainChecker,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CHECKERS: ReadonlyMap<string, CheckerDefinition<any, any>> = new Map(ALL.map((c) => [c.type, c]));

export { rdapDomainExpiry } from './domain.js';
export { errorMessage } from './common.js';
