import { useCallback, useEffect, useRef, useState } from 'react';

import { APP_VERSION } from '../version';

/**
 * Shared PWA / build-update detection used by the worker/admin App and the
 * client portal. Detects a new deploy via:
 *   1. Service-worker lifecycle (`waiting` / `updatefound`)
 *   2. Independent `/version.json` poll (iOS-PWA-friendly fallback)
 *
 * Returns `{ swUpdateAvailable, handleAppUpdate, checkAppVersion }` so hosts
 * can light the avatar "Update Now" affordance and piggyback version checks
 * on their own poll ticks.
 */
export function useAppUpdate() {
  // vite-plugin-pwa is configured with `registerType: 'prompt'` +
  // `skipWaiting: false` + `clientsClaim: false`, so a new deploy's SW
  // installs in the background and parks in the `waiting` state. This
  // effect pushes update checks via `registration.update()` so the user
  // learns about the new build within ~60 s without needing a page
  // refresh — which on iOS PWA is particularly painful (closing and
  // reopening the app is itself the refresh, at which point the old
  // "Update Now" button had already become a no-op).
  //
  // When `swUpdateAvailable` flips to true:
  //   - A red pulsing dot appears on the avatar in the topbar.
  //   - "↑ Update Now" appears in the account popover (desktop + mobile).
  // Tapping the popover item runs `handleAppUpdate` which posts SKIP_WAITING
  // to the waiting SW, clears Workbox caches, and reloads. The
  // `controllerchange` listener below is the final safety net: if the
  // cache-clear hangs, the browser will still reload as soon as the new
  // SW takes over.
  const [swUpdateAvailable, setSwUpdateAvailable] = useState(false);
  const swWaitingRef = useRef(null);
  // Published by the build-version poll effect below so the host's regular
  // poll-tick loop (which runs reliably on iOS PWA, where setInterval
  // alone is throttled) can piggyback a version check on every tick.
  // Without this, iOS PWA users only saw the red "Update available"
  // dot after killing and reopening the app — exactly the behaviour the
  // dot was designed to eliminate.
  const checkAppVersionRef = useRef(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;
    let pollInterval = null;
    let cleanupVisibility = null;
    let cleanupOnline = null;
    let cleanupControllerChange = null;

    // Cross-check /version.json before lighting the indicator.
    //
    // The SW lifecycle and the version-poll path (further down) race on
    // every deploy. Path B (version-poll) is the faster signal source —
    // it just GETs a tiny JSON file — so the user typically sees the
    // indicator and clicks "Update Now" while the browser is still
    // byte-comparing the new /sw.js. At that moment swWaitingRef is null,
    // so handleAppUpdate's postMessage SKIP_WAITING is a no-op; the reload
    // happens, the new bundle loads, and APP_VERSION jumps to the new
    // build. Then, *after* the reload, the browser finishes installing the
    // new SW and parks it in `waiting` — at which point this listener
    // fires for a SW that matches the build the user is already running,
    // producing a confusing second "Update available" prompt that updates
    // nothing.
    //
    // Suppress that false positive by consulting the same source of
    // truth Path B uses: if /version.json reports we're already on the
    // running APP_VERSION, the waiting SW is for the build we just
    // updated to — keep the ref so a subsequent SKIP_WAITING can still
    // tear it down cleanly, but don't surface the indicator. Network
    // errors fall through to fire (preserve old behaviour on offline /
    // edge-cache hiccups so we never silently hide a real update).
    const markWaiting = async (worker) => {
      swWaitingRef.current = worker;
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, {
          cache: 'no-store',
          credentials: 'omit',
        });
        if (res.ok) {
          const body = await res.json();
          const remote = body && typeof body.version === 'string' ? body.version : '';
          if (remote && remote === APP_VERSION) {
            // Already on the build the waiting SW corresponds to.
            return;
          }
        }
      } catch { /* network blip — fall through and fire */ }
      setSwUpdateAvailable(true);
    };

    navigator.serviceWorker.getRegistration().then((reg) => {
      if (cancelled || !reg) return;
      // A new SW may already be waiting from a previous session — catch
      // it immediately so we don't wait for the first `updatefound`.
      if (reg.waiting) markWaiting(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          // With skipWaiting disabled, a fresh SW lands in `installed`
          // and stays there as `reg.waiting` until we post SKIP_WAITING.
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            markWaiting(newWorker);
          }
        });
      });

      // Push update checks into the SW so a new deploy is seen without
      // requiring the user to reload the page. 60 s cadence balances
      // "promptness of the indicator" against "cost of the check"
      // (the browser issues a HEAD to the precache manifest — cheap).
      const checkForUpdate = () => {
        if (document.visibilityState !== 'visible') return;
        reg.update().catch(() => { /* ignore network blips */ });
      };
      pollInterval = setInterval(checkForUpdate, 60_000);

      // Belt-and-braces: also check on tab focus and on back-online so
      // the user who closed the app during a deploy and reopens it a
      // minute later sees the update immediately, not 60 s later.
      const onVisible = () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      };
      document.addEventListener('visibilitychange', onVisible);
      cleanupVisibility = () => document.removeEventListener('visibilitychange', onVisible);

      const onOnline = () => checkForUpdate();
      window.addEventListener('online', onOnline);
      cleanupOnline = () => window.removeEventListener('online', onOnline);
    }).catch(() => undefined);

    // When the active SW actually swaps (after SKIP_WAITING), force a
    // page reload so the app picks up the new precached bundle. This
    // path runs regardless of whether `handleAppUpdate`'s `caches.delete`
    // loop succeeded — a hung cache op can no longer leave the user
    // stuck on the old code forever.
    let reloaded = false;
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    cleanupControllerChange = () => navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);

    return () => {
      cancelled = true;
      if (pollInterval != null) clearInterval(pollInterval);
      if (cleanupVisibility) cleanupVisibility();
      if (cleanupOnline) cleanupOnline();
      if (cleanupControllerChange) cleanupControllerChange();
    };
  }, []);

  // ── Build-version poll: independent path for "new deploy" detection ─────
  // The SW-based path above is the primary detection mechanism, but it's
  // fragile in the field:
  //   • Vercel's `Cache-Control: ..., immutable` on /sw.js (now overridden
  //     in vercel.json, but stale entries persist on installed devices)
  //     makes iOS Safari skip the network entirely on `reg.update()`.
  //   • `updatefound` is unreliable on iOS PWA standalone mode.
  //   • `reg.update()` errors are silently swallowed (intentional, for
  //     network-blip resilience), so a chronic failure looks identical
  //     to a successful "no new version" check.
  //   • If `getRegistration()` returns null on first mount, polling is
  //     never set up and never recovers.
  //
  // This independent poll fetches /version.json (written to public/ by
  // scripts/set-version.mjs at build time, served with `no-store` cache
  // headers) every 30 s. When the response's `version` differs from
  // APP_VERSION (the build constant baked into the running bundle), we
  // light the red "Update available" dot regardless of SW state. The
  // user taps "Update Now" → the existing handleAppUpdate clears
  // caches and reloads. handleAppUpdate already gracefully handles the
  // "no waiting SW yet" case (postMessage is a no-op when swWaitingRef
  // is null), so the same one-tap flow works whether the SW lifecycle
  // detected the update or not.
  useEffect(() => {
    // Skip in dev — APP_VERSION is the literal 'dev' and a stale
    // public/version.json from a prior local build would otherwise
    // fire false positives against every HMR boot.
    if (APP_VERSION === 'dev') return undefined;
    if (typeof fetch !== 'function') return undefined;

    let cancelled = false;
    let interval = null;
    let cleanupVisibility = null;
    let cleanupOnline = null;

    const checkVersion = async () => {
      if (cancelled) return;
      if (document.visibilityState !== 'visible') return;
      try {
        // Cache-bust + cache: 'no-store' so neither the browser, the SW,
        // nor any intermediate proxy can hand us a stale response. The
        // SW's runtimeCaching is scoped to Google Fonts only, so this
        // request falls through to the network, but the explicit
        // no-store is belt-and-braces for misconfigured proxies.
        const res = await fetch(`/version.json?t=${Date.now()}`, {
          cache: 'no-store',
          credentials: 'omit',
        });
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        const remote = body && typeof body.version === 'string' ? body.version : '';
        if (remote && remote !== APP_VERSION) {
          // One-shot log per session-detection so devtools shows why
          // the green dot lit up. Subsequent ticks are silent because
          // setSwUpdateAvailable(true) is idempotent.
          console.info(
            `[version-poll] new build detected: running=${APP_VERSION} server=${remote}`,
          );
          setSwUpdateAvailable(true);
        }
      } catch { /* offline or fetch failure — try again next tick */ }
    };

    // Debounced wrapper used by the iOS-friendly trigger paths below.
    // Without the throttle a user tapping rapidly through the UI could
    // fire dozens of /version.json requests per second; 60 s between
    // checks is plenty (server still gets a fresh read within 60 s of
    // the next interaction).
    let lastCheckAt = 0;
    const checkVersionThrottled = () => {
      const now = Date.now();
      if (now - lastCheckAt < 60_000) return;
      lastCheckAt = now;
      checkVersion();
    };

    // Publish the checker so the host's regular poll-tick loop can call
    // it on every tick. On desktop browsers the setInterval below is the
    // primary trigger; on iOS PWA, where WKWebView throttles setInterval
    // even in foreground, the poll-tick path is the one that fires
    // reliably because it's piggybacking on real network activity that
    // iOS doesn't pause.
    checkAppVersionRef.current = checkVersionThrottled;

    // Kick once on mount, then every 30 s, then on tab focus / back-online
    // so the user who returned to the app right after a deploy sees the
    // dot immediately, not 30 s later.
    checkVersion();
    lastCheckAt = Date.now();
    interval = setInterval(checkVersion, 30_000);

    const onVisible = () => {
      if (document.visibilityState === 'visible') checkVersion();
    };
    document.addEventListener('visibilitychange', onVisible);
    cleanupVisibility = () => document.removeEventListener('visibilitychange', onVisible);

    const onOnline = () => checkVersion();
    window.addEventListener('online', onOnline);
    cleanupOnline = () => window.removeEventListener('online', onOnline);

    // iOS-PWA-friendly trigger: every user tap drives a (debounced)
    // version check. WKWebView fires pointer events with rock-solid
    // reliability while the app is in foreground, even when it's
    // throttling setInterval — and an active user is touching the
    // screen every few seconds, so this guarantees the red "Update
    // available" dot lights up within ~60 s of the next interaction
    // after a deploy lands. Passive listener on the capture phase so we
    // never block a tap; and pointerdown is the only DOM event that
    // fires for both touch and mouse on a single hook.
    const onPointer = () => checkVersionThrottled();
    document.addEventListener('pointerdown', onPointer, { passive: true, capture: true });
    const cleanupPointer = () => document.removeEventListener('pointerdown', onPointer, { capture: true });

    return () => {
      cancelled = true;
      checkAppVersionRef.current = null;
      if (interval != null) clearInterval(interval);
      if (cleanupVisibility) cleanupVisibility();
      if (cleanupOnline) cleanupOnline();
      cleanupPointer();
    };
  }, []);

  const handleAppUpdate = useCallback(async () => {
    if (swWaitingRef.current) {
      swWaitingRef.current.postMessage({ type: 'SKIP_WAITING' });
    }
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch { /* ignore — controllerchange will still reload */ }
    // The controllerchange listener above will also fire once the
    // waiting SW activates and will reload then. Calling reload() here
    // as well covers the case where controllerchange never fires
    // (e.g. no active controller yet on first install).
    window.location.reload();
  }, []);

  const checkAppVersion = useCallback(() => {
    try { checkAppVersionRef.current?.(); } catch { /* non-fatal */ }
  }, []);

  return { swUpdateAvailable, handleAppUpdate, checkAppVersion };
}
