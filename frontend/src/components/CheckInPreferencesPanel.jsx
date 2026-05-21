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
import { t } from '../lib/checkinTheme';

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

  // ── Test-push diagnostic state ──────────────────────────────────────
  // Worker taps "Send me a test push" and we surface a clear pass /
  // fail / "no subscriptions yet" line. Mirrors the admin Settings tab
  // diagnostic but with a simpler one-line summary -- the worker doesn't
  // need to see per-endpoint URLs, just whether their phone got the
  // push or not. Used to triage "I have the PWA installed on iOS but
  // never get pushes when locked" without waiting for a real overdue.
  const [testingPush, setTestingPush] = useState(false);
  const [testResult, setTestResult] = useState(null);    // { ok, count } | null
  const [testError, setTestError] = useState(null);

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

  const handleTestPush = async () => {
    setTestingPush(true);
    setTestError(null);
    setTestResult(null);
    try {
      const res = await api.testMyPush();
      // Distill the per-endpoint results into a one-line worker
      // summary. okCount = how many devices the push pipeline accepted;
      // failCount = expired/dead subs the server cleaned up. Both are
      // useful: a worker with okCount=1 should now check their lock
      // screen / notification tray to see if the OS actually showed it.
      const okCount = (res.results || []).filter((r) => r.ok).length;
      const failCount = (res.results || []).filter((r) => !r.ok).length;
      setTestResult({
        push_configured: !!res.push_configured,
        sub_count: res.sub_count || 0,
        ok: okCount,
        failed: failCount,
      });
    } catch (err) {
      setTestError(err.message || String(err));
    } finally {
      setTestingPush(false);
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
          <h3 style={{ margin: 0, fontSize: 16, color: t.text }}>Notification preferences</h3>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: t.textMuted, fontSize: 20, padding: 4,
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
          <span style={{ fontWeight: 600, color: t.text }}>Push notifications</span>
          {permission === 'granted' ? (
            <span style={{ fontSize: 12, color: t.success }}>(allowed)</span>
          ) : permission === 'denied' ? (
            <span style={{ fontSize: 12, color: t.danger }}>(blocked in OS settings)</span>
          ) : null}
        </label>
        {!supported ? (
          <p style={{ marginTop: 6, fontSize: 13, color: t.warning, lineHeight: 1.4 }}>
            <strong>iPhone users:</strong> Open this site in Safari, tap Share → <em>Add to Home Screen</em>, then open the app from your home screen and enable push here. iOS 16.4 or later required.
          </p>
        ) : (
          <p style={{ marginTop: 6, fontSize: 12, color: t.textMuted, lineHeight: 1.4 }}>
            On by default. Plays the OS sound + vibrates on the lock screen even when the app is closed. Turn off only if you really don't want to be pinged.
          </p>
        )}

        {/* Test-push diagnostic button. Visible whenever push is
            supported on the device, regardless of whether the worker
            has the toggle on -- useful for "I just enabled push, did
            it actually take?" verification. The summary line shows
            sub_count + ok count so the worker can lock their phone
            and see whether the test notification actually shows up
            on the lock screen, which is exactly the iOS-PWA scenario
            that's been hard to debug. */}
        {supported ? (
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={handleTestPush}
              disabled={testingPush || permission !== 'granted'}
              title={permission !== 'granted' ? 'Allow notifications first' : 'Send a test push to every device you\'re signed in on'}
              style={{
                padding: '7px 14px',
                background: (testingPush || permission !== 'granted') ? t.cardBgRaised : t.accentStrong,
                color: (testingPush || permission !== 'granted') ? t.textMuted : t.textOnAccent,
                border: 'none',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: (testingPush || permission !== 'granted') ? 'not-allowed' : 'pointer',
              }}
            >
              {testingPush ? 'Sending…' : '🔔 Send me a test push'}
            </button>
            {testError ? (
              <div style={{ marginTop: 8, padding: 8, background: t.dangerBg, color: t.danger, border: `1px solid ${t.dangerBorder}`, borderRadius: 6, fontSize: 12 }}>
                {testError}
              </div>
            ) : null}
            {testResult ? (() => {
              if (!testResult.push_configured) {
                return (
                  <div style={{ marginTop: 8, padding: 8, background: t.warningBg, color: t.warning, border: `1px solid ${t.warningBorder}`, borderRadius: 6, fontSize: 12 }}>
                    Push isn't configured on the server (missing VAPID keys). Ask your admin.
                  </div>
                );
              }
              if (testResult.sub_count === 0) {
                return (
                  <div style={{ marginTop: 8, padding: 8, background: t.warningBg, color: t.warning, border: `1px solid ${t.warningBorder}`, borderRadius: 6, fontSize: 12 }}>
                    No push subscriptions yet. Toggle <strong>Push notifications</strong> on above, then try again.
                  </div>
                );
              }
              if (testResult.ok > 0) {
                return (
                  <div style={{ marginTop: 8, padding: 8, background: t.successBg, color: t.success, border: `1px solid ${t.successBorder}`, borderRadius: 6, fontSize: 12, lineHeight: 1.5 }}>
                    Sent to {testResult.ok} device{testResult.ok === 1 ? '' : 's'}{testResult.failed > 0 ? ` (${testResult.failed} expired and were cleaned up)` : ''}. Lock your phone for ~5 sec and check the lock screen — if you don't see the notification, your OS might be silencing the app (iOS Focus modes, Android battery saver).
                  </div>
                );
              }
              return (
                <div style={{ marginTop: 8, padding: 8, background: t.dangerBg, color: t.danger, border: `1px solid ${t.dangerBorder}`, borderRadius: 6, fontSize: 12 }}>
                  All {testResult.sub_count} subscription{testResult.sub_count === 1 ? '' : 's'} failed. Toggle push off and back on to refresh, then try again.
                </div>
              );
            })() : null}
          </div>
        ) : null}
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
          <span style={{ fontWeight: 600, color: t.text }}>Email notifications</span>
          <span style={{ fontSize: 12, color: t.textMuted }}>(optional — push usually does the job)</span>
        </label>
        {prefs.notify_email ? (
          <div style={{ marginTop: 10, marginLeft: 26, paddingLeft: 12, borderLeft: `2px solid ${t.border}` }}>
            <div style={{ fontSize: 13, color: t.textSubtle, marginBottom: 6, fontWeight: 500 }}>
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
              <span style={{ fontSize: 13, color: t.textSubtle }}>
                Use my login email — <strong style={{ color: t.text }}>{prefs.auth_email || '(unknown)'}</strong>
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
              <span style={{ fontSize: 13, color: t.textSubtle }}>Use a different email</span>
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
                  background: t.cardBgRaised,
                  color: t.text,
                  border: `1px solid ${t.border}`,
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
        <div style={{ marginTop: 10, padding: 8, background: t.dangerBg, color: t.danger, border: `1px solid ${t.dangerBorder}`, borderRadius: 6, fontSize: 13 }}>
          {error}
        </div>
      ) : null}
      {okMsg ? (
        <div style={{ marginTop: 10, padding: 8, background: t.successBg, color: t.success, border: `1px solid ${t.successBorder}`, borderRadius: 6, fontSize: 13 }}>
          {okMsg}
        </div>
      ) : null}
    </div>
  );
}
