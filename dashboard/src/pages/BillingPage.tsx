import { useEffect, useId, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangleIcon, CheckCircle2Icon, CreditCardIcon, ExternalLinkIcon, MinusIcon, PlusIcon, ReceiptIcon } from 'lucide-react';
import { api, errorMessage } from '@/api/client';
import type { Billing } from '@/api/types';
import { EmptyState, ErrorState, PageHeader } from '@/components/common';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import {
  BILLING_STATUS_LABELS,
  MAX_PAID_SITES,
  billingStatusTone,
  clampPaidSites,
  formatPrice,
  hasSubscription,
  monthlyCostCents,
  pricingNote,
  safeStripeUrl,
  suggestedPaidSites,
  usageRatio,
  type StripeUrlKind,
} from '@/lib/billing';
import { cn } from '@/lib/utils';

const TONE_CLASS = {
  good: 'border-good/40 bg-good/10 text-good',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  poor: 'border-poor/40 bg-poor/10 text-poor',
  neutral: '',
} as const;

/** Navigates to a Stripe URL after checking its origin (never to anything else). */
function redirectToStripe(url: string, kind: StripeUrlKind): boolean {
  const safe = safeStripeUrl(url, kind);
  if (!safe) return false;
  window.location.assign(safe);
  return true;
}

export function BillingPage() {
  const { user, publicConfig } = useAuth();
  const [params] = useSearchParams();
  const isMember = user?.role === 'member';
  const { data, error, reload } = useApi((signal) => api.billing(signal), [], isMember);
  const [billing, setBilling] = useState<Billing | undefined>(undefined);
  useEffect(() => setBilling(data), [data]);
  const checkoutDone = params.get('checkout') === 'success';

  // After returning from Stripe Checkout the webhook may lag a few seconds: refresh once more.
  useEffect(() => {
    if (!checkoutDone || !isMember) return;
    const t = window.setTimeout(reload, 4000);
    return () => window.clearTimeout(t);
  }, [checkoutDone, isMember, reload]);

  if (!isMember) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Billing" />
        <Card>
          <EmptyState title="No billing for this account" icon={<ReceiptIcon />}>
            <p>Billing applies to self-service member accounts only.</p>
          </EmptyState>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Billing" description={publicConfig.billingEnabled ? `${pricingNote(publicConfig)}.` : 'Your plan and site allowance.'} />

      {checkoutDone ? (
        <Alert className="border-good/40">
          <CheckCircle2Icon className="text-good" aria-hidden="true" />
          <AlertTitle>Thank you!</AlertTitle>
          <AlertDescription>Your payment was received. It can take a few seconds until your plan below is updated.</AlertDescription>
        </Alert>
      ) : null}

      {error && !billing ? (
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      ) : !billing ? (
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
          <Skeleton className="h-56 rounded-xl md:col-span-3" />
        </div>
      ) : !billing.enabled ? (
        <PlanOverview billing={billing} />
      ) : (
        <>
          {billing.status === 'past_due' || billing.status === 'unpaid' ? <PaymentIssue hasCustomer={billing.hasCustomer} /> : null}
          <PlanOverview billing={billing} />
          {hasSubscription(billing.status) ? (
            <ChangeQuantity billing={billing} onUpdated={setBilling} />
          ) : (
            <AddPaidSites billing={billing} />
          )}
        </>
      )}
    </div>
  );
}

function PaymentIssue({ hasCustomer }: { hasCustomer: boolean }) {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon aria-hidden="true" />
      <AlertTitle>Payment problem</AlertTitle>
      <AlertDescription>
        <p>
          The last payment failed. Update your payment method to keep your paid sites active.
          {hasCustomer ? ' Use “Manage billing” below.' : ''}
        </p>
      </AlertDescription>
    </Alert>
  );
}

