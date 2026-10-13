import { useEffect, useState } from 'react';
import { PERIODS, type Period, type PeriodSelection } from '../api/types';
import { PERIOD_LABELS, addDays, todayIn, validateCustomRange } from '../lib/query';
import { timeZone } from '../hooks/useStatsQuery';

export function PeriodSelector({
  value,
  onChange,
}: {
  value: PeriodSelection;
  onChange: (sel: PeriodSelection) => void;
}) {
  const today = todayIn(timeZone);
  const [showCustom, setShowCustom] = useState(value.period === 'custom');
  const [from, setFrom] = useState(value.from ?? addDays(today, -29));
  const [to, setTo] = useState(value.to ?? today);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setShowCustom(value.period === 'custom');
    if (value.period === 'custom') {
      if (value.from) setFrom(value.from);
      if (value.to) setTo(value.to);
    }
  }, [value.period, value.from, value.to]);

  const selectValue: Period = showCustom ? 'custom' : value.period;

  return (
    <div className="period">
      <label className="sr-only" htmlFor="period-select">
        Time range
      </label>
      <select
        id="period-select"
        className="select"
        value={selectValue}
        onChange={(e) => {
          const p = e.target.value as Period;
          if (p === 'custom') {
            setShowCustom(true);
            setError(null);
          } else {
            setShowCustom(false);
            onChange({ period: p });
          }
        }}
      >
        {PERIODS.map((p) => (
          <option key={p} value={p}>
            {PERIOD_LABELS[p]}
          </option>
        ))}
      </select>
      {showCustom ? (
        <form
          className="period-custom"
          onSubmit={(e) => {
            e.preventDefault();
            const err = validateCustomRange(from, to);
            setError(err);
            if (!err) onChange({ period: 'custom', from, to });
          }}
        >
          <label className="sr-only" htmlFor="period-from">
            From
          </label>
          <input
            id="period-from"
            type="date"
            className="input input-date"
            value={from}
            max={to || today}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
          <span className="muted">–</span>
          <label className="sr-only" htmlFor="period-to">
            To
          </label>
          <input
            id="period-to"
            type="date"
            className="input input-date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            required
          />
          <button type="submit" className="btn">
            Apply
          </button>
          {error ? (
            <span className="form-error" role="alert">
              {error}
            </span>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
