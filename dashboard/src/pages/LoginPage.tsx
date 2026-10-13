import { useId, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { MailWarningIcon } from 'lucide-react';
import { ApiError, api } from '@/api/client';
import { AuthCard, FormMessage, PasswordField } from '@/components/AuthCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/auth';
import { safeNextPath } from '@/lib/safety';

const linkCls = 'font-medium text-foreground underline-offset-4 hover:underline';

export function LoginPage() {
  const { user, setUser, publicConfig } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNextPath(params.get('next')) ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailId = useId();

  if (user) return <Navigate to={next} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await api.login(email.trim(), password);
      setUser(u);
      navigate(next, { replace: true });
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
