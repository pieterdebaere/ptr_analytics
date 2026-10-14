// Single-datagram UDP exchanges (NTP, DNS) to a checked IP literal, plus the DNS query client.
import dgram from 'node:dgram';
import { randomInt } from 'node:crypto';
import { NetError, abortError } from './errors.js';
import { parseIp } from './ip.js';
import { DnsParseError, encodeQuery, normalizeQueryName, parseMessage, reverseName, RR_TYPES } from './dns-wire.js';
import { SocketReader, tcpConnect, guardSocket, mapSocketError } from './socket.js';

/**
 * Sends `payload` to address:port and resolves with the first datagram accepted by `accept`
 * (the socket is connected, so only datagrams from that address/port are delivered).
 */
export function udpExchange(
  address: string,
  family: 4 | 6,
  port: number,
  payload: Buffer,
  signal: AbortSignal,
  accept: (msg: Buffer) => boolean = () => true,
): Promise<{ data: Buffer; latencyMs: number }> {
  if (!parseIp(address)) return Promise.reject(new NetError('EINVAL', 'not an IP literal'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new NetError('EINVAL', 'invalid port'));
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: family === 6 ? 'udp6' : 'udp4', recvBufferSize: 70_000 });
    let started = 0;
    let done = false;
    const finish = (err: Error | null, data?: Buffer): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve({ data: data!, latencyMs: Math.round((performance.now() - started) * 10) / 10 });
    };
    const onAbort = (): void => finish(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    sock.on('error', (e) => finish(mapSocketError(e)));
    sock.on('message', (msg) => {
      if (accept(msg)) finish(null, msg);
    });
    sock.connect(port, address, () => {
      started = performance.now();
      sock.send(payload, (err) => {
        if (err) finish(mapSocketError(err));
      });
    });
  });
}

export interface DnsQueryResult {
  answers: Array<{ type: string; value: string; ttl: number }>;
  rcode: string;
  latencyMs: number;
}

/** DNS query over UDP to an (already checked) IP literal; retried over TCP when truncated. */
export async function dnsQueryTo(address: string, family: 4 | 6, port: number, nameInput: string, type: string, signal: AbortSignal): Promise<DnsQueryResult> {
  const t = type.toUpperCase();
  if (RR_TYPES[t] === undefined || t === 'OPT') throw new NetError('EINVAL', 'unsupported record type');
  let name: string | null;
  if (t === 'PTR' && parseIp(nameInput)) name = reverseName(nameInput);
  else name = normalizeQueryName(nameInput);
  if (!name) throw new NetError('EINVAL', 'invalid query name');
  const id = randomInt(0, 65536);
  const query = encodeQuery(id, name, t, { edns: 1232 });
  const started = performance.now();
  const isOurs = (msg: Buffer): boolean => {
    if (msg.length < 12 || msg.readUInt16BE(0) !== id) return false;
    try {
      const m = parseMessage(msg);
      return m.qr && m.question !== null && m.question.name.toLowerCase() === name && m.question.type === RR_TYPES[t];
    } catch {
      return false;
    }
  };
  const udp = await udpExchange(address, family, port, query, signal, (msg) => msg.length >= 12 && msg.readUInt16BE(0) === id);
  let msg = parseOrThrow(udp.data);
  if (!isOurs(udp.data)) throw new NetError('EDNSBAD', 'DNS response does not match the query');
  if (msg.tc) {
    const sock = await tcpConnect(address, family, port, signal);
    guardSocket(sock, signal);
    try {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(query.length, 0);
      sock.write(Buffer.concat([len, query]));
      const reader = new SocketReader(sock, signal, 70_000);
      const n = (await reader.read(2)).readUInt16BE(0);
      const data = await reader.read(n);
      if (!isOurs(data)) throw new NetError('EDNSBAD', 'DNS response does not match the query');
      msg = parseOrThrow(data);
    } finally {
      sock.destroy();
    }
  }
  return {
    answers: msg.answers.map((a) => ({ type: a.type, value: a.value, ttl: a.ttl })),
    rcode: msg.rcode,
    latencyMs: Math.round((performance.now() - started) * 10) / 10,
  };
}

function parseOrThrow(buf: Buffer): ReturnType<typeof parseMessage> {
  try {
    return parseMessage(buf);
  } catch (err) {
    if (err instanceof DnsParseError) throw new NetError('EDNSBAD', `malformed DNS response (${err.message})`);
    throw err;
  }
}
