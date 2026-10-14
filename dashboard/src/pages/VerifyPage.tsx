import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MailCheckIcon, MailXIcon } from 'lucide-react';
import { ApiError } from '@/api/client';
import { securityApi } from '@/api/security';
import { MfaStep } from './LoginPage';
import { AuthCard, FormMessage, PasswordField, useUrlToken } from '@/components/AuthCard';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/auth';

const linkCls = 'font-medium text-foreground underline underline-offset-4 hover:text-foreground/80';

/**
 * /verify#token=… — "Confirm your email". Nothing is sent on page load (link
 * scanners must not consume the token); the password proves account ownership.
 * On success the server sets the session cookie and we go to the dashboard.
 */
export function VerifyPage() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const token = useUrlToken();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  if (!token) {
    return (
      <AuthCard
        icon={<MailXIcon />}
        title="Invalid verification link"
        description="This link is incomplete. Open the link from the email again, or sign up again to get a new one."
        footer={
          <span>
            <Link to="/login" className={linkCls}>
              Log in
            </Link>{' '}
            or{' '}
            <Link to="/signup" className={linkCls}>
              sign up again
            </Link>
          </span>
        }
      />
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return setError('Enter your password.');
    setBusy(true);
    setError(null);
    try {
      const r = await securityApi.verifyEmail(token, password);
      if (r.kind === 'mfa') {
        // Accounts with two-factor authentication confirm with their code as well.
        setMfaToken(r.mfaToken);
        setBusy(false);
        return;
      }
      setUser(r.user);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError('This link is invalid or has expired, or the password is wrong.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts. Please try again later.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Verification failed.');
      }
      setBusy(false);
    }
  };

  if (mfaToken) {
    return (
      <MfaStep
        mfaToken={mfaToken}
        onDone={(u) => {
          setUser(u);
          navigate('/', { replace: true });
        }}
        onCancel={(message) => {
          setMfaToken(null);
          setError(message);
        }}
      />
    );
  }

  return (
    <AuthCard
      icon={<MailCheckIcon />}
      title="Confirm your email"
      description="Enter the password you chose when signing up to activate your account."
      footer={
        <span>
          Link expired?{' '}
          <Link to="/signup" className={linkCls}>
            Sign up again
          </Link>
        </span>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
        {error ? <FormMessage>{error}</FormMessage> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Confirming…' : 'Confirm email'}
        </Button>
      </form>
    </AuthCard>
  );
}
