// HTTP family: `http` (status), plus the shared request/auth implementation used by `keyword`
// and `json` (keyword.ts, json.ts) and the header/auth fields reused by `websocket`.
import { createHash, randomBytes } from 'node:crypto';
import { ValidationError, type CheckContext, type CheckResult, type CheckerDefinition, type FieldDef, type HttpResponse, type ValidateContext } from '../types.js';
import { NetError } from '../net/errors.js';
import {
  IGNORE_TLS_FIELD,
  IP_FAMILY_FIELD,
  bool,
  codeAccepted,
  down,
  familyNum,
  guarded,
  headerList,
  int,
  ipFamily,
  isMember,
  ms,
  oneOf,
  pem,
  secret,
  secretHeaderList,
  statusCodes,
  str,
  tlsSummary,
  up,
  url,
  type Input,
} from './common.js';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const AUTH_METHODS = ['none', 'basic', 'bearer', 'oauth2', 'mtls'] as const;

export interface HttpAuthConfig {
  authMethod: (typeof AUTH_METHODS)[number];
  basicUser: string;
  oauthTokenUrl: string;
  oauthClientId: string;
  oauthScopes: string;
  oauthAudience: string;
  oauthAuthMethod: 'client_secret_basic' | 'client_secret_post';
  tlsCert: string;
  tlsCa: string;
}

export interface HttpConfig extends HttpAuthConfig {
  url: string;
  method: (typeof HTTP_METHODS)[number];
  headers: Array<{ key: string; value: string }>;
  /** Names of headers whose values are stored as secrets (`secretHeaders.<name>`). */
  secretHeaders: string[];
  bodyEncoding: 'json' | 'form' | 'raw';
  body: string;
  acceptedStatusCodes: string[];
  maxRedirects: number;
  ignoreTls: boolean;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
  cacheBuster: boolean;
}

export type HttpSecrets = Record<string, string>;

/* ------------------------------------------------------------------- fields */

const showAuth = (...m: string[]): FieldDef['showIf'] => ({ key: 'authMethod', equals: m });

export const HEADER_FIELDS: FieldDef[] = [
  { key: 'headers', label: 'Headers', kind: 'keyvalue', group: 'Request', help: 'Extra request headers (max 50).' },
  {
    key: 'secretHeaders',
    label: 'Secret headers',
    kind: 'keyvalue',
    secret: true,
    group: 'Request',
    help: 'Headers carrying credentials (API keys …). Values are encrypted and never shown again; leave a value empty to keep it.',
  },
];

