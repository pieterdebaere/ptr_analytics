// Protocol checkers (dns, ping, smtp, ntp, redis, ssh, grpc_health, postgres, mysql, mongodb,
// mqtt) against tiny in-process fake servers.
import dgram from 'node:dgram';
import fs from 'node:fs';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECKERS } from '../src/uptime/checkers/registry.js';
import { toNtp } from '../src/uptime/checkers/ntp.js';
import { parseMessage } from '../src/uptime/net/dns-wire.js';
import { close, listen, opensslAvailable, runCheck, testCerts, testNet, uptimeConfig } from './uptime-net-fixtures.js';

const def = (t: string) => CHECKERS.get(t)!;

/** TCP server whose connection handler gets every socket; sockets are destroyed on close. */
function tcpServer(handler: (sock: net.Socket) => void): { server: net.Server; port: () => number; start: () => Promise<void>; stop: () => Promise<void> } {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    handler(s);
  });
  let p = 0;
  return {
    server,
    port: () => p,
    start: async () => {
      p = await listen(server);
    },
    stop: async () => {
      for (const s of sockets) s.destroy();
      await close(server);
    },
  };
}

/* --------------------------------------------------------------------- dns */

describe('dns', () => {
  const srv = dgram.createSocket('udp4');
  let port = 0;
  beforeAll(async () => {
    srv.on('message', (msg, rinfo) => {
      const q = parseMessage(msg);
      const name = q.question!.name;
      const qEnd = msg.indexOf(0, 12) + 5;
      const answers: Buffer[] = [];
      const rr = (type: number, rdata: Buffer): Buffer => {
        const h = Buffer.alloc(12);
        h.writeUInt16BE(0xc00c, 0);
        h.writeUInt16BE(type, 2);
        h.writeUInt16BE(1, 4);
        h.writeUInt32BE(60, 6);
        h.writeUInt16BE(rdata.length, 10);
        return Buffer.concat([h, rdata]);
      };
      if (name === 'example.test' && q.question!.type === 1) answers.push(rr(1, Buffer.from([192, 0, 2, 1])), rr(1, Buffer.from([192, 0, 2, 2])));
      if (name === 'example.test' && q.question!.type === 15) answers.push(rr(15, Buffer.concat([Buffer.from([0, 10]), Buffer.from([4]), Buffer.from('mail'), Buffer.from([0xc0, 0x0c])])));
      const hdr = Buffer.alloc(12);
      msg.copy(hdr, 0, 0, 2);
      hdr.writeUInt16BE(0x8180 | (name === 'gone.test' ? 3 : 0), 2);
      hdr.writeUInt16BE(1, 4);
      hdr.writeUInt16BE(answers.length, 6);
      srv.send(Buffer.concat([hdr, msg.subarray(12, qEnd), ...answers]), rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => srv.bind(0, '127.0.0.1', () => r()));
    port = srv.address().port;
  });
  afterAll(() => srv.close());

  it('queries the resolver and matches expected values', async () => {
    const baseIn = { host: 'example.test', resolver: '127.0.0.1', port };
    expect(await runCheck(def('dns'), baseIn)).toMatchObject({ status: 'up', msg: 'Records: 192.0.2.1 | 192.0.2.2' });
    expect((await runCheck(def('dns'), { ...baseIn, expected: ['192.0.2.2'] })).status).toBe('up');
    expect((await runCheck(def('dns'), { ...baseIn, expected: ['192.0.2.9'] })).status).toBe('down');
    expect((await runCheck(def('dns'), { ...baseIn, expected: ['192.0.2.1', '192.0.2.2'], matchMode: 'all' })).status).toBe('up');
    expect((await runCheck(def('dns'), { ...baseIn, expected: ['192.0.2.1', '192.0.2.3'], matchMode: 'all' })).msg).toMatch(/1 expected record/);
    expect((await runCheck(def('dns'), { ...baseIn, expected: ['192.0.2.1'], matchMode: 'none' })).status).toBe('down');
    expect((await runCheck(def('dns'), { ...baseIn, recordType: 'MX', expected: ['mail.example.test.'] })).status).toBe('up');
    expect((await runCheck(def('dns'), { ...baseIn, recordType: 'MX', expected: ['10 MAIL.example.test'] })).status).toBe('up');
    expect(await runCheck(def('dns'), { ...baseIn, recordType: 'AAAA' })).toMatchObject({ status: 'down', msg: 'No AAAA records' });
    expect(await runCheck(def('dns'), { ...baseIn, host: 'gone.test' })).toMatchObject({ status: 'down', msg: 'DNS NXDOMAIN' });
  });
});

/* -------------------------------------------------------------------- ping */

describe('ping', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ping-'));
  const bin = path.join(dir, 'fakeping');
  const argsFile = path.join(dir, 'args');
  beforeAll(() => {
    fs.writeFileSync(
      bin,
      `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
for last; do :; done
if [ "$last" = "127.0.0.2" ]; then
  echo "3 packets transmitted, 0 received, 100% packet loss, time 2000ms"; exit 1
fi
echo "PING $last ($last) 56(84) bytes of data."
echo "3 packets transmitted, 3 received, 0% packet loss, time 2003ms"
echo "rtt min/avg/max/mdev = 0.040/0.050/0.060/0.008 ms"
`,
      { mode: 0o755 },
    );
  });

  it('runs the binary with a checked IP literal and parses the RTT', async () => {
    const uptime = uptimeConfig({ UPTIME_PING_BINARY: bin });
    expect(def('ping').available!(uptime)).toBe(true);
    const r = await runCheck(def('ping'), { host: 'localhost', count: 3, ipFamily: 'ipv4' }, { uptime });
    expect(r).toMatchObject({ status: 'up', msg: '3/3 replies, avg 0.05 ms', latencyMs: 0 });
    expect(fs.readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual(['-n', '-c', '3', '-W', '2', '-s', '56', '127.0.0.1']);
    expect(await runCheck(def('ping'), { host: '127.0.0.2' }, { uptime })).toMatchObject({ status: 'down', msg: 'No reply (3 packets sent)' });
    const denied = await runCheck(def('ping'), { host: '127.0.0.1' }, { uptime, net: testNet({ UPTIME_PRIVATE_TARGETS: 'deny' }) });
    expect(denied).toMatchObject({ status: 'down', msg: 'target not allowed' });
    expect(await runCheck(def('ping'), { host: '127.0.0.1' }, { uptime: uptimeConfig({ UPTIME_PING_BINARY: '' }) })).toMatchObject({ status: 'down' });
  });
});

/* ------------------------------------------------------------- smtp (+tls) */

describe('smtp', () => {
  const srv = tcpServer((sock) => {
    let tlsSock: tls.TLSSocket | null = null;
    sock.write('220 mail.test ESMTP ready\r\n');
    let buf = '';
    const onLine = (line: string, out: net.Socket | tls.TLSSocket): void => {
      if (/^EHLO /.test(line)) out.write(`250-mail.test\r\n250-SIZE 1000\r\n${tlsSock ? '' : '250-STARTTLS\r\n'}250 HELP\r\n`);
      else if (line === 'STARTTLS') {
        out.write('220 go ahead\r\n');
        sock.removeAllListeners('data');
        const c = testCerts();
        tlsSock = new tls.TLSSocket(sock, { isServer: true, cert: c.selfCert, key: c.selfKey });
        tlsSock.on('error', () => {});
        let tb = '';
        tlsSock.on('data', (d: Buffer) => {
          tb += d.toString();
          let i;
          while ((i = tb.indexOf('\r\n')) >= 0) {
            const l = tb.slice(0, i);
            tb = tb.slice(i + 2);
            onLine(l, tlsSock!);
          }
        });
      } else if (line === 'QUIT') out.end('221 bye\r\n');
      else out.write('502 no\r\n');
    };
    sock.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(l, sock);
      }
    });
  });
  beforeAll(srv.start);
  afterAll(srv.stop);

  it('plain EHLO', async () => {
    expect(await runCheck(def('smtp'), { host: '127.0.0.1', port: srv.port(), security: 'plain' })).toMatchObject({ status: 'up', msg: 'SMTP ready' });
  });

  it.skipIf(!opensslAvailable())('STARTTLS with certificate capture', async () => {
    const strict = await runCheck(def('smtp'), { host: 'localhost', port: srv.port(), security: 'starttls' });
    expect(strict.status).toBe('down');
    expect(strict.tls?.valid).toBe(false);
    const r = await runCheck(def('smtp'), { host: 'localhost', port: srv.port(), security: 'starttls', ignoreTls: true });
    expect(r.status).toBe('up');
    expect(r.msg).toMatch(/^SMTP ready, STARTTLS, certificate expires in \d+ days$/);
    expect(r.tls?.subject).toContain('CN=localhost');
  });
});

