import { type RefObject, useEffect, useState } from 'react';

/**
 * `true` once the element came within `rootMargin` of the viewport (latches).
 * Used to lazy-render heavy charts below the fold.
 */
export function useInViewOnce<T extends Element>(ref: RefObject<T | null>, rootMargin = '200px'): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin, seen]);
  return seen;
}

/** Live visibility (not latched) — used to pause animations that are off-screen. */
export function useIsVisible<T extends Element>(ref: RefObject<T | null>): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setVisible(entry.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}
