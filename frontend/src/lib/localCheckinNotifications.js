/**
 * Local (device-side) check-in notification scheduler.
 *
 * Belt-and-suspenders backup to the server-driven Web Push pipeline.
 * Web Push requires the worker's device to have internet so the push
 * service (Apple / FCM) can deliver to it. A worker out in the field
 * with no cell signal would NEVER hear the buzz, then come back into
 * service hours later thinking everything's fine.
 *
 * This scheduler runs ENTIRELY on the device's own clock. When the
 * PWA is open (foreground OR recently-backgrounded but not killed),
 * a 30s interval evaluates the active shift's deadline and fires
 * ``showNotification`` via the service worker registration as the
 * thresholds cross. No backend round-trip required.
 *
 * Limitations (intentional, documented):
 *   - Once iOS suspends the PWA (~30s after going to background on
 *     locked phone), JS stops running and timers don't fire. That's
 *     the fully-closed case where ONLY server push can wake the SW.
 *     Net effect: this catches the "in pocket, no signal" scenario;
 *     server push catches the "phone closed, has signal" scenario.
 *     Together they cover ~all realistic field scenarios.
 *   - When the device IS online, server push fires the same notifs
 *     a few seconds earlier. We de-dup with tag='checkin' so the OS
 *     tray collapses both into a single visible notification.
 *
 * Local-only ledger keyed by (shift_id, deadline_ts, kind) in
 * localStorage so a reload doesn't replay notifications the worker
 * already saw, and so a new deadline (after a successful check-in)
 * naturally starts a fresh cycle without us tracking it explicitly.
 */

// ── Thresholds (mirrors backend WORKER_ALERTS + overdue repeats) ────
// minutes_overdue >= threshold fires the kind once. Same cadence the
// server scanner uses so workers see the same beats whether they're
// online or offline. ``urgent: true`` sets requireInteraction so the
// notification doesn't auto-dismiss on iOS until tapped.
const LOCAL_THRESHOLDS = [
  {
    kind: 't0',
    minutes: 0,
    title: 'Check-in due now',
    body: "Open Pineview Maps and tap I'm OK.",
    urgent: false,
  },
  {
    kind: 'overdue3',
    minutes: 3,
    title: 'OVERDUE — please check in',
    body: "You're 3 min overdue. Find service and tap I'm OK.",
    urgent: true,
  },
  {
    kind: 'overdue10',
    minutes: 10,
    title: 'Still overdue — check in',
    body: "You're 10 min overdue. The office will be alerted soon.",
    urgent: true,
  },
  {
    kind: 'overdue20',
    minutes: 20,
    title: 'Still overdue — check in',
    body: "You're 20 min overdue. Get to service ASAP.",
    urgent: true,
  },
  {
    kind: 'overdue30',
    minutes: 30,
    title: 'CRITICAL — office alerted',
    body: "30 min overdue. The office has been emailed.",
    urgent: true,
  },
  {
    kind: 'overdue45',
    minutes: 45,
    title: 'CRITICAL — please check in',
    body: "45 min overdue. Please reach service immediately.",
    urgent: true,
  },
  {
    kind: 'overdue60',
    minutes: 60,
    title: '🚨 OFFICE URGENT ALERT SENT',
    body: "60 min overdue. Urgent escalation sent to office.",
    urgent: true,
  },
];

const LEDGER_KEY_PREFIX = 'pv:localCheckinFired:';

function ledgerKey(shiftId, deadlineMs, kind) {
  return `${LEDGER_KEY_PREFIX}${shiftId}:${deadlineMs}:${kind}`;
}

function hasFired(shiftId, deadlineMs, kind) {
  try {
    return localStorage.getItem(ledgerKey(shiftId, deadlineMs, kind)) === '1';
  } catch {
    return false;
  }
}

function markFired(shiftId, deadlineMs, kind) {
  try {
    localStorage.setItem(ledgerKey(shiftId, deadlineMs, kind), '1');
  } catch {
    /* localStorage quota / disabled -- non-fatal */
  }
}

/**
 * Best-effort cleanup of ledger entries older than 24 h so the
 * localStorage namespace doesn't grow forever as shifts accumulate.
 * Called once when the scheduler starts.
 */
function pruneOldLedger() {
  try {
    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const stale = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LEDGER_KEY_PREFIX)) continue;
      // Key format: prefix + shiftId:deadlineMs:kind
      const tail = key.slice(LEDGER_KEY_PREFIX.length);
      const parts = tail.split(':');
      if (parts.length < 3) continue;
      const deadline = Number(parts[1]);
      if (Number.isFinite(deadline) && deadline < cutoffMs) {
        stale.push(key);
      }
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

/**
 * Show a local notification via the SW registration (required on iOS
 * PWA; recommended elsewhere because the SW shows from a privileged
 * context that survives page navigation). Falls back to the page-level
 * ``new Notification`` constructor on non-PWA / desktop scenarios.
 *
 * Returns true if a notification was successfully shown.
 */
async function showLocalNotification(title, body, { urgent }) {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;
  const options = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-32.png',
    // Same tag the server-push handler uses so a server push that
    // arrives a few seconds after our local one collapses into one
    // visible notification in the tray (renotify still buzzes).
    tag: 'checkin',
    renotify: true,
    requireInteraction: !!urgent,
    vibrate: [200, 100, 200, 100, 200],
    data: { url: '/', local: true },
  };
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, options);
      return true;
    } catch {
      /* fall through to page-level fallback */
    }
  }
  try {
    // eslint-disable-next-line no-new
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the local notification scheduler for the given shift.
 *
 * Args:
 *   shift: the active Shift JSON (must have ``id`` and
 *     ``next_deadline_at`` set). Pass null/undefined to no-op.
 *
 * Returns a cleanup function that stops the interval + event
 * listeners. Re-call this with a new shift to swap.
 */
export function scheduleLocalCheckinNotifications(shift) {
  if (!shift || !shift.id || !shift.next_deadline_at) {
    return () => {};
  }
  if (shift.ended_at || shift.mode === 'off') {
    return () => {};
  }
  pruneOldLedger();

  const shiftId = shift.id;
  const deadlineMs = new Date(shift.next_deadline_at).getTime();
  if (!Number.isFinite(deadlineMs)) return () => {};

  const tick = async () => {
    const now = Date.now();
    const minutesOverdue = (now - deadlineMs) / 60_000;
    for (const threshold of LOCAL_THRESHOLDS) {
      // 0.5 min tolerance matches the backend scanner so a slightly
      // delayed tick still fires the right kind on the right beat.
      if (minutesOverdue + 0.5 < threshold.minutes) continue;
      if (hasFired(shiftId, deadlineMs, threshold.kind)) continue;
      const ok = await showLocalNotification(threshold.title, threshold.body, {
        urgent: threshold.urgent,
      });
      if (ok) markFired(shiftId, deadlineMs, threshold.kind);
    }
  };

  // Fire once immediately so a reload mid-overdue still buzzes.
  tick();
  const intervalId = setInterval(tick, 30_000);
  const onVis = () => {
    if (typeof document !== 'undefined' && !document.hidden) tick();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVis);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', tick);
  }

  return () => {
    clearInterval(intervalId);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVis);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', tick);
    }
  };
}
