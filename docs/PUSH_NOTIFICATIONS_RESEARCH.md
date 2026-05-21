# Background push notifications on PWAs — research notes

**Status**: research-only, no code changes proposed by this document.
**Scope**: capabilities and limitations for delivering push notifications
to Pineview Maps users while the app is closed or backgrounded, on iOS,
Android, and desktop browsers.
**Audience**: us, future-us, and anyone evaluating whether the current
Web Push setup is sufficient for the lone-worker safety use case.

> ⚠ Browser-platform behaviour shifts every release. Numbers here reflect
> public spec + known platform behaviour as of the writing of this doc.
> Re-verify before making major decisions, especially on iOS — Apple has
> moved fastest in this space and edge-case behaviour is not always in
> the spec.

---

## TL;DR

- **Android (Chrome / Edge / Firefox / Samsung Internet)**: Web Push
  works fully even when the app is force-closed. The browser process
  itself is what wakes on push, not the app. Notifications appear
  immediately. This is the gold-standard case and what most "it just
  works" articles describe.
- **iOS Safari (iPhone, iPad)**: Web Push works only when the user has
  **installed the PWA to the home screen** (Add to Home Screen). It does
  NOT work in regular Safari tabs. Requires iOS 16.4 or later. After
  install, push works even when the PWA is fully closed, but Apple
  imposes additional rules (every push must show a visible notification —
  no silent data-only push).
- **Desktop (Chrome / Edge / Firefox / Safari macOS)**: Works as long as
  the browser process is running, even with no tab open for the site.
  Most workers run the desktop browser at startup so this case is
  reliable in practice.
- **Periodic Background Sync** (`navigator.periodicSync`): Chrome /
  Android only, gated behind site engagement scoring, never available on
  iOS. Not a viable cross-platform solution.
- **Background Fetch / running arbitrary code while closed**: not
  possible on any platform for PWAs. The only "wake the app" mechanism
  is a server-pushed notification.

The practical headline: **for the lone-worker check-in use case, push
notifications when the PWA is closed are reliable on Android and on
iOS-with-PWA-installed**. The app does not need to be open. But silent
data-only updates (e.g. quietly fetching a location, syncing state
without showing a notification) are NOT possible — every wake must
result in a visible notification on iOS, and engagement-based throttling
applies on Android.

---

## What Pineview Maps already has

Already shipping in `frontend/src/lib/pushClient.js`,
`frontend/src/sw-push.js`, and `backend/app/push_service.py`:

- **VAPID-signed Web Push** end-to-end. The backend uses `pywebpush` to
  POST encrypted payloads to the endpoint each browser registers.
- **`PushSubscription` table** keyed by user_id, holds endpoint +
  p256dh + auth keys. Cleaned up automatically on 404/410 from the push
  endpoint (worker uninstalled or cleared site data).
- **`ensurePushSubscribed()` flow** wired into login (`App.jsx`) and the
  preferences panel. Workers get auto-subscribed if they've previously
  enabled push.
- **Service worker `push` handler** in `sw-push.js`:
  - Parses the JSON payload (matches `PushPayload.to_json()` on the
    backend).
  - Calls `self.registration.showNotification(title, opts)` with
    sensible defaults: tag for replace-don't-stack, vibrate pattern,
    `requireInteraction: true` for urgent overdue alerts, default
    sound.
- **`notificationclick` handler** focuses an existing tab if one is
  open, or opens a new window. Posts `{type: 'open-checkin'}` to the
  focused tab so it can deep-link to MyCheckIns.
- **iOS detection** in `pushClient.js` and `CheckInPreferencesPanel.jsx`
  with the install-instructions UI shown when `PushManager` is missing.

This means the *infrastructure* is already in place. The remaining
questions are about behaviour at the edges — iOS quirks, throttling,
re-subscription, and what's possible beyond "show a notification".

---

## Platform support matrix

