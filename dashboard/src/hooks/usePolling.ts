import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';
import { usePageVisible } from './usePageVisible';

export interface PollingState<T> {
  data: T | undefined;
  error: string | null;
  /** HTTP status of the last failure (e.g. 404 when the server lacks the endpoint) */
  errorStatus: number | null;
}

/**
 * Calls `fn` immediately and then every `intervalMs` while the page is visible
 * (paused in background tabs). In-flight requests are aborted on change/unmount.
 * `onData` runs for every successful response (e.g. to accumulate a series).
 */
export function usePolling<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  deps: readonly unknown[],
  onData?: (data: T) => void,
): PollingState<T> {
  const visible = usePageVisible();
  const [state, setState] = useState<PollingState<T>>({ data: undefined, error: null, errorStatus: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  // Reset when the target changes (e.g. another site).
  useEffect(() => {
    setState({ data: undefined, error: null, errorStatus: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!visible) return;
    let ctrl = new AbortController();
    let stopped = false;
    const load = () => {
      ctrl.abort();
      ctrl = new AbortController();
      const signal = ctrl.signal;
      fnRef.current(signal).then(
        (data) => {
          if (signal.aborted || stopped) return;
          onDataRef.current?.(data);
          setState({ data, error: null, errorStatus: null });
        },
        (err: unknown) => {
          if (signal.aborted || stopped) return;
          const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null;
          setState((s) => ({ data: s.data, error: errorMessage(err) || 'Something went wrong.', errorStatus: status }));
        },
      );
    };
    load();
    const timer = window.setInterval(load, intervalMs);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, visible, intervalMs]);

  return state;
}
