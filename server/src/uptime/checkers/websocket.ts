// `websocket`: RFC 6455 opening handshake over a SafeNet connection (pinned IP, TLS for wss),
// verifies `101` + Sec-WebSocket-Accept (+ subprotocol), then sends a masked close frame.
import { createHash, randomBytes } from 'node:crypto';
import { ValidationError, type CheckerDefinition } from '../types.js';
import { SocketReader, tlsInfoOf, writeAll } from '../net/index.js';
import { HEADER_FIELDS, AUTH_FIELDS, buildAuthHeaders, clientCertOf, httpCertHost, validateAuth, type HttpAuthConfig } from './http.js';
import { IGNORE_TLS_FIELD, IP_FAMILY_FIELD, bool, down, familyNum, guarded, headerList, ipFamily, ms, secretHeaderList, str, up, url } from './common.js';

export interface WebsocketConfig extends HttpAuthConfig {
  url: string;
  subprotocol: string;
  headers: Array<{ key: string; value: string }>;
  secretHeaders: string[];
  ignoreTls: boolean;
  ignoreAcceptHeader: boolean;
  ipFamily: 'auto' | 'ipv4' | 'ipv6';
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const FORBID = ['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'];

export function acceptFor(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** Parses an HTTP/1.1 response head (status line + headers); null when malformed. */
export function parseResponseHead(head: string): { status: number; statusText: string; headers: Map<string, string> } | null {
  const lines = head.split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? '');
  if (!m) return null;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1, 101)) {
    if (line === '') continue;
    const i = line.indexOf(':');
    if (i <= 0) return null;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    headers.set(k, headers.has(k) ? `${headers.get(k)}, ${v}` : v);
  }
  return { status: Number(m[1]), statusText: (m[2] ?? '').slice(0, 100), headers };
}

export const websocketChecker: CheckerDefinition<WebsocketConfig, Record<string, string>> = {
  type: 'websocket',
  label: 'WebSocket',
  description: 'Performs a WebSocket opening handshake (HTTP Upgrade) and closes the connection.',
  category: 'web',
  fields: [
    { key: 'url', label: 'URL', kind: 'url', required: true, maxLength: 2048, placeholder: 'wss://example.com/socket', group: 'Request' },
    { key: 'subprotocol', label: 'Subprotocols', kind: 'text', maxLength: 255, group: 'Request', help: 'Comma separated (Sec-WebSocket-Protocol). The server must select one of them.' },
    ...HEADER_FIELDS,
    IGNORE_TLS_FIELD,
    { key: 'ignoreAcceptHeader', label: 'Ignore Sec-WebSocket-Accept', kind: 'boolean', default: false, group: 'Advanced', help: 'Accept servers that answer with a wrong accept key.' },
    IP_FAMILY_FIELD,
    ...AUTH_FIELDS,
  ],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 1 },
  hosted: 'allowed',
  validate(input, ctx) {
    const sub = str(input, 'subprotocol', { max: 255 });
    const protos = sub ? sub.split(',').map((s) => s.trim()) : [];
    if (protos.some((p) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(p))) throw new ValidationError('subprotocol must be a comma separated list of tokens', 'subprotocol');
    const headers = headerList(input, 'headers', { forbid: FORBID });
    const sh = secretHeaderList(input, 'secretHeaders', ctx, { forbid: FORBID });
    const auth = validateAuth(input, ctx);
    return {
      config: {
        url: url(input, 'url', ctx, { ws: true }),
        subprotocol: protos.join(', '),
        headers,
        secretHeaders: sh.names,
        ignoreTls: bool(input, 'ignoreTls'),
        ignoreAcceptHeader: bool(input, 'ignoreAcceptHeader'),
        ipFamily: ipFamily(input),
        ...auth.config,
      },
      secrets: { ...sh.secrets, ...auth.secrets },
    };
  },
  check(ctx) {
    return guarded(ctx, async () => {
      const c = ctx.config;
      const u = new URL(c.url);
      const secure = u.protocol === 'wss:' || u.protocol === 'https:';
      const hostname = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
      const portNum = u.port ? Number(u.port) : secure ? 443 : 80;
      const auth = await buildAuthHeaders(ctx);
      const cc = clientCertOf(ctx);
      const started = performance.now();
      const conn = await ctx.net.connect({
        host: hostname,
        port: portNum,
        family: familyNum(c.ipFamily),
        signal: ctx.signal,
        tls: secure ? { rejectUnauthorized: !c.ignoreTls, alpn: ['http/1.1'], cert: cc?.cert, key: cc?.key, ca: cc?.ca } : undefined,
      });
      const sock = conn.socket;
      const tls = secure ? tlsInfoOf(sock) : undefined;
      try {
        const key = randomBytes(16).toString('base64');
        const hostHeader = u.port ? `${u.hostname}:${u.port}` : u.hostname;
        const lines = [`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${hostHeader}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13'];
        if (c.subprotocol) lines.push(`Sec-WebSocket-Protocol: ${c.subprotocol}`);
        if (auth['user-agent'] === undefined) lines.push(`User-Agent: ${ctx.userAgent}`);
        for (const [k, v] of Object.entries(auth)) lines.push(`${k}: ${v}`);
        const reader = new SocketReader(sock, ctx.signal, 64 * 1024);
        await writeAll(sock, `${lines.join('\r\n')}\r\n\r\n`);
        const headLines: string[] = [];
        for (;;) {
          const line = await reader.readLine(8192);
          if (line === '') break;
          headLines.push(line);
          if (headLines.length > 101) return down('Invalid HTTP response (too many headers)', { tls });
        }
        const latencyMs = ms(performance.now() - started);
        const head = parseResponseHead(headLines.join('\r\n'));
        const extra = { latencyMs, tls, meta: { remoteAddress: conn.remoteAddress } };
        if (!head) return down('Invalid HTTP response', extra);
        if (head.status !== 101) return down(`Upgrade refused: ${head.status}${head.statusText ? ` ${head.statusText}` : ''}`, extra);
        if ((head.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return down('Invalid upgrade response (Upgrade header)', extra);
        if (!c.ignoreAcceptHeader && head.headers.get('sec-websocket-accept') !== acceptFor(key)) return down('Invalid Sec-WebSocket-Accept', extra);
        const chosen = head.headers.get('sec-websocket-protocol');
        if (c.subprotocol) {
          const offered = c.subprotocol.split(',').map((s) => s.trim());
          if (!chosen || !offered.includes(chosen)) return down('Server did not select an offered subprotocol', extra);
        } else if (chosen) {
          return down('Server selected a subprotocol that was not offered', extra);
        }
        // Masked close frame, status 1000.
        const mask = randomBytes(4);
        const payload = Buffer.from([0x03, 0xe8]);
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
        sock.write(Buffer.concat([Buffer.from([0x88, 0x80 | payload.length]), mask, payload]));
        return up(`101 Switching Protocols${chosen ? ` (${chosen.slice(0, 40)})` : ''}`, extra);
      } finally {
        setTimeout(() => sock.destroy(), 200).unref();
      }
    });
  },
  target: (c) => c.url,
  certHost: httpCertHost,
};