| Capability | Android Chrome | iOS Safari (PWA) | iOS Safari (tab) | Desktop Chrome / Edge | Desktop Safari (macOS) |
|---|---|---|---|---|---|
| Web Push with VAPID | ✅ | ✅ (16.4+) | ❌ | ✅ | ✅ |
| Wakes when app fully closed | ✅ | ✅ | n/a | ✅ (browser running) | ✅ (browser running) |
| Silent push (no notification shown) | ⚠ rate-limited | ❌ | n/a | ⚠ rate-limited | ⚠ rate-limited |
| `requireInteraction: true` (sticky) | ✅ | ⚠ partial | n/a | ✅ | ✅ |
| Vibration pattern | ✅ | ❌ ignored | n/a | ✅ | ❌ ignored |
| Custom sound on push | ⚠ Android 8+ via channels | ❌ | n/a | ⚠ via channel/icon | ❌ |
| Periodic Background Sync | ⚠ Chrome only, gated | ❌ | ❌ | ⚠ Chrome only, gated | ❌ |
| Background Fetch (run code while closed) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Geolocation in service worker | ❌ | ❌ | ❌ | ❌ | ❌ |
| Geolocation in `push` handler | ❌ | ❌ | n/a | ❌ | ❌ |

Legend: ✅ supported, ⚠ supported with conditions, ❌ not supported.

---

## "App is closed" — what that actually means

There are three states a PWA can be in, and they have different push
behaviour:

1. **Active foreground tab**. Tab is visible. Push fires the SW's `push`
   handler AND the visible tab can receive a `message` from the SW for
   live-UI updates. This is what the existing
   `notificationclick → postMessage('open-checkin')` flow assumes.
2. **Tab open but backgrounded** (app in another tab, browser
   minimized, screen locked, phone in pocket). Push still fires the SW.
   On Android the OS shows the notification immediately. On iOS the
   notification shows on the lock screen / banner. Sometimes the SW can
   `clients.matchAll()` and post a message to the open-but-hidden tab so
   it refreshes data in the background — useful for the "real-time
   admin dashboard" use case. iOS may suspend the WebSocket / Realtime
   subscription on the hidden tab independently; the push is the way to
   force a refresh anyway.
3. **App fully closed / browser killed**. Android: push still works,
   the OS wakes the browser to deliver it. iOS PWA: push still works
   IF the PWA was installed to the home screen and the user has
   granted notification permission. Regular iOS Safari (non-installed):
   push does NOT work at all; the user has no way to subscribe.

The lone-worker case (overdue alert when admin's laptop is closed but
the browser auto-launches at boot) is **case 3 on desktop** — works
fine. The mobile case for the worker themselves (overdue reminder when
the worker's phone is in their pocket and the PWA isn't open) is **case
2/3 on Android** (works) or **case 3 on iOS PWA** (works after install,
broken in regular Safari).

---

## iOS-specific gotchas

1. **PWA must be installed to home screen.** Regular Safari tabs have
   no `PushManager`. The current `pushClient.js` detection handles this
   correctly — `pushSupported()` returns false in non-PWA Safari, and
   the prefs panel shows install instructions. **There is no
   workaround.** Users who refuse to install the PWA cannot receive
   push on iOS. Period.
2. **iOS 16.4 minimum.** Released March 2023. Below that, no support.
   Pineview Maps' install-instructions UI should bail with a clear "iOS
   16.4 or later required" message on older devices. (Worth verifying
   the current copy says this.)
3. **Visible-notification rule.** Apple's policy is that every push
   delivery must result in a visible notification within the SW's
   `push` event handler. If a site sends "silent" pushes (data-only,
   no `showNotification` call), iOS will throttle the subscription and
   eventually unsubscribe it. Practically: the existing handler always
   calls `showNotification`, so we're compliant. We CAN'T add a
   "quietly refresh dashboard" silent-push path on iOS.
4. **Notification permission timing.** Must be triggered by a user
   gesture — `Notification.requestPermission()` from a button click,
   not on page load. The current flow (button-driven) is correct.
5. **Subscription persistence.** iOS occasionally invalidates push
   subscriptions silently — the user notices that pushes stopped
   working. Re-subscribe-on-login is the standard mitigation; the
   `ensurePushSubscribed()` call wired into App.jsx login covers this.
6. **No vibration.** iOS ignores the `vibrate` array. Default OS
   notification haptics fire instead. This is fine, just don't rely on
   it.
7. **No custom notification sound.** iOS uses its system notification
   sound. To stand out, the title and body text need to be the
   distinguishing factor, not audio.
