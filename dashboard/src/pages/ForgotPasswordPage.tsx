import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { MailCheckIcon } from 'lucide-react';
import { ApiError, api } from '@/api/client';
import { AuthCard, FormMessage } from '@/components/AuthCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { displayText, isPlainEmail } from '@/lib/safety';

const linkCls = 'font-medium text-foreground underline underline-offset-4 hover:text-foreground/80';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailId = useId();

  const backToLogin = (
    <Link to="/login" className={linkCls}>
      Back to log in
    </Link>
  );

  if (sentTo) {
    return (
      <AuthCard
        icon={<MailCheckIcon />}
        title="Check your email"
        description={
          <>
            If an account exists for <strong className="bidi-isolate break-all text-foreground">{displayText(sentTo)}</strong>, we sent
            a link to reset the password. It is valid for one hour.
          </>
        }
        footer={backToLogin}
      />
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return setError('Enter your email address.');
    if (!isPlainEmail(email.trim())) return setError('Enter a plain email address, like name@example.com.');
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim());
      setSentTo(email.trim());
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError('Too many attempts. Please try again later.');
      else setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Reset your password" description="Enter your email address and we will send you a reset link." footer={backToLogin}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex flex-col gap-2">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            id={emailId}
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            autoFocus
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        {error ? <FormMessage>{error}</FormMessage> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthCard>
  );
}
