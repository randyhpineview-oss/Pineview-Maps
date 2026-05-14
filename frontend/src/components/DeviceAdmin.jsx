import { useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api';
import { useDialog } from './DialogProvider';
import ColorPicker, { pickNextUnusedColor } from './ColorPicker';

// Resolve the base URL we'll hand to OwnTracks. Order of precedence:
//   1. VITE_API_BASE_URL  — set in .env / Vercel for prod
//   2. window.location.origin — local dev fallback
// We deliberately strip a trailing slash so the path concat below is clean.
function getApiBaseUrl() {
  const env = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/$/, '');
  if (env) return env;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

// Format "2 min ago", "3 hr ago", "yesterday at 14:32" for the last-seen
// label. Returns "—" for null/undefined.
function relativeTime(iso) {
  if (!iso) return '—';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '—';
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  // Older: drop to a date string. Locale-aware so admins in different
  // regions see the format they expect.
  return new Date(iso).toLocaleDateString();
}

// One-time reveal of the raw OwnTracks token. After create/rotate we
// keep the token in component state ONLY for the lifetime of this modal;
// closing it loses the value forever (the backend never reveals it again).
function TokenRevealModal({ open, device, rawToken, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!open || !rawToken || !device) return null;

  const apiBase = getApiBaseUrl();
  const ingestUrl = `${apiBase}/api/devices/ping`;

  // The exact OwnTracks JSON config block. Workers can either type each
  // field manually or paste the entire block via Settings → Configuration
  // → "Load configuration from URL/file/clipboard". `tid` is the 2-char
  // tracker id shown on the map dot in OwnTracks-internal views; we use
  // the device's numeric id zero-padded so it's stable and unique.
  const tidPadded = String(device.id).padStart(2, '0').slice(-2);
  const owntracksConfig = JSON.stringify(
    {
      _type: 'configuration',
      mode: 3, // HTTP mode
      url: ingestUrl,
      auth: true,
      // OwnTracks's HTTP Authentication block lets us send a bearer
      // token as the password. Username is purely informational here.
      username: device.label,
      password: rawToken,
      // 15-minute reporting cadence (per the plan).
      locatorDisplacement: 0,
      locatorInterval: 900,
      monitoring: 1, // significant changes
      tid: tidPadded,
      pubExtendedData: true,
      cmd: false,
      pubQos: 1,
      pubRetain: true,
      ignoreInaccurateLocations: 200,
    },
    null,
    2,
  );

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail on iOS PWAs without HTTPS — fall back
      // to a temporary textarea + execCommand which works everywhere.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
  }

  return (
    // Same modal styling pattern as other overlays in the app — full-
    // screen scrim + centered card. Clicking the scrim does NOT close
    // (force the admin to use the explicit "I've copied the token"
    // button — they MUST capture it before losing access).
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        style={{
          background: '#0f1c33',
          border: '1px solid rgba(143,182,255,0.2)',
          borderRadius: '0.75rem',
          padding: '1.25rem',
          maxWidth: '36rem',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          color: '#e5eefb',
        }}
      >
        <h2 style={{ marginTop: 0 }}>Configure OwnTracks on {device.label}</h2>
        <div
          style={{
            background: '#7c2d12',
            color: '#fef3c7',
            padding: '0.6rem 0.8rem',
            borderRadius: '0.4rem',
            marginBottom: '1rem',
            fontSize: '0.85rem',
            fontWeight: 600,
          }}
        >
          ⚠ This token is shown only once. Copy it now — after you close
          this dialog, you'll need to rotate the token to see a new one.
        </div>

        <h3 style={{ fontSize: '0.95rem', marginBottom: '0.25rem' }}>1. Install OwnTracks</h3>
        <p className="small-text" style={{ marginTop: 0 }}>
          On the truck's iPad: install the free <strong>OwnTracks</strong> app
          from the App Store (search "OwnTracks").
        </p>

        <h3 style={{ fontSize: '0.95rem', marginTop: '1rem', marginBottom: '0.25rem' }}>
          2. Configure HTTP mode
        </h3>
        <p className="small-text" style={{ marginTop: 0 }}>
          OwnTracks &rarr; Settings &rarr; Preferences &rarr; <em>Mode</em>: HTTP.
          Then enter these values:
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
          <CopyRow label="URL" value={ingestUrl} onCopy={copyText} />
          <CopyRow label="Username" value={device.label} onCopy={copyText} />
          <CopyRow label="Password (Token)" value={rawToken} onCopy={copyText} mono />
          <CopyRow label="Device ID" value={String(device.id)} onCopy={copyText} />
          <CopyRow label="Tracker ID" value={tidPadded} onCopy={copyText} />
        </div>

        <h3 style={{ fontSize: '0.95rem', marginTop: '1rem', marginBottom: '0.25rem' }}>
          3. (Recommended) Bulk-load this configuration
        </h3>
        <p className="small-text" style={{ marginTop: 0 }}>
          Instead of typing each field, copy the JSON below, paste it in
          Apple Notes on the iPad, share it to OwnTracks, and tap "Load
          configuration". This sets the 15-min reporting interval and
          significant-change mode automatically.
        </p>
        <div style={{ position: 'relative' }}>
          <textarea
            readOnly
            value={owntracksConfig}
            rows={14}
            style={{
              width: '100%',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.78rem',
              background: '#0a1424',
              color: '#bde0fe',
              border: '1px solid rgba(143,182,255,0.15)',
              borderRadius: '0.4rem',
              padding: '0.5rem',
              resize: 'vertical',
            }}
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            className="secondary-button"
            onClick={() => copyText(owntracksConfig)}
            style={{ marginTop: '0.4rem' }}
          >
            {copied ? '✓ Copied' : 'Copy JSON config'}
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
          <button type="button" className="primary-button" onClick={onClose}>
            I've configured this device
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyRow({ label, value, onCopy, mono = false }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.4rem',
        background: '#0a1424',
        border: '1px solid rgba(143,182,255,0.15)',
        borderRadius: '0.4rem',
        padding: '0.4rem 0.6rem',
      }}
    >
      <div style={{ flexShrink: 0, fontWeight: 600, fontSize: '0.8rem', minWidth: '7rem' }}>
        {label}
      </div>
      <div
        style={{
          flexGrow: 1,
          overflowX: 'auto',
          whiteSpace: 'nowrap',
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
          fontSize: mono ? '0.78rem' : '0.85rem',
          color: mono ? '#bde0fe' : '#e5eefb',
        }}
      >
        {value}
      </div>
      <button
        type="button"
        className="secondary-button"
        style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
        onClick={() => onCopy(value)}
      >
        Copy
      </button>
    </div>
  );
}

