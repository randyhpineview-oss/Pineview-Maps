/**
 * History tab — past shifts filtered by date.
 *
 * Date picker (default = today, local Vancouver). Compact one-row per
 * shift with: user · mode · crew · started→ended · check-in count · max
 * overdue marker. Server returns shifts active during the chosen day
 * (started_at < end_of_day AND (ended_at IS NULL OR ended_at >= start)).
 */
import { useCallback, useEffect, useState } from 'react';

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

export default function HistoryTab() {
  const [dateStr, setDateStr] = useState(todayLocalISO());
  const [rows, setRows] = useState([]);
  const [users, setUsers] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchHistory = useCallback(async (d) => {
    setLoading(true);
    try {
      const [shiftRows, crewCandidates] = await Promise.all([
        api.listAdminShifts({ dateStr: d }),
        api.listCheckinCrewCandidates().catch(() => []),
      ]);
      setRows(Array.isArray(shiftRows) ? shiftRows : []);
      const map = {};
      (crewCandidates || []).forEach((u) => { map[u.id] = u; });
      setUsers(map);
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHistory(dateStr); }, [dateStr, fetchHistory]);

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
                <th style={th()}>User</th>
                <th style={th()}>Mode</th>
                <th style={th()}>Crew</th>
                <th style={th()}>Started</th>
                <th style={th()}>Ended</th>
                <th style={th()}>End reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                // Prefer backend-embedded name; fall back to crew-lookup
                // map (now workers-only); finally numeric.
                const user = users[s.user_id];
                const name = s.user_name || user?.name || `User #${s.user_id}`;
                const crewNames = (s.crew_user_ids || []).map((id) => users[id]?.name || `#${id}`).join(', ');
                return (
                  <tr key={s.id} style={{ borderTop: `1px solid ${t.divider}` }}>
                    <td style={td()}>{name}</td>
                    <td style={td()}>
                      {s.mode === 'off' ? 'Off' : s.mode === 'crew' ? `Crew (${(s.crew_user_ids || []).length + 1})` : 'Alone'}
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function th() {
  return { textAlign: 'left', padding: '8px 10px', fontWeight: 600, color: t.textMuted, fontSize: 12 };
}
function td() {
  return { padding: '8px 10px', color: t.textSubtle, verticalAlign: 'top' };
}
