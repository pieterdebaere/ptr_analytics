import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2Icon, MailXIcon } from 'lucide-react';
import { ApiError, api } from '@/api/client';
import { AuthCard, FormMessage, PasswordField, readToken } from '@/components/AuthCard';
import { Button, buttonVariants } from '@/components/ui/button';
import { MIN_PASSWORD, validateNewPassword } from '@/lib/password';
import { cn } from '@/lib/utils';

const linkCls = 'font-medium text-foreground underline underline-offset-4 hover:text-foreground/80';

/** /reset?token=… — sets a new password (signs out all sessions of that user). */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = readToken(params);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <AuthCard
        icon={<MailXIcon />}
        title="Invalid reset link"
        description="This password reset link is incomplete. Request a new one."
        footer={
          <Link to="/forgot" className={linkCls}>
            Request a new link
          </Link>
        }
      />
    );
  }

  if (done) {
    return (
      <AuthCard icon={<CheckCircle2Icon />} title="Password changed" description="You can now log in with your new password. Other sessions were signed out.">
        <Link to="/login" className={cn(buttonVariants(), 'w-full')}>
          Log in
        </Link>
      </AuthCard>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateNewPassword(password, confirm);
    if (err) return setError(err);
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (e2) {
      if (e2 instanceof ApiError && (e2.status === 400 || e2.status === 404 || e2.status === 410)) {
        setError('This reset link is invalid or has expired. Request a new one.');
      } else {
        setError(e2 instanceof ApiError ? e2.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Choose a new password"
      description="Use at least 12 characters. A passphrase is easiest to remember."
      footer={
        <Link to="/login" className={linkCls}>
          Back to log in
        </Link>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" minLength={MIN_PASSWORD} autoFocus />
        <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" minLength={MIN_PASSWORD} />
        {error ? <FormMessage>{error}</FormMessage> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Set new password'}
        </Button>
      </form>
    </AuthCard>
  );
}
