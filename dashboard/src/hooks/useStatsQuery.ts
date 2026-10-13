import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FilterKey, Filters, PeriodSelection, StatsQuery } from '../api/types';
import { browserTimeZone, parseFilters, parsePeriod, withFilter, withPeriod } from '../lib/query';

const TZ = browserTimeZone();

/** Period + filters from the URL query string, with setters that update the URL. */
export function useStatsQuery() {
  const [params, setParams] = useSearchParams();
  const key = params.toString();

  const period = useMemo<PeriodSelection>(() => parsePeriod(new URLSearchParams(key)), [key]);
  const filters = useMemo<Filters>(() => parseFilters(new URLSearchParams(key)), [key]);
  const query = useMemo<StatsQuery>(
    () => ({ ...period, tz: TZ, filters }),
    [period, filters],
  );

  const setPeriod = useCallback(
    (sel: PeriodSelection) => setParams((p) => withPeriod(p, sel)),
    [setParams],
  );
  const setFilter = useCallback(
    (k: FilterKey, value: string | null) => setParams((p) => withFilter(p, k, value)),
    [setParams],
  );
  const clearFilters = useCallback(
    () => setParams((p) => withPeriod(new URLSearchParams(), parsePeriod(p))),
    [setParams],
  );

  return { params, query, period, filters, tz: TZ, setPeriod, setFilter, clearFilters, setParams };
}

export { TZ as timeZone };
