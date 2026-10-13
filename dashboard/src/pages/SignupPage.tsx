import { useId, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { MailCheckIcon, SparklesIcon } from 'lucide-react';
import { ApiError, api } from '@/api/client';
import { AuthCard, FormMessage, PasswordField } from '@/components/AuthCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/auth';
import { pricingNote } from '@/lib/billing';
import { MIN_PASSWORD, validateNewPassword } from '@/lib/password';
import { displayText } from '@/lib/safety';

const linkCls = 'font-medium text-foreground underline underline-offset-4 hover:text-foreground/80';

export function SignupPage() {
  const { user, publicConfig } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailId = useId();
  const termsId = useId();

  if (user) return <Navigate to="/" replace />;

  if (!publicConfig.signupEnabled) {
    return (
      <AuthCard
        title="Sign-up is not available"
        description="This PTR Analytics instance does not accept new accounts. Ask the administrator for an invitation."
        footer={
          <Link to="/login" className={linkCls}>
            Back to log in
          </Link>
        }
      />
    );
  }

  if (sentTo) {
    return (
      <AuthCard
        icon={<MailCheckIcon />}
        title="Check your email"
        description={
          <>
            We sent a verification link to <strong className="bidi-isolate break-all text-foreground">{displayText(sentTo)}</strong>.
            Open it within 24 hours to activate your account.
          </>
        }
        footer={
          <span>
            Already verified?{' '}
            <Link to="/login" className={linkCls}>
              Log in
            </Link>
          </span>
        }
      >
        <p className="text-sm text-muted-foreground">Nothing arrived? Check your spam folder, or sign up again in a few minutes.</p>
      </AuthCard>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateNewPassword(password, confirm);
    if (err) return setError(err);
    if (!accept) return setError('Please accept the terms to continue.');
    setBusy(true);
    setError(null);
    try {
      await api.signup(email.trim(), password);
      setSentTo(email.trim());
    } catch (e2) {
      if (e2 instanceof ApiError && e2.status === 429) setError('Too many attempts. Please try again later.');
      else setError(e2 instanceof ApiError ? e2.message : 'Sign-up failed.');
    } finally {
      setBusy(false);
    }
  };

  const terms = publicConfig.termsUrl;
  const privacy = publicConfig.privacyUrl;

  return (
    <AuthCard
      title="Create your account"
      description="Privacy-friendly analytics and Speed Insights for your websites."
      footer={
        <span>
          Already have an account?{' '}
          <Link to="/login" className={linkCls}>
            Log in
          </Link>
        </span>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        {publicConfig.billingEnabled ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm" data-slot="pricing-note">
            <SparklesIcon className="size-4 shrink-0 text-chart-1" aria-hidden="true" />
            <span>{pricingNote(publicConfig)}.</span>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            id={emailId}
            type="email"
            name="email"
            autoComplete="email"
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
          autoComplete="new-password"
          minLength={MIN_PASSWORD}
          hint={`At least ${MIN_PASSWORD} characters.`}
        />
        <PasswordField label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" minLength={MIN_PASSWORD} />
        <div className="flex items-start gap-2.5">
          <input
            id={termsId}
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 rounded border-input accent-primary"
            checked={accept}
            onChange={(e) => setAccept(e.target.checked)}
            required
          />
          <label htmlFor={termsId} className="text-sm leading-snug text-muted-foreground">
            I accept the{' '}
            {terms ? (
              <a href={terms} target="_blank" rel="noopener noreferrer" className={linkCls}>
                Terms of Service
              </a>
            ) : (
              'Terms of Service'
            )}{' '}
            and the{' '}
            {privacy ? (
              <a href={privacy} target="_blank" rel="noopener noreferrer" className={linkCls}>
                Privacy Policy
              </a>
            ) : (
              'Privacy Policy'
            )}
            .
          </label>
        </div>
        {error ? <FormMessage>{error}</FormMessage> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  );
}
