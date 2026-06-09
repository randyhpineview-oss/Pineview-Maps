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
import { crewMemberPoints } from '../lib/crewPoints';

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

export default function CrewSidebar({
  shifts = [],
  selectedKey = null,
  onLocate,
  onClose,
}) {
  const now = new Date();
  // Flatten active shifts into per-member rows so the office can locate
  // anyone on the crew individually -- not just the lead. Each row
  // inherits the shift's safety tier (compliance is shift-wide) but
  // carries that member's own last-known location + time.
  const tierRank = { red: 0, yellow: 1, blue: 2, green: 3 };
  const rows = [];
  for (const shift of shifts) {
    if (!shift || shift.ended_at || shift.mode === 'off') continue;
    const tier = shift.status_tier || computeTier(shift, now);
    const crewSize = (shift.crew_members && shift.crew_members.length)
      || (1 + (shift.crew_user_ids || []).length);
    for (const p of crewMemberPoints(shift)) {
      rows.push({ ...p, tier, crewSize });
    }
  }
  // Sort: located first, then worst tier first, then lead first within
  // a shift, then by name. This puts "who needs attention AND we know
  // where they are" at the top.
  rows.sort((a, b) => {
    const aLoc = Number.isFinite(a.lat) ? 0 : 1;
    const bLoc = Number.isFinite(b.lat) ? 0 : 1;
    if (aLoc !== bLoc) return aLoc - bLoc;
    const t = (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9);
    if (t !== 0) return t;
    if (a.shiftId !== b.shiftId) return a.shiftId - b.shiftId;
    if (a.isLead !== b.isLead) return a.isLead ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
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
          Crew on shift ({rows.length})
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

      {rows.length === 0 ? (
        <div style={{ color: '#9ab1d6', fontSize: '0.82rem', padding: '0.5rem 0' }}>
          No one is checked in right now.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map((p) => {
            const colors = tierColors(p.tier);
            const hasLoc = Number.isFinite(p.lat) && Number.isFinite(p.lon);
            const stale =
              p.updatedAt && Date.now() - new Date(p.updatedAt).getTime() > STALE_MS;
            const isSelected = selectedKey === p.key;
            return (
              <div
                key={p.key}
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
                  title={tierLabel(p.tier)}
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
                    {p.name}
                    {p.mode === 'crew' && p.isLead ? ' (lead)' : ''}
                    {p.mode === 'crew' && !p.isLead ? ` (crew of ${p.crewSize})` : ''}
                  </div>
                  <div style={{ color: colors.bg, fontSize: '0.72rem' }}>
                    {tierLabel(p.tier)}
                    <span style={{ color: '#9ab1d6' }}>
                      {' · '}
                      📍 {relativeTime(p.updatedAt)}
                      {stale ? ' (stale)' : ''}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!hasLoc}
                  onClick={() => hasLoc && onLocate?.(p)}
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