/* --------------------------------------------------------------------- ntp */

describe('ntp', () => {
  const srv = dgram.createSocket('udp4');
  let port = 0;
  let mode: 'ok' | 'kod' | 'spoof' | 'stratum16' = 'ok';
  beforeAll(async () => {
    srv.on('message', (msg, rinfo) => {
      const res = Buffer.alloc(48);
      res[0] = (4 << 3) | 4;
      res[1] = mode === 'kod' ? 0 : mode === 'stratum16' ? 16 : 2;
      if (mode === 'kod') res.write('RATE', 12, 'latin1');
      msg.copy(res, 24, 40, 48);
      if (mode === 'spoof') res[24] = res[24]! ^ 0xff;
      const now = Date.now() + 250; // server clock 250 ms ahead
      toNtp(now, res, 32);
      toNtp(now, res, 40);
      srv.send(res, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => srv.bind(0, '127.0.0.1', () => r()));
    port = srv.address().port;
  });
  afterAll(() => srv.close());

  it('reports stratum and offset; validates replies', async () => {
    mode = 'ok';
    const r = await runCheck(def('ntp'), { host: '127.0.0.1', port });
    expect(r.status).toBe('up');
    expect(r.msg).toMatch(/^Stratum 2, offset 2\d\d\.\d ms/);
    expect((await runCheck(def('ntp'), { host: '127.0.0.1', port, maxOffsetMs: 100 })).msg).toMatch(/offset above 100 ms/);
    mode = 'kod';
    expect(await runCheck(def('ntp'), { host: '127.0.0.1', port })).toMatchObject({ status: 'down', msg: "Kiss-o'-Death: RATE" });
    mode = 'stratum16';
    expect((await runCheck(def('ntp'), { host: '127.0.0.1', port })).status).toBe('down');
    mode = 'spoof';
    expect(await runCheck(def('ntp'), { host: '127.0.0.1', port })).toMatchObject({ status: 'down', msg: 'NTP reply does not match the request' });
  });
});

/* ------------------------------------------------------------------- redis */

describe('redis', () => {
  let requirePass: string | null = null;
  const srv = tcpServer((sock) => {
    let authed = false;
    let buf = '';
    sock.on('data', (d: Buffer) => {
      buf += d.toString();
      // parse complete RESP arrays
      for (;;) {
        const m = /^\*(\d+)\r\n/.exec(buf);
        if (!m) return;
        let off = m[0].length;
        const args: string[] = [];
        for (let i = 0; i < Number(m[1]); i++) {
          const lm = /^\$(\d+)\r\n/.exec(buf.slice(off));
          if (!lm) return;
          off += lm[0].length;
          const len = Number(lm[1]);
          if (buf.length < off + len + 2) return;
          args.push(buf.slice(off, off + len));
          off += len + 2;
        }
        buf = buf.slice(off);
        const cmd = args[0]!.toUpperCase();
        if (cmd === 'AUTH') {
          authed = args[args.length - 1] === requirePass;
          sock.write(authed ? '+OK\r\n' : '-WRONGPASS invalid username-password pair\r\n');
        } else if (cmd === 'PING') sock.write(requirePass && !authed ? '-NOAUTH Authentication required.\r\n' : '+PONG\r\n');
        else if (cmd === 'QUIT') sock.end('+OK\r\n');
      }
    });
  });
  beforeAll(srv.start);
  afterAll(srv.stop);

  it('PING, AUTH and NOAUTH handling', async () => {
    requirePass = null;
    expect(await runCheck(def('redis'), { host: '127.0.0.1', port: srv.port() })).toMatchObject({ status: 'up', msg: 'PONG' });
    requirePass = 's3cret';
    expect(await runCheck(def('redis'), { host: '127.0.0.1', port: srv.port() })).toMatchObject({ status: 'up', msg: 'Server alive (authentication required)' });
    expect(await runCheck(def('redis'), { host: '127.0.0.1', port: srv.port(), password: 's3cret' })).toMatchObject({ status: 'up', msg: 'PONG' });
    expect(await runCheck(def('redis'), { host: '127.0.0.1', port: srv.port(), username: 'default', password: 's3cret' })).toMatchObject({ status: 'up' });
    const bad = await runCheck(def('redis'), { host: '127.0.0.1', port: srv.port(), password: 'wrong' });
    expect(bad).toMatchObject({ status: 'down', msg: 'Authentication failed (WRONGPASS)' });
  });
});

/* --------------------------------------------------------------------- ssh */

describe('ssh', () => {
  const srv = tcpServer((sock) => {
    sock.write('Pre-banner line\r\nSSH-2.0-OpenSSH_9.6p1 Ubuntu-3\r\n');
  });
  const bad = tcpServer((sock) => {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  beforeAll(async () => {
    await srv.start();
    await bad.start();
  });
  afterAll(async () => {
    await srv.stop();
    await bad.stop();
  });

  it('reads and checks the identification string', async () => {
    expect(await runCheck(def('ssh'), { host: '127.0.0.1', port: srv.port() })).toMatchObject({ status: 'up', msg: 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3' });
    expect((await runCheck(def('ssh'), { host: '127.0.0.1', port: srv.port(), expectedBanner: 'OpenSSH_9' })).status).toBe('up');
    expect((await runCheck(def('ssh'), { host: '127.0.0.1', port: srv.port(), expectedBanner: 'Dropbear' })).status).toBe('down');
    expect((await runCheck(def('ssh'), { host: '127.0.0.1', port: bad.port() })).status).toBe('down');
  });
});

/* ------------------------------------------------------------------- grpc */

function grpcHandler(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => {
    if (headers[':path'] !== '/grpc.health.v1.Health/Check') {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12' }, { endStream: true });
      return;
    }
    const body = Buffer.concat(chunks);
    const service = body.length > 7 ? body.subarray(7).toString() : '';
    if (service === 'unknown') {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '5', 'grpc-message': 'unknown%20service' }, { endStream: true });
      return;
    }
    const status = service === 'down' ? 2 : 1;
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end(Buffer.from([0, 0, 0, 0, 2, 0x08, status]));
  });
}

describe('grpc_health', () => {
  const h2c = http2.createServer();
  h2c.on('stream', grpcHandler);
  let port = 0;
  beforeAll(async () => {
    port = await listen(h2c as unknown as net.Server);
  });
  afterAll(async () => {
    await new Promise<void>((r) => h2c.close(() => r()));
  });

  it('plaintext h2c health checks', async () => {
    const baseIn = { host: '127.0.0.1', port, tls: false };
    expect(await runCheck(def('grpc_health'), baseIn)).toMatchObject({ status: 'up', msg: 'SERVING' });
    expect(await runCheck(def('grpc_health'), { ...baseIn, service: 'svc' })).toMatchObject({ status: 'up', msg: 'SERVING (svc)' });
    expect(await runCheck(def('grpc_health'), { ...baseIn, service: 'down' })).toMatchObject({ status: 'down', msg: 'NOT_SERVING' });
    expect(await runCheck(def('grpc_health'), { ...baseIn, service: 'unknown' })).toMatchObject({ status: 'down', msg: 'Service unknown (NOT_FOUND)' });
  });

  it.skipIf(!opensslAvailable())('TLS (ALPN h2) health check', async () => {
    const c = testCerts();
    const secure = http2.createSecureServer({ cert: c.selfCert, key: c.selfKey });
    secure.on('stream', grpcHandler);
    const sp = await listen(secure as unknown as net.Server);
    try {
      const r = await runCheck(def('grpc_health'), { host: 'localhost', port: sp, tls: true, ignoreTls: true });
      expect(r).toMatchObject({ status: 'up', msg: 'SERVING' });
      expect(r.tls?.subject).toContain('localhost');
      expect((await runCheck(def('grpc_health'), { host: 'localhost', port: sp, tls: true })).status).toBe('down');
    } finally {
      await new Promise<void>((r) => secure.close(() => r()));
    }
  });
});

/* --------------------------------------------------------------- postgres */

describe('postgres', () => {
  const pgMessage = (type: string, body: Buffer): Buffer => {
    const h = Buffer.alloc(5);
    h.write(type, 0, 'latin1');
    h.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([h, body]);
  };
  const handleStartup = (s: net.Socket | tls.TLSSocket, data: Buffer): void => {
    const user = data.subarray(8).toString().split('\0')[1];
    if (user === 'starting') s.write(pgMessage('E', Buffer.from('SFATAL\0C57P03\0Mthe database system is starting up\0\0')));
    else if (user === 'nobody') s.write(pgMessage('E', Buffer.from('SFATAL\0C28000\0Mno pg_hba.conf entry\0\0')));
    else {
      const b = Buffer.alloc(4);
      b.writeInt32BE(10);
      s.write(pgMessage('R', Buffer.concat([b, Buffer.from('SCRAM-SHA-256\0\0')])));
    }
  };
  const srv = tcpServer((sock) => {
    sock.once('data', (d: Buffer) => {
      if (d.length === 8 && d.readInt32BE(4) === 80877103) {
        if (!opensslAvailable()) {
          sock.write('N');
          return;
        }
        sock.write('S');
        const c = testCerts();
        const t = new tls.TLSSocket(sock, { isServer: true, cert: c.selfCert, key: c.selfKey });
        t.on('error', () => {});
        t.once('data', (sd: Buffer) => handleStartup(t, sd));
        return;
      }
      handleStartup(sock, d);
    });
  });
  beforeAll(srv.start);
  afterAll(srv.stop);

  it('handshake without credentials', async () => {
    expect(await runCheck(def('postgres'), { host: '127.0.0.1', port: srv.port() })).toMatchObject({ status: 'up', msg: 'PostgreSQL ready (SASL authentication requested)' });
    expect(await runCheck(def('postgres'), { host: '127.0.0.1', port: srv.port(), username: 'nobody' })).toMatchObject({ status: 'up', msg: 'PostgreSQL alive (error 28000)' });
    expect(await runCheck(def('postgres'), { host: '127.0.0.1', port: srv.port(), username: 'starting' })).toMatchObject({ status: 'down', msg: 'PostgreSQL not accepting connections (57P03)' });
  });

  it.skipIf(!opensslAvailable())('SSLRequest + TLS', async () => {
    const r = await runCheck(def('postgres'), { host: 'localhost', port: srv.port(), sslMode: 'require', ignoreTls: true });
    expect(r.status).toBe('up');
    expect(r.tls?.subject).toContain('localhost');
    expect((await runCheck(def('postgres'), { host: 'localhost', port: srv.port(), sslMode: 'require' })).status).toBe('down');
  });
});

/* ----------------------------------------------------------- mysql, mongo */

describe('mysql', () => {
  const packet = (seq: number, payload: Buffer): Buffer => Buffer.concat([Buffer.from([payload.length & 255, (payload.length >> 8) & 255, payload.length >> 16, seq]), payload]);
  const srv = tcpServer((sock) => {
    sock.write(packet(0, Buffer.concat([Buffer.from([10]), Buffer.from('8.0.36-ptr\0'), Buffer.alloc(40, 1)])));
  });
  const blocked = tcpServer((sock) => {
    const p = Buffer.concat([Buffer.from([0xff, 0x6a, 0x04]), Buffer.from("Host '1.2.3.4' is not allowed")]);
    sock.end(packet(0, p));
  });
  beforeAll(async () => {
    await srv.start();
    await blocked.start();
  });
  afterAll(async () => {
    await srv.stop();
    await blocked.stop();
  });
  it('reads the greeting', async () => {
    expect(await runCheck(def('mysql'), { host: '127.0.0.1', port: srv.port() })).toMatchObject({ status: 'up', msg: 'MySQL 8.0.36-ptr' });
    expect(await runCheck(def('mysql'), { host: '127.0.0.1', port: blocked.port() })).toMatchObject({ status: 'up', msg: 'Server alive (error 1130: host not allowed)' });
  });
});

describe('mongodb', () => {
  let ok = 1;
  const srv = tcpServer((sock) => {
    sock.once('data', (d: Buffer) => {
      const reqId = d.readInt32LE(4);
      // {ok: double, isWritablePrimary: bool, hosts: [..]}
      const el = (type: number, name: string, value: Buffer): Buffer => Buffer.concat([Buffer.from([type]), Buffer.from(name), Buffer.from([0]), value]);
      const dbl = Buffer.alloc(8);
      dbl.writeDoubleLE(ok);
      const arr = Buffer.from([5, 0, 0, 0, 0]);
      const elements = Buffer.concat([el(0x08, 'isWritablePrimary', Buffer.from([1])), el(0x04, 'hosts', arr), el(0x01, 'ok', dbl)]);
      const doc = Buffer.alloc(4 + elements.length + 1);
      doc.writeInt32LE(doc.length);
      elements.copy(doc, 4);
      const hdr = Buffer.alloc(21);
      hdr.writeInt32LE(21 + doc.length, 0);
      hdr.writeInt32LE(99, 4);
      hdr.writeInt32LE(reqId, 8);
      hdr.writeInt32LE(2013, 12);
      sock.write(Buffer.concat([hdr, doc]));
    });
  });
  beforeAll(srv.start);
  afterAll(srv.stop);
  it('hello handshake', async () => {
    ok = 1;
    expect(await runCheck(def('mongodb'), { host: '127.0.0.1', port: srv.port() })).toMatchObject({ status: 'up', msg: 'MongoDB ok (primary)' });
    ok = 0;
    expect((await runCheck(def('mongodb'), { host: '127.0.0.1', port: srv.port() })).status).toBe('down');
  });
});

/* -------------------------------------------------------------------- mqtt */

describe('mqtt', () => {
  const srv = tcpServer((sock) => {
    sock.once('data', (d: Buffer) => {
      expect(d[0]).toBe(0x10);
      const s = d.toString('latin1');
      const flags = d[9]!;
      const wantsAuth = (flags & 0xc0) === 0xc0;
      const rc = s.includes('locked') && !(wantsAuth && s.includes('opensesame')) ? 5 : 0;
      sock.write(Buffer.from([0x20, 0x02, 0x00, rc]));
    });
  });
  beforeAll(srv.start);
  afterAll(srv.stop);
  it('CONNECT / CONNACK', async () => {
    expect(await runCheck(def('mqtt'), { host: '127.0.0.1', port: srv.port() })).toMatchObject({ status: 'up', msg: 'CONNACK accepted' });
    expect(await runCheck(def('mqtt'), { host: '127.0.0.1', port: srv.port(), username: 'locked' })).toMatchObject({ status: 'down', msg: 'Connection refused: not authorized' });
    expect((await runCheck(def('mqtt'), { host: '127.0.0.1', port: srv.port(), username: 'locked', password: 'opensesame' })).status).toBe('up');
  });
});

describe('protocol failure modes', () => {
  it('garbage peers, closed ports, timeouts never throw', async () => {
    const garbage = tcpServer((s) => s.end(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xff, 0xff, 0xff, 0x7f, 1, 2, 3])));
    const silent = tcpServer(() => {});
    await garbage.start();
    await silent.start();
    try {
      for (const t of ['ssh', 'redis', 'mysql', 'mongodb', 'mqtt', 'postgres', 'smtp', 'grpc_health']) {
        const extra = t === 'grpc_health' ? { tls: false } : t === 'smtp' ? { security: 'plain' } : {};
        const g = await runCheck(def(t), { host: '127.0.0.1', port: garbage.port(), ...extra });
        expect(g.status, `${t} garbage`).toBe('down');
        expect(g.msg.length).toBeLessThanOrEqual(200);
        const s = await runCheck(def(t), { host: '127.0.0.1', port: silent.port(), ...extra }, { timeoutMs: 300 });
        expect(s, `${t} silent`).toMatchObject({ status: 'down', msg: 'Timeout after 300 ms' });
      }
    } finally {
      await garbage.stop();
      await silent.stop();
    }
  });
});
