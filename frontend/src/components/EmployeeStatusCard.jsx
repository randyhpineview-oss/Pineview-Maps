/**
 * One avatar card in the Overview tab of CheckInsOverlay.
 *
 * Slack-style: round initials avatar (deterministic colour from a
 * hash of email), name, big status pill, contextual subline,
 * truck/last-check-in footer. Memoized so a Realtime update to one
 * user only re-renders one card -- important when 20-30 cards
 * subscribe to the same channel.
 */
import { memo, useMemo } from 'react';

import { hashToHslColor, initials } from '../lib/avatarColor';
import { tier as computeTier, tierColors, tierLabel } from '../lib/compliance';

function formatRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const days = Math.round(hr / 24);
  return `${days} d ago`;
}

function formatDeadline(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  const min = Math.round(ms / 60_000);
  if (min > 60) return `in ${Math.round(min / 60)} h`;
  if (min > 0) return `in ${min} min`;
  return `${Math.abs(min)} min overdue`;
}

function EmployeeStatusCard({ entry, onClick, isAdmin = false }) {
  const tier = entry.status_tier || computeTier(entry.shift);
  const colors = tierColors(tier);
  const avatar = useMemo(
    () => hashToHslColor(entry.avatar_seed || entry.display_name || entry.user_id),
    [entry.avatar_seed, entry.display_name, entry.user_id],
  );

  // Compose the subline based on shift state.
  let modeLine = '';
  let timingLine = '';
  if (entry.shift) {
    const s = entry.shift;
    const crewCount = Array.isArray(s.crew_user_ids) ? s.crew_user_ids.length : 0;
    if (s.mode === 'alone') modeLine = 'Alone';
    else if (s.mode === 'crew') modeLine = `Crew of ${crewCount + 1}`;
    else if (s.mode === 'off') modeLine = 'Off today';

    if (tier === 'red') timingLine = formatDeadline(s.next_deadline_at);
    else if (tier === 'yellow') timingLine = formatDeadline(s.next_deadline_at);
    else if (tier === 'blue')
      timingLine = `Started ${formatRelative(s.started_at)}`;
    else if (s.last_checkin_at) timingLine = `${formatRelative(s.last_checkin_at)}`;
    else if (s.started_at) timingLine = `Started ${formatRelative(s.started_at)}`;
  } else if (entry.truck_label) {
    modeLine = entry.truck_label;
    timingLine = 'no shift yet';
  }

  return (
    <button
      type="button"
      onClick={() => onClick && onClick(entry)}
      className="employee-status-card"
      aria-label={`${entry.display_name} — ${tierLabel(tier)}`}
      style={{
        // Inline border colour + pill background derived from tier.
        // The grid layout (columns / gap / aspect) is handled by the
        // parent container in OverviewTab.jsx.
        '--card-accent': colors.accent,
        borderColor: colors.accent,
      }}
    >
      <div className="employee-status-card-avatar"
           style={{ background: avatar.bg, color: avatar.fg }}>
        {initials(entry.display_name)}
      </div>
      <div className="employee-status-card-name" title={entry.display_name}>
        {entry.display_name}
      </div>
      <div
        className="employee-status-card-pill"
        style={{ background: colors.bg, color: colors.fg }}
      >
        {tierLabel(tier)}
      </div>
      <div className="employee-status-card-subline">
        {modeLine ? <span>{modeLine}</span> : null}
        {modeLine && timingLine ? <span aria-hidden> · </span> : null}
        {timingLine ? <span>{timingLine}</span> : null}
      </div>
      {entry.truck_label && entry.shift ? (
        <div className="employee-status-card-truck" title={entry.truck_label}>
          🚚 {entry.truck_label}
        </div>
      ) : null}
    </button>
  );
}

// Custom equality check: only re-render when something visible to this
// card changed. user_id is stable, but the shift and truck fields can
// flip on realtime updates and we want those to repaint.
function areEqual(prev, next) {
  if (prev.entry === next.entry) return true;
  const a = prev.entry;
  const b = next.entry;
  if (a.user_id !== b.user_id) return false;
  if (a.status_tier !== b.status_tier) return false;
  if (a.display_name !== b.display_name) return false;
  // Cheap shallow checks on the nested shift/truck fields:
  const aShift = a.shift || {};
  const bShift = b.shift || {};
  if (aShift.id !== bShift.id) return false;
  if (aShift.last_checkin_at !== bShift.last_checkin_at) return false;
  if (aShift.next_deadline_at !== bShift.next_deadline_at) return false;
  if (aShift.mode !== bShift.mode) return false;
  if (aShift.ended_at !== bShift.ended_at) return false;
  if (a.truck_id !== b.truck_id) return false;
  if (a.truck_last_seen_at !== b.truck_last_seen_at) return false;
  return prev.isAdmin === next.isAdmin;
}

export default memo(EmployeeStatusCard, areEqual);
