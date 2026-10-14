import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { base32Decode, base32Encode, hotp, otpauthUrl, totp, verifyTotp } from '../src/auth/totp.js';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  api,
  cookieFrom,
  createCloudApp,
  createTestApp,
  makeFixtures,
  post,
  signupMember,
  tokenFromMail,
  type TestApp,
} from './helpers.js';

const RFC_KEY = Buffer.from('12345678901234567890');

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of vectors) {
      expect(totp(RFC_KEY, t * 1000, 8)).toBe(code);
      expect(totp(RFC_KEY, t * 1000)).toBe(code.slice(2));
    }
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, i) => expect(hotp(RFC_KEY, i)).toBe(code));
  });

  it('round-trips base32 and rejects garbage', () => {
    const buf = Buffer.from('12345678901234567890');
    expect(base32Encode(buf)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')?.equals(buf)).toBe(true);
    expect(base32Decode('GEZ1')).toBeNull();
    expect(base32Decode('')).toBeNull();
  });

  it('accepts ±1 step, rejects ±2 and replays', () => {
    const t = 1_800_000_000_000;
    const step = Math.floor(t / 30_000);
    const code = totp(RFC_KEY, t);
    expect(verifyTotp(RFC_KEY, code, t, 0)).toBe(step);
    expect(verifyTotp(RFC_KEY, code, t + 30_000, 0)).toBe(step);
    expect(verifyTotp(RFC_KEY, code, t - 30_000, 0)).toBe(step);
    expect(verifyTotp(RFC_KEY, code, t + 60_000, 0)).toBeNull();
    expect(verifyTotp(RFC_KEY, code, t - 60_000, 0)).toBeNull();
    // replay: the step was already used
    expect(verifyTotp(RFC_KEY, code, t, step)).toBeNull();
    // an older code after a newer one was accepted
    expect(verifyTotp(RFC_KEY, totp(RFC_KEY, t - 30_000), t, step)).toBeNull();
    expect(verifyTotp(RFC_KEY, '12345', t, 0)).toBeNull();
    expect(verifyTotp(RFC_KEY, 'abcdef', t, 0)).toBeNull();
  });

  it('builds an otpauth URL', () => {
    const url = otpauthUrl('JBSWY3DPEHPK3PXP', 'a+b@example.com', 'PTR Analytics');
    expect(url.startsWith('otpauth://totp/PTR%20Analytics:a%2Bb%40example.com?')).toBe(true);
    const q = new URL(url.replace('otpauth://', 'https://')).searchParams;
    expect(q.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(q.get('issuer')).toBe('PTR Analytics');
    expect(q.get('digits')).toBe('6');
    expect(q.get('period')).toBe('30');
  });
});

/* ------------------------------------------------------------------ helpers */

async function loginRaw(app: FastifyInstance, email = ADMIN_EMAIL, password = ADMIN_PASSWORD, ip = '203.0.113.9') {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-pa-request': '1' },
    remoteAddress: ip,
    payload: { email, password },
  });
}

function mfaLogin(app: FastifyInstance, payload: Record<string, unknown>, ip = '203.0.113.9') {
  return app.inject({ method: 'POST', url: '/api/auth/login/mfa', headers: { 'x-pa-request': '1' }, remoteAddress: ip, payload });
}

/** Enrol MFA for the session; returns the secret key and recovery codes. */
async function enrol(t: TestApp, cookie: string, password = ADMIN_PASSWORD): Promise<{ key: Buffer; recoveryCodes: string[] }> {
  const setup = await api(t.app, cookie, 'POST', '/api/auth/mfa/setup', { password });
  expect(setup.statusCode).toBe(200);
  const { secret, otpauthUrl: url } = setup.json() as { secret: string; otpauthUrl: string };
  expect(url).toContain(`secret=${secret}`);
  const key = base32Decode(secret) as Buffer;
  expect(key.length).toBe(20);
  const enable = await api(t.app, cookie, 'POST', '/api/auth/mfa/enable', { password, code: totp(key, t.clock.t) });
  expect(enable.statusCode).toBe(200);
  const { recoveryCodes } = enable.json() as { recoveryCodes: string[] };
  return { key, recoveryCodes };
}

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

