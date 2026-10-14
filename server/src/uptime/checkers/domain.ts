// `domain`: domain registration expiry via RDAP. The registry RDAP base URL comes from the IANA
// bootstrap file (https://data.iana.org/rdap/dns.json, cached 24 h); all requests go through
// SafeNet (https only). `rdapDomainExpiry()` is exported for the engine's domain-expiry tracking
// of other monitor types.
import { ValidationError, type CheckerDefinition, type SafeNet } from '../types.js';
import { NetError } from '../net/errors.js';
import { normalizeHostname } from '../net/policy.js';
import { daysLeft, down, guarded, int, str, up } from './common.js';

export interface DomainConfig {
  domain: string;
  minDaysLeft: number;
}

/** Public suffixes with more than one label that commonly hold registrations (small PSL subset). */
const MULTI_LABEL_SUFFIXES = new Set(
  `ac.uk co.uk gov.uk ltd.uk me.uk net.uk nhs.uk org.uk plc.uk sch.uk police.uk
   com.au net.au org.au edu.au gov.au asn.au id.au
   co.nz net.nz org.nz govt.nz ac.nz school.nz geek.nz
   co.jp ne.jp or.jp ac.jp go.jp gr.jp ed.jp lg.jp
   co.kr or.kr ne.kr re.kr go.kr ac.kr
   com.br net.br org.br gov.br edu.br art.br
   com.cn net.cn org.cn gov.cn edu.cn ac.cn
   com.tw net.tw org.tw edu.tw gov.tw idv.tw
   com.hk net.hk org.hk edu.hk gov.hk idv.hk
   com.sg net.sg org.sg edu.sg gov.sg per.sg
   com.my net.my org.my edu.my gov.my
   co.in net.in org.in firm.in gen.in ind.in ac.in edu.in gov.in
   co.za net.za org.za gov.za ac.za web.za
   com.mx net.mx org.mx gob.mx edu.mx
   com.ar net.ar org.ar gob.ar edu.ar
   com.tr net.tr org.tr gen.tr biz.tr web.tr edu.tr gov.tr
   com.ua net.ua org.ua in.ua kiev.ua
   co.il org.il net.il ac.il gov.il
   com.pl net.pl org.pl waw.pl
   co.id or.id web.id ac.id go.id my.id
   com.vn net.vn org.vn edu.vn gov.vn
   com.ph net.ph org.ph
   com.pk net.pk org.pk
   com.sa net.sa org.sa
   com.eg net.eg org.eg
   com.ng net.ng org.ng
   co.ke or.ke ne.ke
   co.th in.th ac.th or.th go.th
   com.co net.co org.co nom.co
   com.pe net.pe org.pe
   com.ve net.ve org.ve
   com.ec net.ec org.ec
   co.at or.at gv.at ac.at
   com.es nom.es org.es edu.es gob.es
   com.pt org.pt
   com.gr net.gr org.gr edu.gr
   com.cy net.cy org.cy
   co.hu org.hu
   com.ru net.ru org.ru msk.ru spb.ru
   co.uz com.uz
   com.qa com.kw com.bh com.om com.lb com.jo
   co.ma net.ma org.ma
   com.do com.gt com.sv com.ni com.pa com.py com.uy com.bo
   co.cr co.ve co.ug co.tz co.zw co.zm co.mz
   eu.org us.org
   gov.ie`.split(/\s+/).filter(Boolean),
);

/** Registrable domain: last two labels, or three when the last two are a known public suffix. */
export function registrableDomain(host: string): string | null {
  const h = normalizeHostname(host);
  if (!h) return null;
  const labels = h.split('.');
  if (labels.length < 2) return null;
  const last2 = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(last2)) return labels.length >= 3 ? labels.slice(-3).join('.') : null;
  return last2;
}

/* ---------------------------------------------------------------- bootstrap */

const BOOTSTRAP_TTL = 24 * 3600_000;
let bootstrapUrl = 'https://data.iana.org/rdap/dns.json';
let bootstrap: { at: number; services: Map<string, string> } | null = null;
let bootstrapInflight: Promise<Map<string, string>> | null = null;
const expiryCache = new Map<string, { at: number; value: number | null }>();

/** Test hooks. */
export function setRdapBootstrapUrl(u: string): void {
  bootstrapUrl = u;
  bootstrap = null;
  bootstrapInflight = null;
  expiryCache.clear();
}

export function parseBootstrap(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const services = (json as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) throw new NetError('ERDAP', 'invalid RDAP bootstrap file');
  for (const svc of services.slice(0, 5000)) {
    if (!Array.isArray(svc) || !Array.isArray(svc[0]) || !Array.isArray(svc[1])) continue;
    const urls = (svc[1] as unknown[]).filter((u): u is string => typeof u === 'string' && u.length < 512);
    // Prefer https; plain http only when a registry publishes nothing else.
    const base = urls.find((u) => u.startsWith('https://')) ?? urls.find((u) => u.startsWith('http://'));
    if (!base) continue;
    for (const tld of svc[0] as unknown[]) {
      if (typeof tld === 'string' && tld.length < 64) out.set(tld.toLowerCase(), base.endsWith('/') ? base : `${base}/`);
    }
  }
  return out;
}

