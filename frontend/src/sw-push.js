/* eslint-disable no-restricted-globals */
// Custom service worker source consumed by vite-plugin-pwa in
// `injectManifest` mode. Workbox glues this together with the build
// manifest at compile time so we keep the existing precache + offline
// app-shell behaviour AND add Web Push handlers in one file.
//
// What this SW does (in order of source):
//   1. precacheAndRoute(self.__WB_MANIFEST)
//      Workbox token. At build time the plugin injects the list of
//      hashed asset URLs the app needs to load cold-offline (JS bundle,
//      CSS, icons, pdf.worker.mjs, etc.). Behaviour identical to the
//      previous generateSW config.
//
//   2. push handler
//      Wakes when FCM (Android) or Apple Push (iOS PWA) delivers a
//      message. Shows a notification with default OS sound + vibration
//      so the worker is alerted even when the app is fully closed
//      and the phone is locked.
//
//   3. notificationclick handler
//      When the worker taps the notification (lock screen, tray, in-app)
//      either focuses an open tab or opens a fresh one. Posts an
//      'open-checkin' message to controlled clients so App.jsx can
//      route to the MyCheckInsOverlay automatically.
//
//   4. skipWaiting / clientsClaim are NOT called automatically. App.jsx
//      surfaces a green "Update Now" pill in the topbar when a new SW
//      is parked in the `waiting` state; tapping it posts
//      SKIP_WAITING. This mirrors the existing `registerType: 'prompt'`
//      contract.

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

// __WB_MANIFEST is replaced at build time with the list of precache
// entries. injectManifest will error out at build time if this exact
// expression is missing, so do not refactor it.
precacheAndRoute(self.__WB_MANIFEST || []);
cleanupOutdatedCaches();

// Navigation fallback: SPA deep links (/?ticket=HL000123 etc.) should
// resolve to /index.html offline. Exclude /api/* so the SPA shell
// doesn't accidentally answer for a 404'd backend call.
const navHandler = new NavigationRoute(
  async ({ event }) => {
    try {
      return await fetch(event.request);
    } catch {
      const cache = await caches.match('/index.html');
      return cache || Response.error();
    }
  },
  {
    denylist: [/^\/api\//],
  },
);
registerRoute(navHandler);

// Google Fonts CSS — small, infrequently changing. Stale-while-revalidate
// so first paint is fast and the latest version trickles in.
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com',
  new StaleWhileRevalidate({ cacheName: 'gfonts-css' }),
);

// Google Fonts files — long-lived, cache-first OK.
registerRoute(
  ({ url }) => url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'gfonts-files',
    plugins: [
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 }),
    ],
  }),
);

// Google Maps JS API script and dynamically loaded modules — load instantly, update in bg
registerRoute(
  ({ url }) => url.origin === 'https://maps.googleapis.com' && 
               (url.pathname.startsWith('/maps/api/js') || url.pathname.includes('/maps-api-v3/api/js/')),
  new StaleWhileRevalidate({
    cacheName: 'google-maps-api',
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200],
      }),
      new ExpirationPlugin({
        maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
      }),
    ],
  }),
);

// Google Maps tile images (satellite imagery, hybrid label tiles, roadmap tiles)
registerRoute(
  ({ url }) => {
    const isTileDomain = /^(khms[0-3]?|mts[0-3]?|cbk[0-3]?|lh[3-6]?|maps)\.(googleapis|google)\.com$/.test(url.hostname);
    const isTilePath = url.pathname.includes('/kh/v=') || url.pathname.includes('/maps/vt') || url.pathname.includes('/vt/icon');
    return isTileDomain || isTilePath;
  },
  new CacheFirst({
    cacheName: 'google-maps-tiles',
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200], // Crucial because tile cross-origin responses are opaque (status 0)
      }),
      new ExpirationPlugin({
        maxEntries: 500, // Safe limit (approx 15-40 MB)
        maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
        purgeOnQuotaError: true, // Reclaim space if device storage is full
      }),
    ],
  }),
);

// Google Maps static assets (icons, styles, map files)
registerRoute(
  ({ url }) => url.origin === 'https://maps.gstatic.com',
  new CacheFirst({
    cacheName: 'google-maps-static',
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200],
      }),
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
      }),
    ],
  }),
);


// ─────────────────────────────────────────────────────────────────────
// Web Push handlers (Phase 2 unified)
// ─────────────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  // Payload structure matches PushPayload.to_json() in
  // backend/app/push_service.py. Defensive parsing -- if payload is
  // empty or malformed we still show *something* so the worker
  // notices that a push tried to land.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || 'Pineview Maps';
  const opts = {
    body: payload.body || 'Check-in required',
    // Lock-screen + tray icon. Both files already ship in /public.
    icon: '/icon-192.png',
    // Android status-bar small icon (monochrome). Falls back to icon
    // if the badge file doesn't exist; safe either way.
    badge: '/icon-32.png',
    // tag='checkin' so repeat alerts replace prior ones in the OS
    // notification tray rather than stacking. renotify:true ensures
    // each one still buzzes + pings.
    tag: payload.tag || 'checkin',
    renotify: true,
    // Overdue alerts (urgent:true) require the user to actually tap
    // the notification -- doesn't auto-dismiss after a few seconds.
    requireInteraction: payload.urgent === true,
    // Android vibration pattern: 200ms on, 100ms off, 200ms on.
    // Distinctive enough to feel different from a generic ping.
    // iOS ignores this -- they use their own pattern.
    vibrate: [200, 100, 200],
    // silent: false -- explicitly let the OS play its default
    // notification sound. Workers control loudness via OS settings.
    silent: false,
    data: {
      url: payload.url || '/',
      shiftId: payload.shiftId || null,
    },
  };
  // Two parallel jobs:
  //   1. Show the OS notification (mandatory on iOS -- Apple revokes
  //      the push subscription if a `push` event finishes without a
  //      visible notification).
  //   2. Post a 'CHECKIN_ALERT' message to every open tab so any admin
  //      dashboards backgrounded in another window refresh their data
  //      INSTANTLY rather than waiting for the next 60 s poll. The
  //      OverviewTab listens for this and re-fetches /admin/checkin-
  //      overview, so a worker going overdue updates the admin's
  //      laptop in real time even with the tab hidden in the
  //      background.
  const showNotif = self.registration.showNotification(title, opts);
  const broadcastRefresh = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientsList) => {
      for (const client of clientsList) {
        try {
          client.postMessage({
            type: 'CHECKIN_ALERT',
            tag: payload.tag || 'checkin',
            urgent: payload.urgent === true,
            shiftId: payload.shiftId || null,
          });
        } catch {
          /* ignore postMessage errors */
        }
      }
    })
    .catch(() => { /* swallow -- broadcast is best-effort */ });
  event.waitUntil(Promise.all([showNotif, broadcastRefresh]));
});


self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientsList) => {
        // Reuse any open tab in our scope; tell it to open MyCheckIns.
        const existing = clientsList.find((c) =>
          c.url.includes(self.registration.scope),
        );
        if (existing) {
          existing.focus();
          try {
            existing.postMessage({ type: 'open-checkin' });
          } catch {
            /* ignore postMessage errors */
          }
          return undefined;
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});


// ─────────────────────────────────────────────────────────────────────
// Update opt-in (preserves App.jsx 'Update Now' flow)
// ─────────────────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  // App.jsx posts {type: 'SKIP_WAITING'} when the user taps the green
  // "Update Now" pill in the topbar. Without this, a new SW would stay
  // parked in `waiting` forever -- matches the prior registerType:'prompt'
  // contract from when generateSW was in use.
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
