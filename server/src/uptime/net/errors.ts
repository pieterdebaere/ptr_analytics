// Error types of the network layer. Messages are short and never contain secrets.
import type { TlsInfo } from '../types.js';

export class NetError extends Error {
  override name = 'NetError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The certificate was rejected (rejectUnauthorized); `tls` carries what was presented. */
export class TlsCertificateError extends NetError {
  override name = 'TlsCertificateError';
  constructor(
    message: string,
    readonly tls: TlsInfo,
  ) {
    super('ECERT', message);
  }
}

export function abortError(signal: AbortSignal): NetError {
  const reason = signal.reason as { name?: string } | undefined;
  if (reason && reason.name === 'TimeoutError') return new NetError('ETIMEOUT', 'timeout');
  return new NetError('EABORT', reason && reason.name === 'AbortError' ? 'aborted' : 'timeout');
}

/**
 * Runs `fn` with an abort hook: when `signal` fires, `onAbort` is called (destroy sockets …) and
 * the returned promise rejects with abortError(signal).
 */
export function withAbort<T>(signal: AbortSignal, onAbort: () => void, fn: () => Promise<T>): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const listener = (): void => {
      try {
        onAbort();
      } finally {
        reject(abortError(signal));
      }
    };
    signal.addEventListener('abort', listener, { once: true });
    fn().then(
      (v) => {
        signal.removeEventListener('abort', listener);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', listener);
        reject(signal.aborted ? abortError(signal) : e);
      },
    );
  });
}
