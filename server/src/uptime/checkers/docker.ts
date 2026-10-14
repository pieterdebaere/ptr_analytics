// `docker`: container state via the Docker Engine API (self-hosted only, UPTIME_DOCKER_ENABLED).
// The ONLY checker that uses node:http(s) directly: the target is the operator-configured
// UPTIME_DOCKER_HOST (unix socket path or http(s) URL of a docker-socket-proxy), never user input.
// The container name is validated so that it cannot reach other Engine API endpoints.
import http from 'node:http';
import https from 'node:https';
import { ValidationError, type CheckerDefinition, type CheckResult } from '../types.js';
import type { UptimeConfig } from '../config.js';
import { down, guarded, str, up } from './common.js';

export interface DockerConfig {
  container: string;
}

export const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

interface ContainerState {
  Status?: string;
  Running?: boolean;
  Paused?: boolean;
  Restarting?: boolean;
  ExitCode?: number;
  Health?: { Status?: string };
}

/** Maps the Engine API `State` object to a result. */
export function evaluateContainerState(state: ContainerState | undefined): CheckResult {
  if (!state || typeof state !== 'object') return down('Invalid Docker API response');
  const status = typeof state.Status === 'string' ? state.Status.slice(0, 20) : 'unknown';
  if (state.Paused) return down('Container is paused');
  if (state.Restarting) return down('Container is restarting');
  if (!state.Running) return down(`Container is ${status}${typeof state.ExitCode === 'number' ? ` (exit code ${state.ExitCode})` : ''}`);
  const health = state.Health?.Status;
  if (health === undefined || health === 'none' || health === '') return up('Container is running (no health check)');
  if (health === 'healthy') return up('Container is running and healthy');
  if (health === 'starting') return down('Container is starting (health check pending)');
  return down(`Container is ${String(health).slice(0, 20)}`);
}

function dockerGet(cfg: UptimeConfig, path: string, signal: AbortSignal): Promise<{ status: number; body: Buffer }> {
  const hostCfg = cfg.dockerHost;
  if (!hostCfg) return Promise.reject(new Error('docker host not configured'));
  return new Promise((resolve, reject) => {
    let req: http.ClientRequest;
    const opts = { method: 'GET', headers: { host: 'docker', accept: 'application/json', 'user-agent': cfg.userAgent }, signal, maxHeaderSize: 16 * 1024 };
    const onRes = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 1024 * 1024) {
          res.destroy();
          reject(new Error('docker response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    };
    if (hostCfg.startsWith('/')) {
      req = http.request({ ...opts, socketPath: hostCfg, path }, onRes);
    } else {
      const base = new URL(hostCfg.replace(/^tcp:\/\//, 'http://'));
      const u = new URL(path, base);
      req = (u.protocol === 'https:' ? https : http).request(u, { ...opts, agent: false }, onRes);
    }
    req.on('error', reject);
    req.end();
  });
}

export const dockerChecker: CheckerDefinition<DockerConfig, Record<string, never>> = {
  type: 'docker',
  label: 'Docker container',
  description: 'Checks that a container on the configured Docker host is running (and healthy).',
  category: 'infrastructure',
  fields: [
    {
      key: 'container',
      label: 'Container name or ID',
      kind: 'text',
      required: true,
      maxLength: 128,
      group: 'Target',
      selfHostedOnly: true,
      help: 'Container on UPTIME_DOCKER_HOST.',
    },
  ],
  defaults: { intervalS: 60, timeoutMs: 5_000, retries: 1 },
  hosted: 'disabled',
  available: (cfg) => cfg.dockerEnabled && !!cfg.dockerHost,
  validate(input, ctx) {
    if (ctx.hosted && ctx.role === 'member') throw new ValidationError('docker monitors are not available', 'container');
    const container = str(input, 'container', { required: true, max: 128 });
    if (!CONTAINER_RE.test(container)) throw new ValidationError('container must be a container name or ID', 'container');
    return { config: { container }, secrets: {} };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      if (!ctx.uptime.dockerEnabled || !ctx.uptime.dockerHost) return down('Docker monitoring is disabled on this server');
      if (!CONTAINER_RE.test(ctx.config.container)) return down('Invalid container name');
      const started = performance.now();
      let res: { status: number; body: Buffer };
      try {
        res = await dockerGet(ctx.uptime, `/containers/${encodeURIComponent(ctx.config.container)}/json`, ctx.signal);
      } catch {
        return down(ctx.signal.aborted ? `Timeout after ${ctx.timeoutMs} ms` : 'Docker host not reachable');
      }
      const latencyMs = Math.round(performance.now() - started);
      if (res.status === 404) return down('Container not found', { latencyMs });
      if (res.status !== 200) return down(`Docker API returned ${res.status}`, { latencyMs });
      let parsed: { State?: ContainerState };
      try {
        parsed = JSON.parse(res.body.toString('utf8')) as { State?: ContainerState };
      } catch {
        return down('Invalid Docker API response', { latencyMs });
      }
      return { ...evaluateContainerState(parsed.State), latencyMs };
    });
  },
  target: (c) => `docker:${c.container}`,
};