export const AUTH_FIELDS: FieldDef[] = [
  {
    key: 'authMethod',
    label: 'Authentication',
    kind: 'select',
    default: 'none',
    group: 'Authentication',
    options: [
      { value: 'none', label: 'None' },
      { value: 'basic', label: 'HTTP Basic' },
      { value: 'bearer', label: 'Bearer token' },
      { value: 'oauth2', label: 'OAuth 2.0 client credentials' },
      { value: 'mtls', label: 'Client certificate (mTLS)' },
    ],
  },
  { key: 'basicUser', label: 'Username', kind: 'text', maxLength: 255, group: 'Authentication', showIf: showAuth('basic') },
  { key: 'basicPassword', label: 'Password', kind: 'password', secret: true, maxLength: 1024, group: 'Authentication', showIf: showAuth('basic') },
  { key: 'bearerToken', label: 'Token', kind: 'password', secret: true, required: true, maxLength: 8192, group: 'Authentication', showIf: showAuth('bearer') },
  { key: 'oauthTokenUrl', label: 'Token URL', kind: 'url', required: true, maxLength: 2048, group: 'Authentication', showIf: showAuth('oauth2'), placeholder: 'https://auth.example.com/oauth/token' },
  { key: 'oauthClientId', label: 'Client ID', kind: 'text', required: true, maxLength: 255, group: 'Authentication', showIf: showAuth('oauth2') },
  { key: 'oauthClientSecret', label: 'Client secret', kind: 'password', secret: true, required: true, maxLength: 1024, group: 'Authentication', showIf: showAuth('oauth2') },
  { key: 'oauthScopes', label: 'Scopes', kind: 'text', maxLength: 1024, group: 'Authentication', showIf: showAuth('oauth2'), help: 'Space separated.' },
  { key: 'oauthAudience', label: 'Audience', kind: 'text', maxLength: 1024, group: 'Authentication', showIf: showAuth('oauth2') },
  {
    key: 'oauthAuthMethod',
    label: 'Client authentication',
    kind: 'select',
    default: 'client_secret_basic',
    group: 'Authentication',
    showIf: showAuth('oauth2'),
    options: [
      { value: 'client_secret_basic', label: 'HTTP Basic (client_secret_basic)' },
      { value: 'client_secret_post', label: 'Request body (client_secret_post)' },
    ],
  },
  { key: 'tlsCert', label: 'Client certificate (PEM)', kind: 'textarea', required: true, maxLength: 32768, group: 'Authentication', showIf: showAuth('mtls') },
  { key: 'tlsKey', label: 'Client private key (PEM)', kind: 'textarea', secret: true, required: true, maxLength: 32768, group: 'Authentication', showIf: showAuth('mtls') },
  { key: 'tlsCa', label: 'CA certificate (PEM, optional)', kind: 'textarea', maxLength: 65536, group: 'Authentication', showIf: showAuth('mtls'), help: 'Trust only this CA for the server certificate.' },
];

export const HTTP_FIELDS: FieldDef[] = [
  { key: 'url', label: 'URL', kind: 'url', required: true, maxLength: 2048, placeholder: 'https://example.com/health', group: 'Request' },
  {
    key: 'method',
    label: 'Method',
    kind: 'select',
    default: 'GET',
    group: 'Request',
    options: HTTP_METHODS.map((m) => ({ value: m, label: m })),
  },
  ...HEADER_FIELDS,
  {
    key: 'bodyEncoding',
    label: 'Body encoding',
    kind: 'select',
    default: 'json',
    group: 'Request',
    showIf: { key: 'method', equals: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] },
    options: [
      { value: 'json', label: 'JSON' },
      { value: 'form', label: 'Form (x-www-form-urlencoded)' },
      { value: 'raw', label: 'Raw / other' },
    ],
  },
  { key: 'body', label: 'Body', kind: 'textarea', maxLength: 65536, group: 'Request', showIf: { key: 'method', equals: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] } },
  {
    key: 'acceptedStatusCodes',
    label: 'Accepted status codes',
    kind: 'statuscodes',
    default: ['200-299'],
    group: 'Response',
    help: 'Single codes or ranges, e.g. 200-299, 301.',
  },
  { key: 'maxRedirects', label: 'Max. redirects', kind: 'number', default: 10, min: 0, max: 20, group: 'Request', help: '0 = do not follow redirects.' },
  IGNORE_TLS_FIELD,
  IP_FAMILY_FIELD,
  { key: 'cacheBuster', label: 'Cache buster', kind: 'boolean', default: false, group: 'Advanced', help: 'Append a random query parameter to bypass caches.' },
  ...AUTH_FIELDS,
];

/* --------------------------------------------------------------- validation */

