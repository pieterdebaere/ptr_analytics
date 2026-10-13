import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MailXIcon } from 'lucide-react';
import { ApiError, api } from '@/api/client';
import { AuthCard, readToken } from '@/components/AuthCard';
import { Spinner } from '@/components/common';
import { useAuth } from '@/hooks/auth';

const linkCls = 'font-medium text-foreground underline underline-offset-4 hover:text-foreground/80';

/** /verify?token=… — confirms the email address, signs in and goes to the dashboard. */
export function VerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const token = readToken(params);
  const [error, setError] = useState<string | null>(token ? null : 'This verification link is incomplete.');
  // Tokens are single use: never send the same one twice (StrictMode re-runs effects).
  const sent = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // Wait for the session probe so its answer cannot overwrite the new session.
    if (!token || user === undefined || sent.current === token) return;
    sent.current = token;
    api.verifyEmail(token).then(
      (u) => {
        if (!mounted.current) return;
        setUser(u);
        navigate('/', { replace: true });
      },
      (err: unknown) => {
        if (!mounted.current) return;
        if (err instanceof ApiError && (err.status === 400 || err.status === 404 || err.status === 410)) {
          setError('This verification link is invalid or has expired.');
        } else {
          setError(err instanceof ApiError ? err.message : 'Verification failed.');
        }
      },
    );
  }, [token, user, navigate, setUser]);

  if (error) {
    return (
      <AuthCard
        icon={<MailXIcon />}
        title="Could not verify your email"
        description={error}
        footer={
          <span>
            <Link to="/login" className={linkCls}>
              Log in
            </Link>{' '}
            or{' '}
            <Link to="/signup" className={linkCls}>
              sign up again
            </Link>{' '}
            to get a new link.
          </span>
        }
      />
    );
  }

  return (
    <AuthCard title="Verifying your email…" description="One moment, we are activating your account.">
      <div className="flex justify-center py-2">
        <Spinner label="Verifying" />
      </div>
    </AuthCard>
  );
}
