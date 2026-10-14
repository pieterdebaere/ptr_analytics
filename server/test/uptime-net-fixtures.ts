// Shared fixtures for the uptime network / checker tests.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadUptimeConfig, type UptimeConfig } from '../src/uptime/config.js';
import { createSafeNet, type TargetPolicyOptions } from '../src/uptime/net/index.js';
import type { CheckContext, CheckerDefinition, SafeNet, ValidateContext } from '../src/uptime/types.js';

export function uptimeConfig(env: Record<string, string> = {}, hosted = false): UptimeConfig {
  return loadUptimeConfig(env, { hosted, version: 'test', publicUrl: null });
}

export function testNet(env: Record<string, string> = {}, opts: Partial<TargetPolicyOptions> = {}): SafeNet {
  return createSafeNet({ config: uptimeConfig(env), ...opts });
}

export function signal(ms = 5000): AbortSignal {
  return AbortSignal.timeout(ms);
}

export function vctx(over: Partial<ValidateContext> = {}): ValidateContext {
  return { hosted: false, role: 'admin', config: uptimeConfig(), ...over };
}

export function memberCtx(over: Partial<ValidateContext> = {}): ValidateContext {
  return { hosted: true, role: 'member', config: uptimeConfig({}, true), ...over };
}

/** Validates input and runs the check against `net` (private targets allowed by default). */
export async function runCheck(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: CheckerDefinition<any, any>,
  input: Record<string, unknown>,
  opts: { net?: SafeNet; timeoutMs?: number; uptime?: UptimeConfig; secrets?: Record<string, string>; uid?: string } = {},
) {
  const v = def.validate(input, vctx());
  const timeoutMs = opts.timeoutMs ?? 5000;
  const uptime = opts.uptime ?? uptimeConfig();
  const ctx: CheckContext = {
    monitorUid: opts.uid ?? 'test-monitor',
    config: v.config,
    secrets: { ...v.secrets, ...(opts.secrets ?? {}) },
    timeoutMs,
    signal: AbortSignal.timeout(timeoutMs),
    net: opts.net ?? createSafeNet({ config: uptime }),
    userAgent: 'PTR-Uptime/test',
    maxBodyBytes: uptime.maxBodyBytes,
    uptime,
  };
  return def.check!(ctx);
}

export function listen(server: net.Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port));
  });
}

export function close(server: { close(cb?: () => void): unknown; closeAllConnections?: () => void }): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export interface TestCerts {
  dir: string;
  caCert: string;
  /** Leaf for localhost / 127.0.0.1 signed by the CA, valid 5 days. */
  cert: string;
  key: string;
  /** Self-signed for localhost, valid 30 days. */
  selfCert: string;
  selfKey: string;
  /** Client certificate signed by the CA. */
  clientCert: string;
  clientKey: string;
}

let certs: TestCerts | null = null;

export function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function testCerts(): TestCerts {
  if (certs) return certs;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-uptime-certs-'));
  const p = (n: string): string => path.join(dir, n);
  const run = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  };
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  run(['req', '-x509', ...ec, '-keyout', p('ca.key'), '-out', p('ca.crt'), '-days', '30', '-subj', '/CN=PTR Test CA']);
  fs.writeFileSync(p('leaf.ext'), 'subjectAltName=DNS:localhost,DNS:*.test.invalid,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n');
  run(['req', ...ec, '-keyout', p('leaf.key'), '-out', p('leaf.csr'), '-subj', '/CN=localhost']);
  run(['x509', '-req', '-in', p('leaf.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial', '-out', p('leaf.crt'), '-days', '5', '-extfile', p('leaf.ext')]);
  run(['req', ...ec, '-keyout', p('client.key'), '-out', p('client.csr'), '-subj', '/CN=client']);
  run(['x509', '-req', '-in', p('client.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial', '-out', p('client.crt'), '-days', '5']);
  run(['req', '-x509', ...ec, '-keyout', p('self.key'), '-out', p('self.crt'), '-days', '30', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  const r = (n: string): string => fs.readFileSync(p(n), 'utf8');
  certs = {
    dir,
    caCert: r('ca.crt'),
    cert: r('leaf.crt'),
    key: r('leaf.key'),
    selfCert: r('self.crt'),
    selfKey: r('self.key'),
    clientCert: r('client.crt'),
    clientKey: r('client.key'),
  };
  return certs;
}
