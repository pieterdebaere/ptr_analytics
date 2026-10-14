import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarIcon } from 'lucide-react';
import type { UptimePeriod, UptimeQuery } from '@/api/uptime';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { timeZone } from '@/hooks/useStatsQuery';
import { addDays, todayIn, validateCustomRange } from '@/lib/query';

const PRESETS: Array<{ value: Exclude<UptimePeriod, 'custom'>; label: string; long: string }> = [
  { value: '24h', label: '24h', long: 'Last 24 hours' },
  { value: '7d', label: '7d', long: 'Last 7 days' },
  { value: '30d', label: '30d', long: 'Last 30 days' },
  { value: '90d', label: '90d', long: 'Last 90 days' },
];

export function periodLabel(q: Pick<UptimeQuery, 'period' | 'from' | 'to'>): string {
  if (q.period === 'custom') return q.from && q.to ? `${q.from} – ${q.to}` : 'Custom range';
  return PRESETS.find((p) => p.value === q.period)?.long ?? 'Last 24 hours';
}

/** Uptime period from the URL (`period`, `from`, `to`), default 24h. */
export function useUptimePeriod(): [UptimeQuery, (q: Omit<UptimeQuery, 'tz'>) => void] {
  const [params, setParams] = useSearchParams();
  const key = params.toString();
  const query = useMemo<UptimeQuery>(() => {
    const p = new URLSearchParams(key);
    const raw = p.get('period');
    if (raw === 'custom') {
      const from = p.get('from') ?? undefined;
      const to = p.get('to') ?? undefined;
      if (validateCustomRange(from, to) === null) return { period: 'custom', from, to, tz: timeZone };
    }
    if (raw === '7d' || raw === '30d' || raw === '90d') return { period: raw, tz: timeZone };
    return { period: '24h', tz: timeZone };
  }, [key]);
  const set = useCallback(
    (q: Omit<UptimeQuery, 'tz'>) =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete('from');
          next.delete('to');
          if (q.period === '24h') next.delete('period');
          else next.set('period', q.period);
          if (q.period === 'custom' && q.from && q.to) {
            next.set('from', q.from);
            next.set('to', q.to);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [query, set];
}

export function PeriodPicker({ value, onChange }: { value: UptimeQuery; onChange: (q: Omit<UptimeQuery, 'tz'>) => void }) {
  const today = todayIn(timeZone);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value.from ?? addDays(today, -6));
  const [to, setTo] = useState(value.to ?? today);
  const [error, setError] = useState<string | null>(null);
  const fromId = useId();
  const toId = useId();
  useEffect(() => {
    if (value.period === 'custom') {
      if (value.from) setFrom(value.from);
      if (value.to) setTo(value.to);
    }
  }, [value.period, value.from, value.to]);
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const err = validateCustomRange(from, to);
    setError(err);
    if (!err) {
      onChange({ period: 'custom', from, to });
      setOpen(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ToggleGroup
        variant="outline"
        spacing={0}
        value={value.period === 'custom' ? [] : [value.period]}
        onValueChange={(v: unknown[]) => {
          const k = v[0];
          if (k === '24h' || k === '7d' || k === '30d' || k === '90d') onChange({ period: k });
        }}
        aria-label="Time range"
        className="bg-background dark:bg-transparent"
      >
        {PRESETS.map((p) => (
          <ToggleGroupItem key={p.value} value={p.value} aria-label={p.long} className="px-3 tabular-nums">
            {p.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button variant="outline" className="bg-background tabular-nums aria-pressed:bg-muted" aria-pressed={value.period === 'custom'} />}
        >
          <CalendarIcon className="text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{value.period === 'custom' ? periodLabel(value) : 'Custom'}</span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <PopoverHeader>
            <PopoverTitle>Custom range</PopoverTitle>
            <PopoverDescription>Dates are inclusive, in your time zone.</PopoverDescription>
          </PopoverHeader>
          <form className="flex flex-col gap-3" onSubmit={apply}>
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
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
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
