import { useEffect, useRef, useState } from 'react';
import { createRandom } from '~/lib/random';

export interface LivePoint {
  time: number;
  value: number;
}

const WINDOW_SECONDS = 40;

/** A random walk of "visitors online", one point per second. */
export function useLiveVisitors(paused: boolean): { data: LivePoint[]; value: number } {
  const rand = useRef(createRandom(42));
  const [state, setState] = useState(() => {
    const now = Date.now() / 1000;
    const data: LivePoint[] = [];
    let v = 118;
    for (let i = WINDOW_SECONDS; i >= 0; i--) {
      v = step(v, rand.current);
      data.push({ time: now - i, value: v });
    }
    return { data, value: v };
  });

  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      setState((prev) => {
        const v = step(prev.value, rand.current);
        const now = Date.now() / 1000;
        const data = [...prev.data, { time: now, value: v }].filter((p) => p.time > now - WINDOW_SECONDS - 5);
        return { data, value: v };
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [paused]);

  return state;
}

function step(v: number, rand: () => number): number {
  const drift = (124 - v) * 0.08;
  const next = v + drift + (rand() - 0.5) * 14;
  return Math.max(60, Math.min(190, Math.round(next)));
}
