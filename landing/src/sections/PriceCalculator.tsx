import { Minus, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PRICING } from '~/config';
import { clampSites, formatPrice, MAX_SITES, monthlyPriceCents, paidSites, yearlyPriceCents } from '~/lib/pricing';

const SLIDER_MAX = 50;

export function PriceCalculator() {
  const id = useId();
  const [sites, setSites] = useState(5);
  const [draft, setDraft] = useState('5');

  const update = (n: number) => {
    const v = clampSites(n);
    setSites(v);
    setDraft(String(v));
  };

  const paid = paidSites(sites, PRICING);
  const monthly = monthlyPriceCents(sites, PRICING);
  const yearly = yearlyPriceCents(sites, PRICING);
  const fill = `${((Math.min(sites, SLIDER_MAX) - 1) / (SLIDER_MAX - 1)) * 100}%`;
  const unit = formatPrice(PRICING.pricePerSiteCents, PRICING.currency);

  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-2xl border bg-card md:grid-cols-[1.4fr_1fr]">
      <div className="flex flex-col gap-6 p-6 sm:p-8">
        <div className="flex flex-col gap-1">
          <h3 className="text-lg font-semibold tracking-tight">Price calculator</h3>
          <p className="text-sm text-muted-foreground">How many websites do you want to track on the hosted service?</p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <label htmlFor={`${id}-n`} className="text-sm font-medium">
            Websites
          </label>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9"
              aria-label="One website less"
              disabled={sites <= 1}
              onClick={() => update(sites - 1)}
            >
              <Minus />
            </Button>
            <Input
              id={`${id}-n`}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_SITES}
              step={1}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value !== '' && Number.isFinite(n)) setSites(clampSites(n));
              }}
              onBlur={() => update(Number(draft))}
              className="no-spinner h-9 w-20 text-center text-base font-semibold tabular-nums"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9"
              aria-label="One website more"
              disabled={sites >= MAX_SITES}
              onClick={() => update(sites + 1)}
            >
              <Plus />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <input
            type="range"
            min={1}
            max={SLIDER_MAX}
            step={1}
            value={Math.min(sites, SLIDER_MAX)}
            onChange={(e) => update(Number(e.target.value))}
            aria-label="Number of websites"
            aria-valuetext={`${sites} website${sites === 1 ? '' : 's'}`}
            className="range"
            style={{ '--fill': fill } as React.CSSProperties}
          />
          <div className="relative mx-2.5 h-4 font-mono text-xs text-muted-foreground" aria-hidden="true">
            {[1, 10, 25, SLIDER_MAX].map((t) => (
              <span
                key={t}
                className="absolute -translate-x-1/2"
                style={{ left: `${((t - 1) / (SLIDER_MAX - 1)) * 100}%` }}
              >
                {t === SLIDER_MAX ? `${t}+` : t}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col justify-center gap-4 border-t bg-surface/70 p-6 sm:p-8 md:border-t-0 md:border-l" aria-live="polite">
        <p className="text-sm text-muted-foreground">Your monthly price</p>
        <p className="flex items-baseline gap-2">
          <span className="text-5xl font-semibold tracking-tighter tabular-nums">{formatPrice(monthly, PRICING.currency)}</span>
          <span className="text-muted-foreground">/ month</span>
        </p>
        <dl className="flex flex-col gap-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">First website</dt>
            <dd className="tabular-nums">Free</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">
              {paid} additional × {unit}
            </dt>
            <dd className="tabular-nums">{formatPrice(monthly, PRICING.currency)}</dd>
          </div>
          <div className="mt-1 flex justify-between gap-4 border-t pt-2.5">
            <dt className="text-muted-foreground">Per year</dt>
            <dd className="tabular-nums">{formatPrice(yearly, PRICING.currency)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
