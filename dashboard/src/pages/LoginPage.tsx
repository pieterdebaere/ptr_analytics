import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeftIcon, MailWarningIcon, ShieldCheckIcon } from 'lucide-react';
import { ApiError } from '@/api/client';
import { isRecoveryCode, isTotpCode, normalizeRecoveryCode, normalizeTotp, securityApi, securityError, INVALID_RECOVERY_MESSAGE, INVALID_TOTP_MESSAGE } from '@/api/security';
import type { User } from '@/api/types';
import { AuthCard, FormMessage, PasswordField } from '@/components/AuthCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/auth';
import { safeNextPath } from '@/lib/safety';

const linkCls = 'font-medium text-foreground underline-offset-4 hover:underline';

/** After a 429 the submit button pauses for a moment (the server refuses anyway). */
export const RATE_LIMIT_PAUSE_MS = 30_000;

export function LoginPage() {
  const { user, setUser, publicConfig } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNextPath(params.get('next')) ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const emailId = useId();

  if (user) return <Navigate to={next} replace />;

  const done = (u: User) => {
    setUser(u);
    navigate(next, { replace: true });
  };

  if (mfaToken) {
    return (
      <MfaStep
        mfaToken={mfaToken}
        onDone={done}
        onCancel={(message) => {
          setMfaToken(null);
          setPassword('');
          setError(message);
        }}
      />
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await securityApi.login(email.trim(), password);
      if (r.kind === 'mfa') {
        setMfaToken(r.mfaToken);
        setBusy(false);
        return;
      }
      done(r.user);
    } catch (err) {
      // Unverified accounts get the same 401 as a wrong password (no account enumeration).
      if (err instanceof ApiError && err.status === 401) setError('Invalid email or password.');
      else if (err instanceof ApiError && err.status === 429) setError('Too many attempts. Please wait a few minutes and try again.');
      else setError(err instanceof ApiError ? err.message : 'Login failed.');
      setBusy(false);
    }
  };

  const hosted = publicConfig.signupEnabled;

  return (
    <AuthCard
      title="Log in"
      description="Welcome back. Log in to your analytics dashboard."
      footer={
        hosted ? (
          <span>
            No account yet?{' '}
            <Link to="/signup" className={linkCls}>
              Sign up
            </Link>
          </span>
        ) : undefined
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex flex-col gap-2">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            id={emailId}
            type="email"
            name="email"
            autoComplete="username"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </div>
        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          labelAddon={
            hosted ? (
              <Link to="/forgot" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                Forgot password?
              </Link>
            ) : undefined
          }
        />
        {error ? (
          <div className="flex flex-col gap-1">
            <FormMessage>{error}</FormMessage>
            {hosted ? (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-slot="verify-hint">
                <MailWarningIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                <span>Just signed up? Confirm your email first — we&apos;ve sent you a link.</span>
              </p>
            ) : null}
          </div>
        ) : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
    </AuthCard>
  );
}

/** Second login step for accounts with two-factor authentication (also usable after e-mail verification). */
export function MfaStep({ mfaToken, onDone, onCancel }: { mfaToken: string; onDone: (u: User) => void; onCancel: (message: string | null) => void }) {
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const codeId = useId();
  const hintId = useId();

  useEffect(() => {
    if (!paused) return;
    const t = window.setTimeout(() => setPaused(false), RATE_LIMIT_PAUSE_MS);
    return () => window.clearTimeout(t);
  }, [paused]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const valid = mode === 'totp' ? isTotpCode(code) : isRecoveryCode(code);
    if (!valid) {
      setError(mode === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const u = await securityApi.loginMfa(
        mfaToken,
        mode === 'totp' ? { code: normalizeTotp(code) } : { recoveryCode: normalizeRecoveryCode(code) },
      );
      onDone(u);
    } catch (err) {
      setBusy(false);
      setCode('');
      if (err instanceof ApiError && err.status === 429) {
        // mfa_locked: too many wrong codes for this account; the message names the wait.
        setError(securityError(err).message);
        setPaused(true);
      } else if (err instanceof ApiError && (err.code === 'mfa_expired' || err.status === 410))
        onCancel('Your login attempt expired. Please log in again.');
      else if (err instanceof ApiError && (err.status === 401 || err.status === 400))
        setError(mode === 'totp' ? INVALID_TOTP_MESSAGE : INVALID_RECOVERY_MESSAGE);
      else setError(err instanceof ApiError ? err.message : 'Login failed.');
    }
  };

  const switchMode = () => {
    setMode((m) => (m === 'totp' ? 'recovery' : 'totp'));
    setCode('');
    setError(null);
  };

  return (
    <AuthCard
      icon={<ShieldCheckIcon aria-hidden="true" />}
      title="Two-factor authentication"
      description={
        mode === 'totp'
          ? 'Enter the 6-digit code from your authenticator app.'
          : 'Enter one of the recovery codes you saved when you turned on two-factor authentication. Each code works once.'
      }
      footer={
        <button type="button" className={linkCls} onClick={() => onCancel(null)}>
          <span className="inline-flex items-center gap-1">
            <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
            Back to log in
          </span>
        </button>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor={codeId}>{mode === 'totp' ? 'Authentication code' : 'Recovery code'}</Label>
          {mode === 'totp' ? (
            <Input
              key="totp"
              id={codeId}
              name="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              placeholder="123 456"
              className="h-10 text-center font-mono text-lg tracking-[0.3em] md:text-lg"
              value={code}
              aria-invalid={error ? true : undefined}
              aria-describedby={hintId}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d ]/g, '');
                setCode(v);
                if (error) setError(null);
              }}
              autoFocus
            />
          ) : (
            <Input
              key="recovery"
              id={codeId}
              name="recovery-code"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={64}
              placeholder="xxxx-xxxx-xxxx"
              className="h-10 font-mono"
              value={code}
              aria-invalid={error ? true : undefined}
              aria-describedby={hintId}
              onChange={(e) => {
                setCode(e.target.value);
                if (error) setError(null);
              }}
              autoFocus
            />
          )}
          <p id={hintId} className="text-xs text-muted-foreground">
            {mode === 'totp' ? (
              <>
                Lost your device?{' '}
                <button type="button" className={linkCls} onClick={switchMode}>
                  Use a recovery code
                </button>
              </>
            ) : (
              <button type="button" className={linkCls} onClick={switchMode}>
                Use your authenticator app instead
              </button>
            )}
          </p>
        </div>
        {error ? <FormMessage>{error}</FormMessage> : null}
        <Button type="submit" className="w-full" disabled={busy || paused}>
          {busy ? 'Verifying…' : 'Verify'}
        </Button>
      </form>
    </AuthCard>
  );
}
