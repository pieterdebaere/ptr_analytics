// Two-factor authentication (TOTP + recovery codes), docs/SPEC.md §8.3.
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRoundIcon, RefreshCwIcon, ShieldCheckIcon, ShieldOffIcon, SmartphoneIcon } from 'lucide-react';
import { factorError, isTotpCode, securityApi, securityError, type MfaSetup, type MfaStatus, type SecondFactor } from '@/api/security';
import { FormMessage, PasswordField } from '@/components/AuthCard';
import { ErrorState, SkeletonRows } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { cn } from '@/lib/utils';
import { QrCode } from './QrCode';
import { RecoveryCodes, SecretValue, groupSecret } from './secrets';

export function CodeInput({
  value,
  onChange,
  id,
  autoFocus,
  invalid,
  describedBy,
}: {
  value: string;
  onChange: (v: string) => void;
  id: string;
  autoFocus?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  return (
    <Input
      id={id}
      aria-describedby={describedBy}
      name="totp"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]*"
      maxLength={7}
      placeholder="123 456"
      className="h-10 max-w-44 text-center font-mono text-lg tracking-[0.3em] md:text-lg"
      value={value}
      aria-invalid={invalid || undefined}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value.replace(/[^\d ]/g, ''))}
    />
  );
}

/** Small error line under a field. */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-destructive" role="alert">
      {children}
    </p>
  );
}

export type FactorMode = 'totp' | 'recovery';

/** The value of a second-factor field as request input. */
export function factorOf(mode: FactorMode, value: string): SecondFactor {
  return mode === 'totp' ? { code: value } : { recoveryCode: value };
}

