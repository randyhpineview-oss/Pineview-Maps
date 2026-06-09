/**
 * Tiny wrapper around the browser Geolocation + Permissions APIs.
 *
 * Why this exists: the check-in flow needs to HARD BLOCK when location
 * permission is denied (so the office can actually track crews) but
 * MUST NOT block when permission is granted and the device just can't
 * get a fix right now (indoors, dead spot, fresh fix) -- otherwise a
 * lone-worker safety tap could be silently dropped.
 *
 * The Permissions API (`navigator.permissions.query`) is great when
 * available -- it lets us show a persistent "Location required" banner
 * BEFORE the user even tries to act. But iOS Safari (incl. iPad PWA)
 * historically doesn't support it for geolocation, returning 'prompt'
 * or throwing. The authoritative signal is the PositionError code on
 * getCurrentPosition (1 = PERMISSION_DENIED). We use both: the
 * Permissions API for the proactive banner, the error code for the
 * hard gate at action time.
 */

export const LOCATION_REQUIRED_MESSAGE =
  'Location permission is required for check-ins. Please enable location '
  + 'access for this app in your device settings, then try again.';

// Returns 'granted' | 'denied' | 'prompt' | 'unsupported'. Never throws.
export async function getGeolocationPermission() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'unsupported';
  if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
    // Most iOS Safari versions land here. We just don't know the state
    // until the user actually tries to use location.
    return 'prompt';
  }
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state;
  } catch {
    return 'prompt';
  }
}

// Triggers the system permission prompt if needed, then resolves a
// position OR a structured failure. Never rejects.
//
// Returns:
//   { ok: true, position }
//   { ok: false, denied: true, reason: 'permission denied' }
//   { ok: false, denied: false, reason: '...' }  // timeout / unavailable
export function requestPosition(options = {}) {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ ok: false, denied: false, reason: 'unsupported' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ ok: true, position }),
      (err) => resolve({
        ok: false,
        // PositionError.PERMISSION_DENIED = 1 (spec). The OTHER codes
        // (2 POSITION_UNAVAILABLE, 3 TIMEOUT) mean "you have permission
        // but no fix right now" -- the caller can choose to proceed.
        denied: err && err.code === 1,
        reason: (err && err.message) || `code ${err && err.code}`,
      }),
      { timeout: 8000, maximumAge: 30_000, enableHighAccuracy: false, ...options },
    );
  });
}