8. **Focus mode / Do Not Disturb.** Like any other notification, push
   gets suppressed by iOS Focus modes unless the worker explicitly
   allows Pineview Maps as a "Time Sensitive" app. There's no
   programmatic way for us to bypass this. Document this in onboarding
   so workers know to whitelist the app.
9. **Standalone-only check-in subscription.** Pineview Maps already
   gates push subscription on `isRunningStandalone()` in
   `CheckInPreferencesPanel.jsx`. Confirm this still matches Apple's
   current behaviour (browser-tab subscription would silently fail
   anyway, but the UI message is clearer if we don't even offer it).

---

## Android-specific notes

1. **Generally works the same as desktop Chrome.** The browser process
   wakes on push, fires the SW, shows the notification. App can be
   force-closed from recents and push still arrives.
2. **Battery-saver / Doze mode** can delay push delivery on some
   manufacturer skins (Samsung, Xiaomi, Huawei have aggressive task
   killers). Workers may need to add Pineview Maps / Chrome to a
   battery whitelist. There's no programmatic way to do this — it
   requires manual user setup, documented in onboarding.
3. **Notification channels (Android 8+)** would let us route urgent
   overdue alerts to a high-priority channel so they bypass DND. The
   Web Push API doesn't expose channels directly, but using
   `requireInteraction: true` (already set on urgent payloads) gets
   close to the same effect.
4. **Vibration patterns work** as defined in the SW handler. Workers
   can disable per-channel in OS settings.
5. **Periodic Background Sync** is Chrome-only and gated by Site
   Engagement scores. Not reliable enough for safety-critical use.

---

## What is genuinely impossible

A few things are commonly asked for but not technically achievable from
a PWA on either platform:

- **Run arbitrary code in the background while the app is closed.**
  Every PWA wake-up has to be triggered by either a user-initiated
  navigation or a server-sent push. There is no "every 10 minutes,
  call this function" facility for closed PWAs.
- **Get the user's location while the app is closed.** Geolocation is
  not available in service workers. Even when the SW wakes on push, it
  cannot ask for `navigator.geolocation`. The location-fetch must
  happen while a *page* is open. (For the auto-fetch-location-on-overdue
  feature, this means we're stuck with "last known position from the
  most recent check-in" or "ping while PWA foreground.")
- **Bypass DND / Focus modes / silent mode programmatically.** OS
  controls. The user has to manually trust the app.
- **Send a push from one device to another without the server.**
  Web Push always goes server → endpoint. There's no peer push.
- **Hide a push notification on iOS.** Once delivered, the user sees it
  unless they tap or swipe it away. We can choose `tag` to replace a
  prior one in the tray, but we can't delete it from inside the app.
- **Guarantee push delivery within a specific time window.** Both
  platforms reserve the right to delay push for battery / DND / network
  reasons. Real-world delivery is usually < 5 seconds, but the spec
  doesn't promise anything. For safety-critical timing (e.g. T+30
  office page) the backend's email + database alert chain is the
  reliable backup; push is the convenience layer.

---

## Things that ARE possible we're not currently using

These are options for future feature work — not recommendations to
implement now, just an inventory:

1. **SW → open-tab message-passing to drive real-time UI**. When the SW
   receives an admin-relevant push (e.g. `office_first` overdue
   payload), it can iterate `clients.matchAll({type:'window'})` and
   `client.postMessage({type:'CHECKIN_ALERT'})` to every open admin
   tab. The OverviewTab subscribes to `navigator.serviceWorker
   .addEventListener('message', ...)` and refetches on receipt. This is
   how a backgrounded admin tab can refresh "instantly" without the
   admin clicking the notification.
2. **Notification action buttons**
   (`actions: [{action:'force_checkin', title:'Force check-in'}]`).
   Android only. The notification gets a button row. `notificationclick`
   handler reads `event.action` and can perform an API call directly
   without focusing the tab. Useful for quick admin actions.
3. **Application Server Push w/ TTL**. The backend can set the push
   service's `Urgency: high` header and `TTL: <seconds>` so a phone
   that's been offline still gets the alert when it reconnects (within
   TTL). Currently `pywebpush` defaults are fine but explicit
   `Urgency: high` on overdue alerts is a small reliability win.
4. **`renotify: true`** is already set on overdue tags, which causes
   each repeat to re-buzz even though the tag replaces the prior
   notification. This is correct.
