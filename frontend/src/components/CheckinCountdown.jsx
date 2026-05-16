/**
 * Topbar countdown pill.
 *
 * Visible on every screen size between the "Pineview Maps" title and
 * the Online/Offline badge (see App.jsx insertion point). Hidden when
 * the calling user has no active shift.
 *
 * Updates once per second via a local interval -- one element, one
 * timer, no network. The colour tier comes from `compliance.tier()` so
 * it transitions green->yellow->red exactly when the cadence math says
 * it should, without waiting for a server roundtrip.
 *
 * On narrow viewports (<360 px) the format collapses from h:mm:ss to
 * `1h47m` so the pill keeps fitting next to the title.
 */
import { useEffect, useState } from 'react';

import { formatCountdown, tier as computeTier, tierColors } from '../lib/compliance';

export default function CheckinCountdown({ shift, onOpen }) {
  // 1 s tick so the display animates smoothly. useState here is a
  // cheap re-render trigger -- the actual time math reads `new Date()`
  // inside formatCountdown so we don't need to thread `now` through props.
  const [, setTick] = useState(0);
  // Track narrow viewport for the format swap. ResizeObserver isn't
  // needed since we only care about <360 px (smallest phone) -- a
  // matchMedia listener is cheaper.
  const [narrow, setNarrow] = useState(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 360px)').matches,
  );

  useEffect(() => {
    if (!shift || shift.ended_at) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [shift?.id, shift?.ended_at]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mq = window.matchMedia('(max-width: 360px)');
    const onChange = (e) => setNarrow(e.matches);
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    // Safari < 14 fallback.
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  // Hide entirely when the user has no active shift (or it's an 'off' record).
  if (!shift || shift.ended_at || shift.mode === 'off') return null;

  const now = new Date();
  const tier = computeTier(shift, now);
  const label = formatCountdown(shift, now, narrow);
  const colors = tierColors(tier);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="topbar-checkin-countdown"
      aria-label={`Open check-in. ${label} to next deadline.`}
      title="Open Check-ins"
      style={{
        background: 'transparent',
        border: `1.5px solid ${colors.bg}`,
        color: colors.fg,
      }}
    >
      <span aria-hidden style={{ marginRight: 4 }}>🛟</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{label}</span>
    </button>
  );
}
