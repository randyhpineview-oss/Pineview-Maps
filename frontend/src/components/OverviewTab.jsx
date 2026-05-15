/**
 * Overview tab of the admin Check-ins Dashboard.
 *
 * Slack-style responsive grid of EmployeeStatusCards. Shows anyone with
 * an active shift today OR anyone currently assigned to an active truck.
 *
 * Responsive sizing strategy (matches the plan):
 *   - CSS Grid with auto-fit + minmax handles the cols-per-row axis
 *     naturally: ~6 on a 1440 px desktop, 4 at 1024 px, 3 at 768 px,
 *     2 at 420 px. No JS for this axis.
 *   - JS handles the headcount axis: a ResizeObserver measures the
 *     container's available height and sets --card-min-height so cards
 *     squish vertically when there are many users, then stop at a
 *     legibility floor of ~110 px (any further and the grid scrolls).
 *
 * Data freshness:
 *   - Initial fetch on mount.
 *   - 60 s polling fallback (covers Realtime channel disconnects).
 *   - Subscribes to Supabase Realtime on shifts/checkins/devices so
 *     admin sees the green->red transition the moment it fires
 *     server-side. Debounced 500 ms on refetch so a burst of inserts
 *     doesn't thrash the network.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../lib/api';
import { supabase } from '../lib/supabaseClient';
import EmployeeStatusCard from './EmployeeStatusCard';
import { t } from '../lib/checkinTheme';

const POLL_MS = 60_000;
const REFETCH_DEBOUNCE_MS = 500;

export default function OverviewTab({ isAdmin = false }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null); // expanded card

  const refetchTimerRef = useRef(null);
  const pollTimerRef = useRef(null);

  const fetchOverview = useCallback(async () => {
    try {
      const rows = await api.getCheckinOverview();
      setEntries(Array.isArray(rows) ? rows : []);
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced refetch — used by Realtime + 60 s poll.
  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      fetchOverview();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchOverview]);

  // Initial fetch + 60 s safety-net poll.
  useEffect(() => {
    fetchOverview();
    pollTimerRef.current = setInterval(fetchOverview, POLL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, [fetchOverview]);

  // Realtime subscription.
  useEffect(() => {
    if (!supabase) return undefined;
    const channel = supabase
      .channel('checkin-overview')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'checkins' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, scheduleRefetch)
      .subscribe();
    return () => {
      try { supabase.removeChannel(channel); } catch { /* ignore */ }
    };
  }, [scheduleRefetch]);

  // Local 30 s tick so green->yellow transitions visually without
  // waiting for the next poll/realtime event. We just force a re-render
  // by bumping a counter; the cards recompute tier from current time
  // via React.memo's equality check (deadline doesn't change but
  // status_tier does, which the card re-renders on).
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Server-side sort is already correct (red->yellow->blue->green->idle->off).
  // Memo so we don't re-sort on every tick.
  const visible = useMemo(() => entries, [entries]);

  const handleCardClick = (entry) => {
    setSelected((cur) => (cur && cur.user_id === entry.user_id ? null : entry));
  };

  const handleAdminEndShift = async () => {
    if (!selected || !selected.shift) return;
    if (!window.confirm(`End ${selected.display_name}'s shift now?`)) return;
    try {
      await api.adminEndShift(selected.shift.id);
      await fetchOverview();
      setSelected(null);
    } catch (err) {
      setError(err.message || String(err));
    }
  };

  const handleAdminForceCheckin = async () => {
    if (!selected || !selected.shift) return;
    if (!window.confirm(`Force a check-in for ${selected.display_name}? This counts as a safety override.`)) return;
    try {
      await api.adminForceCheckin(selected.shift.id, {});
      await fetchOverview();
    } catch (err) {
      setError(err.message || String(err));
    }
  };

  if (loading) {
    return <div style={{ padding: 24, fontSize: 14, color: t.textMuted }}>Loading…</div>;
  }
  if (error && entries.length === 0) {
    return <div style={{ padding: 24, fontSize: 14, color: t.danger }}>{error}</div>;
  }
  if (visible.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: t.textMuted }}>
        <div style={{ fontSize: 16, marginBottom: 6, color: t.text }}>No active shifts or truck assignments today.</div>
        <div style={{ fontSize: 13 }}>Assign a truck in DeviceAdmin or wait for a worker to start their shift.</div>
      </div>
    );
  }

  return (
    <div className="overview-tab-root">
      {error ? (
        <div style={{ padding: 8, background: t.dangerBg, color: t.danger, border: `1px solid ${t.dangerBorder}`, borderRadius: 6, fontSize: 13, marginBottom: 10 }}>
          {error}
        </div>
      ) : null}

      <div className="overview-grid">
        {visible.map((entry) => (
          <EmployeeStatusCard
            key={entry.user_id}
            entry={entry}
            onClick={handleCardClick}
            isAdmin={isAdmin}
          />
        ))}
      </div>

      {/* Detail expansion (full-width row below the grid) */}
      {selected ? (
        <div className="overview-detail-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16, color: t.text }}>{selected.display_name}</h3>
            <button
              type="button"
              onClick={() => setSelected(null)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 22, color: t.textMuted }}
              aria-label="Close detail"
            >
              ×
            </button>
          </div>
          <DetailBody entry={selected} />
          {isAdmin && selected.shift && !selected.shift.ended_at ? (
            <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={handleAdminForceCheckin}
                style={{
                  padding: '8px 14px', background: '#2563eb', color: '#fff',
                  border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', fontWeight: 600,
                }}
              >
                Force check-in
              </button>
              <button
                type="button"
                onClick={handleAdminEndShift}
                style={{
                  padding: '8px 14px', background: '#dc2626', color: '#fff',
                  border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', fontWeight: 600,
                }}
              >
                End shift
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DetailBody({ entry }) {
  const s = entry.shift;
  if (!s) {
    return (
      <div style={{ fontSize: 14, color: t.textSubtle, lineHeight: 1.6 }}>
        <div>Role: {entry.role}</div>
        {entry.truck_label ? <div>Assigned truck: <strong style={{ color: t.text }}>{entry.truck_label}</strong></div> : null}
        <div style={{ marginTop: 8, color: t.textMuted }}>No shift started today.</div>
      </div>
    );
  }
  const fmt = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');
  const crewCount = Array.isArray(s.crew_user_ids) ? s.crew_user_ids.length : 0;
  return (
    <div style={{ fontSize: 14, color: t.textSubtle, lineHeight: 1.6 }}>
      <div>Started: {fmt(s.started_at)}</div>
      <div>Mode: <strong style={{ color: t.text }}>{s.mode === 'crew' ? `Crew of ${crewCount + 1}` : 'Alone'}</strong></div>
      <div>Last check-in: {fmt(s.last_checkin_at)}</div>
      <div>Next deadline: {fmt(s.next_deadline_at)}</div>
      {s.crew_freeform ? (
        <div style={{ marginTop: 6 }}>
          <span style={{ color: t.textMuted, fontSize: 12 }}>Extra crew (free-text):</span>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 2, fontSize: 13, color: t.text }}>{s.crew_freeform}</div>
        </div>
      ) : null}
      {entry.truck_label ? (
        <div style={{ marginTop: 6 }}>Truck: <strong style={{ color: t.text }}>{entry.truck_label}</strong></div>
      ) : null}
    </div>
  );
}