async function loadBootstrap(net: SafeNet, signal: AbortSignal): Promise<Map<string, string>> {
  if (bootstrap && Date.now() - bootstrap.at < BOOTSTRAP_TTL) return bootstrap.services;
  bootstrapInflight ??= (async () => {
    try {
      const res = await net.request({ url: bootstrapUrl, method: 'GET', headers: { accept: 'application/json' }, maxRedirects: 3, maxBodyBytes: 2 * 1024 * 1024, signal });
      if (res.status !== 200 || res.truncated) throw new NetError('ERDAP', `RDAP bootstrap download failed (HTTP ${res.status})`);
      let json: unknown;
      try {
        json = JSON.parse(res.body.toString('utf8'));
      } catch {
        throw new NetError('ERDAP', 'invalid RDAP bootstrap file');
      }
      const services = parseBootstrap(json);
      bootstrap = { at: Date.now(), services };
      return services;
    } finally {
      bootstrapInflight = null;
    }
  })();
  return bootstrapInflight;
}

export function rdapBaseFor(services: Map<string, string>, domain: string): string | null {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    const base = services.get(suffix);
    if (base) return base;
  }
  return null;
}

export function expiryFromRdap(json: unknown): number | null {
  const events = (json as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return null;
  for (const e of events.slice(0, 100)) {
    const ev = e as { eventAction?: unknown; eventDate?: unknown };
    if (ev && ev.eventAction === 'expiration' && typeof ev.eventDate === 'string') {
      const t = Date.parse(ev.eventDate);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

/**
 * Looks up the registration expiry of the registrable domain of `host` (cached 12 h).
 * Returns null when the registry publishes no expiry. Throws NetError otherwise.
 */
export async function rdapDomainExpiry(net: SafeNet, host: string, signal: AbortSignal): Promise<{ domain: string; expiresAt: number | null }> {
  const domain = registrableDomain(host);
  if (!domain) throw new NetError('ERDAP', 'not a registrable domain');
  const cached = expiryCache.get(domain);
  if (cached && Date.now() - cached.at < 12 * 3600_000) return { domain, expiresAt: cached.value };
  const services = await loadBootstrap(net, signal);
  const base = rdapBaseFor(services, domain);
  if (!base) throw new NetError('ERDAP', `no RDAP service for .${domain.split('.').pop()}`);
  const res = await net.request({ url: `${base}domain/${encodeURIComponent(domain)}`, method: 'GET', headers: { accept: 'application/rdap+json, application/json' }, maxRedirects: 3, maxBodyBytes: 1024 * 1024, signal });
  if (res.status === 404) throw new NetError('ERDAP', 'domain not found in RDAP');
  if (res.status !== 200) throw new NetError('ERDAP', `RDAP server returned HTTP ${res.status}`);
  let json: unknown;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new NetError('ERDAP', 'invalid RDAP response');
  }
  const value = expiryFromRdap(json);
  if (expiryCache.size > 10_000) expiryCache.clear();
  expiryCache.set(domain, { at: Date.now(), value });
  return { domain, expiresAt: value };
}

export const domainChecker: CheckerDefinition<DomainConfig, Record<string, never>> = {
  type: 'domain',
  label: 'Domain expiry',
  description: 'Checks the registration expiry date of a domain via RDAP.',
  category: 'infrastructure',
  fields: [
    { key: 'domain', label: 'Domain', kind: 'host', required: true, maxLength: 253, placeholder: 'example.com', group: 'Target' },
    { key: 'minDaysLeft', label: 'Minimum days left', kind: 'number', default: 14, min: 0, max: 365, group: 'Target', help: 'DOWN when the domain expires in fewer days.' },
  ],
  defaults: { intervalS: 43_200, timeoutMs: 15_000, retries: 1 },
  hosted: 'allowed',
  validate(input) {
    const raw = str(input, 'domain', { required: true, max: 253 });
    let d = raw;
    try {
      // Accept IDNs and URLs pasted by mistake.
      d = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname;
    } catch {
      throw new ValidationError('domain must be a domain name', 'domain');
    }
    const reg = registrableDomain(d);
    if (!reg) throw new ValidationError('domain must be a registrable domain name', 'domain');
    return { config: { domain: normalizeHostname(d)!, minDaysLeft: int(input, 'minDaysLeft', { min: 0, max: 365, def: 14 }) }, secrets: {} };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const started = performance.now();
      const r = await rdapDomainExpiry(ctx.net, ctx.config.domain, ctx.signal);
      const latencyMs = Math.round(performance.now() - started);
      if (r.expiresAt === null) return up(`${r.domain}: registry publishes no expiry date`, { latencyMs, domainExpiresAt: null });
      const left = daysLeft(r.expiresAt)!;
      const date = new Date(r.expiresAt).toISOString().slice(0, 10);
      const extra = { latencyMs, domainExpiresAt: r.expiresAt };
      if (r.expiresAt < Date.now()) return down(`${r.domain} expired on ${date}`, extra);
      if (left < ctx.config.minDaysLeft) return down(`${r.domain} expires in ${left} days (${date})`, extra);
      return up(`${r.domain} expires in ${left} days (${date})`, extra);
    });
  },
  target: (c) => c.domain,
  certHost: (c) => c.domain,
};
