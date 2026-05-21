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
import {
  t,
  card,
  inp,
  btnPrimary,
  btnGhost,
  btnDangerSm,
} from '../../lib/checkinTheme';

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

  // Test-push diagnostic state. Result is the TestPushResponse payload
  // returned by the backend (push_configured, sub_count, results[]).
  const [testingPush, setTestingPush] = useState(false);
  const [testPushResult, setTestPushResult] = useState(null);
  const [testPushError, setTestPushError] = useState(null);

  // VAPID keypair validation. Loaded on mount + after every test-push so
  // the admin can immediately see whether the keys backend is signing
  // with are actually the matching pair of the public key the frontend
  // hands to pushManager.subscribe().
  const [vapidStatus, setVapidStatus] = useState(null);
  const [vapidLoading, setVapidLoading] = useState(false);

  const loadVapidStatus = useCallback(async () => {
    setVapidLoading(true);
    try {
      const res = await api.getCheckinVapidStatus();
      setVapidStatus(res);
    } catch (err) {
      setVapidStatus({ error: err.message || String(err) });
    } finally {
      setVapidLoading(false);
    }
  }, []);

  useEffect(() => { loadVapidStatus(); }, [loadVapidStatus]);

  const handleTestPush = async () => {
    setTestingPush(true);
    setTestPushError(null);
    setTestPushResult(null);
    try {
      const res = await api.testCheckinPush();
      setTestPushResult(res);
      // Re-verify VAPID after the test in case keys were rotated meanwhile.
      loadVapidStatus();
    } catch (err) {
      setTestPushError(err.message || String(err));
    } finally {
      setTestingPush(false);
    }
  };

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

  if (loading) return <div style={{ padding: 24, color: t.textMuted }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 760 }}>
      {error ? (
        <div style={{ padding: 10, background: t.dangerBg, color: t.danger, border: `1px solid ${t.dangerBorder}`, borderRadius: 6, fontSize: 13, marginBottom: 14 }}>{error}</div>
      ) : null}

      {/* ─── Primary office email ─────────────────────────────────── */}
      <section style={card()}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: 15, color: t.text }}>🏢 Primary office email <span style={{ fontSize: 12, color: t.success, fontWeight: 500 }}>(always active)</span></h3>
        <p style={{ margin: '0 0 10px 0', fontSize: 13, color: t.textMuted, lineHeight: 1.5 }}>
          This address receives every overdue alert and cannot be disabled or deleted — only edited.
        </p>

        {!primary && !primaryEditing ? (
          <div style={{ background: t.warningBg, border: `1px solid ${t.warningBorder}`, padding: 12, borderRadius: 8, marginBottom: 10 }}>
            <div style={{ fontWeight: 600, color: t.warning, fontSize: 13, marginBottom: 6 }}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, background: t.successBg, border: `1px solid ${t.successBorder}`, borderRadius: 6 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: t.success }}>{primary.email}</div>
              {primary.display_name ? <div style={{ fontSize: 12, color: t.successBorder }}>{primary.display_name}</div> : null}
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
        <h3 style={{ margin: '0 0 8px 0', fontSize: 15, color: t.text }}>Additional recipients</h3>
        <p style={{ margin: '0 0 10px 0', fontSize: 13, color: t.textMuted, lineHeight: 1.5 }}>
          Admins, dispatchers, anyone else who should get the alert email. Untick to silence temporarily without deleting.
        </p>

        {others.length === 0 ? (
          <div style={{ padding: 12, background: t.cardBgRaised, border: `1px solid ${t.borderSoft}`, borderRadius: 6, fontSize: 13, color: t.textMuted, textAlign: 'center' }}>
            No additional recipients yet.
          </div>
        ) : (
          <div style={{ background: t.cardBgRaised, border: `1px solid ${t.border}`, borderRadius: 6, overflow: 'hidden' }}>
            {others.map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: `1px solid ${t.divider}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer', minWidth: 0 }}>
                  <input
                    type="checkbox"
                    checked={r.is_active}
                    onChange={(e) => handleToggleActive(r, e.target.checked)}
                    disabled={busy}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: r.is_active ? t.text : t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email}</div>
                    {r.display_name ? <div style={{ fontSize: 12, color: t.textMuted }}>{r.display_name}</div> : null}
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
        <h3 style={{ margin: '0 0 8px 0', fontSize: 15, color: t.text }}>Alert cadence (read-only)</h3>
        <p style={{ margin: '0 0 10px 0', fontSize: 13, color: t.textMuted, lineHeight: 1.5 }}>
          When each kind of alert fires, measured from the worker's next check-in deadline.
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: t.cardBgRaised }}>
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
              <tr key={when} style={{ borderTop: `1px solid ${t.divider}` }}>
                <td style={td()}>{when}</td>
                <td style={td()}>{who}</td>
                <td style={td()}>{ch}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ─── Push diagnostics ─────────────────────────────────────── */}
      <section style={card()}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: 15, color: t.text }}>🔔 Push diagnostics</h3>

        {/* VAPID keypair status -- the smoking-gun config check. If keys
            don't match, every push to iOS / Android will 403 forever. */}
        {vapidLoading ? (
          <div style={{ padding: 10, background: t.cardBgRaised, border: `1px solid ${t.borderSoft}`, borderRadius: 6, fontSize: 12, color: t.textMuted, marginBottom: 10 }}>
            Verifying VAPID keypair…
          </div>
        ) : vapidStatus ? (
          <div
            style={{
              padding: 12,
              borderRadius: 6,
              marginBottom: 12,
              border: `1px solid ${vapidStatus.keys_match ? t.successBorder : t.dangerBorder}`,
              background: vapidStatus.keys_match ? t.successBg : t.dangerBg,
              color: vapidStatus.keys_match ? t.success : t.danger,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              {vapidStatus.keys_match
                ? '✅ VAPID keypair matches (backend can sign for this public key)'
                : '❌ VAPID keypair MISMATCH — push will fail with 403 until fixed'}
            </div>
            {vapidStatus.error ? (
              <div style={{ fontSize: 12, marginBottom: 6 }}>{vapidStatus.error}</div>
            ) : null}
            {!vapidStatus.keys_match && vapidStatus.stored_public_key && vapidStatus.derived_public_key ? (
              <div style={{ fontSize: 11, fontFamily: 'monospace', marginTop: 6 }}>
                <div><strong>Stored public key:</strong> {vapidStatus.stored_public_key}</div>
                <div><strong>Derived from private:</strong> {vapidStatus.derived_public_key}</div>
                <div style={{ marginTop: 6, fontFamily: 'inherit', fontSize: 12 }}>
                  Generate a fresh matched pair and paste BOTH into Render env vars together.
                </div>
              </div>
            ) : null}
            {vapidStatus.keys_match && vapidStatus.stored_public_key ? (
              <div style={{ fontSize: 11, color: t.textMuted, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                Public key: {vapidStatus.stored_public_key}
              </div>
            ) : null}
          </div>
        ) : null}

        <p style={{ margin: '0 0 12px 0', fontSize: 13, color: t.textMuted, lineHeight: 1.5 }}>
          Send a test notification to every device subscribed under your account.
          The result table shows whether each device's push service accepted the
          push and the exact response from Apple / FCM on failures.
        </p>
        <button
          type="button"
          onClick={handleTestPush}
          disabled={testingPush}
          style={btnPrimary()}
        >
          {testingPush ? 'Sending…' : 'Send test push to my devices'}
        </button>

        {testPushError ? (
          <div style={{ marginTop: 12, padding: 10, background: t.dangerBg, color: t.danger, border: `1px solid ${t.dangerBorder}`, borderRadius: 6, fontSize: 13 }}>
            {testPushError}
          </div>
        ) : null}

        {testPushResult ? (
          <div style={{ marginTop: 12 }}>
            {!testPushResult.push_configured ? (
              <div style={{ padding: 10, background: t.warningBg, color: t.warning, border: `1px solid ${t.warningBorder}`, borderRadius: 6, fontSize: 13 }}>
                Push is not configured on the backend (missing VAPID env vars).
                No pushes were sent.
              </div>
            ) : testPushResult.sub_count === 0 ? (
              <div style={{ padding: 10, background: t.warningBg, color: t.warning, border: `1px solid ${t.warningBorder}`, borderRadius: 6, fontSize: 13 }}>
                You have no push subscriptions registered. Open the Check-ins
                overlay → Notifications panel on each device you want to test
                and enable push there first.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: t.textMuted, marginBottom: 6 }}>
                  Sent to {testPushResult.sub_count} device subscription{testPushResult.sub_count === 1 ? '' : 's'}:
                </div>
                <div style={{ background: t.cardBgRaised, border: `1px solid ${t.border}`, borderRadius: 6, overflow: 'hidden' }}>
                  {testPushResult.results.map((r) => {
                    const statusColor = r.deleted
                      ? t.warning
                      : r.ok
                        ? t.success
                        : t.danger;
                    const statusLabel = r.deleted
                      ? '🧹 Removed (stale)'
                      : r.ok
                        ? '✅ Delivered to push service'
                        : '❌ Failed';
                    return (
                      <div key={r.id} style={{ padding: '10px 12px', borderTop: `1px solid ${t.divider}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 13, color: t.text, fontWeight: 600 }}>{r.push_service}</div>
                            {r.user_agent ? (
                              <div style={{ fontSize: 11, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 460 }}>{r.user_agent}</div>
                            ) : null}
                          </div>
                          <div style={{ fontSize: 12, color: statusColor, fontWeight: 600, whiteSpace: 'nowrap' }}>{statusLabel}</div>
                        </div>
                        {r.status_code ? (
                          <div style={{ marginTop: 6, fontSize: 12, color: t.textMuted }}>
                            <strong>Upstream HTTP {r.status_code}</strong>
                            {r.response_body ? <span style={{ fontFamily: 'monospace' }}> — {r.response_body}</span> : null}
                          </div>
                        ) : null}
                        {r.error && !r.status_code ? (
                          <div style={{ marginTop: 6, fontSize: 12, color: t.textMuted }}>{r.error}</div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: 10, padding: 10, background: t.cardBgRaised, border: `1px solid ${t.borderSoft}`, borderRadius: 6, fontSize: 12, color: t.textMuted, lineHeight: 1.5 }}>
                  <strong>iOS troubleshooting:</strong> If the iOS row shows ✅ but the
                  notification didn't appear on your iPhone, the subscription is
                  likely stale (encryption keys mismatch). Open the PWA on your
                  iPhone, toggle push OFF then ON in the Notifications panel,
                  then test again.
                </div>
              </>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function th() {
  return { textAlign: 'left', padding: '6px 10px', fontWeight: 600, color: t.textMuted, fontSize: 12 };
}
function td() {
  return { padding: '6px 10px', color: t.textSubtle };
}