export function validateAuth(input: Input, ctx: ValidateContext): { config: HttpAuthConfig; secrets: Record<string, string> } {
  const authMethod = oneOf(input, 'authMethod', AUTH_METHODS, 'none');
  const config: HttpAuthConfig = {
    authMethod,
    basicUser: '',
    oauthTokenUrl: '',
    oauthClientId: '',
    oauthScopes: '',
    oauthAudience: '',
    oauthAuthMethod: 'client_secret_basic',
    tlsCert: '',
    tlsCa: '',
  };
  const secrets: Record<string, string> = {};
  if (authMethod === 'basic') {
    config.basicUser = str(input, 'basicUser', { max: 255 });
    if (config.basicUser.includes(':')) throw new ValidationError('basicUser must not contain ":"', 'basicUser');
    const pw = secret(input, 'basicPassword', ctx, { max: 1024 });
    if (pw !== undefined) secrets.basicPassword = pw;
  } else if (authMethod === 'bearer') {
    const t = secret(input, 'bearerToken', ctx, { max: 8192 });
    if (!t) throw new ValidationError('bearerToken is required', 'bearerToken');
    secrets.bearerToken = t;
  } else if (authMethod === 'oauth2') {
    config.oauthTokenUrl = url(input, 'oauthTokenUrl', ctx, { httpsOnly: isMember(ctx) });
    config.oauthClientId = str(input, 'oauthClientId', { required: true, max: 255 });
    config.oauthScopes = str(input, 'oauthScopes', { max: 1024 });
    config.oauthAudience = str(input, 'oauthAudience', { max: 1024 });
    config.oauthAuthMethod = oneOf(input, 'oauthAuthMethod', ['client_secret_basic', 'client_secret_post'] as const, 'client_secret_basic');
    const s = secret(input, 'oauthClientSecret', ctx, { max: 1024 });
    if (!s) throw new ValidationError('oauthClientSecret is required', 'oauthClientSecret');
    secrets.oauthClientSecret = s;
  } else if (authMethod === 'mtls') {
    config.tlsCert = pem(str(input, 'tlsCert', { required: true, max: 32768, multiline: true }), 'tlsCert', /CERTIFICATE/);
    const ca = str(input, 'tlsCa', { max: 65536, multiline: true });
    config.tlsCa = ca ? pem(ca, 'tlsCa', /CERTIFICATE/) : '';
    const key = secret(input, 'tlsKey', ctx, { max: 32768, multiline: true });
    if (!key) throw new ValidationError('tlsKey is required', 'tlsKey');
    secrets.tlsKey = pem(key, 'tlsKey', /PRIVATE KEY/);
  }
  return { config, secrets };
}

export function validateHttp(input: Input, ctx: ValidateContext): { config: HttpConfig; secrets: HttpSecrets } {
  const member = isMember(ctx);
  const method = oneOf(input, 'method', HTTP_METHODS, 'GET');
  const headers = headerList(input, 'headers');
  const sh = secretHeaderList(input, 'secretHeaders', ctx);
  const dup = sh.names.find((n) => headers.some((h) => h.key.toLowerCase() === n.toLowerCase()));
  if (dup) throw new ValidationError(`header ${dup} is set twice`, 'secretHeaders');
  const bodyEncoding = oneOf(input, 'bodyEncoding', ['json', 'form', 'raw'] as const, 'json');
  const body = method === 'GET' || method === 'HEAD' ? '' : str(input, 'body', { max: 65536, multiline: true, trim: false });
  if (body.trim() !== '' && bodyEncoding === 'json') {
    try {
      JSON.parse(body);
    } catch {
      throw new ValidationError('body is not valid JSON', 'body');
    }
  }
  const auth = validateAuth(input, ctx);
  const config: HttpConfig = {
    url: url(input, 'url', ctx),
    method,
    headers,
    secretHeaders: sh.names,
    bodyEncoding,
    body,
    acceptedStatusCodes: statusCodes(input, 'acceptedStatusCodes', ['200-299']),
    maxRedirects: int(input, 'maxRedirects', { min: 0, max: member ? 10 : 20, def: 10 }),
    ignoreTls: bool(input, 'ignoreTls'),
    ipFamily: ipFamily(input),
    cacheBuster: bool(input, 'cacheBuster'),
    ...auth.config,
  };
  return { config, secrets: { ...sh.secrets, ...auth.secrets } };
}

/* -------------------------------------------------------------------- OAuth */