/**
 * Admin tab: register iPads (devices), assign a per-truck color, generate
 * OwnTracks bearer tokens, see last-known position info, rotate or
 * retire devices. Sits inside AdminPanel as a CollapsibleSection.
 *
 * Self-loads its own user list (via `/api/admin/devices/assignable-users`)
 * because the app's `cachedUsers` array intermixes Supabase admin records
 * (string UUID ids) with local-users-table Realtime rows (integer ids) —
 * neither type can be reliably used as `assigned_user_id`.
 *
 * Props:
 *   - busy: global busy flag (admin-wide busy state)
 */
export default function DeviceAdmin({ busy = false }) {
  const { confirm, alert } = useDialog();

  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Locally fetched — see component docstring for why this can't reuse
  // App.jsx's cachedUsers state.
  const [assignableUsers, setAssignableUsers] = useState([]);

  // Add-device form local state. The color defaults to whatever
  // `pickNextUnusedColor` returns once the devices list loads, so first-
  // load is "red", then "orange", then "yellow", etc.
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState('#E53935');
  const [newAssignedUserId, setNewAssignedUserId] = useState('');

  // After create/rotate we hold the raw token here so TokenRevealModal can
  // display it. Cleared as soon as the admin dismisses the modal.
  const [tokenReveal, setTokenReveal] = useState(null); // { device, rawToken }

  // Edit-mode tracks which device row is currently expanded for inline
  // editing. Only one at a time to keep the panel compact.
  const [editingId, setEditingId] = useState(null);
  const [editLabel, setEditLabel] = useState('');
  const [editColor, setEditColor] = useState('#1E88E5');
  const [editAssignedUserId, setEditAssignedUserId] = useState('');
  const [editIsActive, setEditIsActive] = useState(true);

  // Backend already returns the list ordered by name, but we re-sort
  // defensively in case a non-API caller ever populates this state.
  const sortedUsers = useMemo(
    () => [...assignableUsers].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [assignableUsers],
  );

  const usedColors = useMemo(() => devices.map((d) => d.color_hex), [devices]);

  async function loadDevices() {
    setLoading(true);
    setError(null);
    try {
      const rows = await api.listDevices({ includeInactive: true });
      setDevices(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err.message || 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }

  async function loadAssignableUsers() {
    // Failure here is non-blocking — the form still works, the dropdown
    // is just empty. We surface the device-list error instead since
    // that's the primary purpose of the tab.
    try {
      const rows = await api.listAssignableDeviceUsers();
      setAssignableUsers(Array.isArray(rows) ? rows : []);
    } catch (err) {
      console.warn('[DeviceAdmin] Failed to load assignable users:', err);
    }
  }

  useEffect(() => {
    loadDevices();
    loadAssignableUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-pick the suggested new-device color whenever the list changes so
  // the next color is always the lowest unused preset.
  useEffect(() => {
    if (!showAddForm) {
      setNewColor(pickNextUnusedColor(usedColors));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usedColors.join('|'), showAddForm]);

  function startEdit(device) {
    setEditingId(device.id);
    setEditLabel(device.label || '');
    setEditColor(device.color_hex || '#1E88E5');
    setEditAssignedUserId(device.assigned_user_id ? String(device.assigned_user_id) : '');
    setEditIsActive(!!device.is_active);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function submitNew(event) {
    event.preventDefault();
    if (!newLabel.trim()) return;
    try {
      const resp = await api.createDevice({
        label: newLabel.trim(),
        color_hex: newColor,
        assigned_user_id: newAssignedUserId ? Number(newAssignedUserId) : null,
      });
      // Stash the raw token for the reveal modal — it's only available
      // in this exact response.
      setTokenReveal({ device: resp.device, rawToken: resp.raw_token });
      // Reset form, hide it, and refresh the list with the new row.
      setNewLabel('');
      setNewAssignedUserId('');
      setShowAddForm(false);
      await loadDevices();
    } catch (err) {
      await alert({
        title: 'Could not create device',
        message: err.message || String(err),
      });
    }
  }

  async function submitEdit(deviceId) {
    try {
      const payload = {
        label: editLabel.trim(),
        color_hex: editColor,
        is_active: editIsActive,
      };
      // Distinguish "no user selected" from "different user selected".
      // Backend treats clear_assigned_user as an explicit clear path.
      if (editAssignedUserId === '') {
        payload.clear_assigned_user = true;
      } else {
        payload.assigned_user_id = Number(editAssignedUserId);
      }
      await api.updateDevice(deviceId, payload);
      setEditingId(null);
      await loadDevices();
    } catch (err) {
      await alert({
        title: 'Could not update device',
        message: err.message || String(err),
      });
    }
  }

  async function handleRotate(device) {
    const ok = await confirm({
      title: 'Rotate token',
      message: `Generate a new OwnTracks token for "${device.label}"? The current token will stop working immediately — you'll need to re-configure OwnTracks on this iPad.`,
      okLabel: 'Rotate token',
      severity: 'danger',
    });
    if (!ok) return;
    try {
      const resp = await api.rotateDeviceToken(device.id);
      setTokenReveal({ device, rawToken: resp.raw_token });
      await loadDevices();
    } catch (err) {
      await alert({ title: 'Could not rotate token', message: err.message || String(err) });
    }
  }

  async function handleDelete(device, hard = false) {
    const verbLong = hard
      ? `Permanently delete "${device.label}" and all its ping history? This cannot be undone.`
      : `Disable "${device.label}"? The iPad will no longer appear on the map. You can reactivate it later by editing the device.`;
    const ok = await confirm({
      title: hard ? 'Delete forever' : 'Disable device',
      message: verbLong,
      okLabel: hard ? 'Delete forever' : 'Disable',
      severity: 'danger',
    });
    if (!ok) return;
    try {
      await api.deleteDevice(device.id, { hard });
      await loadDevices();
    } catch (err) {
      await alert({ title: 'Could not remove device', message: err.message || String(err) });
    }
  }

  return (
    <div className="list-grid">
      <TokenRevealModal
        open={!!tokenReveal}
        device={tokenReveal?.device}
        rawToken={tokenReveal?.rawToken}
        onClose={() => setTokenReveal(null)}
      />

      {/* Add Device toggle */}
      <div className="site-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div>
          <strong>Truck iPads</strong>
          <div className="small-text">
            {devices.length === 0
              ? 'No devices registered yet.'
              : `${devices.filter((d) => d.is_active).length} active · ${devices.length} total`}
          </div>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => setShowAddForm((s) => !s)}
          disabled={busy}
        >
          {showAddForm ? 'Cancel' : '+ Add iPad'}
        </button>
      </div>

      {/* Add Device form (inline, expands above the list) */}
      {showAddForm ? (
        <form onSubmit={submitNew} className="site-row" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span className="small-text" style={{ fontWeight: 600 }}>Label</span>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Truck 5"
              required
              autoFocus
            />
          </label>
          <div>
            <div className="small-text" style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Truck color</div>
            <ColorPicker value={newColor} onChange={setNewColor} usedColors={usedColors} />
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span className="small-text" style={{ fontWeight: 600 }}>
              Assigned employee <span style={{ color: '#9ab1d6', fontWeight: 400 }}>(optional, tooltip only)</span>
            </span>
            <select
              value={newAssignedUserId}
              onChange={(e) => setNewAssignedUserId(e.target.value)}
            >
              <option value="">— None —</option>
              {sortedUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button type="submit" className="primary-button" disabled={!newLabel.trim() || busy}>
              Create &amp; reveal token
            </button>
            <button type="button" className="secondary-button" onClick={() => setShowAddForm(false)}>
              Cancel
            </button>
          </div>
          <div className="small-text" style={{ color: '#9ab1d6' }}>
            On submit, you'll see the OwnTracks token and configuration JSON
            <strong> once</strong>. Make sure to configure the iPad before closing.
          </div>
        </form>
      ) : null}

      {/* Error banner */}
      {error ? (
        <div className="site-row" style={{ background: '#7c2d12', color: '#fef3c7' }}>
          {error}
        </div>
      ) : null}

      {/* Device list */}
      {loading && devices.length === 0 ? (
        <div className="site-row"><div className="small-text">Loading devices…</div></div>
      ) : devices.length === 0 && !showAddForm ? (
        <div className="site-row">
          <div className="small-text">No devices yet. Tap "+ Add iPad" to register the first truck.</div>
        </div>
      ) : (
        devices.map((device) => {
          const isEditing = editingId === device.id;
          return (
            <div key={device.id} className="site-row" style={{ opacity: device.is_active ? 1 : 0.55 }}>
              {!isEditing ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <span
                      aria-hidden
                      title={device.color_hex}
                      style={{
                        display: 'inline-block',
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        background: device.color_hex,
                        border: '1px solid rgba(255,255,255,0.2)',
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ flexGrow: 1, minWidth: 0 }}>
                      <strong>{device.label}</strong>
                      {!device.is_active ? (
                        <span style={{ marginLeft: '0.4rem', fontSize: '0.7rem', color: '#fbbf24' }}>
                          (disabled)
                        </span>
                      ) : null}
                      <div className="small-text" style={{ color: '#9ab1d6' }}>
                        {device.assigned_user_name ? `Assigned to ${device.assigned_user_name}` : 'Unassigned'}
                        {' · '}
                        Last seen: {relativeTime(device.last_seen_at)}
                        {device.last_battery_pct != null ? ` · 🔋 ${device.last_battery_pct}%` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="button-row" style={{ marginTop: '0.6rem' }}>
                    <button type="button" className="secondary-button" onClick={() => startEdit(device)}>
                      Edit
                    </button>
                    <button type="button" className="secondary-button" onClick={() => handleRotate(device)}>
                      Rotate token
                    </button>
                    <button type="button" className="danger-button" onClick={() => handleDelete(device, false)}>
                      {device.is_active ? 'Disable' : 'Disable'}
                    </button>
                    <button type="button" className="danger-button" onClick={() => handleDelete(device, true)} style={{ opacity: 0.7 }}>
                      Delete forever
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <span className="small-text" style={{ fontWeight: 600 }}>Label</span>
                    <input
                      type="text"
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                    />
                  </label>
                  <div>
                    <div className="small-text" style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Truck color</div>
                    <ColorPicker
                      value={editColor}
                      onChange={setEditColor}
                      usedColors={usedColors.filter((c) => c !== device.color_hex)}
                    />
                  </div>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <span className="small-text" style={{ fontWeight: 600 }}>Assigned employee</span>
                    <select
                      value={editAssignedUserId}
                      onChange={(e) => setEditAssignedUserId(e.target.value)}
                    >
                      <option value="">— None —</option>
                      {sortedUsers.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name || u.email}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={editIsActive}
                      onChange={(e) => setEditIsActive(e.target.checked)}
                    />
                    <span className="small-text">Active (shows on map)</span>
                  </label>
                  <div className="button-row">
                    <button type="button" className="primary-button" onClick={() => submitEdit(device.id)}>
                      Save
                    </button>
                    <button type="button" className="secondary-button" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
