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
import { crewMemberPoints, bestLocatedPoint } from '../lib/crewPoints';

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

// onLeadClick: pre-resolved callback (with fallback point) supplied by parent
// locateTarget: the point the Locate button should zoom to (may differ from p
//   when the lead has no fix — bestLocatedPoint provides a crew fallback).
function MemberRow({ p, isSelected, colors, tier, isCrew, crewSize, isExpanded, onLocate, onToggle, onLeadClick, locateTarget, isMate = false }) {
  if (!p) return null;
  // For the Locate button: use the explicit locateTarget when provided
  // (crew-fallback for lead rows), otherwise fall back to the member's own point.
  const resolvedTarget = locateTarget || p;
  const hasLoc = Number.isFinite(resolvedTarget.lat) && Number.isFinite(resolvedTarget.lon);
  const stale = p.updatedAt && Date.now() - new Date(p.updatedAt).getTime() > STALE_MS;
  // For the lead row of a crew shift, clicking the name area expands the crew
  // and navigates to the best available location — no separate chevron needed.
  const nameClickable = !isMate && isCrew && !!onToggle;
  function handleNameClick() {
    if (!nameClickable) return;
    onToggle?.();
    onLeadClick?.();
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: isMate ? '0.4rem 0.55rem' : '0.5rem 0.6rem',
        borderRadius: 10,
        background: isSelected ? 'rgba(143,182,255,0.14)' : 'rgba(9,17,31,0.6)',
        border: `1px solid ${isSelected ? 'rgba(143,182,255,0.4)' : 'rgba(143,182,255,0.12)'}`,
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      <span
        aria-hidden
        title={tierLabel(tier)}
        style={{
          width: isMate ? 8 : 11,
          height: isMate ? 8 : 11,
          borderRadius: '50%',
          background: colors.bg,
          border: '1px solid rgba(255,255,255,0.25)',
          flexShrink: 0,
          opacity: isMate ? 0.75 : 1,
        }}
      />
      {/* Name + subtitle — tappable on the lead row to expand crew */}
      <div
        style={{ flexGrow: 1, minWidth: 0, cursor: nameClickable ? 'pointer' : 'default' }}
        onClick={nameClickable ? handleNameClick : undefined}
        role={nameClickable ? 'button' : undefined}
        tabIndex={nameClickable ? 0 : undefined}
        onKeyDown={nameClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleNameClick(); } : undefined}
      >
        <div style={{
          color: isMate ? '#9ab1d6' : '#e5eefb',
          fontSize: isMate ? '0.78rem' : '0.84rem',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {p.name}
          {isCrew && !isMate ? (
            <span style={{ color: '#9ab1d6', fontSize: '0.7rem', marginLeft: 4 }}>
              {isExpanded ? '▲' : '▼'} lead · crew of {crewSize}
            </span>
          ) : null}
        </div>
        <div style={{ color: colors.bg, fontSize: '0.7rem' }}>
          📍 {relativeTime(p.updatedAt)}{stale ? ' (stale)' : ''}
        </div>
      </div>
      {/* Locate button — uses resolvedTarget (may be a crew member fallback) */}
      <button
        type="button"
        disabled={!hasLoc}
        onClick={() => hasLoc && onLocate?.(resolvedTarget)}
        style={{
          flexShrink: 0, borderRadius: 7,
          border: '1px solid rgba(143,182,255,0.2)',
          background: hasLoc ? 'rgba(143,182,255,0.16)' : 'rgba(9,17,31,0.6)',
          color: hasLoc ? '#dbe7ff' : '#5f7396',
          padding: '0.28rem 0.45rem', fontSize: '0.72rem',
          cursor: hasLoc ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap',
        }}
      >
        Locate
      </button>
    </div>
  );
}

export default function CrewSidebar({
  shifts = [],
  selectedKey = null,
  onLocate,
  onClose,
  expandedShiftIds = null,
  onToggleShiftExpanded,
  closing = false,
}) {
  const now = new Date();
  const tierRank = { red: 0, yellow: 1, blue: 2, green: 3 };

  // Build one group per active shift (sorted by worst tier first, then
  // name). Within each group the lead comes first, then crew mates
  // alphabetically. Crew mates are hidden until the chevron is clicked.
  const groups = [];
  for (const shift of shifts) {
    if (!shift || shift.ended_at || shift.mode === 'off') continue;
    const tier = shift.status_tier || computeTier(shift, now);
    const members = crewMemberPoints(shift).map((p) => ({ ...p, tier }));
    // lead first, then rest by name
    members.sort((a, b) => {
      if (a.isLead !== b.isLead) return a.isLead ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });
    const lead = members.find((m) => m.isLead) || members[0];
    const crewSize = members.length;
    groups.push({ shift, tier, lead, members, crewSize });
  }
  groups.sort((a, b) => {
    const t = (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9);
    if (t !== 0) return t;
    return String(a.lead?.name || '').localeCompare(String(b.lead?.name || ''));
  });

  const totalPeople = groups.reduce((s, g) => s + g.crewSize, 0);

  return (
    <div className={`crew-overlay${closing ? ' crew-overlay--closing' : ''}`}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <strong style={{ color: '#f5f8ff', fontSize: '0.9rem' }}>
          Crew on shift ({totalPeople})
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

      {groups.length === 0 ? (
        <div style={{ color: '#9ab1d6', fontSize: '0.82rem', padding: '0.5rem 0' }}>
          No one is checked in right now.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
          {groups.map(({ shift, tier, lead, members, crewSize }) => {
            const colors = tierColors(tier);
            const isExpanded = !!(expandedShiftIds && expandedShiftIds.has(shift.id));
            const isCrew = shift.mode === 'crew' && crewSize > 1;
            // crew mates only (everyone except lead)
            const mates = members.filter((m) => !m.isLead);

            return (
              <div key={shift.id}>
                {/* ── Lead / solo row (always visible) ── */}
                <MemberRow
                  p={lead}
                  isSelected={selectedKey === lead?.key}
                  colors={colors}
                  tier={tier}
                  isCrew={isCrew}
                  crewSize={crewSize}
                  isExpanded={isExpanded}
                  onLocate={onLocate}
                  onToggle={isCrew ? () => onToggleShiftExpanded?.(shift.id) : null}
                  onLeadClick={isCrew ? (() => {
                    const target = bestLocatedPoint(shift);
                    if (target) onLocate?.(target);
                  }) : null}
                  locateTarget={isCrew ? bestLocatedPoint(shift) : null}
                />

                {/* ── Crew mates (shown when expanded) ── */}
                {isExpanded && mates.map((m) => (
                  <div key={m.key} style={{ paddingLeft: 14, marginTop: 4 }}>
                    <MemberRow
                      p={m}
                      isSelected={selectedKey === m.key}
                      colors={colors}
                      tier={tier}
                      isCrew={false}
                      crewSize={crewSize}
                      isExpanded={false}
                      onLocate={onLocate}
                      onToggle={null}
                      isMate
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
