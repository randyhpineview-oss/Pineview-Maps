/**
 * MyCheckInsOverlay — the personal check-in page.
 *
 * Two states adapted from current shift status:
 *   A. No active shift  -> start-shift form (mode picker + crew picker).
 *   B. Active shift     -> live countdown, giant I'm OK button,
 *                          mid-shift edit panel, end-shift button,
 *                          today's check-in timeline.
 *
 * Also serves as the forced overlay when rendered with `force=true`:
 *   - No close button. No backdrop-click-to-dismiss.
 *   - The only paths out are: tap I'm OK (records check-in), tap End
 *     shift, or wait for the deadline math to relax (e.g. after the
 *     check-in lands, the parent flips force=false).
 *   - When offline, the I'm OK button is hidden and only Dismiss is
 *     shown. Tapping Dismiss sets dismissedWhileOffline=true on the
 *     parent so the overlay hides until isOnline flips back to true.
 *
 * The forced-overlay portal pattern (parent renders us via React
 * createPortal under document.body) preserves any open form's state
 * because we never unmount the underlying tree -- we just sit on top.
 */
import { useEffect, useMemo, useState } from 'react';

import { hashToHslColor, initials } from '../lib/avatarColor';

import { api } from '../lib/api';
import { formatCountdown, shouldForceOverlay, tier as computeTier, tierColors, tierLabel } from '../lib/compliance';
import {
  ensurePushSubscribed,
  pushSupported,
  requestNotificationPermission,
} from '../lib/pushClient';
import CrewPicker from './CrewPicker';
import CheckInPreferencesPanel from './CheckInPreferencesPanel';

const S = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 95,
    background: 'rgba(8, 12, 20, 0.78)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '24px 12px',
    overflowY: 'auto',
  },
  card: {
    width: '100%',
    maxWidth: 520,
    background: '#0f172a',
    color: '#e5eefb',
    border: '1px solid rgba(143, 182, 255, 0.16)',
    borderRadius: 12,
    boxShadow: '0 20px 50px rgba(0,0,0,0.55)',
    padding: '20px 22px 24px 22px',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    fontSize: 22,
    cursor: 'pointer',
    color: '#9ab1d6',
    padding: 4,
    lineHeight: 1,
  },
  primaryBtn: (bg, fg) => ({
    width: '100%',
    padding: '18px 22px',
    fontSize: 22,
    fontWeight: 700,
    background: bg,
    color: fg,
    border: 'none',
    borderRadius: 12,
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
  }),
  ghostBtn: {
    padding: '10px 16px',
    background: 'transparent',
    color: '#e5eefb',
    border: '1px solid rgba(143, 182, 255, 0.18)',
    borderRadius: 8,
    fontSize: 14,
    cursor: 'pointer',
  },
  dangerBtn: {
    padding: '10px 16px',
    background: '#dc2626',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  modeBtn: (selected) => ({
    flex: 1,
    padding: '14px 12px',
    border: selected ? '2px solid #60a5fa' : '1px solid rgba(143, 182, 255, 0.18)',
    background: selected ? 'rgba(96, 165, 250, 0.12)' : 'transparent',
    color: selected ? '#60a5fa' : '#e5eefb',
    borderRadius: 10,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: selected ? 700 : 500,
    textAlign: 'center',
  }),
  sectionTitle: { margin: '18px 0 8px 0', fontSize: 13, color: '#9ab1d6', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 },
  timelineRow: { padding: '6px 0', borderBottom: '1px solid rgba(143, 182, 255, 0.08)', fontSize: 13, color: '#c9d6ee', display: 'flex', justifyContent: 'space-between' },
};

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return `${hr} h ago`;
}

