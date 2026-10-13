import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';

export interface ApiState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `fn` whenever `deps` change, aborting the previous request.
 * Stale responses are ignored. `fn` receives an AbortSignal.
 */
export function useApi<T>(fn: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], enabled = true): ApiState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fnRef.current(ctrl.signal).then(
      (result) => {
        if (ctrl.signal.aborted) return;
        setData(result);
        setLoading(false);
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(errorMessage(err) || 'Something went wrong.');
        setLoading(false);
      },
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