/** Authenticator code, or (after a click) one of the recovery codes — same wording as the login step. */
export function SecondFactorField({
  mode,
  onModeChange,
  value,
  onChange,
  error,
  autoFocus,
}: {
  mode: FactorMode;
  onModeChange: (m: FactorMode) => void;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  autoFocus?: boolean;
}) {
  const id = useId();
  const errId = useId();
  const switchMode = () => {
    onModeChange(mode === 'totp' ? 'recovery' : 'totp');
    onChange('');
  };
  return (
    <div className="flex flex-col gap-2" data-slot="second-factor">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Label htmlFor={id}>{mode === 'totp' ? 'Authentication code' : 'Recovery code'}</Label>
        <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={switchMode}>
          {mode === 'totp' ? 'Use a recovery code instead' : 'Use your authenticator app instead'}
        </button>
      </div>
      {mode === 'totp' ? (
        <CodeInput id={id} value={value} onChange={onChange} invalid={!!error} autoFocus={autoFocus} describedBy={error ? errId : undefined} />
      ) : (
        <Input
          id={id}
          name="recovery-code"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={64}
          placeholder="xxxx-xxxx-xxxx"
          className="h-10 max-w-64 font-mono"
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error ? <FieldError id={errId}>{error}</FieldError> : null}
    </div>
  );
}

/** "I have stored these codes" gate: the dialog cannot be dismissed before it is on. */
function SavedSwitch({ saved, onChange }: { saved: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={saved} onCheckedChange={onChange} />I have stored these codes in a safe place
    </label>
  );
}

export function MfaCard({ onStatus }: { onStatus?: (s: MfaStatus) => void } = {}) {
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi((signal) => securityApi.mfaStatus(signal), []);
  useEffect(() => {
    if (data) onStatus?.(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const [dialog, setDialog] = useState<'enable' | 'disable' | 'regenerate' | null>(null);
  const account = user?.email ?? '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication
          {data ? (
            data.enabled ? (
              <Badge className="bg-good/12 text-good-text" data-slot="mfa-status">
                <ShieldCheckIcon aria-hidden="true" />
                On
              </Badge>
            ) : (
              <Badge variant="secondary" data-slot="mfa-status">
                Off
              </Badge>
            )
          ) : null}
        </CardTitle>
        <CardDescription>
          Protect your account with a one-time code from an authenticator app (1Password, Google Authenticator, Aegis …) in addition to your password.
        </CardDescription>
        {data && !data.enabled ? (
          <CardAction>
            <Button type="button" onClick={() => setDialog('enable')}>
              <ShieldCheckIcon aria-hidden="true" />
              Turn on
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data?.required && !data.enabled ? (
          <div className="flex items-start gap-3 rounded-lg border border-warn/40 bg-warn/[0.08] p-3 text-sm" role="alert" data-slot="mfa-required">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-warn-text" aria-hidden="true" />
            <div className="flex flex-col gap-2">
              <p>
                <strong className="font-medium">Two-factor authentication is required for admins on this server.</strong> Set it up to continue using the
                dashboard.
              </p>
              <Button type="button" className="w-fit" onClick={() => setDialog('enable')}>
                Set up now
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !data ? (
          <SkeletonRows rows={2} />
        ) : data?.enabled ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <KeyRoundIcon className="size-4" aria-hidden="true" />
                </span>
                <div className="text-sm">
                  <p className="font-medium">Recovery codes</p>
                  <p className={cn('text-muted-foreground', data.recoveryCodesLeft <= 3 && 'text-warn-text')} data-slot="codes-left">
                    {data.recoveryCodesLeft === 0
                      ? 'No unused codes left — generate new ones now.'
                      : `${data.recoveryCodesLeft} unused ${data.recoveryCodesLeft === 1 ? 'code' : 'codes'} left.`}
                  </p>
                </div>
              </div>
              <Button type="button" variant="outline" onClick={() => setDialog('regenerate')}>
                <RefreshCwIcon aria-hidden="true" />
                Generate new codes
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {data.required ? 'Required for admins on this server — it cannot be turned off.' : 'Turning it off makes your account accessible with your password alone.'}
              </p>
              <Button type="button" variant="destructive" onClick={() => setDialog('disable')} disabled={data.required}>
                <ShieldOffIcon aria-hidden="true" />
                Turn off
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            <SmartphoneIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>Two-factor authentication is off. To turn it on you need an authenticator app that can scan a QR code.</p>
          </div>
        )}
      </CardContent>

      {dialog === 'enable' ? <EnableDialog account={account} onClose={() => setDialog(null)} onChanged={reload} /> : null}
      {dialog === 'disable' || dialog === 'regenerate' ? (
        <ConfirmDialog mode={dialog} account={account} onClose={() => setDialog(null)} onChanged={reload} />
      ) : null}
    </Card>
  );
}

type EnableStep = { kind: 'password' } | { kind: 'scan'; setup: MfaSetup } | { kind: 'codes'; codes: string[]; apiKeysRevoked: number };

function EnableDialog({ account, onClose, onChanged }: { account: string; onClose: () => void; onChanged: () => void }) {
  const [step, setStep] = useState<EnableStep>({ kind: 'password' });
  // Kept only while the dialog is open: enabling needs the password again.
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const codeId = useId();
  const codeErrId = useId();

  const fail = (err: unknown) => {
    const e = securityError(err);
    if (e.field === 'password') {
      setPasswordError(e.message);
      setStep({ kind: 'password' });
    } else if (e.field === 'code') setCodeError(e.message);
    else setError(e.message || null);
  };

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return setPasswordError('Enter your password.');
    setBusy(true);
    setPasswordError(null);
    setError(null);
    try {
      setStep({ kind: 'scan', setup: await securityApi.mfaSetup(password) });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!isTotpCode(code)) return setCodeError('Enter the 6-digit code from your authenticator app.');
    setBusy(true);
    setCodeError(null);
    setError(null);
    try {
      const r = await securityApi.mfaEnable(password, code);
      setPassword('');
      setStep({ kind: 'codes', codes: r.recoveryCodes, apiKeysRevoked: r.apiKeysRevoked });
      onChanged();
    } catch (err) {
      setCode('');
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const showingCodes = step.kind === 'codes';
  // Recovery codes are shown once: no Escape / outside click / close button until stored.
  const onOpenChange = (open: boolean) => {
    if (!open && (!showingCodes || saved)) onClose();
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!showingCodes || saved}>
        {step.kind === 'codes' ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your recovery codes</DialogTitle>
              <DialogDescription>
                Two-factor authentication is on. If you lose your device, each of these codes lets you log in once. They are shown only now.
              </DialogDescription>
            </DialogHeader>
            <RecoveryCodes codes={step.codes} account={account} onSavedChange={setSaved} />
            {step.apiKeysRevoked > 0 ? (
              <p className="text-sm text-muted-foreground" data-slot="keys-revoked">
                {step.apiKeysRevoked === 1 ? 'Your API key was' : `Your ${step.apiKeysRevoked} API keys were`} revoked. Create new keys where you still need them.
              </p>
            ) : null}
            <SavedSwitch saved={saved} onChange={setSaved} />
            <DialogFooter>
              <Button type="button" disabled={!saved} onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : step.kind === 'password' ? (
          <form onSubmit={start} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>Turn on two-factor authentication</DialogTitle>
              <DialogDescription>Confirm your password to start. You will need an authenticator app to scan a QR code.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <PasswordField label="Password" value={password} onChange={(v) => (setPassword(v), setPasswordError(null))} autoComplete="current-password" autoFocus />
              {passwordError ? <FieldError>{passwordError}</FieldError> : null}
            </div>
            <p className="text-xs text-muted-foreground">Turning it on signs you out on your other devices and revokes your API keys.</p>
            {error ? <FormMessage>{error}</FormMessage> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Checking…' : 'Continue'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={confirm} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>Turn on two-factor authentication</DialogTitle>
              <DialogDescription>Scan the QR code with your authenticator app, then enter the 6-digit code it shows.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <QrCode value={step.setup.otpauthUrl} label="QR code for your authenticator app" className="mx-auto size-44 shrink-0 border sm:mx-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-3 text-sm">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Can&apos;t scan? Enter this key manually:</span>
                  <SecretValue value={groupSecret(step.setup.secret)} label="Secret key" wrap />
                  <a href={step.setup.otpauthUrl} className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
                    Open in an authenticator app on this device
                  </a>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={codeId}>Authentication code</Label>
                  <CodeInput
                    id={codeId}
                    value={code}
                    onChange={(v) => (setCode(v), setCodeError(null))}
                    invalid={!!codeError}
                    describedBy={codeError ? codeErrId : undefined}
                    autoFocus
                  />
                  {codeError ? <FieldError id={codeErrId}>{codeError}</FieldError> : null}
                </div>
              </div>
            </div>
            {error ? <FormMessage>{error}</FormMessage> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Verifying…' : 'Verify & turn on'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog({ mode, account, onClose, onChanged }: { mode: 'disable' | 'regenerate'; account: string; onClose: () => void; onChanged: () => void }) {
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [factorMode, setFactorMode] = useState<FactorMode>('totp');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const factor = factorOf(factorMode, code);
    const pe = password ? null : 'Enter your password.';
    const ce = factorError(factor);
    setPasswordError(pe);
    setCodeError(ce);
    if (pe || ce) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'disable') {
        await securityApi.mfaDisable(password, factor);
        onChanged();
        onClose();
      } else {
        setCodes(await securityApi.regenerateRecoveryCodes(password, factor));
        setPassword('');
        onChanged();
      }
    } catch (err) {
      const f = securityError(err);
      if (f.field === 'password') setPasswordError(f.message);
      else if (f.field === 'code') {
        setCodeError(f.message);
        setCode('');
      } else setError(f.message || null);
    } finally {
      setBusy(false);
    }
  };

  const onOpenChange = (open: boolean) => {
    if (!open && (!codes || saved)) onClose();
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md" showCloseButton={!codes || saved}>
        {codes ? (
          <>
            <DialogHeader>
              <DialogTitle>New recovery codes</DialogTitle>
              <DialogDescription>Your old codes no longer work. Store these somewhere safe — they are shown only now.</DialogDescription>
            </DialogHeader>
            <RecoveryCodes codes={codes} account={account} onSavedChange={setSaved} />
            <SavedSwitch saved={saved} onChange={setSaved} />
            <DialogFooter>
              <Button type="button" disabled={!saved} onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={onSubmit} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>{mode === 'disable' ? 'Turn off two-factor authentication' : 'Generate new recovery codes'}</DialogTitle>
              <DialogDescription>
                {mode === 'disable'
                  ? 'Confirm with your password and a code from your authenticator app. This signs you out on your other devices and revokes your API keys.'
                  : 'This replaces all existing recovery codes. Confirm with your password and a code from your authenticator app.'}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <PasswordField label="Password" value={password} onChange={(v) => (setPassword(v), setPasswordError(null))} autoComplete="current-password" autoFocus />
              {passwordError ? <FieldError>{passwordError}</FieldError> : null}
            </div>
            <SecondFactorField
              mode={factorMode}
              onModeChange={setFactorMode}
              value={code}
              onChange={(v) => (setCode(v), setCodeError(null))}
              error={codeError}
            />
            {error ? <FormMessage>{error}</FormMessage> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant={mode === 'disable' ? 'destructive' : 'default'} disabled={busy}>
                {busy ? 'Working…' : mode === 'disable' ? 'Turn off' : 'Generate codes'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
