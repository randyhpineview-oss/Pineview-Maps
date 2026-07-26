import { useEffect, useState } from 'react';

/** Match App Support / overlay exit duration (~180–200ms). */
export const OVERLAY_EXIT_MS = 200;

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Keep a conditionally rendered UI mounted through a short exit animation
 * after `open` becomes false. Render when `mounted`; add a `--closing`
 * class when `closing` so CSS can run exit keyframes before unmount.
 */
export function useAnimatedPresence(open, exitMs = OVERLAY_EXIT_MS) {
  const [state, setState] = useState(() => ({
    mounted: Boolean(open),
    closing: false,
  }));

  useEffect(() => {
    if (open) {
      setState({ mounted: true, closing: false });
      return undefined;
    }
    setState((prev) => {
      if (!prev.mounted) return prev;
      if (prefersReducedMotion()) {
        return { mounted: false, closing: false };
      }
      return { mounted: true, closing: true };
    });
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!state.closing) return undefined;
    const timer = window.setTimeout(() => {
      setState({ mounted: false, closing: false });
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [state.closing, exitMs]);

  return state;
}
