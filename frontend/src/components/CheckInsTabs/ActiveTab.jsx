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
import { t } from '../../lib/checkinTheme';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [, setTick] = useState(0);
  const refetchTimer = useRef(null);
  const pollTimer = useRef(null);

  // The admin shifts endpoint now embeds `user_name` and `crew_members`
  // for every row, so we don't need to fetch the assignable-users list
  // here -- one fewer roundtrip, no "User #N" gaps when the caller is
  // an admin (the crew-candidates endpoint excluded the caller).
  const fetchAll = useCallback(async () => {
    try {
      const shiftRows = await api.listAdminActiveShifts();
      setShifts(Array.isArray(shiftRows) ? shiftRows : []);
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

  // 30 s local tick for tier transitions. Note we name the updater
  // arg `prev` (not `t`) so it doesn't shadow the imported theme module.
  useEffect(() => {
    const id = setInterval(() => setTick((prev) => prev + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const handleEnd = async (s) => {
    const who = s.user_name || `user #${s.user_id}`;
    if (!window.confirm(`End shift for ${who}?`)) return;
    try { await api.adminEndShift(s.id); await fetchAll(); }
    catch (err) { setError(err.message || String(err)); }
  };
  const handleForce = async (s) => {
    if (!window.confirm(`Force a check-in on this shift?`)) return;
    try { await api.adminForceCheckin(s.id, {}); await fetchAll(); }
    catch (err) { setError(err.message || String(err)); }
  };

  if (loading) return <div style={{ padding: 24, color: t.textMuted }}>Loading active shifts…</div>;
  if (error && shifts.length === 0) return <div style={{ padding: 24, color: t.danger }}>{error}</div>;
  if (shifts.length === 0) {
    return <div style={{ padding: 24, textAlign: 'center', color: t.textMuted }}>No active shifts right now.</div>;
  }

  return (
    <div className="active-tab-root">
      {error ? <div style={{ padding: 8, background: t.dangerBg, color: t.danger, border: `1px solid ${t.dangerBorder}`, borderRadius: 6, fontSize: 13, marginBottom: 10 }}>{error}</div> : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        {shifts.map((s) => {
          // Backend embeds user_name + crew_members in every admin shift
          // row, so we don't need any local lookup. Numeric fallback only
          // for cases where the embedding was somehow missed.
          const name = s.user_name || `User #${s.user_id}`;
          const email = s.user_email || '';
          const tier = computeTier(s, new Date());
          const colors = tierColors(tier);
          const av = hashToHslColor(email || name);
          const crewMembers = Array.isArray(s.crew_members) ? s.crew_members : [];
          const crewCount = crewMembers.length
            || (Array.isArray(s.crew_user_ids) ? s.crew_user_ids.length : 0);
          return (
            <div key={s.id} style={{
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
                }}>{initials(name)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
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
              {/* Crew teammates as mini-avatar chips. Reads as a small
                  tree under the lead -- the user explicitly asked to see
                  "all the names on the dashboard of people that are
                  checked in". */}
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
              {isAdmin ? (
                <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => handleForce(s)} style={{
                    padding: '6px 10px', background: t.accentStrong, color: t.textOnAccent, border: 'none',
                    borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
                  }}>Force check-in</button>
                  <button type="button" onClick={() => handleEnd(s)} style={{
                    padding: '6px 10px', background: t.dangerStrong, color: t.textOnAccent, border: 'none',
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
