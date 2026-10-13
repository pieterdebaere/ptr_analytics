import { useEffect, useId, useState, type FormEvent } from 'react';
import { CalendarIcon } from 'lucide-react';
import { PERIODS, type Period, type PeriodSelection } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { timeZone } from '@/hooks/useStatsQuery';
import { PERIOD_LABELS, addDays, todayIn, validateCustomRange } from '@/lib/query';

function formatRange(from: string, to: string): string {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const fy = from.slice(0, 4);
    const ty = to.slice(0, 4);
    const withYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const a = Date.parse(`${from}T00:00:00Z`);
    const b = Date.parse(`${to}T00:00:00Z`);
    return fy === ty ? `${fmt.format(a)} – ${withYear.format(b)}` : `${withYear.format(a)} – ${withYear.format(b)}`;
  } catch {
    return `${from} – ${to}`;
  }
}

/** Period dropdown (shadcn Select) plus a popover for a custom date range. */
export function PeriodSelector({
  value,
  onChange,
}: {
  value: PeriodSelection;
  onChange: (sel: PeriodSelection) => void;
}) {
  const today = todayIn(timeZone);
  const [from, setFrom] = useState(value.from ?? addDays(today, -29));
  const [to, setTo] = useState(value.to ?? today);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const fromId = useId();
  const toId = useId();

  useEffect(() => {
    if (value.period === 'custom') {
      if (value.from) setFrom(value.from);
      if (value.to) setTo(value.to);
    }
  }, [value.period, value.from, value.to]);

  const onSelect = (p: Period | null) => {
    if (!p) return;
    if (p === 'custom') {
      setError(null);
      setOpen(true);
    } else {
      onChange({ period: p });
    }
  };

  const onApply = (e: FormEvent) => {
    e.preventDefault();
    const err = validateCustomRange(from, to);
    setError(err);
    if (!err) {
      onChange({ period: 'custom', from, to });
      setOpen(false);
    }
  };

  const isCustom = value.period === 'custom' && value.from && value.to;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Select<Period> value={value.period} onValueChange={onSelect}>
        <SelectTrigger aria-label="Time range" className="min-w-40 bg-background">
          <CalendarIcon className="text-muted-foreground" aria-hidden="true" />
          <SelectValue>{(v: Period) => PERIOD_LABELS[v] ?? PERIOD_LABELS['7d']}</SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} align="start">
          {PERIODS.map((p) => (
            <SelectItem key={p} value={p}>
              {p === 'custom' ? 'Custom range…' : PERIOD_LABELS[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              className={isCustom || open ? 'min-w-0 bg-background tabular-nums' : 'hidden'}
              aria-label={isCustom ? `Custom range ${formatRange(value.from!, value.to!)} (edit)` : 'Custom range'}
            />
          }
        >
          {isCustom ? <span className="truncate">{formatRange(value.from!, value.to!)}</span> : <span>Pick dates</span>}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <PopoverHeader>
            <PopoverTitle>Custom range</PopoverTitle>
            <PopoverDescription>Dates are inclusive, in your time zone.</PopoverDescription>
          </PopoverHeader>
          <form className="flex flex-col gap-3" onSubmit={onApply}>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={fromId}>From</Label>
                <Input id={fromId} type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={toId}>To</Label>
                <Input id={toId} type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} required />
              </div>
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Apply</Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}
