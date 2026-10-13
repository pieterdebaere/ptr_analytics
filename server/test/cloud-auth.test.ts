import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { runCleanup } from '../src/jobs/cleanup.js';
import { sha256Hex } from '../src/lib/ids.js';
import { accountDeletedMail, escapeHtml, verifyEmailMail } from '../src/mail.js';
import {
  ADMIN_EMAIL,
  CLOUD_ENV,
  CLOUD_URL,
  DAY,
  HOUR,
  MIN,
  api,
  cookieFrom,
  createCloudApp,
  createTestApp,
  login,
  post,
  signupMember,
  tokenFromMail,
  type CloudTestApp,
} from './helpers.js';

let t: CloudTestApp;
afterEach(async () => {
  await t?.app.close();
});

const PASSWORD = 'member password 123';

describe('cloud configuration', () => {
  const base = { DATA_DIR: '/tmp/x' };
  it('is off by default', () => {
    const c = loadConfig(base).cloud;
    expect(c).toMatchObject({ signupEnabled: false, billingEnabled: false, memberSiteLimit: 10, freeSites: 1, pricePerSiteCents: 100, priceCurrency: 'eur' });
  });

  it('fails fast on incomplete combinations without echoing secrets', () => {
    expect(() => loadConfig({ ...base, SIGNUP_ENABLED: 'true' })).toThrow(/SMTP_URL, MAIL_FROM, PUBLIC_URL/);
    expect(() => loadConfig({ ...base, ...CLOUD_ENV, PUBLIC_URL: '' })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ ...base, ...CLOUD_ENV, BILLING_ENABLED: 'true' })).toThrow(/STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID/);
    expect(() => loadConfig({ ...base, BILLING_ENABLED: 'true' })).toThrow(/requires SIGNUP_ENABLED/);
    const billing = { ...base, ...CLOUD_ENV, BILLING_ENABLED: 'true', STRIPE_WEBHOOK_SECRET: 'whsec_abcdefgh123', STRIPE_PRICE_ID: 'price_abc123' };
    for (const [key, value] of [
      ['STRIPE_SECRET_KEY', 'pk_test_notasecretkey123'],
      ['STRIPE_WEBHOOK_SECRET', 'secret-without-prefix-123'],
      ['STRIPE_PRICE_ID', 'prod_abc123'],
    ] as const) {
      const env = { STRIPE_SECRET_KEY: 'sk_test_abcdefgh123', ...billing, [key]: value };
      let err: unknown;
      try {
        loadConfig(env);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect(String(err)).not.toContain(value);
    }
    expect(loadConfig({ ...billing, STRIPE_SECRET_KEY: 'rk_live_abcdefgh123' }).cloud.billingEnabled).toBe(true);
    let smtpErr: unknown;
    try {
      loadConfig({ ...base, ...CLOUD_ENV, SMTP_URL: 'http://user:topsecretpw@mail.example.com' });
    } catch (e) {
      smtpErr = e;
    }
    expect(String(smtpErr)).toMatch(/smtp/);
    expect(String(smtpErr)).not.toContain('topsecretpw');
    expect(() => loadConfig({ ...base, ...CLOUD_ENV, MAIL_FROM: 'x <bad\r\nBcc: a@b.c>' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TERMS_URL: 'javascript:alert(1)' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PRICE_CURRENCY: 'euro' })).toThrow(ConfigError);
  });
});

describe('mail templates', () => {
  it('escapes interpolations in HTML and has a plain text part', () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe('&#60;a href=&#34;x&#34;&#62;&#39;&#38;');
    const m = verifyEmailMail('https://a.example/verify?token=abc&x="<script>');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&#60;script&#62;');
    expect(m.text).toContain('https://a.example/verify?token=abc&x="<script>');
    expect(accountDeletedMail().text).toMatch(/deleted/);
  });
});