interface CachedToken {
  token: string;
  type: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();
const TOKEN_CACHE_MAX = 5000;

function tokenKey(uid: string, c: HttpAuthConfig, clientSecret: string): string {
  const h = createHash('sha256').update(JSON.stringify([c.oauthTokenUrl, c.oauthClientId, clientSecret, c.oauthScopes, c.oauthAudience, c.oauthAuthMethod])).digest('base64url');
  return `${uid}:${h}`;
}

/** Test hook. */
export function clearOAuthTokenCache(): void {
  tokenCache.clear();
}

async function oauthToken(ctx: CheckContext<HttpAuthConfig, HttpSecrets>, force: boolean): Promise<CachedToken> {
  const c = ctx.config;
  const clientSecret = ctx.secrets.oauthClientSecret ?? '';
  const key = tokenKey(ctx.monitorUid, c, clientSecret);
  const cached = tokenCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached;
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (c.oauthScopes) form.set('scope', c.oauthScopes);
  if (c.oauthAudience) form.set('audience', c.oauthAudience);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (c.oauthAuthMethod === 'client_secret_post') {
    form.set('client_id', c.oauthClientId);
    form.set('client_secret', clientSecret);
  } else {
    const enc = (s: string): string => encodeURIComponent(s).replace(/%20/g, '+');
    headers.authorization = `Basic ${Buffer.from(`${enc(c.oauthClientId)}:${enc(clientSecret)}`).toString('base64')}`;
  }
  let res: HttpResponse;
  try {
    res = await ctx.net.request({ url: c.oauthTokenUrl, method: 'POST', headers, body: form.toString(), maxRedirects: 0, maxBodyBytes: 64 * 1024, signal: ctx.signal });
  } catch (err) {
    if (err instanceof NetError && err.code !== 'ETIMEOUT' && err.code !== 'EABORT') throw new NetError('EOAUTH', `OAuth token request failed: ${err.message}`);
    throw err;
  }
  if (res.status !== 200) throw new NetError('EOAUTH', `OAuth token request failed (HTTP ${res.status})`);
  let parsed: { access_token?: unknown; token_type?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(res.body.toString('utf8')) as typeof parsed;
  } catch {
    throw new NetError('EOAUTH', 'OAuth token response is not JSON');
  }
  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0 || parsed.access_token.length > 16384 || /[\r\n]/.test(parsed.access_token)) {
    throw new NetError('EOAUTH', 'OAuth token response has no access_token');
  }
  const type = typeof parsed.token_type === 'string' && /^[A-Za-z-]{1,32}$/.test(parsed.token_type) ? parsed.token_type : 'Bearer';
  const expiresIn = typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in) ? parsed.expires_in : Number(parsed.expires_in) || 300;
  const tok: CachedToken = { token: parsed.access_token, type: type.toLowerCase() === 'bearer' ? 'Bearer' : type, expiresAt: Date.now() + Math.max(0, expiresIn - 30) * 1000 };
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value!);
  tokenCache.set(key, tok);
  return tok;
}

/* -------------------------------------------------------------------- check */

/** Headers incl. secret headers and authentication (explicit Authorization headers win). */
export async function buildAuthHeaders(ctx: CheckContext<HttpAuthConfig & { headers: Array<{ key: string; value: string }>; secretHeaders: string[] }, HttpSecrets>, forceToken = false): Promise<Record<string, string>> {
  const c = ctx.config;
  const h: Record<string, string> = {};
  for (const { key, value } of c.headers) h[key.toLowerCase()] = value;
  for (const name of c.secretHeaders) {
    const v = ctx.secrets[`secretHeaders.${name}`];
    if (v !== undefined) h[name.toLowerCase()] = v;
  }
  if (h.authorization === undefined) {
    if (c.authMethod === 'basic') {
      h.authorization = `Basic ${Buffer.from(`${c.basicUser}:${ctx.secrets.basicPassword ?? ''}`, 'utf8').toString('base64')}`;
    } else if (c.authMethod === 'bearer' && ctx.secrets.bearerToken) {
      h.authorization = `Bearer ${ctx.secrets.bearerToken}`;
    } else if (c.authMethod === 'oauth2') {
      const t = await oauthToken(ctx as CheckContext<HttpAuthConfig, HttpSecrets>, forceToken);
      h.authorization = `${t.type} ${t.token}`;
    }
  }
  return h;
}

