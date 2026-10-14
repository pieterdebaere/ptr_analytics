// SSRF-safe network layer of the uptime module (docs/SPEC.md §8.1, docs/uptime/ANALYSIS.md §8.7.1).
//
// Guarantees of every SafeNet method:
//  * Hostnames are resolved with c-ares (`dns.promises.Resolver`, timeouts, cancellable), never
//    `dns.lookup`; IP literals must be strict (no `127.1`, `0x7f.1`, `2130706433` …; URLs are
//    normalised by the WHATWG parser first).
//  * EVERY resolved address is checked against the policy (one denied record refuses the target);
//    IPv6 embeddings of IPv4 (mapped, compatible, NAT64, 6to4, Teredo) are checked as IPv4.
//  * Connections go to exactly the checked IP literal (no second resolution → no DNS rebinding);
//    TLS uses the original hostname for SNI and verification.
//  * HTTP redirects are followed manually and every hop is re-resolved and re-checked.
//  * No ambient proxies: HTTP_PROXY / HTTPS_PROXY / NO_PROXY / NODE_USE_ENV_PROXY are ignored for
//    monitor traffic (no agent is used at all).
//  * Every socket is destroyed when the AbortSignal fires.
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { SafeNet } from '../types.js';
import type { UptimeConfig } from '../config.js';
import { TargetPolicy } from './policy.js';
import { caresResolver, resolveTarget, type HostResolver } from './resolve.js';
import { connectResolved } from './socket.js';
import { httpRequest } from './http.js';
import { dnsQueryTo, udpExchange } from './udp.js';
import { NetError } from './errors.js';
import { parseIp } from './ip.js';

export interface TargetPolicyOptions {
  config: UptimeConfig;
  /** Addresses of this server / PUBLIC_URL host: always denied (no self-targeting loops). IPs, CIDRs or hostnames. */
  selfAddresses?: readonly string[];
  /** Stricter rules for members in hosted mode (private ranges always denied, https-only URLs …). */
  hostedMember?: boolean;
  /** DNS servers for name resolution ("ip" or "ip:port"); default: the system resolv.conf servers. */
  dnsServers?: readonly string[];
  /** Replaces the c-ares resolver (tests). Must return IP literals of the requested family. */
  resolver?: HostResolver;
  /** User-Agent used when a request carries none (default: config.userAgent). */
  userAgent?: string;
}

export type NetSocket = Socket | TLSSocket;

export function createSafeNet(opts: TargetPolicyOptions): SafeNet {
  const policy = new TargetPolicy({ config: opts.config, selfAddresses: opts.selfAddresses, hostedMember: opts.hostedMember });
  const resolver = opts.resolver ?? caresResolver(opts.dnsServers);
  const userAgent = opts.userAgent ?? opts.config.userAgent;

  const net: SafeNet = {
    resolve(host, o) {
      return resolveTarget(policy, resolver, host, o);
    },

    async connect(o) {
      const target = await resolveTarget(policy, resolver, o.host, { family: o.family ?? 0, signal: o.signal });
      return connectResolved(target, o.port, {
        signal: o.signal,
        tls: o.tls
          ? {
              servername: o.tls.servername ?? target.host,
              rejectUnauthorized: o.tls.rejectUnauthorized,
              alpn: o.tls.alpn,
              cert: o.tls.cert,
              key: o.tls.key,
              ca: o.tls.ca,
            }
          : undefined,
      });
    },

    request(o) {
      return httpRequest(policy, resolver, { ...o, userAgent });
    },

    async dnsQuery(o) {
      const target = await resolveTarget(policy, resolver, o.server, { signal: o.signal });
      const a = target.addresses[0]!;
      return dnsQueryTo(a.address, a.family, o.port ?? 53, o.name, o.type, o.signal);
    },

    async udp(o) {
      const target = await resolveTarget(policy, resolver, o.host, { family: o.family ?? 0, signal: o.signal });
      const a = target.addresses.find((x) => x.family === 4) ?? target.addresses[0]!;
      const r = await udpExchange(a.address, a.family, o.port, o.payload, o.signal);
      return { data: r.data, remoteAddress: a.address, latencyMs: r.latencyMs };
    },

    assertAllowed(address) {
      if (!parseIp(address)) throw new NetError('EINVAL', 'not an IP literal');
      policy.assertIp(address);
    },
  };
  return net;
}

export { TargetPolicy, normalizeHost, normalizeHostname } from './policy.js';
export { NetError, TlsCertificateError } from './errors.js';
export { SocketReader, upgradeTls, tlsInfoOf, writeAll, buildTlsInfo } from './socket.js';
export { parseHttpUrl } from './http.js';
export { parseIp, normalizeIp, classifyIp, embeddedIPv4 } from './ip.js';
export { QUERY_TYPES, parseMessage, encodeQuery, DnsParseError } from './dns-wire.js';
export type { HostResolver } from './resolve.js';