describe('self-hosted mode is unchanged', () => {
  it('has no sign-up endpoints and reports cloud features off', async () => {
    t = { ...(await createTestApp()), mail: { sent: [], transport: { send: async () => {} } }, stripe: null as never };
    expect(t.ctx.mailer).toBeNull();
    for (const url of ['/api/auth/signup', '/api/auth/verify', '/api/auth/forgot', '/api/auth/reset']) {
      expect((await post(t.app, url, { email: 'a@b.co', password: PASSWORD, token: 'x' })).statusCode, url).toBe(404);
    }
    const pc = await t.app.inject({ method: 'GET', url: '/api/public-config' });
    expect(pc.statusCode).toBe(200);
    expect(pc.json()).toMatchObject({ signupEnabled: false, billingEnabled: false });
    const cookie = await login(t.app);
    expect((await api(t.app, cookie, 'POST', '/api/billing/checkout', { paidSites: 1 })).statusCode).toBe(404);
    expect((await api(t.app, cookie, 'GET', '/api/billing')).statusCode).toBe(403);
    expect((await post(t.app, '/api/billing/webhook', {})).statusCode).toBe(404);
  });
});

describe('sign-up and verification', () => {
  it('public config exposes the hosted settings', async () => {
    t = await createCloudApp({ env: { TERMS_URL: 'https://example.com/terms', PRIVACY_URL: 'https://example.com/privacy' } });
    const res = await t.app.inject({ method: 'GET', url: '/api/public-config' });
    expect(res.json()).toEqual({
      signupEnabled: true,
      billingEnabled: false,
      freeSites: 1,
      memberSiteLimit: 10,
      pricePerSiteCents: 100,
      currency: 'eur',
      termsUrl: 'https://example.com/terms',
      privacyUrl: 'https://example.com/privacy',
    });
  });

  it('signs up an unverified member, mails a single-use link, verifies with the password and logs in', async () => {
    t = await createCloudApp();
    const res = await post(t.app, '/api/auth/signup', { email: '  New@Example.com ', password: PASSWORD, acceptTerms: true });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['set-cookie']).toBeUndefined();
    const user = t.ctx.users.byEmail('new@example.com');
    expect(user).toMatchObject({ role: 'member', emailVerified: false });

    await t.ctx.mailer?.idle();
    expect(t.mail.sent).toHaveLength(1);
    const mail = t.mail.sent[0]!;
    expect(mail.to).toBe('new@example.com');
    expect(mail.from).toBe(CLOUD_ENV['MAIL_FROM']);
    expect(mail.subject).toMatch(/Confirm/);
    const token = tokenFromMail(mail, 'verify');
    // the token travels in the URL fragment (never sent to servers, logs or Referer)
    expect(mail.html).toContain(`${CLOUD_URL}/verify#token=${token}`);
    expect(mail.text).not.toContain('?token=');
    // only the hash is stored
    const row = t.ctx.db.prepare('SELECT token_hash, purpose, expires_at FROM user_tokens').get() as Record<string, unknown>;
    expect(row).toEqual({ token_hash: sha256Hex(token), purpose: 'verify', expires_at: t.clock.t + DAY });

    // the link alone is not enough: the password chosen at sign-up is required
    expect((await post(t.app, '/api/auth/verify', { token })).statusCode).toBe(400);
    const wrong = await post(t.app, '/api/auth/verify', { token, password: 'wrong password 123' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: 'this link is invalid or has expired' });
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect(t.ctx.users.byEmail('new@example.com')?.emailVerified).toBe(false);

    // a wrong password did not use up the link
    const v = await post(t.app, '/api/auth/verify', { token, password: PASSWORD });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ user: { email: 'new@example.com', role: 'member', emailVerified: true } });
    const cookie = cookieFrom(v);
    expect(cookie).toMatch(/^__Host-pa_session=/);
    expect((await api(t.app, cookie, 'GET', '/api/auth/me')).json()).toMatchObject({ user: { emailVerified: true } });
    // single use
    expect((await post(t.app, '/api/auth/verify', { token, password: PASSWORD })).statusCode).toBe(400);
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM user_tokens').get()).toEqual({ n: 0 });
    expect((await post(t.app, '/api/auth/login', { email: 'new@example.com', password: PASSWORD })).statusCode).toBe(200);
  });

  it('unverified login answers exactly like a wrong password and re-sends the verification mail (rate limited)', async () => {
    t = await createCloudApp();
    await post(t.app, '/api/auth/signup', { email: 'pending@example.com', password: PASSWORD });
    await t.ctx.mailer?.idle();
    expect(t.mail.sent).toHaveLength(1);
    const right = await post(t.app, '/api/auth/login', { email: 'pending@example.com', password: PASSWORD });
    const wrong = await post(t.app, '/api/auth/login', { email: 'pending@example.com', password: 'wrong password 123' });
    const unknown = await post(t.app, '/api/auth/login', { email: 'nobody@example.com', password: PASSWORD });
    for (const r of [right, wrong, unknown]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'invalid email or password' });
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect(Object.keys(right.headers).sort()).toEqual(Object.keys(wrong.headers).sort());
    await t.ctx.mailer?.idle();
    // the correct password re-sent the verification mail; the wrong one did not
    expect(t.mail.sent).toHaveLength(2);
    const resent = tokenFromMail(t.mail.sent[1], 'verify');
    // the first link still works too (several links may be outstanding)
    expect(t.ctx.userTokens.peek(tokenFromMail(t.mail.sent[0], 'verify'), 'verify', t.clock.t)).not.toBeNull();
    // at most once per 10 minutes ...
    await post(t.app, '/api/auth/login', { email: 'pending@example.com', password: PASSWORD });
    await t.ctx.mailer?.idle();
    expect(t.mail.sent).toHaveLength(2);
    // ... and 3 times per day
    for (let i = 0; i < 4; i++) {
      t.clock.t += 11 * MIN;
      await post(t.app, '/api/auth/login', { email: 'pending@example.com', password: PASSWORD });
    }
    await t.ctx.mailer?.idle();
    expect(t.mail.sent).toHaveLength(4);
    // only the newest 3 links are kept
    expect(t.ctx.userTokens.peek(tokenFromMail(t.mail.sent[0], 'verify'), 'verify', t.clock.t)).toBeNull();
    expect((await post(t.app, '/api/auth/verify', { token: resent, password: PASSWORD })).statusCode).toBe(200);
  });

  it('a verification link cannot activate or log into an account whose password the clicker does not know', async () => {
    t = await createCloudApp();
    // Pre-registration: the attacker signs up the victim's address with a password they know.
    await post(t.app, '/api/auth/signup', { email: 'victim@example.com', password: 'attacker password 1' }, '203.0.113.60');
    await t.ctx.mailer?.idle();
    const victimLink = tokenFromMail(t.mail.sent[0], 'verify');
    // The victim clicks the genuine mail and enters their own password: nothing happens.
    const res = await post(t.app, '/api/auth/verify', { token: victimLink, password: 'victim password 12' }, '198.51.100.9');
    expect(res.statusCode).toBe(400);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(t.ctx.users.byEmail('victim@example.com')?.emailVerified).toBe(false);
    // The attacker still cannot log in (unverified looks like a wrong password).
    expect((await post(t.app, '/api/auth/login', { email: 'victim@example.com', password: 'attacker password 1' }, '203.0.113.60')).statusCode).toBe(401);

    // Login CSRF: the attacker's own verification link sent to someone else is useless without the password.
    await post(t.app, '/api/auth/signup', { email: 'attacker@example.com', password: 'attacker password 1' }, '203.0.113.61');
    await t.ctx.mailer?.idle();
    const attackerLink = tokenFromMail(t.mail.sent.find((m) => m.to === 'attacker@example.com'), 'verify');
    const csrf = await post(t.app, '/api/auth/verify', { token: attackerLink, password: 'victim password 12' }, '198.51.100.9');
    expect(csrf.statusCode).toBe(400);
    expect(csrf.headers['set-cookie']).toBeUndefined();
  });

  it('password checks on verify go through the login rate limits; every submission counts per IP', async () => {
    t = await createCloudApp();
    await post(t.app, '/api/auth/signup', { email: 'brute@example.com', password: PASSWORD });
    await t.ctx.mailer?.idle();
    const token = tokenFromMail(t.mail.sent[0], 'verify');
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(t.app, '/api/auth/verify', { token, password: `guess number ${i}xx` }, '192.0.2.10')).statusCode);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(codes[10]).toBe(429);
    // even the right password is refused while limited
    expect((await post(t.app, '/api/auth/verify', { token, password: PASSWORD }, '192.0.2.10')).statusCode).toBe(429);
    expect((await post(t.app, '/api/auth/verify', { token, password: PASSWORD }, '192.0.2.11')).statusCode).toBe(200);
  });

  it('rejects expired, malformed and wrong-purpose tokens', async () => {
    t = await createCloudApp();
    await post(t.app, '/api/auth/signup', { email: 'late@example.com', password: PASSWORD });
    await t.ctx.mailer?.idle();
    const token = tokenFromMail(t.mail.sent[0], 'verify');
    for (const bad of ['', 'x', 'A'.repeat(43), 42, null, token + 'A']) {
      expect((await post(t.app, '/api/auth/verify', { token: bad, password: PASSWORD })).statusCode).toBe(400);
    }
    // a verify token cannot reset a password
    expect((await post(t.app, '/api/auth/reset', { token, password: 'another password 1' })).statusCode).toBe(400);
    t.clock.t += DAY + 1;
    expect((await post(t.app, '/api/auth/verify', { token, password: PASSWORD })).json()).toEqual({ error: 'this link is invalid or has expired' });
  });

  it('requires acceptTerms when terms are configured and validates input', async () => {
    t = await createCloudApp({ env: { TERMS_URL: 'https://example.com/terms' } });
    expect((await post(t.app, '/api/auth/signup', { email: 'a@example.com', password: PASSWORD })).statusCode).toBe(400);
    expect((await post(t.app, '/api/auth/signup', { email: 'a@example.com', password: PASSWORD, acceptTerms: 'true' })).statusCode).toBe(400);
    expect((await post(t.app, '/api/auth/signup', { email: 'a@example', password: PASSWORD, acceptTerms: true })).statusCode).toBe(400);
    expect((await post(t.app, '/api/auth/signup', { email: 'a@example.com', password: 'short', acceptTerms: true })).statusCode).toBe(400);
    expect((await post(t.app, '/api/auth/signup', { email: 'a‮@example.com', password: PASSWORD, acceptTerms: true })).statusCode).toBe(400);
    expect((await post(t.app, '/api/auth/signup', { email: 'a@example.com', password: PASSWORD, acceptTerms: true })).statusCode).toBe(202);
    // CSRF rules unchanged
    const noHeader = await t.app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'b@example.com', password: PASSWORD, acceptTerms: true } });
    expect(noHeader.statusCode).toBe(403);
  });

  it('does not reveal existing accounts: same response, "already registered" mail, no takeover', async () => {
    t = await createCloudApp();
    const victim = await signupMember(t, 'victim@example.com');
    const attackerPassword = 'attacker password 1';
    const res = await post(t.app, '/api/auth/signup', { email: 'VICTIM@example.com', password: attackerPassword, acceptTerms: true }, '203.0.113.50');
    const fresh = await post(t.app, '/api/auth/signup', { email: 'nobody@example.com', password: attackerPassword, acceptTerms: true }, '203.0.113.50');
    expect(res.statusCode).toBe(fresh.statusCode);
    expect(res.body).toBe(fresh.body);
    expect(Object.keys(res.headers).sort()).toEqual(Object.keys(fresh.headers).sort());
    await t.ctx.mailer?.idle();
    const already = t.mail.sent.find((m) => m.to === 'victim@example.com' && /already/.test(m.subject));
    expect(already).toBeDefined();
    expect(already!.text).not.toContain('/verify');
    tokenFromMail(already, 'reset');
    // the existing account is untouched
    expect((await post(t.app, '/api/auth/login', { email: 'victim@example.com', password: attackerPassword })).statusCode).toBe(401);
    expect((await api(t.app, victim.cookie, 'GET', '/api/auth/me')).statusCode).toBe(200);
    // admin addresses too, but operator accounts never get a reset link by mail
    expect((await post(t.app, '/api/auth/signup', { email: ADMIN_EMAIL, password: attackerPassword }, '203.0.113.51')).statusCode).toBe(202);
    expect(t.ctx.users.byEmail(ADMIN_EMAIL)?.role).toBe('admin');
    await t.ctx.mailer?.idle();
    const operatorMail = t.mail.sent.find((m) => m.to === ADMIN_EMAIL);
    expect(operatorMail?.subject).toMatch(/already/);
    expect(operatorMail?.text).not.toContain('token=');
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM user_tokens WHERE user_id = ?').get(t.ctx.users.byEmail(ADMIN_EMAIL)!.id)).toEqual({ n: 0 });
  });

  it('pre-registration by someone else is defused by the owner resetting the password', async () => {
    t = await createCloudApp();
    // attacker registers the victim's address (cannot verify it)
    await post(t.app, '/api/auth/signup', { email: 'owner@example.com', password: 'attacker password 1' }, '203.0.113.60');
    // the real owner signs up later: gets a reset link, never a verify link for that account
    await post(t.app, '/api/auth/signup', { email: 'owner@example.com', password: 'owner password 123' }, '203.0.113.61');
    await t.ctx.mailer?.idle();
    const reset = tokenFromMail(t.mail.sent[1], 'reset');
    expect((await post(t.app, '/api/auth/reset', { token: reset, password: 'owner password 123' })).statusCode).toBe(204);
    expect(t.ctx.users.byEmail('owner@example.com')?.emailVerified).toBe(true);
    // the attacker's password and the original verify link are dead
    expect((await post(t.app, '/api/auth/login', { email: 'owner@example.com', password: 'attacker password 1' })).statusCode).toBe(401);
    expect((await post(t.app, '/api/auth/verify', { token: tokenFromMail(t.mail.sent[0], 'verify'), password: 'attacker password 1' })).statusCode).toBe(400);
    expect((await post(t.app, '/api/auth/login', { email: 'owner@example.com', password: 'owner password 123' })).statusCode).toBe(200);
  });

  it('rate limits sign-ups per IP and per email', async () => {
    t = await createCloudApp();
    for (let i = 0; i < 3; i++) {
      expect((await post(t.app, '/api/auth/signup', { email: 'spam@example.com', password: PASSWORD }, `192.0.2.${i + 1}`)).statusCode).toBe(202);
    }
    expect((await post(t.app, '/api/auth/signup', { email: 'spam@example.com', password: PASSWORD }, '192.0.2.99')).statusCode).toBe(429);
    for (let i = 0; i < 10; i++) {
      expect((await post(t.app, '/api/auth/signup', { email: `u${i}@example.com`, password: PASSWORD }, '192.0.2.200')).statusCode).toBe(202);
    }
    expect((await post(t.app, '/api/auth/signup', { email: 'u99@example.com', password: PASSWORD }, '192.0.2.200')).statusCode).toBe(429);
    t.clock.t += HOUR;
    expect((await post(t.app, '/api/auth/signup', { email: 'u99@example.com', password: PASSWORD }, '192.0.2.200')).statusCode).toBe(202);
    await t.ctx.mailer?.idle();
    expect(t.mail.sent.filter((m) => m.to === 'spam@example.com')).toHaveLength(3);
  });

  it('purges expired tokens and stale unverified sign-ups', async () => {
    t = await createCloudApp();
    await post(t.app, '/api/auth/signup', { email: 'stale@example.com', password: PASSWORD });
    await signupMember(t, 'kept@example.com');
    t.clock.t += 8 * DAY;
    const r = await runCleanup(t.ctx);
    expect(r.userTokens).toBe(1);
    expect(r.unverifiedUsers).toBe(1);
    expect(t.ctx.users.byEmail('stale@example.com')).toBeNull();
    expect(t.ctx.users.byEmail('kept@example.com')).not.toBeNull();
    expect(t.ctx.users.byEmail(ADMIN_EMAIL)).not.toBeNull();
  });
});

