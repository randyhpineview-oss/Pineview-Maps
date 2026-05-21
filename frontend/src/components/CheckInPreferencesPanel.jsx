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
 * Sections (top-to-bottom):
 *   1. Push notifications -- toggle, OS-permission pill, "Send me a test
 *      push" diagnostic button, and (when blocked) a platform-specific
 *      "How to re-enable" disclosure.
 *   2. Location (GPS) -- live permission state, "Test GPS now" button,
 *      and (when blocked) the same disclosure pattern. Surfaces the
 *      OFTEN-INVISIBLE failure mode where a worker declined the
 *      geolocation prompt long ago and their I'm-OK taps are recording
 *      without coordinates -- the office never sees a map pin and the
 *      worker can't tell from the green-button UI alone.
 *   3. Email notifications -- toggle + login-email-vs-custom picker.
 *
 * Honest constraint: browsers DELIBERATELY do not let websites reset a
 * denied permission programmatically. The "How to re-enable" disclosures
 * are the only path -- they walk the worker through their device's
 * Settings app screen by screen for iOS / Android / desktop.
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
import { useCallback, useEffect, useState } from 'react';

import { api } from '../lib/api';
import {
  ensurePushSubscribed,
  notificationPermission,
  pushSupported,
  requestNotificationPermission,
  unsubscribePush,
} from '../lib/pushClient';
import {
  detectPlatform,
  geolocationSupported,
  testGeolocation,
  watchGeolocationPermission,
} from '../lib/permissionsClient';
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

  // ── GPS / Geolocation diagnostic state ──────────────────────────────
  // Same idea as the test-push button but for the Location permission.
  // The check-in flow records lat/lon best-effort -- if the worker
  // declined the permission long ago they may not realise their I'm-OK
  // taps are being recorded WITHOUT coordinates, which means the office
  // has no map breadcrumb of where they were. Surfacing the permission
  // state + a "Test GPS now" button lets workers self-diagnose without
  // having to make an actual check-in to find out.
  //
  // ``gpsState`` is updated reactively via watchGeolocationPermission so
  // the pill flips the moment the worker re-enables location in OS
  // Settings without needing to refresh the panel.
  const [gpsState, setGpsState] = useState(geolocationSupported() ? 'prompt' : 'unsupported');
  const [testingGps, setTestingGps] = useState(false);
  const [gpsResult, setGpsResult] = useState(null);  // { ok, lat, lon, accuracyM } | { ok:false, reason, message } | null

  // Platform-aware "How to re-enable" instructions. Computed once;
  // worker isn't going to switch from iOS to Android mid-session.
  const platform = detectPlatform();

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

  // Subscribe to geolocation permission changes for live state pill.
  useEffect(() => {
    const unwatch = watchGeolocationPermission((next) => setGpsState(next));
    return unwatch;
  }, []);

  const handleTestGps = useCallback(async () => {
    setTestingGps(true);
    setGpsResult(null);
    try {
      const res = await testGeolocation({ timeoutMs: 8000, highAccuracy: true });
      setGpsResult(res);
      // If the worker just granted permission via the prompt, refresh
      // gpsState immediately rather than waiting for the change event,
      // because some iOS versions are flaky about firing it.
      if (res.ok) setGpsState('granted');
      else if (res.reason === 'denied') setGpsState('denied');
    } catch (err) {
      setGpsResult({
        ok: false,
        reason: 'unknown',
        message: (err && err.message) || String(err),
      });
    } finally {
      setTestingGps(false);
    }
  }, []);

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

        {/* When notifications are explicitly blocked at the OS level,
            no amount of toggling above will help -- the OS won't show
            the prompt again. Surface platform-specific reset steps so
            the worker knows EXACTLY where to go. Honest copy: there's
            no JS API to reset a denied permission, only the user can
            do it through Settings. */}
        {supported && permission === 'denied' ? (
          <PermissionResetInstructions kind="notifications" platform={platform} />
        ) : null}
      </section>

      {/* GPS / Location -- diagnostic + reset instructions. The check-in
          flow uses navigator.geolocation.getCurrentPosition() best-effort
          so a worker who declined the permission is still able to tap
          I'm OK, but their check-ins record without lat/lon. This
          section gives them a way to verify and (if blocked) reset. */}
      {gpsState !== 'unsupported' ? (
        <section style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontWeight: 600, color: t.text }}>📍 Location (GPS)</span>
            {gpsState === 'granted' ? (
              <span style={{ fontSize: 12, color: t.success }}>(allowed)</span>
            ) : gpsState === 'denied' ? (
              <span style={{ fontSize: 12, color: t.danger }}>(blocked in OS settings)</span>
            ) : gpsState === 'prompt' ? (
              <span style={{ fontSize: 12, color: t.textMuted }}>(not asked yet)</span>
            ) : null}
          </div>
          <p style={{ marginTop: 6, fontSize: 12, color: t.textMuted, lineHeight: 1.4 }}>
            Recorded with each I'm OK tap so the office can see where you were if something goes wrong.
            Your check-ins still work without it — but they won't have a map pin.
          </p>

          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={handleTestGps}
              disabled={testingGps || gpsState === 'denied'}
              title={gpsState === 'denied' ? 'Location is blocked — see how to fix below' : 'Try to get your current location'}
              style={{
                padding: '7px 14px',
                background: (testingGps || gpsState === 'denied') ? t.cardBgRaised : t.accentStrong,
                color: (testingGps || gpsState === 'denied') ? t.textMuted : t.textOnAccent,
                border: 'none',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: (testingGps || gpsState === 'denied') ? 'not-allowed' : 'pointer',
              }}
            >
              {testingGps
                ? 'Locating…'
                : gpsState === 'prompt'
                  ? '📍 Allow location'
                  : '📍 Test GPS now'}
            </button>

            {gpsResult ? (
              gpsResult.ok ? (
                <div style={{ marginTop: 8, padding: 8, background: t.successBg, color: t.success, border: `1px solid ${t.successBorder}`, borderRadius: 6, fontSize: 12, lineHeight: 1.5 }}>
                  GPS is working: <strong>{gpsResult.lat.toFixed(5)}, {gpsResult.lon.toFixed(5)}</strong>
                  {gpsResult.accuracyM != null ? ` (±${Math.round(gpsResult.accuracyM)} m)` : ''}.
                </div>
              ) : gpsResult.reason === 'denied' ? (
                <div style={{ marginTop: 8, padding: 8, background: t.dangerBg, color: t.danger, border: `1px solid ${t.dangerBorder}`, borderRadius: 6, fontSize: 12 }}>
                  Location is blocked. See the steps below to re-enable it.
                </div>
              ) : gpsResult.reason === 'unavailable' ? (
                <div style={{ marginTop: 8, padding: 8, background: t.warningBg, color: t.warning, border: `1px solid ${t.warningBorder}`, borderRadius: 6, fontSize: 12 }}>
                  GPS couldn't get a fix. If you're indoors or the radio is off, try again outside or after toggling Location services.
                </div>
              ) : gpsResult.reason === 'timeout' ? (
                <div style={{ marginTop: 8, padding: 8, background: t.warningBg, color: t.warning, border: `1px solid ${t.warningBorder}`, borderRadius: 6, fontSize: 12 }}>
                  GPS timed out after 8 seconds. Make sure Location is on and you have a clear sky / signal, then try again.
                </div>
              ) : (
                <div style={{ marginTop: 8, padding: 8, background: t.dangerBg, color: t.danger, border: `1px solid ${t.dangerBorder}`, borderRadius: 6, fontSize: 12 }}>
                  {gpsResult.message || 'GPS test failed.'}
                </div>
              )
            ) : null}
          </div>

          {/* If blocked, show how to fix. We can't programmatically
              reset the permission -- this is a hard browser security
              guarantee -- so all we can do is point the worker at the
              right Settings screen for their device. */}
          {gpsState === 'denied' ? (
            <PermissionResetInstructions kind="gps" platform={platform} />
          ) : null}
        </section>
      ) : null}

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

