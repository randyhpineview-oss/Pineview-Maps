/**
 * Worker-facing notification preferences panel.
 *
 * Used in two contexts:
 *   1. Inline inside MyCheckInsOverlay (small expandable "Notifications"
 *      section).
 *   2. As a standalone modal from the Settings tab (admin can audit who
 *      has what enabled, plus the same email picker shows for the admin's
 *      own account).
 *
 * Email is OPTIONAL and OFF by default. When the worker turns it on, an
 * email picker reveals two options:
 *    (•) Use my login email — auth.email (one tap, no typing)
 *    ( ) Use a different email — text input + validation
 *
 * The server falls back to auth.email at send time when notify_email=true
 * and notify_email_address is null, so the "use login email" path stores
 * null and is naturally robust to email-change-at-Supabase.
 */
import { useEffect, useState } from 'react';

import { api } from '../lib/api';
import {
  ensurePushSubscribed,
  notificationPermission,
  pushSupported,
  requestNotificationPermission,
  unsubscribePush,
} from '../lib/pushClient';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function CheckInPreferencesPanel({ onClose, embedded = false }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);

  const [prefs, setPrefs] = useState({
    notify_push: true,
    notify_email: false,
    notify_email_address: null,
    auth_email: '',
  });
  // Email-picker UI state -- 'login' uses auth.email (stores null),
  // 'custom' uses the typed override.
  const [emailMode, setEmailMode] = useState('login');
  const [customEmail, setCustomEmail] = useState('');
  const [permission, setPermission] = useState(notificationPermission());
  const supported = pushSupported();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fetched = await api.getMyCheckinPrefs();
        if (cancelled) return;
        setPrefs(fetched);
        if (fetched.notify_email_address) {
          setEmailMode('custom');
          setCustomEmail(fetched.notify_email_address);
        } else {
          setEmailMode('login');
        }
        setLoading(false);
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
  }, []);

  const save = async (patch) => {
    setSaving(true);
    setError(null);
    setOkMsg(null);
    try {
      const next = { ...prefs, ...patch };
      // Compose notify_email_address from the picker state.
      let addr = null;
      if (next.notify_email) {
        if (emailMode === 'custom' && customEmail.trim()) {
          if (!EMAIL_RE.test(customEmail.trim())) {
            throw new Error('Enter a valid email address.');
          }
          addr = customEmail.trim();
        }
      }
      const saved = await api.updateMyCheckinPrefs({
        notify_push: next.notify_push,
        notify_email: next.notify_email,
        notify_email_address: addr,
      });
      setPrefs(saved);
      setOkMsg('Saved.');
      setTimeout(() => setOkMsg(null), 2500);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const togglePush = async (next) => {
    if (next) {
      // Ask OS permission + register the subscription with the backend.
      const perm = await requestNotificationPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setError('Browser blocked notifications. Open your phone\'s Settings → Notifications and enable it for Pineview Maps, then try again.');
        return;
      }
      const res = await ensurePushSubscribed();
      if (!res.ok) {
        setError(
          res.reason === 'no-vapid'
            ? 'Push isn\'t configured on the server yet — ask your admin to set the VAPID keys.'
            : `Couldn't enable push (${res.reason}).`,
        );
        return;
      }
      await save({ notify_push: true });
    } else {
      // Tear down the browser subscription so the OS stops bothering us.
      try {
        await unsubscribePush();
      } catch {
        /* non-fatal */
      }
      await save({ notify_push: false });
    }
  };

  const toggleEmail = async (next) => {
    await save({ notify_email: next });
  };

  const onEmailModeChange = async (next) => {
    setEmailMode(next);
    if (next === 'login') {
      // Persist immediately so the change is durable even if the
      // worker walks away.
      setCustomEmail('');
      if (prefs.notify_email) await save({ notify_email: true });
    }
  };

  const onCustomEmailBlur = async () => {
    if (!prefs.notify_email) return;
    if (emailMode !== 'custom') return;
    if (!customEmail.trim()) return;
    await save({ notify_email: true });
  };

  if (loading) {
    return <div style={{ padding: 16, fontSize: 14 }}>Loading preferences…</div>;
  }

  return (
    <div className={embedded ? 'checkin-prefs-panel embedded' : 'checkin-prefs-panel'}>
      {!embedded ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Notification preferences</h3>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: '#6b7280', fontSize: 20, padding: 4,
              }}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Push */}
      <section style={{ marginBottom: 18 }}>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: supported ? 'pointer' : 'not-allowed' }}
        >
          <input
            type="checkbox"
            checked={prefs.notify_push && permission === 'granted'}
            disabled={!supported || saving}
            onChange={(e) => togglePush(e.target.checked)}
          />
          <span style={{ fontWeight: 600, color: '#111827' }}>Push notifications</span>
          {permission === 'granted' ? (
            <span style={{ fontSize: 12, color: '#16a34a' }}>(allowed)</span>
          ) : permission === 'denied' ? (
            <span style={{ fontSize: 12, color: '#dc2626' }}>(blocked in OS settings)</span>
          ) : null}
        </label>
        {!supported ? (
          <p style={{ marginTop: 6, fontSize: 13, color: '#b45309', lineHeight: 1.4 }}>
            <strong>iPhone users:</strong> Open this site in Safari, tap Share → <em>Add to Home Screen</em>, then open the app from your home screen and enable push here. iOS 16.4 or later required.
          </p>
        ) : (
          <p style={{ marginTop: 6, fontSize: 12, color: '#6b7280', lineHeight: 1.4 }}>
            Recommended. Plays default OS sound + vibrates on lock screen even when the app is closed.
          </p>
        )}
      </section>

      {/* Email */}
      <section style={{ marginBottom: 18 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={prefs.notify_email}
            disabled={saving}
            onChange={(e) => toggleEmail(e.target.checked)}
          />
          <span style={{ fontWeight: 600, color: '#111827' }}>Email notifications</span>
          <span style={{ fontSize: 12, color: '#6b7280' }}>(optional — push usually does the job)</span>
        </label>
        {prefs.notify_email ? (
          <div style={{ marginTop: 10, marginLeft: 26, paddingLeft: 12, borderLeft: '2px solid #e5e7eb' }}>
            <div style={{ fontSize: 13, color: '#374151', marginBottom: 6, fontWeight: 500 }}>
              Send check-in emails to:
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 6 }}>
              <input
                type="radio"
                name="emailMode"
                value="login"
                checked={emailMode === 'login'}
                onChange={() => onEmailModeChange('login')}
                disabled={saving}
              />
              <span style={{ fontSize: 13 }}>
                Use my login email — <strong>{prefs.auth_email || '(unknown)'}</strong>
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 6 }}>
              <input
                type="radio"
                name="emailMode"
                value="custom"
                checked={emailMode === 'custom'}
                onChange={() => onEmailModeChange('custom')}
                disabled={saving}
              />
              <span style={{ fontSize: 13 }}>Use a different email</span>
            </label>
            {emailMode === 'custom' ? (
              <input
                type="email"
                placeholder="you@example.com"
                value={customEmail}
                onChange={(e) => setCustomEmail(e.target.value)}
                onBlur={onCustomEmailBlur}
                disabled={saving}
                style={{
                  marginLeft: 22,
                  padding: '6px 10px',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  fontSize: 13,
                  width: '90%',
                  maxWidth: 320,
                }}
              />
            ) : null}
          </div>
        ) : null}
      </section>

      {error ? (
        <div style={{ marginTop: 10, padding: 8, background: '#fef2f2', color: '#991b1b', borderRadius: 6, fontSize: 13 }}>
          {error}
        </div>
      ) : null}
      {okMsg ? (
        <div style={{ marginTop: 10, padding: 8, background: '#ecfdf5', color: '#065f46', borderRadius: 6, fontSize: 13 }}>
          {okMsg}
        </div>
      ) : null}
    </div>
  );
}
