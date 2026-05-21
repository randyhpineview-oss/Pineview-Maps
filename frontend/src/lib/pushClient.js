// Web Push subscription helper.
//
// The flow:
//   1. Browser calls ensurePushSubscribed() (e.g. on login, or when the
//      worker enables push in the prefs panel).
//   2. We fetch the VAPID public key from the backend.
//   3. Call serviceWorker.ready -> pushManager.subscribe() with that
//      key. The browser hits FCM (Android) / Apple Push (iOS PWA) and
//      returns a subscription endpoint + the p256dh/auth keys it
//      generated.
//   4. POST the subscription to /api/push/subscribe so the backend can
//      send pushes against it from the scan endpoint.
//
// Idempotent: re-running just refreshes the row server-side.
//
// iOS gotchas (intentional, documented in plan):
//   * iOS Safari before 16.4 has no PushManager. We detect and bail.
//   * iOS only supports push for PWAs installed via Add to Home Screen.
//     CheckInPreferencesPanel shows the install instructions when the
//     PushManager isn't available.

import { api } from './api';

/** True iff the browser can register for Web Push at all. */
export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * The OS notification-permission state. Returns 'unsupported' on browsers
 * without the Notification API at all (old Safari on iOS < 16.4).
 *
 * @returns {'granted'|'denied'|'default'|'unsupported'}
 */
export function notificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * Convert the base64url public VAPID key into the Uint8Array shape the
 * PushManager.subscribe API needs.
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Byte-compare two ArrayBuffer-ish values. Used to detect VAPID public
 * key drift between an existing browser-side subscription and the
 * current server VAPID key.
 *
 * Returns false (not equal) when either side is null/undefined so the
 * caller treats "no info" as "needs refresh" -- safer than silently
 * keeping a subscription we can't verify.
 */
function buffersEqual(a, b) {
  if (!a || !b) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  if (va.length !== vb.length) return false;
  for (let i = 0; i < va.length; i += 1) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}

/**
 * Pull the active push subscription (if any) from the SW registration.
 */
async function getCurrentSubscription() {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Request OS permission to show notifications. Idempotent: returns the
 * current permission state if already decided.
 *
 * @returns {Promise<'granted'|'denied'|'default'|'unsupported'>}
 */
export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Ensure the user is subscribed for push, creating a new subscription if
 * needed and POSTing it to /api/push/subscribe. Safe to call multiple
 * times -- only does work when something has changed.
 *
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function ensurePushSubscribed() {
  if (!pushSupported()) {
    return { ok: false, reason: 'unsupported' };
  }
  if (Notification.permission !== 'granted') {
    return { ok: false, reason: 'permission-not-granted' };
  }

  // Pull the public key from the backend. Cached for the duration of
  // the call -- the server response is stable so a single fetch is fine.
  let publicKey;
  try {
    const resp = await api.getVapidPublicKey();
    publicKey = (resp && resp.public_key) || '';
  } catch (err) {
    console.warn('[push] Failed to fetch VAPID key:', err);
    return { ok: false, reason: 'no-vapid' };
  }
  if (!publicKey) return { ok: false, reason: 'no-vapid' };

  let reg;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch (err) {
    console.warn('[push] No active service worker:', err);
    return { ok: false, reason: 'no-sw' };
  }

  const expectedKey = urlBase64ToUint8Array(publicKey);
  let subscription = await reg.pushManager.getSubscription();

  // VAPID-drift recovery: if the browser still has a subscription bound
  // to an OLD VAPID public key (server-side key rotation, fresh deploy
  // with regenerated keys, etc.), it would silently keep pushing to a
  // dead endpoint that backend can never sign for -- Apple/FCM return
  // 403 "bad JWT" every time. Detect the mismatch by comparing the
  // existing subscription's applicationServerKey bytes to the current
  // server key, and recycle the sub on mismatch so the new subscribe()
  // below binds to the current key.
  if (subscription) {
    const existingKey = subscription.options && subscription.options.applicationServerKey;
    if (!buffersEqual(existingKey, expectedKey)) {
      console.info('[push] VAPID key changed; recycling stale subscription');
      try {
        await subscription.unsubscribe();
      } catch (err) {
        console.warn('[push] Stale subscription unsubscribe failed:', err);
      }
      subscription = null;
    }
  }

  if (!subscription) {
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: expectedKey,
      });
    } catch (err) {
      console.warn('[push] subscribe() failed:', err);
      return { ok: false, reason: 'subscribe-failed' };
    }
  }

  // POST to backend (idempotent upsert). Keys come out of the
  // subscription as ArrayBuffers; serialize to base64url.
  const json = subscription.toJSON();
  try {
    await api.subscribePush({
      endpoint: subscription.endpoint,
      p256dh: json.keys?.p256dh || '',
      auth: json.keys?.auth || '',
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    });
  } catch (err) {
    console.warn('[push] Failed to POST subscription to backend:', err);
    return { ok: false, reason: 'post-failed' };
  }
  return { ok: true };
}

/**
 * Unsubscribe the device from push (both at the browser level AND at the
 * backend). Safe to call when not subscribed -- silently no-ops.
 *
 * @returns {Promise<void>}
 */
export async function unsubscribePush() {
  const sub = await getCurrentSubscription();
  if (!sub) return;
  try {
    await api.unsubscribePush(sub.endpoint);
  } catch (err) {
    // Don't fail loudly -- the local unsubscribe below is the more
    // important effect.
    console.warn('[push] Backend unsubscribe failed (continuing):', err);
  }
  try {
    await sub.unsubscribe();
  } catch (err) {
    console.warn('[push] Browser unsubscribe failed:', err);
  }
}
