/**
 * Overview tab of the admin Check-ins Dashboard.
 *
 * Renders the same rich per-shift cards as the Active tab (avatar,
 * status pill, mode, crew tree, deadlines, force/end buttons), plus
 * a slimmer "Not started yet" card for truck-assigned workers who
 * haven't tapped Start. The user asked for "make Overview look like
 * Active because that shows the names", so the two tabs share the
 * same card design -- Active hides idle entries while Overview
 * includes them.
 *
 * Layout: CSS Grid with auto-fit + minmax(300px, 1fr). No JS for
 * sizing -- the cards reflow naturally on resize.
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
import { hashToHslColor, initials } from '../lib/avatarColor';
import { tier as computeTier, tierColors, tierLabel, formatCountdown } from '../lib/compliance';
import { t } from '../lib/checkinTheme';

const POLL_MS = 60_000;
const REFETCH_DEBOUNCE_MS = 500;

function fmtTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return '—'; }
}
function fmtRelative(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return `${hr} h ago`;
}

export default function OverviewTab({ isAdmin = false }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  // Debounced refetch -- used by Realtime + 60 s poll.
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
  // waiting for the next poll/realtime event. Updater is named `prev`
  // (not `t`) so it doesn't shadow the imported theme module.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((prev) => prev + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Server-side sort is already correct (red->yellow->blue->green->idle->off).
  const visible = useMemo(() => entries, [entries]);

  const handleEnd = async (entry) => {
    if (!entry?.shift) return;
    if (!window.confirm(`End ${entry.display_name}'s shift now?`)) return;
    try { await api.adminEndShift(entry.shift.id); await fetchOverview(); }
    catch (err) { setError(err.message || String(err)); }
  };
  const handleForce = async (entry) => {
    if (!entry?.shift) return;
    if (!window.confirm(`Force a check-in for ${entry.display_name}? This counts as a safety override.`)) return;
    try { await api.adminForceCheckin(entry.shift.id, {}); await fetchOverview(); }
    catch (err) { setError(err.message || String(err)); }
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

      {/* Cards match the Active-tab card style exactly (per the user's
          "make Overview look like Active because that shows the names"
          ask), with the extension that we also render entries that have
          no shift yet -- those are truck-assigned workers who haven't
          tapped Start. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        {visible.map((entry) => (
          <OverviewCard
            key={entry.user_id}
            entry={entry}
            isAdmin={isAdmin}
            onForce={() => handleForce(entry)}
            onEnd={() => handleEnd(entry)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One per-entry card. Two layouts:
 *   - With a shift: full Active-style card with crew tree.
 *   - Without a shift (truck-assigned only): compact "Not started yet"
 *     card so admins can still see the worker exists for the day.
 */
function OverviewCard({ entry, isAdmin, onForce, onEnd }) {
  const s = entry.shift;
  const tier = s ? computeTier(s, new Date()) : 'idle';
  const colors = tierColors(tier);
  const av = hashToHslColor(entry.avatar_seed || entry.display_name);

  if (!s) {
    // No shift today, just a truck assignment. Render a slimmer card.
    return (
      <div style={{
        background: t.cardBg, borderRadius: 10, padding: 14,
        border: `2px solid ${colors.accent}`,
        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
        color: t.text,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 36, height: 36, borderRadius: '50%',
            background: av.bg, color: av.fg, fontWeight: 600, fontSize: 13,
          }}>{initials(entry.display_name)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.display_name}</div>
            <div style={{ fontSize: 11, color: t.textMuted }}>{entry.role}</div>
          </div>
          <span style={{
            background: colors.bg, color: colors.fg, padding: '3px 8px',
            borderRadius: 999, fontSize: 11, fontWeight: 600,
          }}>{tierLabel(tier)}</span>
        </div>
        {entry.truck_label ? (
          <div style={{ fontSize: 13, color: t.textSubtle }}>
            <strong style={{ color: t.text }}>Truck:</strong> {entry.truck_label}
          </div>
        ) : null}
        <div style={{ fontSize: 12, color: t.textMuted, marginTop: 6 }}>
          No shift started yet today.
        </div>
      </div>
    );
  }

  // Active-shift card. Identical visual to ActiveTab cards.
  const crewMembers = Array.isArray(s.crew_members) ? s.crew_members : [];
  const crewCount = crewMembers.length
    || (Array.isArray(s.crew_user_ids) ? s.crew_user_ids.length : 0);
  return (
    <div style={{
      background: t.cardBg, borderRadius: 10, padding: 14,
      border: `2px solid ${colors.accent}`,
      boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
      color: t.text,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 36, height: 36, borderRadius: '50%',
          background: av.bg, color: av.fg, fontWeight: 600, fontSize: 13,
        }}>{initials(entry.display_name)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.display_name}</div>
          <div style={{ fontSize: 11, color: t.textMuted }}>Started {fmtTime(s.started_at)}</div>
        </div>
        <span style={{
          background: colors.bg, color: colors.fg, padding: '3px 8px',
          borderRadius: 999, fontSize: 11, fontWeight: 600,
        }}>{tierLabel(tier)}</span>
      </div>
      <div style={{ fontSize: 13, color: t.textSubtle, marginBottom: 4 }}>
        <strong style={{ color: t.text }}>Mode:</strong> {s.mode === 'crew' ? `Crew of ${crewCount + 1}` : 'Alone'}
      </div>
      {/* Crew tree under the lead -- the user's "I want to see who is in
          this crew" request, rendered as mini-avatar rows. */}
      {crewMembers.length ? (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 13, color: t.text, fontWeight: 600, marginBottom: 4 }}>Crew</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 8, borderLeft: `2px solid ${t.divider}` }}>
            {crewMembers.map((m) => {
              const mav = hashToHslColor(m.email || m.name);
              return (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 22, height: 22, borderRadius: '50%',
                    background: mav.bg, color: mav.fg, fontWeight: 600, fontSize: 10,
                  }}>{initials(m.name)}</span>
                  <span style={{ fontSize: 13, color: t.textSubtle }}>{m.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {s.crew_freeform ? (
        <div style={{ fontSize: 12, color: t.textMuted, marginBottom: 4, whiteSpace: 'pre-wrap' }}>+ {s.crew_freeform}</div>
      ) : null}
      <div style={{ fontSize: 13, color: t.textSubtle, marginBottom: 4 }}>
        <strong style={{ color: t.text }}>Last check-in:</strong> {fmtRelative(s.last_checkin_at)}
      </div>
      <div style={{ fontSize: 13, color: t.textSubtle }}>
        <strong style={{ color: t.text }}>Next deadline:</strong> {fmtTime(s.next_deadline_at)} ({formatCountdown(s, new Date()) || '—'})
      </div>
      {entry.truck_label ? (
        <div style={{ fontSize: 12, color: t.textMuted, marginTop: 4 }}>🚚 {entry.truck_label}</div>
      ) : null}
      {isAdmin ? (
        <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={onForce} style={{
            padding: '6px 10px', background: t.accentStrong, color: t.textOnAccent, border: 'none',
            borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
          }}>Force check-in</button>
          <button type="button" onClick={onEnd} style={{
            padding: '6px 10px', background: t.dangerStrong, color: t.textOnAccent, border: 'none',
            borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
          }}>End shift</button>
        </div>
      ) : null}
    </div>
  );
}
