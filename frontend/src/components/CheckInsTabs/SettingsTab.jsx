/**
 * Settings tab — office alert recipients + cadence preview.
 *
 * Two-section recipient list per the plan:
 *   1. 🏢 Primary office email — pinned at the top, no disable/delete.
 *      First-time setup banner appears when no primary exists.
 *   2. Additional recipients — toggleable checkbox per row, add/edit/delete.
 *
 * Plus a small read-only "Cadence preview" table so admins remember
 * what triggers when.
 */
import { useCallback, useEffect, useState } from 'react';

import { api } from '../../lib/api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SettingsTab() {
  const [recipients, setRecipients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Primary editor state
  const [primaryEditing, setPrimaryEditing] = useState(false);
  const [primaryEmail, setPrimaryEmail] = useState('');
  const [primaryDisplayName, setPrimaryDisplayName] = useState('');

  // Add-recipient form state
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');

  const fetchAll = useCallback(async () => {
    try {
      const rows = await api.listAlertRecipients();
      setRecipients(Array.isArray(rows) ? rows : []);
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const primary = recipients.find((r) => r.is_primary) || null;
  const others = recipients.filter((r) => !r.is_primary);

  const handlePrimarySave = async () => {
    if (!primaryEmail || !EMAIL_RE.test(primaryEmail.trim())) {
      setError('Enter a valid email address for the primary office recipient.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.upsertPrimaryRecipient({
        email: primaryEmail.trim(),
        displayName: primaryDisplayName.trim() || null,
      });
      setPrimaryEditing(false);
      setPrimaryEmail('');
      setPrimaryDisplayName('');
      await fetchAll();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const beginEditPrimary = () => {
    setPrimaryEmail(primary?.email || '');
    setPrimaryDisplayName(primary?.display_name || '');
    setPrimaryEditing(true);
  };

  const handleAddRecipient = async () => {
    if (!newEmail || !EMAIL_RE.test(newEmail.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addAlertRecipient({
        email: newEmail.trim(),
        displayName: newDisplayName.trim() || null,
        isActive: true,
      });
      setAdding(false);
      setNewEmail('');
      setNewDisplayName('');
      await fetchAll();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleActive = async (row, next) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateAlertRecipient(row.id, { isActive: next });
      await fetchAll();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (row) => {
    if (!window.confirm(`Remove ${row.email} from the recipient list?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAlertRecipient(row.id);
      await fetchAll();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div style={{ padding: 24, color: '#6b7280' }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 760 }}>
      {error ? (
        <div style={{ padding: 10, background: '#fef2f2', color: '#991b1b', borderRadius: 6, fontSize: 13, marginBottom: 14 }}>{error}</div>
      ) : null}

      {/* ─── Primary office email ─────────────────────────────────── */}
      <section style={card()}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: 15 }}>🏢 Primary office email <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 500 }}>(always active)</span></h3>
        <p style={{ margin: '0 0 10px 0', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
          This address receives every overdue alert and cannot be disabled or deleted — only edited.
        </p>

        {!primary && !primaryEditing ? (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', padding: 12, borderRadius: 8, marginBottom: 10 }}>
            <div style={{ fontWeight: 600, color: '#92400e', fontSize: 13, marginBottom: 6 }}>
              Set the office email that always gets overdue alerts:
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="email"
                placeholder="office@example.com"
                value={primaryEmail}
                onChange={(e) => setPrimaryEmail(e.target.value)}
                style={inp({ flex: '1 1 200px' })}
              />
              <input
                type="text"
                placeholder="Display name (optional)"
                value={primaryDisplayName}
                onChange={(e) => setPrimaryDisplayName(e.target.value)}
                style={inp({ flex: '1 1 160px' })}
              />
              <button type="button" onClick={handlePrimarySave} disabled={busy} style={btnPrimary()}>Save</button>
            </div>
          </div>
        ) : null}

        {primary && !primaryEditing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, background: '#ecfdf5', borderRadius: 6 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#065f46' }}>{primary.email}</div>
              {primary.display_name ? <div style={{ fontSize: 12, color: '#047857' }}>{primary.display_name}</div> : null}
            </div>
            <button type="button" onClick={beginEditPrimary} style={btnGhost()}>Edit</button>
          </div>
        ) : null}

        {primaryEditing ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="email"
              placeholder="office@example.com"
              value={primaryEmail}
              onChange={(e) => setPrimaryEmail(e.target.value)}
              style={inp({ flex: '1 1 200px' })}
              autoFocus
            />
            <input
              type="text"
              placeholder="Display name (optional)"
              value={primaryDisplayName}
              onChange={(e) => setPrimaryDisplayName(e.target.value)}
              style={inp({ flex: '1 1 160px' })}
            />
            <button type="button" onClick={handlePrimarySave} disabled={busy} style={btnPrimary()}>Save</button>
            <button type="button" onClick={() => setPrimaryEditing(false)} style={btnGhost()}>Cancel</button>
          </div>
        ) : null}
      </section>

      {/* ─── Additional recipients ────────────────────────────────── */}
      <section style={card()}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: 15 }}>Additional recipients</h3>
        <p style={{ margin: '0 0 10px 0', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
          Admins, dispatchers, anyone else who should get the alert email. Untick to silence temporarily without deleting.
        </p>

        {others.length === 0 ? (
          <div style={{ padding: 12, background: '#f9fafb', borderRadius: 6, fontSize: 13, color: '#6b7280', textAlign: 'center' }}>
            No additional recipients yet.
          </div>
        ) : (
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden' }}>
            {others.map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid #f3f4f6' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer', minWidth: 0 }}>
                  <input
                    type="checkbox"
                    checked={r.is_active}
                    onChange={(e) => handleToggleActive(r, e.target.checked)}
                    disabled={busy}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: r.is_active ? '#111827' : '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email}</div>
                    {r.display_name ? <div style={{ fontSize: 12, color: '#6b7280' }}>{r.display_name}</div> : null}
                  </div>
                </label>
                <button type="button" onClick={() => handleDelete(r)} disabled={busy} style={btnDangerSm()}>Remove</button>
              </div>
            ))}
          </div>
        )}

        {!adding ? (
          <div style={{ marginTop: 10 }}>
            <button type="button" onClick={() => setAdding(true)} style={btnGhost()}>+ Add recipient</button>
          </div>
        ) : (
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="email"
              placeholder="someone@example.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              style={inp({ flex: '1 1 200px' })}
              autoFocus
            />
            <input
              type="text"
              placeholder="Display name (optional)"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              style={inp({ flex: '1 1 160px' })}
            />
            <button type="button" onClick={handleAddRecipient} disabled={busy} style={btnPrimary()}>Add</button>
            <button type="button" onClick={() => { setAdding(false); setNewEmail(''); setNewDisplayName(''); }} style={btnGhost()}>Cancel</button>
          </div>
        )}
      </section>

      {/* ─── Cadence preview ──────────────────────────────────────── */}
      <section style={card()}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: 15 }}>Alert cadence (read-only)</h3>
        <p style={{ margin: '0 0 10px 0', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
          When each kind of alert fires, measured from the worker's next check-in deadline.
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={th()}>When</th>
              <th style={th()}>Who</th>
              <th style={th()}>Channel</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['T−15 min',        'Worker', 'Push + (optional) email'],
              ['T+0 (deadline)',  'Worker', 'Push + (optional) email'],
              ['T+3 min (overdue)','Worker', 'Push (urgent) + (optional) email'],
              ['Every 10 min after T+3', 'Worker', 'Push (urgent) + (optional) email'],
              ['T+30 min',        'Office', 'Email (standard tone)'],
              ['T+60 min',        'Office', 'Email (🚨 URGENT tone)'],
            ].map(([when, who, ch]) => (
              <tr key={when} style={{ borderTop: '1px solid #f3f4f6' }}>
                <td style={td()}>{when}</td>
                <td style={td()}>{who}</td>
                <td style={td()}>{ch}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function card() {
  return { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 14 };
}
function inp(extra = {}) {
  return {
    padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6,
    fontSize: 13, minWidth: 0, ...extra,
  };
}
function btnPrimary() {
  return {
    padding: '6px 14px', background: '#2563eb', color: '#fff', border: 'none',
    borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  };
}
function btnGhost() {
  return {
    padding: '6px 12px', background: '#f3f4f6', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, cursor: 'pointer',
  };
}
function btnDangerSm() {
  return {
    padding: '4px 10px', background: '#fef2f2', color: '#991b1b',
    border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, cursor: 'pointer',
  };
}
function th() {
  return { textAlign: 'left', padding: '6px 10px', fontWeight: 600, color: '#374151', fontSize: 12 };
}
function td() {
  return { padding: '6px 10px', color: '#374151' };
}
