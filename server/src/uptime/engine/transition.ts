// Status transitions (docs/SPEC.md §8.2, ANALYSIS §1.3–1.5): a pure function reproducing
// Uptime Kuma's retry / "important beat" / notification / resend / upside-down rules.
import { STATUS } from '../types.js';

export type EngineStatus = -1 | 0 | 1 | 2 | 3;

/** The part of the persisted monitor state the transition depends on. */
export interface TransitionState {
  /** -1 = no beat yet (the next beat is the "first beat"). */
  status: EngineStatus;
  /** Consecutive failed checks (keeps counting while DOWN, like Kuma). */
  retries: number;
  /** Non-important DOWN beats since the last notification (resend counter, Kuma's down_count). */
  failedSinceNotify: number;
  /** Open outage (first failed check → recovery). */
  outageOpen: boolean;
  outageConfirmed: boolean;
}

export type TransitionInput =
  /** A check ran: `ok` is the raw checker outcome (before upside-down inversion). */
  | { kind: 'check'; ok: boolean; msg: string; latencyMs?: number | null }
  /**
   * Engine-defined status (group, manual): no retries and no upside-down inversion.
   * `noOutage`: the status only means "no data yet" (manual monitor without a status, empty
   * group), not a failure: it never opens or confirms an outage, and closes an open one.
   */
  | { kind: 'custom'; status: 0 | 1 | 2; msg: string; noOutage?: boolean };

export interface TransitionSettings {
  maxRetries: number;
  /** 0 = never, else re-notify every N consecutive non-important DOWN beats. */
  resendEvery: number;
  upsideDown: boolean;
}

export type NotifyKind = 'down' | 'up' | 'resend';

export interface TransitionOutput {
  status: 0 | 1 | 2 | 3;
  retries: number;
  failedSinceNotify: number;
  msg: string;
  /** Latency is only kept for UP beats. */
  latencyMs: number | null;
  /** Kuma's "important" beat: stored as an event (status change). */
  important: boolean;
  notify: NotifyKind | null;
  /** Outage bookkeeping for this beat. */
  outage: { open: boolean; confirm: boolean; close: boolean };
}

const { DOWN, UP, PENDING, MAINTENANCE } = STATUS;

/**
 * Kuma `Monitor.isImportantBeat`: first beat, and the transitions
 * UP→DOWN, PENDING→DOWN, DOWN→UP, MAINTENANCE→UP, MAINTENANCE→DOWN, UP→MAINTENANCE, DOWN→MAINTENANCE.
 * Not important: UP→PENDING, PENDING→UP, PENDING→PENDING, X→X, PENDING↔MAINTENANCE.
 */
export function isImportantBeat(isFirst: boolean, prev: number, cur: number): boolean {
  if (isFirst) return true;
  if (cur === DOWN) return prev === UP || prev === PENDING || prev === MAINTENANCE;
  if (cur === UP) return prev === DOWN || prev === MAINTENANCE;
  if (cur === MAINTENANCE) return prev === UP || prev === DOWN;
  return false;
}

/**
 * Kuma `Monitor.isImportantForNotification`: like isImportantBeat, but entering maintenance and
 * MAINTENANCE→UP are silent. A first beat only notifies when it is DOWN (Kuma `sendNotification`).
 */
export function isImportantForNotification(isFirst: boolean, prev: number, cur: number): boolean {
  if (isFirst) return cur === DOWN;
  if (cur === DOWN) return prev === UP || prev === PENDING || prev === MAINTENANCE;
  if (cur === UP) return prev === DOWN;
  return false;
}

const UPSIDE_DOWN_MSG = 'Check succeeded but upside-down mode expects a failure';

/**
 * (state, result, settings, inMaintenance) → next state + beat + event/notification decisions.
 * Never throws; inputs are trusted (validated when the monitor was saved).
 */
export function transition(
  prev: TransitionState,
  input: TransitionInput,
  settings: TransitionSettings,
  inMaintenance: boolean,
): TransitionOutput {
  const isFirst = prev.status === -1;
  let status: 0 | 1 | 2 | 3;
  let retries = prev.retries;
  let msg: string;
  let latencyMs: number | null = null;

  if (inMaintenance) {
    // The check is not executed; Kuma resets the retry counter.
    status = MAINTENANCE;
    retries = 0;
    msg = 'Under maintenance';
  } else if (input.kind === 'custom') {
    status = input.status;
    retries = input.status === UP ? 0 : retries;
    msg = input.msg;
  } else {
    const success = settings.upsideDown ? !input.ok : input.ok;
    if (success) {
      status = UP;
      retries = 0;
      msg = input.msg; // upside down: the failure message explains the "up"
      latencyMs = input.ok && typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs) ? Math.max(0, Math.round(input.latencyMs)) : null;
    } else {
      msg = input.ok ? `${UPSIDE_DOWN_MSG}: ${input.msg}` : input.msg;
      if (settings.maxRetries > 0 && retries < settings.maxRetries) {
        retries++;
        status = PENDING;
      } else {
        // Continue counting retries while DOWN (so DOWN never goes back to PENDING).
        retries++;
        status = DOWN;
      }
    }
  }

  const important = isImportantBeat(isFirst, prev.status, status);
  let notify: NotifyKind | null = null;
  let failedSinceNotify = prev.failedSinceNotify;
  if (important) {
    if (isImportantForNotification(isFirst, prev.status, status)) notify = status === UP ? 'up' : 'down';
    failedSinceNotify = 0;
  } else if (status === DOWN && settings.resendEvery > 0) {
    failedSinceNotify++;
    if (failedSinceNotify >= settings.resendEvery) {
      notify = 'resend';
      failedSinceNotify = 0;
    }
  }

  const noData = !inMaintenance && input.kind === 'custom' && input.noOutage === true;
  const failing = !noData && (status === DOWN || status === PENDING);
  const outage = { open: false, confirm: false, close: false };
  if (failing) {
    if (!prev.outageOpen) outage.open = true;
    if (status === DOWN && !(prev.outageOpen && prev.outageConfirmed)) outage.confirm = true;
  } else if (prev.outageOpen) {
    outage.close = true;
  }

  return { status, retries, failedSinceNotify, msg, latencyMs, important, notify, outage };
}

/** Apply a transition output to the state (convenience for callers and tests). */
export function nextState(prev: TransitionState, out: TransitionOutput): TransitionState {
  const outageOpen = out.outage.close ? false : prev.outageOpen || out.outage.open;
  const outageConfirmed = out.outage.close ? false : out.outage.open ? out.outage.confirm : prev.outageConfirmed || out.outage.confirm;
  return { status: out.status, retries: out.retries, failedSinceNotify: out.failedSinceNotify, outageOpen, outageConfirmed };
}
