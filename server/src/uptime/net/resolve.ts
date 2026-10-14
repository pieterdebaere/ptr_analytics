// Name resolution for monitor traffic: c-ares (`dns.promises.Resolver`) with timeouts and
// cancellation, never `dns.lookup` (libuv thread pool, /etc/hosts, no cancel).
import { promises as dnsp } from 'node:dns';
import { formatIp, parseIp } from './ip.js';
import { isLocalhostName, normalizeHostname, type TargetPolicy } from './policy.js';
import type { ResolvedTarget } from '../types.js';
import { TargetDeniedError } from '../types.js';
import { NetError, abortError } from './errors.js';

/** Resolves one family; returns IP literals. Tests inject a fake; default uses c-ares. */
export type HostResolver = (host: string, family: 4 | 6, signal: AbortSignal) => Promise<string[]>;

export function caresResolver(servers?: readonly string[]): HostResolver {
  return async (host, family, signal) => {
    const r = new dnsp.Resolver({ timeout: 2500, tries: 2 });
    if (servers && servers.length > 0) r.setServers([...servers]);
    const onAbort = (): void => r.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return family === 4 ? await r.resolve4(host) : await r.resolve6(host);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
}

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'ENONAME', 'NXDOMAIN', 'ESERVFAIL', 'EREFUSED', 'EBADRESP', 'ECONNREFUSED']);

function strip(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * "Not found" error. Hosted members get exactly the same error as for a denied target, so the
 * answer cannot be used to enumerate internal DNS names (`*.svc.cluster.local`, `*.ec2.internal`
 * …: "exists but private" vs "does not exist"). Self-hosted admins keep the precise message.
 */
function notFound(policy: TargetPolicy, message: string): Error {
  if (policy.hostedMember) return new TargetDeniedError('target not allowed');
  return new NetError('ENOTFOUND', message);
}

/**
 * Resolves `host` (IP literal or hostname) and checks every address against the policy.
 * Throws TargetDeniedError if the name or ANY resolved address is denied (mixing a public and a
 * private record is refused), NetError(ENOTFOUND) when nothing was found (TargetDeniedError for
 * hosted members, see notFound).
 */
export async function resolveTarget(
  policy: TargetPolicy,
  resolver: HostResolver,
  hostInput: string,
  opts: { family?: 4 | 6 | 0; signal: AbortSignal },
): Promise<ResolvedTarget> {
  if (opts.signal.aborted) throw abortError(opts.signal);
  const raw = strip(hostInput.trim());
  const ip = parseIp(raw);
  const family = opts.family ?? 0;
  if (ip) {
    if (family !== 0 && ip.family !== family) throw new NetError('ENOTFOUND', `address family mismatch (IPv${ip.family} literal)`);
    const text = formatIp(ip);
    policy.assertIp(text);
    return { host: text, addresses: [{ address: text, family: ip.family }] };
  }
  const host = normalizeHostname(raw);
  if (!host) throw new NetError('EINVALIDHOST', 'invalid hostname');
  const hc = policy.checkHostname(host);
  if (!hc.ok) throw new TargetDeniedError('target not allowed');

  let v4: string[] = [];
  let v6: string[] = [];
  if (isLocalhostName(host)) {
    // RFC 6761: never sent to DNS.
    v4 = ['127.0.0.1'];
    v6 = ['::1'];
  } else {
    const errors: unknown[] = [];
    const run = async (fam: 4 | 6): Promise<string[]> => {
      try {
        return await raceAbort(resolver(host, fam, opts.signal), opts.signal);
      } catch (err) {
        errors.push(err);
        return [];
      }
    };
    [v4, v6] = await Promise.all([family === 6 ? Promise.resolve([]) : run(4), family === 4 ? Promise.resolve([]) : run(6)]);
    if (opts.signal.aborted) throw abortError(opts.signal);
    if (v4.length === 0 && v6.length === 0) {
      const e = errors[0] as { code?: string } | undefined;
      if (e && e.code && !NOT_FOUND.has(e.code)) {
        if (e.code === 'ECANCELLED') throw abortError(opts.signal);
        if (e.code === 'ETIMEOUT') throw new NetError('EDNSTIMEOUT', 'DNS lookup timed out');
      }
      throw notFound(policy, 'host not found');
    }
  }
  const addresses: Array<{ address: string; family: 4 | 6 }> = [];
  const seen = new Set<string>();
  for (const [list, fam] of [
    [v4, 4],
    [v6, 6],
  ] as const) {
    if (family !== 0 && fam !== family) continue;
    for (const a of list.slice(0, 32)) {
      const p = parseIp(a);
      if (!p || p.family !== fam) throw new TargetDeniedError('target not allowed');
      const text = formatIp(p);
      // Every address must pass: a single denied record refuses the whole target.
      policy.assertIp(text, { hostAllowlisted: hc.allowlisted });
      if (!seen.has(text)) {
        seen.add(text);
        addresses.push({ address: text, family: fam });
      }
    }
  }
  if (addresses.length === 0) throw notFound(policy, 'host not found');
  return { host, addresses };
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Connection order: IPv4 first, then IPv6, interleaved (no happy eyeballs, all addresses are checked). */
export function connectOrder(addresses: ResolvedTarget['addresses']): ResolvedTarget['addresses'] {
  const v4 = addresses.filter((a) => a.family === 4);
  const v6 = addresses.filter((a) => a.family === 6);
  const out: ResolvedTarget['addresses'] = [];
  for (let i = 0; i < Math.max(v4.length, v6.length); i++) {
    if (v4[i]) out.push(v4[i]!);
    if (v6[i]) out.push(v6[i]!);
  }
  return out;
}
