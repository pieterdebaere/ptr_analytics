// Time-weighted uptime aggregation (ANALYSIS §8.2): each beat's status holds from its timestamp
// until the next beat, capped at `interval + timeout + 5 s` (beyond: no data). Durations are split
// across UTC hour/day bucket boundaries.

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export interface StatDelta {
  up_ms: number;
  down_ms: number;
  pending_ms: number;
  maint_ms: number;
  checks: number;
  failures: number;
  lat_n: number;
  lat_sum: number;
  lat_min: number | null;
  lat_max: number | null;
}

export const emptyDelta = (): StatDelta => ({
  up_ms: 0,
  down_ms: 0,
  pending_ms: 0,
  maint_ms: 0,
  checks: 0,
  failures: 0,
  lat_n: 0,
  lat_sum: 0,
  lat_min: null,
  lat_max: null,
});

/** Longest time a beat's status is assumed to hold. */
export function gapCapMs(intervalS: number, retryIntervalS: number, timeoutMs: number): number {
  return Math.max(intervalS, retryIntervalS) * 1000 + timeoutMs + 5000;
}

export const bucketOf = (ts: number, size: number): number => Math.floor(ts / size) * size;

/** Split [from, to) into pieces per bucket of `size` ms (UTC aligned). */
export function splitRange(from: number, to: number, size: number): Array<{ bucket: number; ms: number }> {
  const out: Array<{ bucket: number; ms: number }> = [];
  if (!(to > from)) return out;
  let t = from;
  while (t < to) {
    const bucket = bucketOf(t, size);
    const end = Math.min(to, bucket + size);
    out.push({ bucket, ms: end - t });
    t = end;
  }
  return out;
}

export interface PrevBeat {
  ts: number;
  status: number;
}

export interface Beat {
  ts: number;
  status: number;
  latencyMs: number | null;
  /** Counts as a check (maintenance beats are not checks). */
  counted: boolean;
}

function durationKey(status: number): keyof Pick<StatDelta, 'up_ms' | 'down_ms' | 'pending_ms' | 'maint_ms'> | null {
  switch (status) {
    case 0:
      return 'down_ms';
    case 1:
      return 'up_ms';
    case 2:
      return 'pending_ms';
    case 3:
      return 'maint_ms';
    default:
      return null;
  }
}

/**
 * Contributions of one beat to the buckets of `size`: the time since the previous beat (with the
 * previous status, capped) plus the check counters / latency of the new beat.
 */
export function beatContributions(prev: PrevBeat | null, beat: Beat, capMs: number, size: number): Map<number, StatDelta> {
  const out = new Map<number, StatDelta>();
  const get = (bucket: number): StatDelta => {
    let d = out.get(bucket);
    if (!d) {
      d = emptyDelta();
      out.set(bucket, d);
    }
    return d;
  };
  if (prev) {
    const key = durationKey(prev.status);
    // Clock steps backwards: never negative; gaps beyond the cap: no data.
    const end = Math.min(beat.ts, prev.ts + capMs);
    if (key && end > prev.ts) {
      for (const piece of splitRange(prev.ts, end, size)) get(piece.bucket)[key] += piece.ms;
    }
  }
  if (beat.counted) {
    const d = get(bucketOf(beat.ts, size));
    d.checks++;
    if (beat.status === 0 || beat.status === 2) d.failures++;
    if (beat.status === 1 && beat.latencyMs !== null) {
      d.lat_n++;
      d.lat_sum += beat.latencyMs;
      d.lat_min = d.lat_min === null ? beat.latencyMs : Math.min(d.lat_min, beat.latencyMs);
      d.lat_max = d.lat_max === null ? beat.latencyMs : Math.max(d.lat_max, beat.latencyMs);
    }
  }
  return out;
}

export function mergeDelta(into: StatDelta, d: StatDelta): void {
  into.up_ms += d.up_ms;
  into.down_ms += d.down_ms;
  into.pending_ms += d.pending_ms;
  into.maint_ms += d.maint_ms;
  into.checks += d.checks;
  into.failures += d.failures;
  into.lat_n += d.lat_n;
  into.lat_sum += d.lat_sum;
  if (d.lat_min !== null) into.lat_min = into.lat_min === null ? d.lat_min : Math.min(into.lat_min, d.lat_min);
  if (d.lat_max !== null) into.lat_max = into.lat_max === null ? d.lat_max : Math.max(into.lat_max, d.lat_max);
}

/** Uptime ratio of aggregated durations (maintenance and no-data excluded); null when empty. */
export function uptimeRatio(d: { up_ms: number; down_ms: number; pending_ms: number }): number | null {
  const total = d.up_ms + d.down_ms + d.pending_ms;
  return total > 0 ? d.up_ms / total : null;
}
