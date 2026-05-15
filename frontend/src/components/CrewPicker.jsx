/**
 * Shared crew picker. Used by:
 *   - MyCheckInsOverlay (no-shift state)  -- pick crew on shift start
 *   - MyCheckInsOverlay (active state)    -- edit crew mid-shift
 *
 * Two-part input:
 *   1. Multi-select chips of every active system user (sourced from
 *      `/api/checkins/me/assignable-users`).
 *   2. Free-text textarea for crew members who aren't system users
 *      (subcontractors, day labour). Newline-separated names.
 *
 * Selections are pre-loaded from the worker's last-used crew so a
 * stable Joe+Mark pairing doesn't need re-picking every morning.
 */
import { useEffect, useMemo, useState } from 'react';

import { hashToHslColor, initials } from '../lib/avatarColor';

export default function CrewPicker({
  selectedUserIds = [],
  freeform = '',
  candidates = null, // when provided, skip the network fetch
  onChange,
  disabled = false,
}) {
  const [users, setUsers] = useState(candidates || []);
  const [loading, setLoading] = useState(candidates == null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (candidates != null) {
      setUsers(candidates);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const { api } = await import('../lib/api');
        const rows = await api.listCheckinCrewCandidates();
        if (!cancelled) {
          setUsers(rows || []);
          setLoading(false);
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
  }, [candidates]);

  // Stable membership Set so toggle has O(1) lookups.
  const selectedSet = useMemo(() => new Set(selectedUserIds), [selectedUserIds]);

  const toggle = (id) => {
    if (disabled) return;
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({
      userIds: Array.from(next),
      freeform,
    });
  };

  const onFreeformChange = (e) => {
    if (disabled) return;
    onChange({ userIds: Array.from(selectedSet), freeform: e.target.value });
  };

  if (loading) {
    return <div style={{ fontSize: 13, color: '#9ab1d6' }}>Loading crew options…</div>;
  }
  if (error) {
    return (
      <div style={{ fontSize: 13, color: '#ef4444' }}>
        Couldn't load crew list: {error}
      </div>
    );
  }

  return (
    <div className="crew-picker">
      <div style={{ fontSize: 13, color: '#c9d6ee', marginBottom: 6, fontWeight: 500 }}>
        Tap to add/remove crew members:
      </div>
      <div
        className="crew-picker-chips"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
      >
        {users.length === 0 ? (
          <span style={{ fontSize: 13, color: '#9ab1d6' }}>
            No other users on this account yet.
          </span>
        ) : (
          users.map((u) => {
            const isSel = selectedSet.has(u.id);
            const colors = hashToHslColor(u.email || u.name);
            return (
              <button
                key={u.id}
                type="button"
                disabled={disabled}
                onClick={() => toggle(u.id)}
                title={u.email || u.name}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 10px 5px 5px',
                  border: isSel ? '2px solid #60a5fa' : '1px solid rgba(143, 182, 255, 0.18)',
                  borderRadius: 999,
                  background: isSel ? 'rgba(96, 165, 250, 0.12)' : 'transparent',
                  cursor: disabled ? 'default' : 'pointer',
                  fontSize: 13,
                  color: isSel ? '#60a5fa' : '#e5eefb',
                  fontWeight: isSel ? 600 : 400,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: colors.bg,
                    color: colors.fg,
                    fontSize: 10,
                    fontWeight: 600,
                  }}
                >
                  {initials(u.name)}
                </span>
                {u.name}
                {isSel ? <span style={{ marginLeft: 2 }}>✓</span> : null}
              </button>
            );
          })
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <label
          htmlFor="crew-freeform"
          style={{ fontSize: 13, color: '#c9d6ee', fontWeight: 500, display: 'block', marginBottom: 4 }}
        >
          Anyone not on this list? (one per line — optional)
        </label>
        <textarea
          id="crew-freeform"
          value={freeform}
          onChange={onFreeformChange}
          disabled={disabled}
          rows={2}
          placeholder="e.g. Dale (subcontractor)&#10;     Sarah from Halo"
          style={{
            width: '100%',
            padding: '8px 10px',
            color: '#e5eefb',
            border: '1px solid rgba(143, 182, 255, 0.18)',
            borderRadius: 6,
            fontSize: 13,
            fontFamily: 'inherit',
            resize: 'vertical',
            background: disabled ? 'rgba(143, 182, 255, 0.04)' : 'rgba(143, 182, 255, 0.06)',
          }}
        />
      </div>
    </div>
  );
}
