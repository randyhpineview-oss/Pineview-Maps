/**
 * History tab — past shifts filtered by date.
 *
 * Date picker (default = today, local Vancouver). Each shift renders
 * as a header row with: user · mode · crew · started→ended · end
 * reason. Clicking the row expands an inline timeline that shows
 * EVERY check-in (with map link if GPS was captured) and EVERY
 * missed-deadline / escalation event (T-15 reminder, T0 due,
 * worker overdue repeats, office_first, office_urgent).
 *
 * The backend embeds `checkins` and `missed_events` directly on each
 * shift row (`/api/admin/shifts?date=...`) so expanding any row is
 * instant -- no per-row follow-up requests.
 *
 * Crew members' "I'm OK" taps record a Checkin row keyed to the
 * lead's shift, with `user_id` = the crew member who tapped. The
 * timeline displays each event with that user's name, so when User A
 * is the shift lead and User B is added as crew, B's check-ins
 * automatically appear under A's shift card -- this is what fixed
 * the "additional users added to check-in not showing in history"
 * complaint.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../../lib/api';
import { t } from '../../lib/checkinTheme';

function todayLocalISO() {
  // Local YYYY-MM-DD for the Vancouver-tz default. Using the browser's
  // local time is "good enough" here because the worker and admin are
  // typically in the same TZ; the backend interprets the date string in
  // America/Vancouver anyway.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return '—'; }
}

// Pretty label for an alert kind from the checkin_alerts ledger. These
// strings are the same kinds the cron scanner inserts in
// `checkin_routes.py / checkin_cadence.py`. Anything unknown falls
// back to the raw kind so we don't silently swallow new event types
// added later.
function missedEventLabel(kind) {
  if (kind === 'worker_t-15') return '15-min reminder sent';
  if (kind === 'worker_t0') return 'Check-in deadline reached';
  if (kind === 'worker_overdue_3') return 'Worker overdue 3 min';
  if (kind && kind.startsWith('worker_overdue_repeat_')) {
    const n = kind.replace('worker_overdue_repeat_', '');
    return `Worker still overdue (+${n} min)`;
  }
  if (kind === 'office_first') return 'Office paged (T+30)';
  if (kind === 'office_urgent') return 'Office paged URGENT (T+60)';
  if (kind && kind.startsWith('office_')) return `Office paged (${kind.replace('office_', '')})`;
  return kind || 'Missed event';
}

// Severity → colour tokens. Mirrors the buckets the backend assigns in
// _alert_severity().
function severityColors(sev) {
  switch (sev) {
    case 'reminder': return { bg: 'rgba(143,182,255,0.10)', fg: t.textSubtle, border: t.border };
    case 'due':      return { bg: t.warningBg, fg: t.warning, border: t.warningBorder };
    case 'overdue':  return { bg: t.dangerBg, fg: t.danger, border: t.dangerBorder };
    case 'urgent':   return { bg: 'rgba(220,38,38,0.18)', fg: '#ffffff', border: t.dangerBorder };
    default:         return { bg: t.dangerBg, fg: t.danger, border: t.dangerBorder };
  }
}

// External Google Maps URL for a captured check-in location. Same
// pattern as `mapUtils.getDirectionsUrl` but a plain pin (no
// directions) so admin can see the spot in satellite / street view
// without committing to navigation. New tab so the dashboard stays
// open underneath.
function mapUrlForCheckin(c) {
  if (c.lat == null || c.lon == null) return null;
  return `https://www.google.com/maps?q=${encodeURIComponent(c.lat)},${encodeURIComponent(c.lon)}`;
}

export default function HistoryTab() {
  const [dateStr, setDateStr] = useState(todayLocalISO());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Set of shift ids currently expanded. Multiple rows can be open at
  // once -- admins frequently want to compare two shifts side by side.
  const [expanded, setExpanded] = useState(() => new Set());

  const fetchHistory = useCallback(async (d) => {
    setLoading(true);
    try {
      const shiftRows = await api.listAdminShifts({ dateStr: d });
      setRows(Array.isArray(shiftRows) ? shiftRows : []);
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHistory(dateStr); }, [dateStr, fetchHistory]);

  const toggleRow = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="history-tab-root">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <label style={{ fontSize: 13, color: t.textSubtle }}>Date:</label>
        <input
          type="date"
          value={dateStr}
          onChange={(e) => setDateStr(e.target.value)}
          style={{
            padding: '6px 10px', background: t.cardBgRaised, color: t.text,
            border: `1px solid ${t.border}`, borderRadius: 6, fontSize: 13,
          }}
        />
        <button type="button" onClick={() => setDateStr(todayLocalISO())} style={{
          padding: '6px 10px', background: 'transparent', color: t.text,
          border: `1px solid ${t.border}`, borderRadius: 6, fontSize: 13, cursor: 'pointer',
        }}>Today</button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: t.textMuted }}>{rows.length} shift{rows.length === 1 ? '' : 's'}</span>
      </div>

      {error ? <div style={{ padding: 8, background: t.dangerBg, color: t.danger, border: `1px solid ${t.dangerBorder}`, borderRadius: 6, fontSize: 13, marginBottom: 10 }}>{error}</div> : null}

      {loading ? (
        <div style={{ padding: 24, color: t.textMuted }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: t.textMuted }}>No shifts on this date.</div>
      ) : (
        <div style={{ background: t.cardBg, borderRadius: 10, overflow: 'hidden', border: `1px solid ${t.border}` }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: t.cardBgRaised }}>
              <tr>
                <th style={th({ width: 28 })} aria-label="Expand" />
                <th style={th()}>User</th>
                <th style={th()}>Mode</th>
                <th style={th()}>Crew</th>
                <th style={th()}>Started</th>
                <th style={th()}>Ended</th>
                <th style={th()}>End reason</th>
                <th style={th({ textAlign: 'right' })}>Activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <ShiftRow
                  key={s.id}
                  shift={s}
                  open={expanded.has(s.id)}
                  onToggle={() => toggleRow(s.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ShiftRow({ shift, open, onToggle }) {
  const s = shift;
  const name = s.user_name || `User #${s.user_id}`;
  const crewMembers = Array.isArray(s.crew_members) ? s.crew_members : [];
  const crewIds = Array.isArray(s.crew_user_ids) ? s.crew_user_ids : [];
  const crewNames = (
    crewMembers.length
      ? crewMembers.map((m) => m.name)
      : crewIds.map((id) => `#${id}`)
  ).join(', ');
  const crewCount = crewMembers.length || crewIds.length;
  const checkinCount = Array.isArray(s.checkins) ? s.checkins.length : 0;
  const missedCount = Array.isArray(s.missed_events) ? s.missed_events.length : 0;

  return (
    <>
      <tr
        style={{
          borderTop: `1px solid ${t.divider}`,
          cursor: 'pointer',
          background: open ? t.rowHover : 'transparent',
        }}
        onClick={onToggle}
      >
        <td style={td({ textAlign: 'center', color: t.textMuted, fontSize: 11, width: 28 })}>
          {open ? '▾' : '▸'}
        </td>
        <td style={td()}>{name}</td>
        <td style={td()}>
          {s.mode === 'off' ? 'Off' : s.mode === 'crew' ? `Crew (${crewCount + 1})` : 'Alone'}
        </td>
        <td style={td()} title={crewNames}>{crewNames || (s.crew_freeform ? '+ freeform' : '')}</td>
        <td style={td()}>{fmtTime(s.started_at)}</td>
        <td style={td()}>{s.ended_at ? fmtTime(s.ended_at) : <em style={{ color: t.success }}>still active</em>}</td>
        <td style={td()}>
          {s.auto_end_reason ? (
            <span style={{
              fontSize: 11, padding: '2px 6px', borderRadius: 999,
              background: s.auto_end_reason === 'admin_override' ? t.dangerBg : 'rgba(143,182,255,0.10)',
              color: s.auto_end_reason === 'admin_override' ? t.danger : t.textSubtle,
            }}>{s.auto_end_reason}</span>
          ) : ''}
        </td>
        <td style={td({ textAlign: 'right', whiteSpace: 'nowrap' })}>
          <span style={{ color: t.textSubtle }}>
            {checkinCount} check-in{checkinCount === 1 ? '' : 's'}
          </span>
          {missedCount > 0 ? (
            <span style={{ marginLeft: 8, color: t.danger }}>
              · {missedCount} missed
            </span>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr style={{ background: t.cardBgRaised, borderTop: `1px solid ${t.divider}` }}>
          <td colSpan={8} style={{ padding: '12px 16px 14px 44px' }}>
            <ShiftTimeline shift={s} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Inline expanded view for a shift row. Renders a chronological list
 * of: shift-started · every check-in · every missed/escalation event ·
 * shift-ended. Each check-in with GPS gets a [📍 Map] button that
 * opens Google Maps in a new tab at those coordinates.
 */