export function clientCertOf(ctx: CheckContext<HttpAuthConfig, HttpSecrets>): { cert: string; key: string; ca?: string } | undefined {
  if (ctx.config.authMethod !== 'mtls' || !ctx.config.tlsCert || !ctx.secrets.tlsKey) return undefined;
  return { cert: ctx.config.tlsCert, key: ctx.secrets.tlsKey, ca: ctx.config.tlsCa || undefined };
}

/** Performs the configured request (OAuth refresh + one retry on 401). */
export async function performHttp(ctx: CheckContext<HttpConfig, HttpSecrets>, maxBodyBytes: number): Promise<HttpResponse> {
  const c = ctx.config;
  let target = c.url;
  if (c.cacheBuster) {
    const u = new URL(target);
    u.searchParams.set('ptr_uptime_cb', randomBytes(6).toString('hex'));
    target = u.toString();
  }
  const send = async (forceToken: boolean): Promise<HttpResponse> => {
    const headers = await buildAuthHeaders(ctx, forceToken);
    let body: string | undefined;
    if (c.body !== '' && c.method !== 'GET' && c.method !== 'HEAD') {
      body = c.body;
      if (headers['content-type'] === undefined) {
        headers['content-type'] = c.bodyEncoding === 'json' ? 'application/json' : c.bodyEncoding === 'form' ? 'application/x-www-form-urlencoded' : 'text/plain; charset=utf-8';
      }
    }
    return ctx.net.request({
      url: target,
      method: c.method,
      headers,
      body,
      maxRedirects: c.maxRedirects,
      ignoreTls: c.ignoreTls,
      family: familyNum(c.ipFamily),
      maxBodyBytes,
      signal: ctx.signal,
      clientCert: clientCertOf(ctx),
    });
  };
  const res = await send(false);
  if (res.status === 401 && c.authMethod === 'oauth2') return send(true);
  return res;
}

export function statusLine(res: HttpResponse): string {
  return `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
}

export function httpExtra(res: HttpResponse): Partial<CheckResult> {
  return {
    latencyMs: ms(res.timings.totalMs),
    tls: res.tls,
    meta: { httpStatus: res.status, redirects: res.redirects, remoteAddress: res.remoteAddress, ttfbMs: ms(res.timings.ttfbMs) },
  };
}

export function httpTarget(c: { url: string }): string | null {
  return c.url || null;
}

export function httpCertHost(c: { url: string }): string | null {
  try {
    const u = new URL(c.url);
    if (u.protocol !== 'https:' && u.protocol !== 'wss:') return null;
    return u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
  } catch {
    return null;
  }
}

export const httpChecker: CheckerDefinition<HttpConfig, HttpSecrets> = {
  type: 'http',
  label: 'HTTP(S)',
  description: 'Requests a URL and checks the status code.',
  category: 'web',
  fields: HTTP_FIELDS,
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate: validateHttp,
  check(ctx) {
    return guarded(ctx, async () => {
      // Only the status matters: read at most 64 KiB of the body.
      const res = await performHttp(ctx, Math.min(ctx.maxBodyBytes, 64 * 1024));
      const extra = httpExtra(res);
      if (!codeAccepted(res.status, ctx.config.acceptedStatusCodes)) return down(statusLine(res), extra);
      return up(`${statusLine(res)}${tlsSummary(res.tls)}`, extra);
    });
  },
  target: httpTarget,
  certHost: httpCertHost,
};
