/**
 * CrewLayer — live worker/truck positions derived from active check-in
 * shifts' passive "last known location" (shifts.last_loc_*).
 *
 * This is the read side of the foreground location reporter: while a
 * worker has the app open on an active shift, App.jsx pings their GPS to
 * the server, which lands on the shift row. The office map renders one
 * pin per active shift that has a position. The pin colour follows the
 * check-in compliance tier (green = OK, yellow = due soon, red =
 * overdue) so the office sees safety status + location in one glance.
 *
 * Privacy: a shift only appears here while it's active. Once the worker
 * checks out the shift drops off /api/admin/shifts/active and the pin
 * disappears on the next refresh — matching the "stop showing location
 * after checkout" rule. The last known spot is never re-broadcast.
 *
 * Must be a child of <GoogleMap> (uses Marker + OverlayView from
 * @react-google-maps/api). Mirrors TrucksLayer's marker-key discipline:
 * the key includes the tier + selection so a tier change cleanly
 * remounts the icon; position updates apply via the `position` prop.
 */
import { useEffect, useState } from 'react';
import { Marker, OverlayView } from '@react-google-maps/api';

import { tier as computeTier, tierColors, tierLabel } from '../lib/compliance';

// A teardrop person-pin. Larger than a site pin so a moving crew is easy
// to spot among stationary lease pins on a satellite view.
function crewSvg(colorHex, isSelected) {
  const stroke = isSelected ? '#ffffff' : 'rgba(255,255,255,0.85)';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="48" viewBox="0 0 40 48">
    <ellipse cx="20" cy="45" rx="9" ry="2.5" fill="rgba(0,0,0,0.35)"/>
    <path d="M20 2C11.7 2 5 8.7 5 17c0 10.5 15 27 15 27s15-16.5 15-27C35 8.7 28.3 2 20 2z"
      fill="${colorHex}" stroke="${stroke}" stroke-width="2"/>
    <circle cx="20" cy="14" r="4.2" fill="#ffffff"/>
    <path d="M12.5 25c0-4.4 3.4-7.5 7.5-7.5s7.5 3.1 7.5 7.5z" fill="#ffffff"/>
  </svg>`;
}

function buildCrewIcon(colorHex, isSelected) {
  const svg = crewSvg(colorHex || '#22c55e', isSelected);
  const w = isSelected ? 52 : 36;
  const h = isSelected ? 62 : 43;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: window.google ? new window.google.maps.Size(w, h) : undefined,
    anchor: window.google ? new window.google.maps.Point(w / 2, h) : undefined,
  };
}

function relativeTime(iso) {
  if (!iso) return 'no fix yet';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'no fix yet';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return 'just now';
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

// A location older than this (ms) is "stale" — the worker likely
// backgrounded the app (iOS can't report in the background). We dim the
// pin and flag it in the popup so the office doesn't over-trust an old
// fix as the truck's current spot.
const STALE_MS = 2 * 60 * 60_000;

function crewName(shift) {
  if (shift.user_name) return shift.user_name;
  if (Array.isArray(shift.crew_members) && shift.crew_members.length) {
    return shift.crew_members.map((m) => m.name).filter(Boolean).join(', ');
  }
  return shift.crew_freeform || `Shift #${shift.id}`;
}

export default function CrewLayer({
  shifts = [],
  visible = true,
  selectedShiftId = null,
  onSelectShift,
}) {
  // 30 s tick so "X min ago" + the stale/dim treatment stay current
  // without a network call.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!visible) return null;

  const now = new Date();
  const renderable = shifts.filter(
    (s) =>
      !s.ended_at &&
      s.mode !== 'off' &&
      Number.isFinite(s.last_loc_lat) &&
      Number.isFinite(s.last_loc_lon),
  );

  const activePopup = selectedShiftId != null
    ? renderable.find((s) => s.id === selectedShiftId) || null
    : null;

  return (
    <>
      {renderable.map((shift) => {
        const t = shift.status_tier || computeTier(shift, now);
        const colorHex = tierColors(t).bg;
        const isSelected = selectedShiftId === shift.id;
        const stale =
          shift.last_loc_at &&
          Date.now() - new Date(shift.last_loc_at).getTime() > STALE_MS;
        const mKey = `crew-${shift.id}-${t}-${isSelected ? 'sel' : 'norm'}-${stale ? 'stale' : 'fresh'}`;
        return (
          <Marker
            key={mKey}
            position={{ lat: shift.last_loc_lat, lng: shift.last_loc_lon }}
            icon={buildCrewIcon(colorHex, isSelected)}
            opacity={stale ? 0.55 : 1}
            zIndex={isSelected ? 620 : 520}
            onClick={() => onSelectShift?.(shift.id)}
          />
        );
      })}

      {activePopup ? (() => {
        const t = activePopup.status_tier || computeTier(activePopup, now);
        const colorHex = tierColors(t).bg;
        const stale =
          activePopup.last_loc_at &&
          Date.now() - new Date(activePopup.last_loc_at).getTime() > STALE_MS;
        return (
          <OverlayView
            position={{ lat: activePopup.last_loc_lat, lng: activePopup.last_loc_lon }}
            mapPaneName={OverlayView.FLOAT_PANE}
            getPixelPositionOffset={(w, h) => ({ x: -(w / 2), y: -(h + 50) })}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
              style={{
                background: '#0f1c33',
                color: '#e5eefb',
                border: '1px solid rgba(143,182,255,0.2)',
                borderRadius: '0.5rem',
                padding: '0.6rem 0.8rem',
                minWidth: '11rem',
                maxWidth: '16rem',
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                fontSize: '0.85rem',
                lineHeight: 1.35,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: colorHex,
                    border: '1px solid rgba(255,255,255,0.25)',
                    flexShrink: 0,
                  }}
                />
                <strong style={{ flexGrow: 1, minWidth: 0 }}>{crewName(activePopup)}</strong>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => onSelectShift?.(null)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#9ab1d6',
                    cursor: 'pointer',
                    padding: '0 0.25rem',
                    fontSize: '1rem',
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </div>
              <div style={{ marginTop: '0.4rem', color: '#9ab1d6', fontSize: '0.78rem' }}>
                <div style={{ color: colorHex }}>🛟 {tierLabel(t)}</div>
                <div>📍 {relativeTime(activePopup.last_loc_at)}{stale ? ' (stale)' : ''}</div>
                {Number.isFinite(activePopup.last_loc_accuracy_m) ? (
                  <div>🎯 ±{Math.round(activePopup.last_loc_accuracy_m)} m</div>
                ) : null}
                {activePopup.mode === 'crew' ? <div>👥 Crew</div> : <div>🧍 Solo</div>}
                {stale ? (
                  <div style={{ marginTop: '0.3rem', color: '#fbbf24', fontSize: '0.72rem' }}>
                    App backgrounded — location not updating.
                  </div>
                ) : null}
              </div>
            </div>
          </OverlayView>
        );
      })() : null}
    </>
  );
}
