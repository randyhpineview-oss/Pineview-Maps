/**
 * Shared bits for the Active + Overview tab cards on the Check-ins
 * Dashboard:
 *
 *   - useCheckinFlash(lastCheckinIso, shiftId)
 *       Returns a className string that's `checkin-flash` for ~4s
 *       whenever last_checkin_at advances. Resets on shift change so
 *       cards don't flash on initial mount, only on actual new taps.
 *       Powers the "live TV feed" green-glow visual the office sees
 *       when a worker checks in/out.
 *
 *   - <CheckinList shift /> renders today's check-in taps as a
 *       compact vertical list inside each shift card. Displays the
 *       tap time + "(crew member name)" when a teammate tapped.
 *       Backend embeds these on the admin shift / overview rows so no
 *       extra fetch is needed.
 */
import { useEffect, useRef, useState } from 'react';

import { t } from '../../lib/checkinTheme';

const FLASH_MS = 4000;

export function useCheckinFlash(lastCheckinIso, shiftId) {
  const [flashing, setFlashing] = useState(false);
  // Track the previously-seen value per shift so initial mount /
  // shift change does NOT trigger a flash -- only an actual change
  // while we're watching this shift.
  const prevRef = useRef({ shiftId: null, iso: null });
  const timerRef = useRef(null);

  useEffect(() => {
    const prev = prevRef.current;
    if (prev.shiftId !== shiftId) {
      // First render for this shift -- baseline only.
      prevRef.current = { shiftId, iso: lastCheckinIso || null };
      return;
    }
    if (lastCheckinIso && lastCheckinIso !== prev.iso) {
      prevRef.current = { shiftId, iso: lastCheckinIso };
      setFlashing(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setFlashing(false), FLASH_MS);
    }
  }, [lastCheckinIso, shiftId]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return flashing ? 'checkin-flash' : '';
}

function fmtTimeShort(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * Compact vertical list of every check-in tap for a shift today.
 * Shows newest-first so the most recent activity is glanceable on the
 * TV. Falls back to a neutral "No check-ins yet" line for shifts that
 * just started.
 */
export function CheckinList({ shift, leadName }) {
  const checkins = Array.isArray(shift?.checkins) ? shift.checkins : [];
  // Newest first.
  const sorted = [...checkins].sort((a, b) => {
    const at = new Date(a.created_at).getTime();
    const bt = new Date(b.created_at).getTime();
    return bt - at;
  });
  return (
    <div>
      <div style={{
        fontSize: 12, color: t.text, fontWeight: 600,
        marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span>Check-ins today</span>
        <span style={{
          background: t.cardBgRaised, color: t.textMuted,
          borderRadius: 999, padding: '0 6px', fontSize: 11, fontWeight: 600,
        }}>{sorted.length}</span>
      </div>
      {sorted.length === 0 ? (
        <div style={{ fontSize: 12, color: t.textMuted, fontStyle: 'italic' }}>
          No check-ins yet.
        </div>
      ) : (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 2,
          maxHeight: 140, overflowY: 'auto',
          paddingLeft: 8, borderLeft: `2px solid ${t.divider}`,
        }}>
          {sorted.map((c) => {
            // Show a name suffix only when the tap was by someone other
            // than the shift lead (i.e. a crew teammate) -- keeps the
            // common single-worker case clean.
            const tapper = c.user_name && c.user_name !== leadName
              ? c.user_name
              : null;
            return (
              <div key={c.id} style={{
                fontSize: 12, color: t.textSubtle,
                display: 'flex', gap: 6, alignItems: 'baseline',
              }}>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: t.text }}>
                  {fmtTimeShort(c.created_at)}
                </span>
                {tapper ? (
                  <span style={{ color: t.textMuted }}>· {tapper}</span>
                ) : null}
                {c.recorded_by_name ? (
                  <span style={{ color: t.warning, fontSize: 11 }}>
                    · forced by {c.recorded_by_name}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
