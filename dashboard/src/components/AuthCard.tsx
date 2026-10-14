import { useEffect, useId, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { MAX_PASSWORD } from '@/lib/password';
import { cn } from '@/lib/utils';
import { AuthLayout } from './Layout';

export function AuthCard({
  title,
  description,
  children,
  footer,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <AuthLayout>
      <Card className="shadow-sm">
        <CardHeader className="gap-1.5">
          {icon ? (
            <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-muted text-foreground [&_svg]:size-5">{icon}</div>
          ) : null}
          <CardTitle className="text-lg font-semibold">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        {children ? <CardContent>{children}</CardContent> : null}
        {footer ? <CardFooter className="justify-center text-sm text-muted-foreground">{footer}</CardFooter> : null}
      </Card>
    </AuthLayout>
  );
}

/** Password input with a show/hide toggle. */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  hint,
  autoFocus,
  labelAddon,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  minLength?: number;
  hint?: ReactNode;
  autoFocus?: boolean;
  labelAddon?: ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  const [show, setShow] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {labelAddon}
      </div>
      <InputGroup>
        <InputGroupInput
          id={id}
          type={show ? 'text' : 'password'}
          name={autoComplete === 'current-password' ? 'password' : 'new-password'}
          autoComplete={autoComplete}
          required
          minLength={minLength}
          maxLength={MAX_PASSWORD}
          value={value}
          autoFocus={autoFocus}
          aria-describedby={hint ? hintId : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((s) => !s)}>
            {show ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function FormMessage({ kind = 'error', children, className }: { kind?: 'error' | 'ok'; children: ReactNode; className?: string }) {
  return (
    <p className={cn('text-sm', kind === 'error' ? 'text-destructive' : 'text-good-text', className)} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

const TOKEN_RE = /^[A-Za-z0-9_-]+={0,2}$/;

function validToken(t: string | null): string | null {
  if (!t || t.length > 512 || !TOKEN_RE.test(t)) return null;
  return t;
}

/**
 * Reads a single-use token from the URL fragment (`#token=…`, mail links) or,
 * for older links, the query string (`?token=…`), and checks its shape.
 */
export function readToken(hash: string, search: string): string | null {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  if (fromHash !== null) return validToken(fromHash);
  return validToken(new URLSearchParams(search).get('token'));
}

/**
 * Takes the token from the current URL once and immediately strips it from the
 * address bar / history (it must not linger in history, screenshots or referrers).
 */
export function useUrlToken(): string | null {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => readToken(location.hash, location.search));
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (location.hash || params.has('token')) {
      params.delete('token');
      const qs = params.toString();
      navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '', hash: '' }, { replace: true });
    }
    // only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return token;
}