function PlanOverview({ billing }: { billing: Billing }) {
  const tone = billingStatusTone(billing.status);
  const ratio = usageRatio(billing);
  const cost = monthlyCostCents(billing.paidSites, billing.pricePerSiteCents);
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card className="gap-3">
        <CardHeader>
          <CardDescription>Sites</CardDescription>
          <CardTitle className="text-3xl font-semibold tracking-tight tabular-nums">
            {billing.sitesUsed}
            <span className="text-lg font-normal text-muted-foreground"> / {billing.sitesAllowed}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Progress value={Math.round(ratio * 100)} aria-label="Sites used" className={cn(ratio >= 1 && '[&_[data-slot=progress-indicator]]:bg-warn')} />
          <p className="text-xs text-muted-foreground">
            {billing.enabled
              ? `${billing.freeSites} free + ${billing.paidSites} paid ${billing.paidSites === 1 ? 'site' : 'sites'}`
              : 'Sites included in your account'}
            {billing.sitesUsed > billing.sitesAllowed ? ` · ${billing.sitesUsed - billing.sitesAllowed} suspended` : ''}
          </p>
        </CardContent>
      </Card>
      <Card className="gap-3">
        <CardHeader>
          <CardDescription>Paid sites</CardDescription>
          <CardTitle className="text-3xl font-semibold tracking-tight tabular-nums">{billing.paidSites}</CardTitle>
        </CardHeader>
        <CardContent>
          <Badge variant="outline" className={cn(TONE_CLASS[tone])} data-slot="billing-status">
            {BILLING_STATUS_LABELS[billing.status] ?? billing.status}
          </Badge>
        </CardContent>
      </Card>
      <Card className="gap-3">
        <CardHeader>
          <CardDescription>Monthly cost</CardDescription>
          <CardTitle className="text-3xl font-semibold tracking-tight tabular-nums" data-slot="monthly-cost">
            {formatPrice(cost, billing.currency)}
            <span className="text-lg font-normal text-muted-foreground"> / month</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            {formatPrice(billing.pricePerSiteCents, billing.currency)} per paid site · taxes may apply
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function QuantityInput({ value, onChange, min, label }: { value: number; onChange: (n: number) => void; min: number; label: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <InputGroup className="w-40">
        <InputGroupAddon>
          <InputGroupButton size="icon-xs" aria-label="Fewer" disabled={value <= min} onClick={() => onChange(clampPaidSites(value - 1, min))}>
            <MinusIcon aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
        <InputGroupInput
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={MAX_PAID_SITES}
          className="text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={value}
          onChange={(e) => onChange(clampPaidSites(Number(e.target.value), min))}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="More" disabled={value >= MAX_PAID_SITES} onClick={() => onChange(clampPaidSites(value + 1, min))}>
            <PlusIcon aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function AddPaidSites({ billing }: { billing: Billing }) {
  const [qty, setQty] = useState(() => suggestedPaidSites(billing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const url = await api.billingCheckout(clampPaidSites(qty, 1));
      if (!redirectToStripe(url, 'checkout')) {
        setError('The server returned an unexpected checkout address. Please contact support.');
        setBusy(false);
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <CardHeader>
          <CardTitle>Add paid sites</CardTitle>
          <CardDescription>
            Your first {billing.freeSites === 1 ? 'site is' : `${billing.freeSites} sites are`} free. Each paid site adds{' '}
            {formatPrice(billing.pricePerSiteCents, billing.currency)} per month; you are redirected to Stripe to pay securely.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-6">
          <QuantityInput value={qty} onChange={setQty} min={1} label="Paid sites" />
          <div className="flex flex-col gap-1 pb-1">
            <span className="text-xs text-muted-foreground">Total</span>
            <span className="text-sm font-medium tabular-nums">
              {formatPrice(monthlyCostCents(qty, billing.pricePerSiteCents), billing.currency)} / month
            </span>
          </div>
          {error ? <p className="w-full text-sm text-destructive" role="alert">{error}</p> : null}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          {billing.hasCustomer ? <PortalButton /> : null}
          <Button type="submit" disabled={busy}>
            <CreditCardIcon aria-hidden="true" />
            {busy ? 'Redirecting…' : 'Continue to checkout'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function ChangeQuantity({ billing, onUpdated }: { billing: Billing; onUpdated: (b: Billing) => void }) {
  const [qty, setQty] = useState(billing.paidSites);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => setQty(billing.paidSites), [billing.paidSites]);
  const changed = qty !== billing.paidSites;
  const willSuspend = billing.freeSites + qty < billing.sitesUsed;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const b = await api.billingQuantity(clampPaidSites(qty));
      onUpdated(b);
      setMessage({ kind: 'ok', text: qty === 0 ? 'Your subscription ends at the end of the billing period.' : 'Your plan was updated.' });
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <CardHeader>
          <CardTitle>Change paid sites</CardTitle>
          <CardDescription>Changes are prorated. Setting 0 cancels the subscription at the end of the billing period.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-6">
            <QuantityInput value={qty} onChange={setQty} min={0} label="Paid sites" />
            <div className="flex flex-col gap-1 pb-1">
              <span className="text-xs text-muted-foreground">New total</span>
              <span className="text-sm font-medium tabular-nums">
                {formatPrice(monthlyCostCents(qty, billing.pricePerSiteCents), billing.currency)} / month
              </span>
            </div>
          </div>
          {willSuspend ? (
            <p className="flex items-center gap-2 text-sm text-warn">
              <AlertTriangleIcon className="size-4 shrink-0" aria-hidden="true" />
              {billing.sitesUsed - billing.freeSites - qty} of your newest sites will be suspended (no data is deleted).
            </p>
          ) : null}
          {message ? (
            <p className={message.kind === 'ok' ? 'text-sm text-good' : 'text-sm text-destructive'} role="status">
              {message.text}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          {billing.hasCustomer ? <PortalButton /> : null}
          <Button type="submit" disabled={busy || !changed}>
            {busy ? 'Updating…' : 'Update plan'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function PortalButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = await api.billingPortal();
      if (!redirectToStripe(url, 'portal')) {
        setError('Unexpected billing portal address.');
        setBusy(false);
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <>
      {error ? (
        <span className="mr-auto text-sm text-destructive" role="alert">
          {error}
        </span>
      ) : null}
      <Button type="button" variant="outline" disabled={busy} onClick={() => void open()}>
        <ExternalLinkIcon aria-hidden="true" />
        {busy ? 'Opening…' : 'Manage billing'}
      </Button>
    </>
  );
}

