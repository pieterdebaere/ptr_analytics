// Two-factor authentication (TOTP + recovery codes), docs/SPEC.md §8.3.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { KeyRoundIcon, RefreshCwIcon, ShieldCheckIcon, ShieldOffIcon, SmartphoneIcon } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { isTotpCode, securityApi, type MfaSetup } from '@/api/security';
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

export function CodeInput({ value, onChange, id, autoFocus, invalid }: { value: string; onChange: (v: string) => void; id: string; autoFocus?: boolean; invalid?: boolean }) {
  return (
    <Input
      id={id}
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

export function MfaCard() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi((signal) => securityApi.mfaStatus(signal), []);
  const [dialog, setDialog] = useState<'enable' | 'disable' | 'regenerate' | null>(null);
  const account = user?.email ?? '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication
          {data ? (
            data.enabled ? (
              <Badge className="bg-good/12 text-good" data-slot="mfa-status">
                <ShieldCheckIcon aria-hidden="true" />
                Enabled
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
              Enable
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
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
                  <p className={cn('text-muted-foreground', data.recoveryCodesLeft <= 3 && 'text-warn')} data-slot="codes-left">
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
              <p className="text-sm text-muted-foreground">Turning it off makes your account accessible with your password alone.</p>
              <Button type="button" variant="destructive" onClick={() => setDialog('disable')}>
                <ShieldOffIcon aria-hidden="true" />
                Turn off
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            <SmartphoneIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>Two-factor authentication is off. You will need an authenticator app to scan a QR code.</p>
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

function EnableDialog({ account, onClose, onChanged }: { account: string; onClose: () => void; onChanged: () => void }) {
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const codeId = useId();

  useEffect(() => {
    let cancelled = false;
    setSetupError(null);
    securityApi.mfaSetup().then(
      (s) => !cancelled && setSetup(s),
      (e: unknown) => !cancelled && setSetupError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isTotpCode(code)) return setError('Enter the 6-digit code from your app.');
    setBusy(true);
    setError(null);
    try {
      const c = await securityApi.mfaEnable(code);
      setCodes(c);
      onChanged();
    } catch (err) {
      setError(errorMessage(err) || 'That code did not work. Check the time on your device and try again.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        {codes ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your recovery codes</DialogTitle>
              <DialogDescription>
                Two-factor authentication is on. If you lose your device, each of these codes lets you log in once. They are shown only now.
              </DialogDescription>
            </DialogHeader>
            <RecoveryCodes codes={codes} account={account} onSavedChange={setSaved} />
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={saved} onCheckedChange={setSaved} />I have stored these codes in a safe place
            </label>
            <DialogFooter>
              <Button type="button" disabled={!saved} onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Enable two-factor authentication</DialogTitle>
              <DialogDescription>Scan the QR code with your authenticator app, then enter the 6-digit code it shows.</DialogDescription>
            </DialogHeader>
            {setupError ? (
              <ErrorState message={setupError} onRetry={() => setAttempt((a) => a + 1)} />
            ) : !setup ? (
              <SkeletonRows rows={3} />
            ) : (
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                <QrCode value={setup.otpauthUrl} label="QR code for your authenticator app" className="mx-auto size-44 shrink-0 border sm:mx-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-3 text-sm">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Can&apos;t scan? Enter this key manually:</span>
                    <SecretValue value={groupSecret(setup.secret)} label="Secret key" />
                    <a href={setup.otpauthUrl} className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
                      Open in an authenticator app on this device
                    </a>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={codeId}>Code from the app</Label>
                    <CodeInput id={codeId} value={code} onChange={setCode} invalid={!!error} autoFocus />
                  </div>
                </div>
              </div>
            )}
            {error ? <FormMessage>{error}</FormMessage> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !setup}>
                {busy ? 'Verifying…' : 'Verify & enable'}
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
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const codeId = useId();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isTotpCode(code)) return setError('Enter the 6-digit code from your app.');
    setBusy(true);
    setError(null);
    try {
      if (mode === 'disable') {
        await securityApi.mfaDisable(password, code);
        onChanged();
        onClose();
      } else {
        setCodes(await securityApi.regenerateRecoveryCodes(password, code));
        onChanged();
      }
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        {codes ? (
          <>
            <DialogHeader>
              <DialogTitle>New recovery codes</DialogTitle>
              <DialogDescription>Your old codes no longer work. Store these somewhere safe — they are shown only now.</DialogDescription>
            </DialogHeader>
            <RecoveryCodes codes={codes} account={account} />
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{mode === 'disable' ? 'Turn off two-factor authentication' : 'Generate new recovery codes'}</DialogTitle>
              <DialogDescription>
                {mode === 'disable'
                  ? 'Confirm with your password and a current code from your authenticator app.'
                  : 'This replaces all existing recovery codes. Confirm with your password and a current code.'}
              </DialogDescription>
            </DialogHeader>
            <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
            <div className="flex flex-col gap-2">
              <Label htmlFor={codeId}>Authentication code</Label>
              <CodeInput id={codeId} value={code} onChange={setCode} invalid={!!error} />
            </div>
            {error ? <FormMessage>{error}</FormMessage> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant={mode === 'disable' ? 'destructive' : 'default'} disabled={busy || !password}>
                {busy ? 'Working…' : mode === 'disable' ? 'Turn off' : 'Generate codes'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