describe('password reset', () => {
  it('always answers 202, mails a 1 h single-use link and signs out every session', async () => {
    t = await createCloudApp();
    const m = await signupMember(t, 'forgot@example.com');
    const second = await login(t.app, 'forgot@example.com', PASSWORD);
    const unknown = await post(t.app, '/api/auth/forgot', { email: 'nobody@example.com' });
    const known = await post(t.app, '/api/auth/forgot', { email: 'Forgot@example.com' });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
    await t.ctx.mailer?.idle();
    expect(t.mail.sent.filter((x) => x.to === 'nobody@example.com')).toHaveLength(0);
    const token = tokenFromMail(t.mail.sent[t.mail.sent.length - 1], 'reset');
    expect((await post(t.app, '/api/auth/reset', { token, password: 'short' })).statusCode).toBe(400);
    expect((await post(t.app, '/api/auth/reset', { token, password: 'brand new password' })).statusCode).toBe(204);
    expect((await post(t.app, '/api/auth/reset', { token, password: 'brand new password' })).statusCode).toBe(400);
    expect((await api(t.app, m.cookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await api(t.app, second, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await post(t.app, '/api/auth/login', { email: 'forgot@example.com', password: 'brand new password' })).statusCode).toBe(200);
  });

  it('keeps up to 3 outstanding reset links (a third party cannot void the owner\'s link); all die on reset', async () => {
    t = await createCloudApp();
    await signupMember(t, 'exp@example.com');
    for (let i = 0; i < 4; i++) {
      t.clock.t += 1000;
      await post(t.app, '/api/auth/forgot', { email: 'exp@example.com' }, `192.0.2.${i + 1}`);
      if (i === 2) t.ctx.limits.forgotEmail.reset('exp@example.com');
    }
    await t.ctx.mailer?.idle();
    const links = t.mail.sent.filter((m) => /Reset/.test(m.subject)).map((m) => tokenFromMail(m, 'reset'));
    expect(links).toHaveLength(4);
    // the oldest is dropped beyond 3; the others are all still valid
    expect(t.ctx.userTokens.peek(links[0], 'reset', t.clock.t)).toBeNull();
    for (const l of links.slice(1)) expect(t.ctx.userTokens.peek(l, 'reset', t.clock.t)).not.toBeNull();
    expect((await post(t.app, '/api/auth/reset', { token: links[1], password: 'brand new password' })).statusCode).toBe(204);
    // every other link died with the successful reset
    for (const l of links) expect((await post(t.app, '/api/auth/reset', { token: l, password: 'another password 12' })).statusCode).toBe(400);
  });

  it('expires reset links after 1 hour', async () => {
    t = await createCloudApp();
    await signupMember(t, 'exp@example.com');
    await post(t.app, '/api/auth/forgot', { email: 'exp@example.com' });
    await t.ctx.mailer?.idle();
    const latest = tokenFromMail(t.mail.sent[t.mail.sent.length - 1], 'reset');
    t.clock.t += HOUR + 1;
    expect((await post(t.app, '/api/auth/reset', { token: latest, password: 'brand new password' })).statusCode).toBe(400);
  });

  it('never resets operator accounts by mail: same 202, nothing sent, operator tokens refused', async () => {
    t = await createCloudApp();
    const res = await post(t.app, '/api/auth/forgot', { email: ADMIN_EMAIL });
    const unknown = await post(t.app, '/api/auth/forgot', { email: 'nobody@example.com' });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe(unknown.body);
    await t.ctx.mailer?.idle();
    expect(t.mail.sent).toHaveLength(0);
    // even a token that exists (e.g. issued before the account became an admin) is refused
    const admin = t.ctx.users.byEmail(ADMIN_EMAIL)!;
    const token = t.ctx.userTokens.issue(admin.id, 'reset', t.clock.t);
    expect((await post(t.app, '/api/auth/reset', { token, password: 'hijacked password 1' })).statusCode).toBe(400);
    expect((await post(t.app, '/api/auth/login', { email: ADMIN_EMAIL, password: 'correct horse battery' })).statusCode).toBe(200);
  });

  it('rate limits forgot-password per email and token guesses per IP', async () => {
    t = await createCloudApp();
    for (let i = 0; i < 3; i++) expect((await post(t.app, '/api/auth/forgot', { email: 'x@example.com' }, `192.0.2.${i}`)).statusCode).toBe(202);
    expect((await post(t.app, '/api/auth/forgot', { email: 'x@example.com' }, '192.0.2.50')).statusCode).toBe(429);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await post(t.app, '/api/auth/verify', { token: 'A'.repeat(43), password: PASSWORD }, '192.0.2.77')).statusCode;
    expect(last).toBe(429);
  });
});

describe('account deletion', () => {
  it('requires the password, deletes the member with all sites and data, and mails a confirmation', async () => {
    t = await createCloudApp();
    const m = await signupMember(t, 'leaving@example.com');
    const site = (await api(t.app, m.cookie, 'POST', '/api/sites', { name: 'Mine', domains: ['mine.example'] })).json() as { site: { id: string } };
    expect((await api(t.app, m.cookie, 'DELETE', '/api/account', { password: 'wrong password 1' })).statusCode).toBe(400);
    expect((await api(t.app, m.cookie, 'DELETE', '/api/account', {})).statusCode).toBe(400);
    const res = await api(t.app, m.cookie, 'DELETE', '/api/account', { password: PASSWORD });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/Max-Age=0|Expires=/);
    expect(t.ctx.users.byEmail('leaving@example.com')).toBeNull();
    expect(t.ctx.sites.byId(site.site.id)).toBeNull();
    expect((await api(t.app, m.cookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
    await t.ctx.mailer?.idle();
    expect(t.mail.sent[t.mail.sent.length - 1]).toMatchObject({ to: 'leaving@example.com', subject: expect.stringMatching(/deleted/) });
  });

  it('is only for members', async () => {
    t = await createCloudApp();
    const admin = await login(t.app);
    expect((await api(t.app, admin, 'DELETE', '/api/account', { password: 'correct horse battery' })).statusCode).toBe(403);
    expect(t.ctx.users.byEmail(ADMIN_EMAIL)).not.toBeNull();
  });
});

describe('mailer', () => {
  it('never blocks the response and logs failures without addresses or credentials', async () => {
    const lines: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fixtures = (await import('./helpers.js')).makeFixtures();
    const app = await (await import('../src/app.js')).buildApp(
      loadConfig({ ...CLOUD_ENV, DATA_DIR: fixtures.root, TRACKER_FILE: fixtures.trackerFile, DASHBOARD_DIR: fixtures.dashboardDir }),
      {
        dbPath: ':memory:',
        logStream: { write: (l: string) => lines.push(l) },
        mailTransport: {
          send: async () => {
            await gate;
            throw Object.assign(new Error('550 mailbox unavailable for secret@example.com'), { code: 'EENVELOPE', responseCode: 550 });
          },
        },
      },
    );
    try {
      const res = await post(app, '/api/auth/signup', { email: 'secret@example.com', password: PASSWORD });
      expect(res.statusCode).toBe(202); // answered while the SMTP send is still pending
      release();
      await app.ctx.mailer?.idle();
      const log = lines.join('\n');
      expect(log).toContain('failed to send email');
      expect(log).not.toContain('secret@example.com');
      expect(log).not.toContain('smtp-secret');
      expect(log).not.toContain('token=');
    } finally {
      await app.close();
    }
  });
});
