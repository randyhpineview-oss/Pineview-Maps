/**
 * Active tab — per-shift detail tiles for ALL active shifts.
 *
 * Heavier admin controls than the Overview cards: each tile shows the
 * full shift breakdown (mode, crew names, last check-in, deadline) and
 * exposes End-shift + Force-checkin buttons inline so admins can act
 * without first clicking through a card.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../lib/api';
import { supabase } from '../../lib/supabaseClient';
import { hashToHslColor, initials } from '../../lib/avatarColor';
import { tier as computeTier, tierColors, tierLabel, formatCountdown } from '../../lib/compliance';

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

export default function ActiveTab({ isAdmin = true }) {
  const [shifts, setShifts] = useState([]);
  const [users, setUsers] = useState({}); // id -> {name, email, role}
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [, setTick] = useState(0);
  const refetchTimer = useRef(null);
  const pollTimer = useRef(null);

  const fetchAll = useCallback(async () => {
    try {
      const [shiftRows, crewCandidates] = await Promise.all([
        api.listAdminActiveShifts(),
        api.listCheckinCrewCandidates().catch(() => []),
      ]);
      setShifts(Array.isArray(shiftRows) ? shiftRows : []);
      // Build a quick id -> name lookup for crew rendering. The
      // crew-candidates endpoint excludes the caller, so we may miss
      // names for admins who happen to be on a shift -- that's fine,
      // we just fall back to "user #N" for that case.
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

  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      fetchAll();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchAll]);

  useEffect(() => {
    fetchAll();
    pollTimer.current = setInterval(fetchAll, POLL_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, [fetchAll]);

  useEffect(() => {
    if (!supabase) return undefined;
    const channel = supabase
      .channel('checkin-active-tab')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'checkins' }, scheduleRefetch)
      .subscribe();
    return () => { try { supabase.removeChannel(channel); } catch { /* ignore */ } };
  }, [scheduleRefetch]);

  // 30 s local tick for tier transitions.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const handleEnd = async (s) => {
    if (!window.confirm(`End shift for user #${s.user_id}?`)) return;
    try { await api.adminEndShift(s.id); await fetchAll(); }
    catch (err) { setError(err.message || String(err)); }
  };
  const handleForce = async (s) => {
    if (!window.confirm(`Force a check-in on this shift?`)) return;
    try { await api.adminForceCheckin(s.id, {}); await fetchAll(); }
    catch (err) { setError(err.message || String(err)); }
  };

  if (loading) return <div style={{ padding: 24, color: '#6b7280' }}>Loading active shifts…</div>;
  if (error && shifts.length === 0) return <div style={{ padding: 24, color: '#dc2626' }}>{error}</div>;
  if (shifts.length === 0) {
    return <div style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No active shifts right now.</div>;
  }

  return (
    <div className="active-tab-root">
      {error ? <div style={{ padding: 8, background: '#fef2f2', color: '#991b1b', borderRadius: 6, fontSize: 13, marginBottom: 10 }}>{error}</div> : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        {shifts.map((s) => {
          const user = users[s.user_id];
          const name = user?.name || `User #${s.user_id}`;
          const tier = computeTier(s, new Date());
          const colors = tierColors(tier);
          const av = hashToHslColor(user?.email || name);
          const crewNames = (s.crew_user_ids || []).map((id) => users[id]?.name || `#${id}`);
          return (
            <div key={s.id} style={{
              background: '#fff', borderRadius: 10, padding: 14,
              border: `2px solid ${colors.accent}`,
              boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 36, height: 36, borderRadius: '50%',
                  background: av.bg, color: av.fg, fontWeight: 600, fontSize: 13,
                }}>{initials(name)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>Started {fmtTime(s.started_at)}</div>
                </div>
                <span style={{
                  background: colors.bg, color: colors.fg, padding: '3px 8px',
                  borderRadius: 999, fontSize: 11, fontWeight: 600,
                }}>{tierLabel(tier)}</span>
              </div>
              <div style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>
                <strong>Mode:</strong> {s.mode === 'crew' ? `Crew of ${crewNames.length + 1}` : 'Alone'}
              </div>
              {crewNames.length ? (
                <div style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>
                  <strong>Crew:</strong> {crewNames.join(', ')}
                </div>
              ) : null}
              {s.crew_freeform ? (
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4, whiteSpace: 'pre-wrap' }}>+ {s.crew_freeform}</div>
              ) : null}
              <div style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>
                <strong>Last check-in:</strong> {fmtRelative(s.last_checkin_at)}
              </div>
              <div style={{ fontSize: 13, color: '#374151' }}>
                <strong>Next deadline:</strong> {fmtTime(s.next_deadline_at)} ({formatCountdown(s, new Date()) || '—'})
              </div>
              {isAdmin ? (
                <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => handleForce(s)} style={{
                    padding: '6px 10px', background: '#2563eb', color: '#fff', border: 'none',
                    borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
                  }}>Force check-in</button>
                  <button type="button" onClick={() => handleEnd(s)} style={{
                    padding: '6px 10px', background: '#dc2626', color: '#fff', border: 'none',
                    borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
                  }}>End shift</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
