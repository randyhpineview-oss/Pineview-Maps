/**
 * CrewSidebar — manager-only list of active check-in shifts with their
 * live "last known location" + safety status, each with a "Locate"
 * button that pans/zooms the map to that crew and opens its pin popup.
 *
 * Data is the same `crewShifts` array that feeds the map's CrewLayer
 * (active shifts with a passive last_loc). Shifts without a position yet
 * are still listed (so the office knows someone's on shift) but their
 * Locate button is disabled.
 *
 * Privacy: only active shifts appear; a checked-out worker drops off the
 * source list and disappears here on the next refresh.
 */
import { tier as computeTier, tierColors, tierLabel } from '../lib/compliance';

const STALE_MS = 2 * 60 * 60_000;

function relativeTime(iso) {
  if (!iso) return 'no location yet';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'no location yet';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return 'just now';
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

function crewName(shift) {
  if (shift.user_name) return shift.user_name;
  if (Array.isArray(shift.crew_members) && shift.crew_members.length) {
    return shift.crew_members.map((m) => m.name).filter(Boolean).join(', ');
  }
  return shift.crew_freeform || `Shift #${shift.id}`;
}

export default function CrewSidebar({
  shifts = [],
  selectedShiftId = null,
  onLocate,
  onClose,
}) {
  const now = new Date();
  // Active, non-off shifts. Sort: those with a location first, then by
  // worst (most overdue) status so the office sees who needs attention.
  const tierRank = { red: 0, yellow: 1, blue: 2, green: 3 };
  const active = shifts
    .filter((s) => !s.ended_at && s.mode !== 'off')
    .slice()
    .sort((a, b) => {
      const aLoc = Number.isFinite(a.last_loc_lat) ? 0 : 1;
      const bLoc = Number.isFinite(b.last_loc_lat) ? 0 : 1;
      if (aLoc !== bLoc) return aLoc - bLoc;
      const at = a.status_tier || computeTier(a, now);
      const bt = b.status_tier || computeTier(b, now);
      return (tierRank[at] ?? 9) - (tierRank[bt] ?? 9);
    });

  return (
    <div className="crew-overlay">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <strong style={{ color: '#f5f8ff', fontSize: '0.9rem' }}>
          Crew on shift ({active.length})
        </strong>
        <button
          type="button"
          aria-label="Close"
          onClick={() => onClose?.()}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#9ab1d6',
            cursor: 'pointer',
            fontSize: '1.1rem',
            lineHeight: 1,
            padding: '0 0.25rem',
          }}
        >
          ×
        </button>
      </div>

      {active.length === 0 ? (
        <div style={{ color: '#9ab1d6', fontSize: '0.82rem', padding: '0.5rem 0' }}>
          No one is checked in right now.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {active.map((shift) => {
            const t = shift.status_tier || computeTier(shift, now);
            const colors = tierColors(t);
            const hasLoc =
              Number.isFinite(shift.last_loc_lat) &&
              Number.isFinite(shift.last_loc_lon);
            const stale =
              shift.last_loc_at &&
              Date.now() - new Date(shift.last_loc_at).getTime() > STALE_MS;
            const isSelected = selectedShiftId === shift.id;
            return (
              <div
                key={shift.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '0.5rem 0.6rem',
                  borderRadius: 10,
                  background: isSelected
                    ? 'rgba(143,182,255,0.14)'
                    : 'rgba(9,17,31,0.6)',
                  border: `1px solid ${isSelected ? 'rgba(143,182,255,0.4)' : 'rgba(143,182,255,0.12)'}`,
                }}
              >
                <span
                  aria-hidden
                  title={tierLabel(t)}
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: colors.bg,
                    border: '1px solid rgba(255,255,255,0.25)',
                    flexShrink: 0,
                  }}
                />
                <div style={{ flexGrow: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: '#e5eefb',
                      fontSize: '0.84rem',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {crewName(shift)}
                    {shift.mode === 'crew' ? ' 👥' : ''}
                  </div>
                  <div style={{ color: colors.bg, fontSize: '0.72rem' }}>
                    {tierLabel(t)}
                    <span style={{ color: '#9ab1d6' }}>
                      {' · '}
                      📍 {relativeTime(shift.last_loc_at)}
                      {stale ? ' (stale)' : ''}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!hasLoc}
                  onClick={() => hasLoc && onLocate?.(shift)}
                  style={{
                    flexShrink: 0,
                    borderRadius: 8,
                    border: '1px solid rgba(143,182,255,0.2)',
                    background: hasLoc ? 'rgba(143,182,255,0.16)' : 'rgba(9,17,31,0.6)',
                    color: hasLoc ? '#dbe7ff' : '#5f7396',
                    padding: '0.32rem 0.55rem',
                    fontSize: '0.74rem',
                    cursor: hasLoc ? 'pointer' : 'not-allowed',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Locate
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
