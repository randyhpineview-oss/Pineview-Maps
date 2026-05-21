// Browser permission helpers for the worker prefs panel.
//
// Two permissions are diagnosed by CheckInPreferencesPanel:
//   * Notifications  — used by Web Push for overdue reminders.
//   * Geolocation    — captured at check-in time so the office can see
//                      WHERE the worker was when they tapped I'm OK.
//
// Important constraint, surfaced honestly in the UI: the W3C Permissions
// spec does NOT allow a website to programmatically reset a denied
// permission. Once a user clicks Block, they have to undo it themselves
// in OS / browser Settings -- there's no JavaScript API to clear the
// decision. This module's job is therefore:
//   1. Report the current state ('granted' | 'denied' | 'prompt' | 'unsupported').
//   2. Re-prompt when the state is 'prompt' (i.e. never decided yet, or
//      dismissed without choosing).
//   3. Provide platform-specific instructions when the state is 'denied'
//      so the worker knows the exact path through Settings to fix it.

/**
 * Best-effort detection of the device platform so the prefs panel can
 * render iOS-specific vs Android-specific vs desktop reset steps.
 *
 * UA-sniffing is brittle in the general case, but here we're only
 * choosing which set of instructions to render -- a misclassified
 * desktop-as-mobile worker still sees correct generic guidance.
 *
 * @returns {'ios'|'android'|'desktop'}
 */
export function detectPlatform() {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = (navigator.userAgent || '').toLowerCase();
  // iPadOS 13+ reports as "Macintosh" but also has touch points >0,
  // so check that fallback too. iPhones / iPods always include their
  // name in the UA.
  if (/iphone|ipod/.test(ua)) return 'ios';
  if (/ipad/.test(ua)) return 'ios';
  if (/macintosh/.test(ua) && navigator.maxTouchPoints && navigator.maxTouchPoints > 1) {
    return 'ios';
  }
  if (/android/.test(ua)) return 'android';
  return 'desktop';
}

/**
 * True iff the browser exposes a usable navigator.geolocation. Old
 * WKWebViews and some kiosk browsers don't.
 */
export function geolocationSupported() {
  return typeof navigator !== 'undefined' && !!navigator.geolocation;
}

/**
 * Query the current geolocation permission state. Returns 'unsupported'
 * on browsers that have geolocation but no Permissions API (some older
 * iOS WKWebViews fall in this gap), so the caller treats it as "we
 * can't tell, just try the request and let the OS prompt handle it".
 *
 * @returns {Promise<'granted'|'denied'|'prompt'|'unsupported'>}
 */
export async function geolocationPermission() {
  if (!geolocationSupported()) return 'unsupported';
  if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
    return 'unsupported';
  }
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state;
  } catch {
    return 'unsupported';
  }
}

/**
 * Watch geolocation permission state and invoke ``onChange`` whenever
 * the user grants / revokes access (e.g. they granted via the prompt,
 * or revoked from OS Settings while the app was open).
 *
 * Returns an unsubscribe function suitable for a React effect cleanup.
 *
 * @param {(state: 'granted'|'denied'|'prompt'|'unsupported') => void} onChange
 * @returns {() => void}
 */
export function watchGeolocationPermission(onChange) {
  if (!geolocationSupported()) {
    onChange('unsupported');
    return () => {};
  }
  if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
    onChange('unsupported');
    return () => {};
  }
  let cancelled = false;
  let permissionStatus = null;
  const handler = () => {
    if (cancelled || !permissionStatus) return;
    onChange(permissionStatus.state);
  };
  navigator.permissions
    .query({ name: 'geolocation' })
    .then((status) => {
      if (cancelled) return;
      permissionStatus = status;
      onChange(status.state);
      // PermissionStatus extends EventTarget; the 'change' event fires
      // on iOS / Android / desktop when the OS or browser updates the
      // decision. Subscribing here means the prefs panel automatically
      // flips from "Blocked" to "Allowed" the moment the worker turns
      // it back on in Settings, without needing a manual refresh.
      try {
        status.addEventListener('change', handler);
      } catch {
        /* ignore -- some old Safari versions don't fire the event */
      }
    })
    .catch(() => {
      if (cancelled) return;
      onChange('unsupported');
    });
  return () => {
    cancelled = true;
    if (permissionStatus) {
      try {
        permissionStatus.removeEventListener('change', handler);
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * Trigger the browser's geolocation request, returning the position or
 * a structured error reason. Used by the "Test GPS now" button on the
 * prefs panel so the worker can verify whether their device is actually
 * giving us coordinates -- the same path the I'm-OK button takes.
 *
 * @param {{ timeoutMs?: number, highAccuracy?: boolean }} [opts]
 * @returns {Promise<
 *   { ok: true, lat: number, lon: number, accuracyM: number|null }
 *   | { ok: false, reason: 'unsupported'|'denied'|'unavailable'|'timeout'|'unknown', message: string }
 * >}
 */
export function testGeolocation({ timeoutMs = 8000, highAccuracy = true } = {}) {
  if (!geolocationSupported()) {
    return Promise.resolve({
      ok: false,
      reason: 'unsupported',
      message: 'This browser does not support GPS.',
    });
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          ok: true,
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : null,
        });
      },
      (err) => {
        // err.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT.
        // These are the tri-state outcomes worth distinguishing for the
        // worker -- "blocked" means open Settings, "unavailable" usually
        // means no GPS lock yet (try outdoors), "timeout" usually means
        // the radio is off or in airplane mode.
        let reason = 'unknown';
        if (err) {
          if (err.code === 1) reason = 'denied';
          else if (err.code === 2) reason = 'unavailable';
          else if (err.code === 3) reason = 'timeout';
        }
        resolve({
          ok: false,
          reason,
          message: (err && err.message) || 'Could not get location.',
        });
      },
      {
        enableHighAccuracy: highAccuracy,
        timeout: timeoutMs,
        // maximumAge: 0 forces a fresh fix rather than handing back a
        // stale cached position -- the test should reflect "is GPS
        // working RIGHT NOW", not "did it ever work this session".
        maximumAge: 0,
      },
    );
  });
}