function ShiftTimeline({ shift }) {
  // Normalise everything into a single array sorted by time so the
  // worker reads the shift as a story, not three parallel lists.
  const events = useMemo(() => {
    const out = [];
    if (shift.started_at) {
      out.push({
        kind: 'started',
        at: shift.started_at,
        label: shift.mode === 'off'
          ? `Marked day off`
          : `Shift started (${shift.mode === 'crew' ? 'crew' : 'alone'})`,
      });
    }
    for (const c of (shift.checkins || [])) {
      out.push({ kind: 'checkin', at: c.created_at, checkin: c });
    }
    for (const m of (shift.missed_events || [])) {
      // Use sent_at so the timeline reflects when admin/worker
      // actually got pinged, not the (often identical) due_at.
      out.push({ kind: 'missed', at: m.sent_at || m.due_at, missed: m });
    }
    if (shift.ended_at) {
      out.push({
        kind: 'ended',
        at: shift.ended_at,
        label: `Shift ended${shift.auto_end_reason ? ` (${shift.auto_end_reason})` : ''}`,
      });
    }
    out.sort((a, b) => new Date(a.at) - new Date(b.at));
    return out;
  }, [shift]);

  if (events.length === 0) {
    return <div style={{ color: t.textMuted, fontSize: 13 }}>No activity recorded.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {events.map((e, idx) => {
        if (e.kind === 'started' || e.kind === 'ended') {
          return (
            <div
              key={`${e.kind}-${idx}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '4px 0', fontSize: 13, color: t.textSubtle,
              }}
            >
              <span style={{ width: 56, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                {fmtTime(e.at)}
              </span>
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: e.kind === 'started' ? t.accent : '#9ab1d6',
              }} />
              <span style={{ color: t.text }}>{e.label}</span>
            </div>
          );
        }
        if (e.kind === 'checkin') {
          const c = e.checkin;
          const mapUrl = mapUrlForCheckin(c);
          const who = c.user_name || `User #${c.user_id}`;
          return (
            <div
              key={`checkin-${c.id}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '4px 0', fontSize: 13, color: t.textSubtle,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ width: 56, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                {fmtTime(e.at)}
              </span>
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: t.success,
              }} />
              <span style={{ color: t.text }}>
                <strong style={{ fontWeight: 600 }}>{who}</strong> checked in
                {c.recorded_by_name ? (
                  <span style={{ color: t.textMuted }}>
                    {' '}(forced by {c.recorded_by_name})
                  </span>
                ) : null}
              </span>
              {mapUrl ? (
                <a
                  href={mapUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  // Stop the click bubbling to the parent <tr>'s
                  // onToggle so opening the map doesn't also collapse
                  // the row.
                  onClick={(ev) => ev.stopPropagation()}
                  title={c.accuracy_m ? `Accuracy ±${Math.round(c.accuracy_m)}m` : 'View on map'}
                  style={{
                    fontSize: 12, padding: '2px 8px',
                    background: 'rgba(96,165,250,0.12)', color: t.accent,
                    border: `1px solid ${t.borderSoft}`, borderRadius: 999,
                    textDecoration: 'none', fontWeight: 500,
                  }}
                >
                  📍 Map
                </a>
              ) : (
                <span style={{ fontSize: 11, color: t.textMuted }}>(no GPS)</span>
              )}
              {c.notes ? (
                <span style={{ fontSize: 12, color: t.textMuted, fontStyle: 'italic' }}>
                  “{c.notes}”
                </span>
              ) : null}
            </div>
          );
        }
        // missed-event row
        const m = e.missed;
        const colors = severityColors(m.severity);
        return (
          <div
            key={`missed-${m.id}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '4px 0', fontSize: 13, color: t.textSubtle,
            }}
          >
            <span style={{ width: 56, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>
              {fmtTime(e.at)}
            </span>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: colors.fg,
            }} />
            <span style={{
              padding: '2px 8px', borderRadius: 999,
              background: colors.bg, color: colors.fg,
              border: `1px solid ${colors.border}`,
              fontSize: 12, fontWeight: 500,
            }}>
              {missedEventLabel(m.kind)}
            </span>
            <span style={{ fontSize: 11, color: t.textMuted }}>via {m.channel}</span>
          </div>
        );
      })}
    </div>
  );
}

function th(extra = {}) {
  return { textAlign: 'left', padding: '8px 10px', fontWeight: 600, color: t.textMuted, fontSize: 12, ...extra };
}
function td(extra = {}) {
  return { padding: '8px 10px', color: t.textSubtle, verticalAlign: 'top', ...extra };
}
