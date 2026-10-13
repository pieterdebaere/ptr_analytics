import { useId, useState, type ReactNode } from 'react';
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
    <p className={cn('text-sm', kind === 'error' ? 'text-destructive' : 'text-good', className)} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

/** Reads a single-use token (`?token=`) and checks its shape before sending it anywhere. */
export function readToken(params: URLSearchParams): string | null {
  const t = params.get('token');
  if (!t || t.length > 512 || !/^[A-Za-z0-9_-]+={0,2}$/.test(t)) return null;
  return t;
}