5. **iOS "Time-Sensitive" notifications**. Setting `interruptionLevel:
   'time-sensitive'` in the notification options on iOS allows the
   alert to bypass Focus modes if the user has granted that level. As
   of recent iOS Safari, the Web Push API does accept this option;
   verify support before relying on it.

---

## Recommendations specific to Pineview Maps

In rough priority order if we ever want to harden the push pipeline:

1. **SW → tab message on push** so backgrounded admin dashboards refresh
   instantly when an overdue alert fires (the "real-time admin
   dashboard" feature originally requested). Cheap. Already discussed.
2. **Add `Urgency: high` header** to overdue push payloads on the
   backend. One-line change in `push_service.py`. Improves delivery
   reliability when worker phones are on flaky networks.
3. **Confirm iOS install-instructions copy mentions iOS 16.4+** in
   `CheckInPreferencesPanel.jsx`. If a worker's iPhone is below 16.4,
   the install path won't help — they need to update iOS.
4. **Onboarding doc / video for workers** showing how to:
   - Add the PWA to home screen on iOS.
   - Whitelist the PWA in the OS battery saver on aggressive Android
     skins.
   - Allow Time Sensitive / DND-bypass for the app's notifications on
     iOS Focus modes.
5. **Add a self-test page** in the prefs panel: "Send me a test push"
   that triggers a backend endpoint to push an immediate "✅ working"
   notification. Lets workers verify their setup without waiting for
   an actual overdue event. Cheap, hugely reduces field-debug time.
6. **Document the limits in the admin-side training material**:
   - Push delivery is best-effort, not guaranteed within N seconds.
   - The email backup is the legal/audit-trail layer; push is for
     convenience.
   - Workers must install the PWA on iOS for push to work at all.
7. **Don't bother with Periodic Background Sync.** Not portable. Stick
   with server-pushed wake-ups.
8. **Don't try to implement silent / data-only push** for state sync.
   iOS will eventually break it and Android may rate-limit. If we want
   open admin tabs to live-refresh on alerts, do it through the SW
   message-passing path (#1 above) which always pairs with a visible
   notification.

---

## Open questions to revisit later

- **Does the existing `ensurePushSubscribed` flow re-subscribe
  automatically when iOS silently invalidates a subscription?** Worth
  testing on a real iPhone — leave a PWA installed, don't open it for
  several weeks, then check whether the subscription endpoint in the
  DB still receives pushes. If not, we may need to re-subscribe on
  every login regardless of cached state.
- **What happens to push subscriptions when a user changes their email
  / role in our user table?** The `PushSubscription` row is keyed by
  `user_id`, so role changes are fine. Email changes are also fine.
  Account deletion currently cascades — confirm.
- **Should office push subscribers be a configurable list, or
  every admin/office user automatically?** Current behaviour: any
  admin/office user with `notify_push = true` gets office overdue
  alerts. Email recipients are managed separately in
  `OfficeAlertRecipient`. Possible mismatch: an admin who turned off
  push prefs would still get email alerts from the office recipients
  list if their email was on it.
- **How do we surface push-delivery failures to admins?** Currently the
  backend logs but doesn't alert anyone if a push fails to deliver to
  every subscribed admin. For safety-critical alerts we may want a
  fallback: "couldn't reach any admin via push; falling back to SMS
  via Twilio" or similar. Out of scope here, just a flag for the
  product roadmap.

---

## References

- [W3C Push API spec](https://www.w3.org/TR/push-api/)
- [W3C Notifications API spec](https://www.w3.org/TR/notifications/)
- [Apple Web Push announcement (iOS 16.4)](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Apple "Notifications, badging, focus, and Live Activities for web apps"](https://developer.apple.com/documentation/usernotifications/sending_web_push_notifications_in_web_apps_and_browsers)
- [Chrome Periodic Background Sync](https://developer.chrome.com/docs/capabilities/periodic-background-sync)
- [VAPID RFC 8292](https://datatracker.ietf.org/doc/html/rfc8292)
- Pineview Maps source:
  - `frontend/src/lib/pushClient.js`
  - `frontend/src/sw-push.js`
  - `backend/app/push_service.py`
  - `backend/app/checkin_routes.py` (alert dispatch)
  - `backend/app/checkin_models.py` (`PushSubscription` model)