async function adminCookie(): Promise<string> {
  const res = await loginRaw(t.app);
  expect(res.statusCode).toBe(200);
  return cookieFrom(res);
}

describe('MFA enrolment', () => {
  it('requires a valid code to enable and stores the secret encrypted', async () => {
    t = await createTestApp();
    const cookie = await adminCookie();
    expect((await api(t.app, cookie, 'GET', '/api/auth/mfa')).json()).toEqual({ enabled: false, pending: false, recoveryCodesLeft: 0, required: false });
    const setup = await api(t.app, cookie, 'POST', '/api/auth/mfa/setup', { password: ADMIN_PASSWORD });
    const { secret } = setup.json() as { secret: string };
    const row = t.ctx.db.prepare('SELECT totp_secret FROM user_mfa').get() as { totp_secret: Buffer };
    expect(row.totp_secret.includes(Buffer.from(secret))).toBe(false);
    expect((await api(t.app, cookie, 'GET', '/api/auth/mfa')).json()).toMatchObject({ enabled: false, pending: true });
    const bad = await api(t.app, cookie, 'POST', '/api/auth/mfa/enable', { password: ADMIN_PASSWORD, code: '000000' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'invalid_code' });
    const key = base32Decode(secret) as Buffer;
    const ok = await api(t.app, cookie, 'POST', '/api/auth/mfa/enable', { password: ADMIN_PASSWORD, code: totp(key, t.clock.t) });
    expect(ok.statusCode).toBe(200);
    const codes = (ok.json() as { recoveryCodes: string[] }).recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    // stored hashed only
    const stored = t.ctx.db.prepare('SELECT code_hash FROM user_recovery_codes').all() as Array<{ code_hash: string }>;
    expect(stored).toHaveLength(10);
    for (const s of stored) expect(codes.map((c) => c.replace(/-/g, ''))).not.toContain(s.code_hash);
    expect((await api(t.app, cookie, 'GET', '/api/auth/mfa')).json()).toMatchObject({ enabled: true, pending: false, recoveryCodesLeft: 10 });
    // no second setup while enabled
    expect((await api(t.app, cookie, 'POST', '/api/auth/mfa/setup', { password: ADMIN_PASSWORD })).statusCode).toBe(409);
  });

  it('revokes other sessions when MFA is enabled', async () => {
    t = await createTestApp();
    const a = await adminCookie();
    const b = await adminCookie();
    await enrol(t, a);
    expect((await api(t.app, a, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await api(t.app, b, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });
});

describe('MFA login flow', () => {
  it('needs the second factor before any session exists', async () => {
    t = await createTestApp();
    const { key } = await enrol(t, await adminCookie());
    t.clock.t += 60_000;
    const countSessions = (): number => (t.ctx.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get() as { n: number }).n;
    const before = countSessions();
    const first = await loginRaw(t.app);
    expect(first.statusCode).toBe(200);
    expect(first.headers['set-cookie']).toBeUndefined();
    const body = first.json() as { mfaRequired: boolean; mfaToken: string; user?: unknown };
    expect(body.mfaRequired).toBe(true);
    expect(body.user).toBeUndefined();
    expect(body.mfaToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(countSessions()).toBe(before);

    const wrong = await mfaLogin(t.app, { mfaToken: body.mfaToken, code: '000000' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const ok = await mfaLogin(t.app, { mfaToken: body.mfaToken, code: totp(key, t.clock.t) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { user: { email: string } }).user.email).toBe(ADMIN_EMAIL);
    const cookie = cookieFrom(ok);
    expect((await api(t.app, cookie, 'GET', '/api/auth/me')).statusCode).toBe(200);
  });

  it('rejects bypass attempts', async () => {
    t = await createTestApp();
    const cookie = await adminCookie();
    const { key } = await enrol(t, cookie);
    // another user with MFA
    const other = await api(t.app, cookie, 'POST', '/api/users', { email: 'other@example.com', password: 'other password 123', role: 'admin' });
    expect(other.statusCode).toBe(201);
    const otherLogin = await loginRaw(t.app, 'other@example.com', 'other password 123');
    const otherCookie = cookieFrom(otherLogin);
    const otherMfa = await enrol(t, otherCookie, 'other password 123');
    t.clock.t += 60_000;

    // 1. login/mfa without the password step: no token at all / forged token
    expect((await mfaLogin(t.app, { code: totp(key, t.clock.t) })).statusCode).toBe(400);
    expect((await mfaLogin(t.app, { mfaToken: 'A'.repeat(43), code: totp(key, t.clock.t) })).statusCode).toBe(401);
    // 2. a session-cookie value is not an mfaToken
    expect((await mfaLogin(t.app, { mfaToken: cookie.split('=')[1], code: totp(key, t.clock.t) })).statusCode).toBe(401);

    // 3. using user A's token with user B's code
    const a = (await loginRaw(t.app)).json() as { mfaToken: string };
    const cross = await mfaLogin(t.app, { mfaToken: a.mfaToken, code: totp(otherMfa.key, t.clock.t) });
    expect(cross.statusCode).toBe(401);
    // the token still belongs to A and logs in A only
    const ok = await mfaLogin(t.app, { mfaToken: a.mfaToken, code: totp(key, t.clock.t) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { user: { email: string } }).user.email).toBe(ADMIN_EMAIL);

    // 4. reusing the token
    t.clock.t += 30_000;
    expect((await mfaLogin(t.app, { mfaToken: a.mfaToken, code: totp(key, t.clock.t) })).statusCode).toBe(401);

    // 5. replaying the same code with a fresh token
    const b = (await loginRaw(t.app)).json() as { mfaToken: string };
    const code = totp(key, t.clock.t);
    expect((await mfaLogin(t.app, { mfaToken: b.mfaToken, code })).statusCode).toBe(200);
    const c = (await loginRaw(t.app)).json() as { mfaToken: string };
    expect((await mfaLogin(t.app, { mfaToken: c.mfaToken, code })).statusCode).toBe(401);

    // 6. expired token (5 minutes)
    const d = (await loginRaw(t.app)).json() as { mfaToken: string };
    t.clock.t += 5 * 60_000 + 1;
    const late = await mfaLogin(t.app, { mfaToken: d.mfaToken, code: totp(key, t.clock.t) });
    expect(late.statusCode).toBe(401);
    expect(late.json()).toMatchObject({ code: 'mfa_expired' });

    // 7. a wrong password never yields a token
    const wrongPw = await loginRaw(t.app, ADMIN_EMAIL, 'wrong password 123');
    expect(wrongPw.statusCode).toBe(401);
    expect(wrongPw.json()).not.toHaveProperty('mfaToken');
  });

  it('burns the token after 5 wrong codes and locks the second factor progressively', async () => {
    t = await createTestApp();
    const { key } = await enrol(t, await adminCookie());
    t.clock.t += 60_000;
    let n = 0;
    const token = async (): Promise<string> =>
      ((await loginRaw(t.app, ADMIN_EMAIL, ADMIN_PASSWORD, `203.0.113.${++n}`)).json() as { mfaToken: string }).mfaToken;
    const mfaToken = await token();
    for (let i = 0; i < 5; i++) expect((await mfaLogin(t.app, { mfaToken, code: '000000' }, `198.51.100.${i + 1}`)).statusCode).toBe(401);
    const after = await mfaLogin(t.app, { mfaToken, code: totp(key, t.clock.t) });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ code: 'mfa_expired' });
    // 5 consecutive failures lock the account's second factor (all tokens, all IPs) for 30 s …
    const t2 = await token();
    const locked = await mfaLogin(t.app, { mfaToken: t2, code: totp(key, t.clock.t) }, '198.51.100.99');
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ code: 'mfa_locked' });
    t.clock.t += 30_000;
    // … and every further failure doubles the lock (60 s now)
    expect((await mfaLogin(t.app, { mfaToken: t2, code: '000000' }, '198.51.100.98')).statusCode).toBe(401);
    t.clock.t += 30_000;
    expect((await mfaLogin(t.app, { mfaToken: t2, code: totp(key, t.clock.t) }, '198.51.100.97')).statusCode).toBe(429);
    t.clock.t += 30_001;
    expect((await mfaLogin(t.app, { mfaToken: t2, code: totp(key, t.clock.t) }, '198.51.100.96')).statusCode).toBe(200);
    // the success ended the streak
    const t3 = await token();
    expect((await mfaLogin(t.app, { mfaToken: t3, code: '000000' }, '198.51.100.95')).statusCode).toBe(401);
  });

  it('caps wrong codes per day; successful logins never reset that budget', async () => {
    t = await createTestApp();
    const { key } = await enrol(t, await adminCookie());
    let n = 0;
    const ip = (): string => `192.0.2.${++n}`;
    const token = async (): Promise<string> => ((await loginRaw(t.app, ADMIN_EMAIL, ADMIN_PASSWORD, ip())).json() as { mfaToken: string }).mfaToken;
    let failures = 0;
    // 4 wrong codes, then the owner signs in correctly (never 5 in a row, so no backoff lock)
    while (failures < 28) {
      t.clock.t += 30_000;
      const tok = await token();
      for (let i = 0; i < 4; i++, failures++) expect((await mfaLogin(t.app, { mfaToken: tok, code: '000000' }, ip())).statusCode).toBe(401);
      expect((await mfaLogin(t.app, { mfaToken: tok, code: totp(key, t.clock.t) }, ip())).statusCode).toBe(200);
    }
    t.clock.t += 30_000;
    const tok = await token();
    for (let i = 0; i < 2; i++) expect((await mfaLogin(t.app, { mfaToken: tok, code: '000000' }, ip())).statusCode).toBe(401);
    // 30 failures within 24 h: even the right code is refused until the window ends
    const capped = await mfaLogin(t.app, { mfaToken: await token(), code: totp(key, t.clock.t) }, ip());
    expect(capped.statusCode).toBe(429);
    t.clock.t += 24 * 3_600_000;
    expect((await mfaLogin(t.app, { mfaToken: await token(), code: totp(key, t.clock.t) }, ip())).statusCode).toBe(200);
  });

  it('limits MFA submissions per IP', async () => {
    t = await createTestApp();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await mfaLogin(t.app, { mfaToken: 'B'.repeat(43), code: '123456' }, '192.0.2.50')).statusCode;
    expect(last).toBe(429);
  });

  it('accepts each recovery code once', async () => {
    t = await createTestApp();
    const { recoveryCodes } = await enrol(t, await adminCookie());
    const code = recoveryCodes[0] as string;
    const { mfaToken } = (await loginRaw(t.app)).json() as { mfaToken: string };
    const ok = await mfaLogin(t.app, { mfaToken, recoveryCode: code.toUpperCase() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ recoveryCodesLeft: 9 });
    const { mfaToken: again } = (await loginRaw(t.app)).json() as { mfaToken: string };
    expect((await mfaLogin(t.app, { mfaToken: again, recoveryCode: code })).statusCode).toBe(401);
    // also accepted in the code field
    expect((await mfaLogin(t.app, { mfaToken: again, code: recoveryCodes[1] })).statusCode).toBe(200);
  });

  it('a password change invalidates outstanding challenges', async () => {
    t = await createTestApp();
    const cookie = await adminCookie();
    const { key } = await enrol(t, cookie);
    t.clock.t += 60_000;
    const { mfaToken } = (await loginRaw(t.app)).json() as { mfaToken: string };
    const ch = await api(t.app, cookie, 'POST', '/api/auth/password', { currentPassword: ADMIN_PASSWORD, newPassword: 'a brand new password' });
    expect(ch.statusCode).toBe(204);
    expect((await mfaLogin(t.app, { mfaToken, code: totp(key, t.clock.t) })).statusCode).toBe(401);
  });
});

describe('disabling MFA and recovery codes', () => {
  it('needs password and a current code', async () => {
    t = await createTestApp();
    const cookie = await adminCookie();
    const { key, recoveryCodes } = await enrol(t, cookie);
    t.clock.t += 60_000;
    expect((await api(t.app, cookie, 'POST', '/api/auth/mfa/disable', { password: ADMIN_PASSWORD })).statusCode).toBe(400);
    expect((await api(t.app, cookie, 'POST', '/api/auth/mfa/disable', { password: 'wrong password!!', code: totp(key, t.clock.t) })).statusCode).toBe(400);
    expect((await api(t.app, cookie, 'POST', '/api/auth/mfa/disable', { password: ADMIN_PASSWORD, code: '000000' })).statusCode).toBe(400);
    expect((await api(t.app, cookie, 'GET', '/api/auth/mfa')).json()).toMatchObject({ enabled: true });

    const regen = await api(t.app, cookie, 'POST', '/api/auth/mfa/recovery-codes', { password: ADMIN_PASSWORD, code: totp(key, t.clock.t) });
    expect(regen.statusCode).toBe(200);
    const fresh = (regen.json() as { recoveryCodes: string[] }).recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(recoveryCodes[0]);
    // old codes are gone
    const { mfaToken } = (await loginRaw(t.app)).json() as { mfaToken: string };
    expect((await mfaLogin(t.app, { mfaToken, recoveryCode: recoveryCodes[2] })).statusCode).toBe(401);

    const off = await api(t.app, cookie, 'POST', '/api/auth/mfa/disable', { password: ADMIN_PASSWORD, recoveryCode: fresh[0] });
    expect(off.statusCode).toBe(204);
    expect((await api(t.app, cookie, 'GET', '/api/auth/mfa')).json()).toMatchObject({ enabled: false, recoveryCodesLeft: 0 });
    expect((t.ctx.db.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes').get() as { n: number }).n).toBe(0);
    const plain = await loginRaw(t.app);
    expect(plain.json()).toHaveProperty('user');
  });
});

describe('REQUIRE_MFA_FOR_ADMINS', () => {
  it('blocks admins without MFA except the enrolment endpoints', async () => {
    t = await createTestApp({ env: { REQUIRE_MFA_FOR_ADMINS: 'true' } });
    const cookie = await adminCookie();
    const sites = await api(t.app, cookie, 'GET', '/api/sites');
    expect(sites.statusCode).toBe(403);
    expect(sites.json()).toEqual({ error: 'mfa_required', code: 'mfa_required' });
    expect((await api(t.app, cookie, 'POST', '/api/sites', { name: 'x', domains: ['x.com'] })).statusCode).toBe(403);
    const me = await api(t.app, cookie, 'GET', '/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ mfaEnabled: false, mfaSetupRequired: true });
    expect((await api(t.app, cookie, 'GET', '/api/auth/mfa')).json()).toMatchObject({ required: true });
    await enrol(t, cookie);
    expect((await api(t.app, cookie, 'GET', '/api/sites')).statusCode).toBe(200);
    expect((await api(t.app, cookie, 'GET', '/api/auth/me')).json()).toMatchObject({ mfaEnabled: true, mfaSetupRequired: false });
    // cannot switch it off again
    expect((await api(t.app, cookie, 'POST', '/api/auth/mfa/disable', { password: ADMIN_PASSWORD, code: '123456' })).statusCode).toBe(409);
  });
});

describe('hosted mode: e-mail flows never bypass MFA', () => {
  it('password reset keeps MFA and creates no session', async () => {
    const c = await createCloudApp();
    t = c;
    const email = 'member@example.org';
    const { cookie } = await signupMember(c, email);
    const { key } = await enrol(c, cookie, 'member password 123');
    const forgot = await post(c.app, '/api/auth/forgot', { email });
    expect(forgot.statusCode).toBe(202);
    await c.ctx.mailer?.idle();
    const token = tokenFromMail(c.mail.sent[c.mail.sent.length - 1], 'reset');
    const reset = await post(c.app, '/api/auth/reset', { token, password: 'reset password 456' });
    expect(reset.statusCode).toBe(204);
    expect(reset.headers['set-cookie']).toBeUndefined();
    expect((await api(c.app, cookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
    const login = await loginRaw(c.app, email, 'reset password 456');
    expect(login.statusCode).toBe(200);
    const body = login.json() as { mfaRequired?: boolean; mfaToken: string };
    expect(body.mfaRequired).toBe(true);
    expect(login.headers['set-cookie']).toBeUndefined();
    c.clock.t += 60_000;
    const ok = await mfaLogin(c.app, { mfaToken: body.mfaToken, code: totp(key, c.clock.t) });
    expect(ok.statusCode).toBe(200);
  });
});

describe('hosted mode: e-mail verification goes through the MFA gate', () => {
  it('answers with a challenge instead of a session when MFA is enabled', async () => {
    const c = await createCloudApp();
    t = c;
    const email = 'fresh@example.org';
    const password = 'member password 123';
    expect((await post(c.app, '/api/auth/signup', { email, password, acceptTerms: true })).statusCode).toBe(202);
    await c.ctx.mailer?.idle();
    const token = tokenFromMail(c.mail.sent[c.mail.sent.length - 1], 'verify');
    const user = c.ctx.users.byEmail(email);
    if (!user) throw new Error('no user');
    // e.g. enrolled earlier and the account was reset to unverified by an operator
    const secret = base32Encode(Buffer.from('abcdefghijklmnopqrst'));
    c.ctx.db
      .prepare('INSERT INTO user_mfa (user_id, totp_secret, enabled_at, last_step) VALUES (?, ?, ?, 0)')
      .run(user.id, c.ctx.secretBox().seal({ secret }, `mfa:${user.id}`), c.clock.t);
    const v = await post(c.app, '/api/auth/verify', { token, password });
    expect(v.statusCode).toBe(200);
    expect(v.headers['set-cookie']).toBeUndefined();
    const body = v.json() as { mfaRequired: boolean; mfaToken: string };
    expect(body.mfaRequired).toBe(true);
    const ok = await mfaLogin(c.app, { mfaToken: body.mfaToken, code: totp(Buffer.from('abcdefghijklmnopqrst'), c.clock.t) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['set-cookie']).toBeDefined();
  });
});

describe('cli mfa-reset', () => {
  it('removes MFA and signs the user out', async () => {
    const fixtures = makeFixtures();
    const dataDir = path.join(fixtures.root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const env = {
      DATA_DIR: dataDir,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      TRACKER_FILE: fixtures.trackerFile,
      DASHBOARD_DIR: fixtures.dashboardDir,
    };
    const clock = { t: Date.UTC(2026, 5, 15, 12) };
    const app = await buildApp(loadConfig(env), { logger: false, now: () => clock.t });
    t = { app, ctx: app.ctx, clock, fixtures };
    await enrol(t, await adminCookie());
    expect((t.ctx.db.prepare('SELECT COUNT(*) AS n FROM user_mfa').get() as { n: number }).n).toBe(1);
    await app.close();
    const out: string[] = [];
    await runCli(['mfa-reset', ADMIN_EMAIL], env, (s) => out.push(s));
    expect(out.join('\n')).toContain('Two-factor authentication removed');
    const app2 = await buildApp(loadConfig(env), { logger: false, now: () => clock.t });
    t = { app: app2, ctx: app2.ctx, clock, fixtures };
    expect((app2.ctx.db.prepare('SELECT COUNT(*) AS n FROM user_mfa').get() as { n: number }).n).toBe(0);
    expect((app2.ctx.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get() as { n: number }).n).toBe(0);
    expect((await loginRaw(app2)).json()).toHaveProperty('user');
  });
});