/**
 * Inline disclosure with platform-specific steps for re-enabling a
 * blocked browser permission. Honest framing: there is no JavaScript
 * API to reset a denied Notification or Geolocation permission -- the
 * Permissions spec deliberately gives the user one-way control over
 * blocking. So all we can do is render the exact OS / browser path.
 *
 * Props:
 *   - kind: 'notifications' | 'gps'
 *   - platform: 'ios' | 'android' | 'desktop'
 */
function PermissionResetInstructions({ kind, platform }) {
  const label = kind === 'notifications' ? 'notifications' : 'location (GPS)';
  // Icon + title vary by kind so the worker can scan multiple
  // disclosures (Notifications + GPS both blocked) without confusing
  // them.
  const icon = kind === 'notifications' ? '🔔' : '📍';
  const title = `How to re-enable ${label}`;

  // Three platform tracks. Steps are intentionally numbered + short --
  // worker is reading this on a small phone screen, possibly outdoors.
  let steps;
  if (platform === 'ios') {
    steps = kind === 'notifications' ? [
      'Open the iPhone Settings app.',
      'Scroll down and tap Pineview Maps (or Notifications → Pineview Maps).',
      'Turn Allow Notifications ON.',
      'Make sure Lock Screen, Banners, and Sounds are all checked.',
      'For overdue alerts to bypass Focus modes, also turn ON Time Sensitive Notifications.',
      'Come back and tap "Send me a test push" above to verify.',
    ] : [
      'Open the iPhone Settings app.',
      'Scroll down and tap Pineview Maps.',
      'Tap Location.',
      'Choose "While Using the App" (or "Always" if you want check-ins to work in the background).',
      'Make sure Precise Location is ON.',
      'Come back and tap "Test GPS now" above to verify.',
    ];
  } else if (platform === 'android') {
    steps = kind === 'notifications' ? [
      'Long-press the Pineview Maps icon on your home screen.',
      'Tap App info (or the ⓘ icon).',
      'Tap Notifications.',
      'Turn Allow notifications ON.',
      'If your phone has battery saver / power optimisation, set Pineview Maps to "Unrestricted" so notifications come through promptly.',
      'Come back and tap "Send me a test push" above to verify.',
    ] : [
      'Long-press the Pineview Maps icon on your home screen.',
      'Tap App info (or the ⓘ icon).',
      'Tap Permissions → Location.',
      'Choose "Allow only while using the app" (or "Allow all the time").',
      'Make sure "Use precise location" is ON.',
      'Come back and tap "Test GPS now" above to verify.',
    ];
  } else {
    steps = kind === 'notifications' ? [
      'Click the lock or info icon to the LEFT of the URL in the address bar.',
      'Find Notifications in the list.',
      'Change it from Block to Allow (or click "Reset permission").',
      'Reload the page.',
      'Come back and tap "Send me a test push" above to verify.',
    ] : [
      'Click the lock or info icon to the LEFT of the URL in the address bar.',
      'Find Location in the list.',
      'Change it from Block to Allow (or click "Reset permission").',
      'Reload the page.',
      'Come back and tap "Test GPS now" above to verify.',
    ];
  }

  return (
    <details
      style={{
        marginTop: 10,
        padding: 10,
        background: t.warningBg,
        border: `1px solid ${t.warningBorder}`,
        borderRadius: 6,
        color: t.warning,
        fontSize: 13,
      }}
    >
      <summary style={{ cursor: 'pointer', fontWeight: 600, color: t.warning, listStyle: 'revert' }}>
        {icon} {title}
      </summary>
      <p style={{ marginTop: 8, marginBottom: 8, fontSize: 12, color: t.textSubtle, lineHeight: 1.5 }}>
        Browsers don't let an app reset a blocked permission directly —
        only you can, from your device's Settings. Here's the exact path:
      </p>
      <ol style={{ marginTop: 4, marginLeft: 20, fontSize: 13, color: t.text, lineHeight: 1.6 }}>
        {steps.map((s, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <li key={i} style={{ marginBottom: 4 }}>{s}</li>
        ))}
      </ol>
    </details>
  );
}