export default function MyCheckInsOverlay({
  onClose,
  force = false,
  isOnline = true,
  onShiftChanged,
  initialData = null,
  currentUserId = null,
}) {
  const [tick, setTick] = useState(0);
  const [shift, setShift] = useState(initialData?.shift || null);
  const [checkins, setCheckins] = useState(initialData?.checkins || []);
  const [loading, setLoading] = useState(!initialData);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Start-shift form state.
  const [mode, setMode] = useState('alone');
  const [crewUserIds, setCrewUserIds] = useState([]);
  const [crewFreeform, setCrewFreeform] = useState('');
  const [notes, setNotes] = useState('');

  // Mid-shift edit panel state.
  const [editing, setEditing] = useState(false);
  const [editMode, setEditMode] = useState('alone');
  const [editCrewUserIds, setEditCrewUserIds] = useState([]);
  const [editCrewFreeform, setEditCrewFreeform] = useState('');
  // Lead-handoff picker state: id of the crew mate currently selected to
  // become the new lead. Null when the picker isn't open.
  const [handoffTarget, setHandoffTarget] = useState(null);

  // Notification prefs accordion.
  const [showPrefs, setShowPrefs] = useState(false);

  // Are we viewing someone else's shift as a crew member?
  const isCrewMember = useMemo(
    () => !!(shift && currentUserId && shift.user_id !== currentUserId),
    [shift, currentUserId]
  );
  // The lead's name is embedded in crew_members on the shift object.
  const leadName = useMemo(() => {
    if (!shift) return '';
    if (shift.user_name) return shift.user_name;
    const lead = (shift.crew_members || []).find((m) => m.id === shift.user_id);
    return lead?.name || `User #${shift.user_id}`;
  }, [shift]);

  // 1-second tick for the live countdown.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Clear crew selections when switching from crew back to alone.
  useEffect(() => {
    if (mode === 'alone') {
      setCrewUserIds([]);
      setCrewFreeform('');
    }
  }, [mode]);

  useEffect(() => {
    if (editMode === 'alone') {
      setEditCrewUserIds([]);
      setEditCrewFreeform('');
    }
  }, [editMode]);

  // Initial fetch.
  useEffect(() => {
    if (initialData) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getMyTodayCheckin();
        if (cancelled) return;
        setShift(data.shift || null);
        setCheckins(data.checkins || []);
        // Pre-populate the edit panel with current values.
        if (data.shift) {
          setEditMode(data.shift.mode === 'crew' ? 'crew' : 'alone');
          setEditCrewUserIds(data.shift.crew_user_ids || []);
          setEditCrewFreeform(data.shift.crew_freeform || '');
        }
        setLoading(false);
        // If the user is on someone else's crew and hasn't registered
        // push yet, auto-subscribe so they get deadline alerts too.
        // Best-effort -- happens once when the overlay opens.
        if (data.shift && currentUserId && data.shift.user_id !== currentUserId) {
          try {
            if (pushSupported()) {
              await requestNotificationPermission();
              ensurePushSubscribed().catch(() => { /* non-fatal */ });
            }
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || String(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialData]);

  // Pre-populate start form from user_profiles last_* on first mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prefs = await api.getMyCheckinPrefs();
        if (cancelled) return;
        if (!shift && prefs.last_mode && (prefs.last_mode === 'alone' || prefs.last_mode === 'crew')) {
          setMode(prefs.last_mode);
        }
        if (!shift && Array.isArray(prefs.last_crew_user_ids)) {
          setCrewUserIds(prefs.last_crew_user_ids);
        }
      } catch {
        /* ignore -- the picker still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tier = useMemo(() => computeTier(shift, new Date()), [shift, tick]);
  const colors = tierColors(tier);

  const handleStart = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // If they previously marked today as off, end that shift first so
      // the backend's "already active" guard doesn't 409.
      if (shift && shift.mode === 'off' && !shift.ended_at) {
        await api.endShift(shift.id);
      }
      const created = await api.startShift({
        mode,
        crewUserIds: mode === 'crew' ? crewUserIds : [],
        crewFreeform: mode === 'crew' ? crewFreeform : '',
        notes,
      });
      setShift(created);
      setEditMode(created.mode === 'crew' ? 'crew' : 'alone');
      setEditCrewUserIds(created.crew_user_ids || []);
      setEditCrewFreeform(created.crew_freeform || '');
      // Tell the parent immediately so the topbar countdown lights up
      // without waiting for Supabase Realtime -- iOS PWAs frequently
      // drop the websocket while backgrounded, which is the root cause
      // of the "have to close+reopen to see the timer" bug.
      if (onShiftChanged) onShiftChanged(created);
      // Push is on-by-default for workers: ask for OS permission and
      // register the subscription right after the shift starts so the
      // worker doesn't have to dig into prefs. Best-effort -- if they
      // decline the prompt the shift still proceeds and they can flip
      // push back on later from the Notification preferences accordion.
      try {
        if (pushSupported()) {
          await requestNotificationPermission();
          ensurePushSubscribed().catch(() => { /* non-fatal */ });
        }
      } catch { /* non-fatal */ }
      // Close the overlay so the worker lands back on the dashboard
      // with the top-bar countdown live. Without this the overlay just
      // re-renders into "active shift" view, which feels stuck.
      if (onClose) onClose();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckin = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // Best-effort: include geolocation if available + already granted.
      let lat = null;
      let lon = null;
      let accuracyM = null;
      if (typeof navigator !== 'undefined' && navigator.geolocation) {
        try {
          const pos = await new Promise((res, rej) => {
            navigator.geolocation.getCurrentPosition(res, rej, {
              timeout: 5000,
              maximumAge: 30_000,
              enableHighAccuracy: false,
            });
          });
          lat = pos.coords.latitude;
          lon = pos.coords.longitude;
          accuracyM = pos.coords.accuracy;
        } catch {
          /* no geo permission -- record without */
        }
      }
      const createdCheckin = await api.createCheckin({ lat, lon, accuracyM });
      setCheckins((prev) => [createdCheckin, ...prev]);
      // Re-fetch shift so the new deadline + last_checkin_at reflect server truth.
      try {
        const data = await api.getMyTodayCheckin();
        setShift(data.shift || null);
        // Bubble up so the topbar countdown pill picks up the new
        // deadline immediately (Realtime would otherwise be the only
        // signal, and that's unreliable on iPad).
        if (onShiftChanged) onShiftChanged(data.shift || null);
      } catch {
        /* ignore -- the local tick will catch up */
      }
      // If we're rendering as the forced overlay, the parent's
      // shouldForceOverlay() will now return false and unmount us.
      if (!force && onClose) onClose();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEnd = async () => {
    if (!shift) return;
    const who = isCrewMember ? `${leadName}'s crew shift` : 'your shift';
    if (!window.confirm(`End ${who} now?`)) return;
    setSubmitting(true);
    setError(null);
    try {
      const ended = await api.endShift(shift.id);
      setShift(ended);
      if (onShiftChanged) onShiftChanged(ended);
      if (onClose) onClose();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleHandoff = async () => {
    if (!shift || !handoffTarget) return;
    const newLead = (shift.crew_members || []).find((m) => m.id === handoffTarget);
    const newLeadLabel = newLead?.name || `User #${handoffTarget}`;
    if (!window.confirm(
      `Hand off lead to ${newLeadLabel}? You'll stay on the crew, but ${newLeadLabel} becomes the point person for paperwork + alerts.`
    )) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await api.transferShiftLead(shift.id, handoffTarget);
      setShift(updated);
      if (onShiftChanged) onShiftChanged(updated);
      setHandoffTarget(null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCompositionSave = async () => {
    if (!shift) return;
    setSubmitting(true);
    setError(null);
    try {
      const finalMode =
        editMode === 'crew' &&
        (editCrewUserIds.length === 0 && !editCrewFreeform.trim())
          ? 'alone'
          : editMode;
      const updated = await api.patchShiftComposition(shift.id, {
        mode: finalMode,
        crewUserIds: editCrewUserIds,
        crewFreeform: editCrewFreeform,
      });
      setShift(updated);
      if (onShiftChanged) onShiftChanged(updated);
      setEditing(false);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────
  const headerLabel = shift
    ? shift.mode === 'off' && !shift.ended_at
      ? 'Start your shift'
      : force && !isOnline
        ? 'You\'re offline'
        : force
          ? tier === 'red' ? 'OVERDUE — please check in' : 'Check-in due'
          : isCrewMember
            ? `On ${leadName}'s crew`
            : 'On shift'
    : 'Start your shift';

  return (
    <div
      style={{
        ...S.overlay,
        // Forced overlay sits on top with a darker scrim and ignores
        // clicks on the backdrop (no onClick handler).
        background: force ? 'rgba(8,12,20,0.92)' : S.overlay.background,
      }}
      onClick={!force && onClose ? (e) => { if (e.target === e.currentTarget) onClose(); } : undefined}
    >
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, color: '#e5eefb' }}>🛟 {headerLabel}</h2>
            {shift?.started_at ? (
              <div style={{ fontSize: 12, color: '#9ab1d6', marginTop: 2 }}>
                Started {formatTime(shift.started_at)}
              </div>
            ) : null}
          </div>
          {!force && onClose ? (
            <button type="button" style={S.closeBtn} onClick={onClose} aria-label="Close">×</button>
          ) : null}
        </div>

        {loading ? (
          <div style={{ padding: '20px 0', fontSize: 14, color: '#9ab1d6' }}>Loading…</div>
        ) : null}

        {/* ── No active shift OR active off shift -> Start form ──────── */}
        {!loading && (!shift || (shift.mode === 'off' && !shift.ended_at)) ? (
          <>
            <p style={{ margin: '0 0 14px 0', fontSize: 14, color: '#c9d6ee', lineHeight: 1.5 }}>
              You don't have a shift today yet. Pick how you're working and we'll start your check-in clock.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" style={S.modeBtn(mode === 'alone')} onClick={() => setMode('alone')}>
                <div style={{ fontSize: 18, marginBottom: 2 }}>🧍</div>
                Working alone
                <div style={{ fontSize: 11, color: '#9ab1d6', fontWeight: 400 }}>Check in every 2 h</div>
              </button>
              <button type="button" style={S.modeBtn(mode === 'crew')} onClick={() => setMode('crew')}>
                <div style={{ fontSize: 18, marginBottom: 2 }}>👥</div>
                With a crew
                <div style={{ fontSize: 11, color: '#9ab1d6', fontWeight: 400 }}>Check in every 4 h</div>
              </button>
            </div>
            {mode === 'crew' ? (
              <div style={{ marginTop: 16 }}>
                <CrewPicker
                  selectedUserIds={crewUserIds}
                  freeform={crewFreeform}
                  onChange={({ userIds, freeform }) => {
                    setCrewUserIds(userIds);
                    setCrewFreeform(freeform);
                  }}
                />
              </div>
            ) : null}
            <div style={{ marginTop: 14 }}>
              <label style={{ fontSize: 13, color: '#c9d6ee', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                Notes (optional)
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. BCER north quadrant, sites W01370 + W01753"
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  background: 'rgba(143, 182, 255, 0.06)',
                  color: '#e5eefb',
                  border: '1px solid rgba(143, 182, 255, 0.18)',
                  borderRadius: 6,
                  fontSize: 13,
                }}
              />
            </div>
            {error ? (
              <div style={{ marginTop: 12, padding: 8, background: 'rgba(239, 68, 68, 0.10)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: 6, fontSize: 13 }}>
                {error}
              </div>
            ) : null}
            <div style={{ marginTop: 18, display: 'flex', gap: 8 }}>
              <button
                type="button"
                style={S.primaryBtn('#16a34a', '#ffffff')}
                onClick={handleStart}
                disabled={submitting}
              >
                {submitting ? 'Starting…' : 'Start shift'}
              </button>
            </div>
            {!shift ? (
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm('Mark today as your day off?')) return;
                    setSubmitting(true);
                    try {
                      const offShift = await api.startShift({ mode: 'off', crewUserIds: [], crewFreeform: '', notes });
                      if (onShiftChanged) onShiftChanged(offShift);
                      if (onClose) onClose();
                    } catch (err) {
                      setError(err.message || String(err));
                    } finally {
                      setSubmitting(false);
                    }
                  }}
                  style={{
                    background: 'transparent', border: 'none', color: '#9ab1d6',
                    fontSize: 12, cursor: 'pointer', textDecoration: 'underline',
                  }}
                >
                  I'm off today (skip check-ins)
                </button>
              </div>
            ) : null}
          </>
        ) : null}

        {/* ── Active shift -> live status + I'm OK + edit ──────────── */}
        {!loading && shift && !shift.ended_at && shift.mode !== 'off' ? (
          <>
            {/* Live countdown banner */}
            <div
              style={{
                background: colors.bg,
                color: colors.fg,
                padding: '14px 16px',
                borderRadius: 10,
                marginBottom: 14,
                textAlign: 'center',
                fontWeight: 600,
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>
                Next check-in {tier === 'red' ? '' : 'in'}
              </div>
              <div style={{ fontSize: 32, fontVariantNumeric: 'tabular-nums' }}>
                {formatCountdown(shift, new Date()) || '—'}
              </div>
              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                {tierLabel(tier)}
              </div>
            </div>

            {!isOnline ? (
              <div
                style={{
                  padding: 14,
                  background: 'rgba(239, 68, 68, 0.12)',
                  color: '#fca5a5',
                  border: '2px solid rgba(239, 68, 68, 0.55)',
                  borderRadius: 8,
                  marginBottom: 12,
                  fontSize: 14,
                  lineHeight: 1.55,
                }}
              >
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, color: '#fecaca' }}>
                  🚫 No service — your check-in CANNOT be recorded yet
                </div>
                <div>
                  <strong>Find cell or WiFi service first</strong>, then come back and tap I'm OK.
                  The office cannot see you as checked-in until this request reaches the server.
                </div>
              </div>
            ) : (
              <button
                type="button"
                style={S.primaryBtn(colors.bg, colors.fg)}
                onClick={handleCheckin}
                disabled={submitting}
              >
                {submitting ? 'Recording…' : "I'm OK"}
              </button>
            )}

            {/* Mode + crew summary */}
            <div style={{ marginTop: 14, fontSize: 13, color: '#c9d6ee' }}>
              <strong style={{ color: '#e5eefb' }}>Mode:</strong>{' '}
              {shift.mode === 'alone' ? 'Working alone (2 h)' : 'With a crew (4 h)'}
              {shift.last_checkin_at ? (
                <span style={{ marginLeft: 10, color: '#9ab1d6' }}>
                  · last check-in {formatRelative(shift.last_checkin_at)}
                </span>
              ) : null}
            </div>
            {/* Crew tree — visible to lead and crew members alike so
                everyone knows who they can ask to check in for them. */}
            {shift.mode === 'crew' && (shift.crew_members || []).length ? (
              <div style={{ marginTop: 8, paddingLeft: 8, borderLeft: '2px solid rgba(143,182,255,0.18)' }}>
                <div style={{ fontSize: 12, color: '#9ab1d6', fontWeight: 600, marginBottom: 4 }}>Crew</div>
                {(() => {
                  // Lead first, then crewmates.
                  const lead = (shift.crew_members || []).find((m) => m.id === shift.user_id);
                  const mates = (shift.crew_members || []).filter((m) => m.id !== shift.user_id);
                  const all = lead ? [lead, ...mates] : mates;
                  return all.map((m) => {
                    const av = hashToHslColor(m.email || m.name);
                    return (
                      <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 18, height: 18, borderRadius: '50%',
                          background: av.bg, color: av.fg, fontWeight: 600, fontSize: 9,
                        }}>{initials(m.name)}</span>
                        <span style={{ fontSize: 12, color: '#c9d6ee' }}>
                          {m.name}
                          {m.id === shift.user_id ? ' (lead)' : ''}
                          {m.id === currentUserId ? ' (you)' : ''}
                        </span>
                      </div>
                    );
                  });
                })()}
              </div>
            ) : null}

            {/* Lead handoff — visible only to the current lead of an
                active crew shift. Lets the lead pass the role to a
                crew mate (e.g. when leaving the job site). The mode,
                deadline, check-ins, and crew composition are
                preserved; only the "who's the point person" changes. */}
            {shift.mode === 'crew'
              && shift.user_id === currentUserId
              && (shift.crew_user_ids || []).length > 0 ? (
              <div style={{ marginTop: 12, padding: 10, border: '1px solid rgba(143, 182, 255, 0.16)', borderRadius: 8, background: 'rgba(143, 182, 255, 0.04)' }}>
                <div style={{ fontSize: 12, color: '#9ab1d6', marginBottom: 6 }}>
                  Leaving the job site? Hand the lead role to a crew mate.
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={handoffTarget ?? ''}
                    onChange={(e) => setHandoffTarget(e.target.value ? Number(e.target.value) : null)}
                    style={{
                      flexGrow: 1,
                      minWidth: 160,
                      background: 'rgba(9,17,31,0.85)',
                      color: '#f5f8ff',
                      border: '1px solid rgba(143,182,255,0.2)',
                      borderRadius: 8,
                      padding: '6px 10px',
                      fontSize: 13,
                    }}
                  >
                    <option value="">Select new lead…</option>
                    {(shift.crew_members || [])
                      .filter((m) => m.id !== shift.user_id)
                      .map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleHandoff}
                    disabled={!handoffTarget || submitting}
                    style={{
                      ...S.ghostBtn,
                      background: handoffTarget ? '#2563eb' : 'rgba(9,17,31,0.85)',
                      color: handoffTarget ? '#fff' : '#5f7396',
                      border: `1px solid ${handoffTarget ? '#2563eb' : 'rgba(143,182,255,0.2)'}`,
                      fontWeight: 600,
                      cursor: handoffTarget && !submitting ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Hand off lead
                  </button>
                </div>
              </div>
            ) : null}

            {/* Edit panel (collapsed by default) */}
            <div style={{ marginTop: 16 }}>
              {!editing ? (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  style={{
                    background: 'transparent', border: 'none', color: '#60a5fa',
                    cursor: 'pointer', fontSize: 13, padding: 0, textDecoration: 'underline',
                  }}
                >
                  Edit crew / mode
                </button>
              ) : (
                <div style={{ border: '1px solid rgba(143, 182, 255, 0.16)', borderRadius: 8, padding: 12, background: 'rgba(143, 182, 255, 0.04)' }}>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    <button
                      type="button"
                      style={S.modeBtn(editMode === 'alone')}
                      onClick={() => setEditMode('alone')}
                    >
                      🧍 Alone
                    </button>
                    <button
                      type="button"
                      style={S.modeBtn(editMode === 'crew')}
                      onClick={() => setEditMode('crew')}
                    >
                      👥 With crew
                    </button>
                  </div>
                  {editMode === 'crew' ? (
                    <CrewPicker
                      selectedUserIds={editCrewUserIds}
                      freeform={editCrewFreeform}
                      onChange={({ userIds, freeform }) => {
                        setEditCrewUserIds(userIds);
                        setEditCrewFreeform(freeform);
                      }}
                    />
                  ) : null}
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
                    <button type="button" style={S.ghostBtn} onClick={() => setEditing(false)} disabled={submitting}>
                      Cancel
                    </button>
                    <button type="button" style={{ ...S.ghostBtn, background: '#2563eb', color: '#fff', border: '1px solid #2563eb', fontWeight: 600 }} onClick={handleCompositionSave} disabled={submitting}>
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Today's check-ins timeline */}
            {checkins.length > 0 ? (
              <div>
                <div style={S.sectionTitle}>Today's check-ins</div>
                <div>
                  {checkins.slice(0, 8).map((c) => (
                    <div key={c.id} style={S.timelineRow}>
                      <span>{formatTime(c.created_at)}</span>
                      <span style={{ color: '#9ab1d6', fontSize: 12 }}>
                        {c.recorded_by_user_id
                        ? '(admin recorded)'
                        : c.user_id === currentUserId
                          ? "I'm OK"
                          : 'Crew check-in'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Prefs accordion */}
            <div style={{ marginTop: 18 }}>
              <button
                type="button"
                onClick={() => setShowPrefs((s) => !s)}
                style={{
                  background: 'transparent', border: 'none', color: '#9ab1d6',
                  cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline',
                }}
              >
                {showPrefs ? '▾ Hide' : '▸ Notification preferences'}
              </button>
              {showPrefs ? (
                <div style={{ marginTop: 10, padding: 12, border: '1px solid rgba(143, 182, 255, 0.16)', borderRadius: 8, background: 'rgba(143, 182, 255, 0.04)' }}>
                  <CheckInPreferencesPanel embedded />
                </div>
              ) : null}
            </div>

            {error ? (
              <div style={{ marginTop: 12, padding: 8, background: 'rgba(239, 68, 68, 0.10)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: 6, fontSize: 13 }}>
                {error}
              </div>
            ) : null}

            <div style={{ marginTop: 18, display: 'flex', justifyContent: force && !isOnline ? 'center' : 'space-between', gap: 8 }}>
              {force && !isOnline ? (
                <button type="button" style={S.ghostBtn} onClick={onClose}>
                  Dismiss
                </button>
              ) : (
                <>
                  <button type="button" style={S.dangerBtn} onClick={handleEnd} disabled={submitting}>
                    End shift
                  </button>
                  {!force && onClose ? (
                    <button type="button" style={S.ghostBtn} onClick={onClose}>
                      Close
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </>
        ) : null}

        {/* ── Shift ended -> just summary + close ────────────────── */}
        {!loading && shift && shift.ended_at ? (
          <div>
            <p style={{ fontSize: 14, color: '#c9d6ee', lineHeight: 1.5 }}>
              {shift.mode === 'off'
                ? 'Marked as your day off — no check-ins required today.'
                : `Shift ended at ${formatTime(shift.ended_at)}${shift.auto_end_reason ? ` (${shift.auto_end_reason})` : ''}.`}
            </p>
            {!force && onClose ? (
              <button type="button" style={S.ghostBtn} onClick={onClose}>Close</button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
