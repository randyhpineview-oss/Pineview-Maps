// Single-source-of-truth compliance helpers, mirrored from
// backend/app/checkin_cadence.py. Anything that affects which colour
// the countdown / overview card shows lives HERE so the frontend can
// recompute on every local tick without a server roundtrip.
//
// Tier definitions (must match backend `tier()`):
//   green  -- on shift, > 15 min to next deadline
//   yellow -- T-15 to T+2 (approaching deadline)
//   red    -- > T+3 overdue
//   blue   -- shift started < 5 min ago, no check-in yet (just starting up)
//   idle   -- truck-assigned but no shift today
//   off    -- shift ended OR mode === 'off'
//
// Used by:
//   * CheckinCountdown.jsx -- the topbar pill colour + label
//   * EmployeeStatusCard.jsx -- the Overview tab card tier
//   * MyCheckInsOverlay.jsx -- the giant I'm OK button colour
//   * App.jsx forced-overlay effect -- threshold for showing the overlay

/**
 * Return the compliance tier for a shift object.
 *
 * @param {object|null|undefined} shift  Shift JSON from the API (or null when
 *                                       no active shift).
 * @param {Date}                  [now]  Override clock (testing).
 * @returns {'green'|'yellow'|'red'|'blue'|'idle'|'off'}
 */
export function tier(shift, now = new Date()) {
  if (!shift) return 'idle';
  if (shift.ended_at) return 'off';
  if (shift.mode === 'off') return 'off';

  // Blue: just-started, no check-in yet. Distinct tier on the Overview
  // tab so admins can spot "starting up" vs "fully active". 5 min window.
  if (!shift.last_checkin_at && shift.started_at) {
    const startedMs = new Date(shift.started_at).getTime();
    if (now.getTime() - startedMs < 5 * 60_000) return 'blue';
  }

  if (!shift.next_deadline_at) return 'green';
  const deadlineMs = new Date(shift.next_deadline_at).getTime();
  const minutesTo = (deadlineMs - now.getTime()) / 60_000;
  if (minutesTo > 15) return 'green';
  if (minutesTo > -3) return 'yellow';
  return 'red';
}

/**
 * Whether the forced "I'm OK" overlay should be showing right now.
 * True iff the shift is active AND deadline is within 5 minutes (T-5 or later)
 * AND the worker hasn't already checked in within the last minute.
 *
 * @param {object|null|undefined} shift
 * @param {Date}                  [now]
 * @returns {boolean}
 */
export function shouldForceOverlay(shift, now = new Date()) {
  if (!shift || shift.ended_at || shift.mode === 'off') return false;
  if (!shift.next_deadline_at) return false;
  const deadlineMs = new Date(shift.next_deadline_at).getTime();
  const minutesTo = (deadlineMs - now.getTime()) / 60_000;
  if (minutesTo > 5) return false;
  // Suppress for 60 s right after a successful check-in so the worker
  // doesn't see the overlay flash open and immediately close on their
  // own tap.
  if (shift.last_checkin_at) {
    const lastMs = new Date(shift.last_checkin_at).getTime();
    if (now.getTime() - lastMs < 60_000) return false;
  }
  return true;
}

/**
 * Format a countdown for the topbar.
 *
 * Wide:    "1:47:32"  (h:mm:ss while > 1 h to deadline)
 *          "47:32"    (m:ss while < 1 h)
 *          "OVERDUE 12:34"  (when past the deadline)
 * Narrow:  "1h47m"    (drops seconds on viewports < 360 px so the
 *                      digits stop jittering and the pill fits)
 *
 * @param {object|null} shift
 * @param {Date}        [now]
 * @param {boolean}     [narrow]  Narrow format (smaller display).
 * @returns {string}
 */
export function formatCountdown(shift, now = new Date(), narrow = false) {
  if (!shift || shift.ended_at || !shift.next_deadline_at) return '';
  const deadlineMs = new Date(shift.next_deadline_at).getTime();
  const diffSec = Math.round((deadlineMs - now.getTime()) / 1000);
  const overdue = diffSec < 0;
  const absSec = Math.abs(diffSec);
  const h = Math.floor(absSec / 3600);
  const m = Math.floor((absSec % 3600) / 60);
  const s = absSec % 60;

  if (narrow) {
    if (h > 0) return `${overdue ? '-' : ''}${h}h${String(m).padStart(2, '0')}m`;
    return `${overdue ? '-' : ''}${m}m${String(s).padStart(2, '0')}s`;
  }
  const padded = (n) => String(n).padStart(2, '0');
  const tail = h > 0 ? `${h}:${padded(m)}:${padded(s)}` : `${m}:${padded(s)}`;
  return overdue ? `OVERDUE ${tail}` : tail;
}

/**
 * Compose a human label for a status tier (used in cards + tooltips).
 *
 * @param {string} t
 * @returns {string}
 */
export function tierLabel(t) {
  switch (t) {
    case 'green': return 'OK';
    case 'yellow': return 'Due soon';
    case 'red': return 'OVERDUE';
    case 'blue': return 'Just started';
    case 'idle': return 'Not started yet';
    case 'off': return 'Off shift';
    case 'checked_out': return 'Checked out';
    default: return t || '';
  }
}

/**
 * Background + foreground colour pair for a tier. Used for the countdown
 * pill, overview cards, and the giant I'm OK button. RGB hexes chosen to
 * pass WCAG AA contrast against the foreground colour.
 */
export function tierColors(t) {
  switch (t) {
    case 'green':  return { bg: '#16a34a', fg: '#ffffff', accent: '#15803d' };
    case 'yellow': return { bg: '#facc15', fg: '#1f2937', accent: '#ca8a04' };
    case 'red':    return { bg: '#dc2626', fg: '#ffffff', accent: '#991b1b' };
    case 'blue':   return { bg: '#2563eb', fg: '#ffffff', accent: '#1d4ed8' };
    case 'idle':   return { bg: '#9ca3af', fg: '#ffffff', accent: '#6b7280' };
    case 'off':    return { bg: '#6b7280', fg: '#ffffff', accent: '#374151' };
    case 'checked_out': return { bg: '#4b5563', fg: '#e5e7eb', accent: '#374151' };
    default:       return { bg: '#9ca3af', fg: '#ffffff', accent: '#6b7280' };
  }
}
