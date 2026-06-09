import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import AutocompleteInput from './components/AutocompleteInput';
import CrewSidebar from './components/CrewSidebar';
import { useDialog } from './components/DialogProvider';
import FilterBar from './components/FilterBar';
import InstallAppPrompt from './components/InstallAppPrompt';
import LoginPage from './components/LoginPage';
import MapView from './components/MapView';
import PipelineDetailSheet from './components/PipelineDetailSheet';
import SiteDetailSheet from './components/SiteDetailSheet';
import CheckinCountdown from './components/CheckinCountdown';
import { api } from './lib/api';
import { shouldForceOverlay } from './lib/compliance';
import { scheduleLocalCheckinNotifications } from './lib/localCheckinNotifications';
import { requestWithUploadProgress } from './lib/xhrUpload';
import {
  buildLane2Payload,
  compressLane2Photos,
  isTwoLaneTargetType,
  lane2EndpointFor,
  stripFilesForLane1,
} from './lib/uploadLanes';
import { nearestFraction } from './lib/mapUtils';
import { onAuthStateChange, signOut, supabase } from './lib/supabaseClient';
import { APP_VERSION, APP_VERSION_LABEL } from './version';
import {
  getAllLookups,
  getLastSyncAt,
  getLookups,
  getLookupsMaxAgeMs,
  getPipelines,
  getQueuedActions,
  getRecents,
  getSites,
  getUploadQueue,
  getUsers,
  getWatermarks,
  queueAction,
  putUser,
  queueUpload,
  removePipeline,
  removeQueuedAction,
  removeRecentById,
  removeUploadEntry,
  removeSite,
  removeUserById,
  replaceLookups,
  replacePipelines,
  replaceRecents,
  replaceSites,
  replaceUsers,
  setLastSyncAt,
  setWatermarks,
  updateUploadEntry,
  upsertPipeline,
  upsertRecent,
  upsertSite,
  deleteHydroseedDailyDraft,
  putCachedPdf,
} from './lib/offlineStore';
import { formatDate, nameKey, normalizeName, pinTypeLabel, statusLabel } from './lib/mapUtils';
import { localDateISO } from './lib/dateUtil';

// ── Code-splitting: heavy / route-gated components load in their own chunks ─
//
// Cold-start path is Map tab + SiteDetailSheet + auth screens, so those stay
// eager. The rest are loaded on demand the first time the user opens the
// relevant tab or modal, then pre-warmed during idle time (see preload
// effect below) so second-visit transitions don't flicker.
//
// Each lazy()-wrapped import becomes its own Rollup chunk at build time,
// shaving roughly a third of the gzipped main bundle on cold start:
//   • AdminPanel        — admin tab (recent deletes, lookup tables)
//   • ApproveEditModal  — admin review flow
//   • HerbicideLeaseSheet — inspection modal (jspdf + qrcode + html2canvas)
//   • FormsPanel        — forms tab (recents + drafts + queue)
//   • PdfPreviewOverlay — PDF viewer (pdfjs-dist worker)
//   • TMTicketDetailSheet — T&M ticket drawer
const AdminPanel = lazy(() => import('./components/AdminPanel'));
const ApproveEditModal = lazy(() => import('./components/ApproveEditModal'));
const HerbicideLeaseSheet = lazy(() => import('./components/HerbicideLeaseSheet'));
const FormsPanel = lazy(() => import('./components/FormsPanel'));
const PdfPreviewOverlay = lazy(() => import('./components/PdfPreviewOverlay'));
const TMTicketDetailSheet = lazy(() => import('./components/TMTicketDetailSheet'));
// Hydroseed Daily Application Record (HD######) — modal form, parallel
// in purpose to HerbicideLeaseSheet but for hydroseeding crews. Lazy because
// it pulls in its own PDF generator + the annotation canvas.
const HydroseedDailyRecord = lazy(() => import('./components/HydroseedDailyRecord'));
// Hydroseed Ticket detail sheet (HT######) — office pricing + signing UI.
const HydroseedTicketDetailSheet = lazy(() => import('./components/HydroseedTicketDetailSheet'));
// Reports dashboard is admin/office-only and intentionally opened very
// rarely (weekly/yearly). Unlike the components above, it is NOT included
// in the idle-time preload block — we only fetch its chunk on demand when
// the user taps "Open Reports" so worker sessions never pay for it, and
// even an admin who never runs a report never downloads it.
const ReportsDashboard = lazy(() => import('./components/ReportsDashboard'));
// Quote Builder is same deal — admin/office only, chunk fetched on demand
// when the user taps "Open Quotes" in AdminPanel. Workers never download it.
const QuoteBuilder = lazy(() => import('./components/QuoteBuilder'));
// Calendar overlay (tasks/events/bids/contacts) — admin/office only, lazy
// because it pulls in @fullcalendar/* (~150 KB gzipped). Workers and
// admins who never open the Calendar never download the chunk.
const CalendarOverlay = lazy(() => import('./components/CalendarOverlay'));
// Personal check-in overlay (every signed-in user). Lazy so workers
// only download the bundle when they actually tap the menu item / the
// forced overlay triggers. Used for: avatar-menu "🛟 Check-ins" entry
// point, the forced T-5 overlay, and the soft-banner Start now flow.
const MyCheckInsOverlay = lazy(() => import('./components/MyCheckInsOverlay'));
// Admin/office Check-ins Dashboard (Overview / Active / History /
// Settings tabs). Same lazy/admin pattern as ReportsDashboard etc.
const CheckInsOverlay = lazy(() => import('./components/CheckInsOverlay'));
// Operations TV dashboard. Used two ways: the dedicated `tv` role boots
// straight into it (full-screen), and admin/office can open it as a
// dismissible overlay from the AdminPanel Tools row. Lazy so only those
// paths download the chunk.
const TVDashboard = lazy(() => import('./components/TVDashboard'));
const LinkLeaseSheetModal = lazy(() => import('./components/LinkLeaseSheetModal'));
// SignupPage is only reached via a `?invite=...` URL (rare). Lazy so the
// invite-only chunk doesn't sit in the cold-start main bundle for every
// returning login. Suspense fallback shows a tiny "Loading…" placeholder.
const SignupPage = lazy(() => import('./components/SignupPage'));

// Small retry helper for dynamic chunk loads. Transient Vercel edge / network
// blips occasionally make a single import() reject; one retry with backoff
// covers ~all of those cases. Used for the PDF-generator imports below.
async function importWithRetry(loader, retries = 1) {
  try {
    return await loader();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, 800));
    return importWithRetry(loader, retries - 1);
  }
}

const DEFAULT_FILTERS = { search: '', client: '', area: '', status: '', approval_state: '' };
const DEFAULT_LAYERS = { lsd: true, water: true, quad_access: true, reclaimed: true, pipelines: true, trucks: true, crew: true };
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

const TAB_MAP = 'map';
const TAB_SITES = 'sites';
const TAB_FORMS = 'forms';
const TAB_ADMIN = 'admin';

const MapIcon = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>);
const ListIcon = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>);
const GearIcon = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>);

function demoSession(role) {
  return {
    id: 0,
    name: `Pineview ${role.charAt(0).toUpperCase()}${role.slice(1)}`,
    email: `${role}@pineview.local`,
    role,
  };
}

function siteIdentityKey(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    const raw = value.id ?? value.cacheId ?? value.tempId;
    return raw == null ? '' : String(raw);
  }
  return String(value);
}

function matchSiteIdentity(site, selectedSite) {
  const left = siteIdentityKey(site);
  const right = siteIdentityKey(selectedSite);
  return Boolean(left && right && left === right);
}

function removeSitesByIdentity(sites, target) {
  const key = siteIdentityKey(target);
  if (!key) return sites;
  return sites.filter((site) => siteIdentityKey(site) !== key);
}

function isHiddenSite(site) {
  return site?.approval_state === 'rejected' || Boolean(site?.deleted_at);
}

// Mirrors the `visibleSites` filter predicate below so we can detect, right
// after a worker submits a new pin, whether the current map filter / layer
// settings would quietly hide it. A user who had e.g. `approval_state =
// "approved"` set and then added a pin (which is always created as
// pending_review) would otherwise see no pin on the map — the symptom
// behind the "shows in pending but not on the map, had to refresh" bug
// report. Returns an array of `{ kind, key, label }` entries describing
// every filter/layer that's currently hiding the site, so the caller can
// both tell the user what's going on AND clear the offending settings in
// one shot. Empty array = pin is visible, nothing to do.
const FILTER_LABELS = {
  client: 'client',
  area: 'area',
  status: 'status',
  approval_state: 'approval',
  search: 'search',
};
const LAYER_LABELS = {
  lsd: 'LSD',
  water: 'Water',
  quad_access: 'Quad Access',
  reclaimed: 'Reclaimed',
};
function getFiltersHidingSite(site, filters, layers) {
  const hiding = [];
  const isWater = site.pin_type === 'water';
  if (site.pin_type && layers && layers[site.pin_type] === false) {
    hiding.push({ kind: 'layer', key: site.pin_type, label: `${LAYER_LABELS[site.pin_type] || site.pin_type} layer` });
  }
  // client / area equality is intentionally case-insensitive so legacy
  // rows with mismatched casing (e.g. "Foothills" vs "FOOTHILLS") still
  // group with the user's chosen filter value until the migration / next
  // edit normalizes them. See lib/mapUtils#nameKey.
  if (filters.client && nameKey(site.client) !== nameKey(filters.client) && !isWater) {
    hiding.push({ kind: 'filter', key: 'client', label: `${FILTER_LABELS.client} filter` });
  }
  if (filters.area && nameKey(site.area) !== nameKey(filters.area) && !isWater) {
    hiding.push({ kind: 'filter', key: 'area', label: `${FILTER_LABELS.area} filter` });
  }
  if (filters.status && site.status !== filters.status && !isWater) {
    hiding.push({ kind: 'filter', key: 'status', label: `${FILTER_LABELS.status} filter` });
  }
  if (filters.approval_state && site.approval_state !== filters.approval_state) {
    hiding.push({ kind: 'filter', key: 'approval_state', label: `${FILTER_LABELS.approval_state} filter` });
  }
  const normalizedSearch = (filters.search || '').trim().toLowerCase();
  if (normalizedSearch) {
    const haystack = [site.lsd, site.client, site.area, site.notes].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(normalizedSearch)) {
      hiding.push({ kind: 'filter', key: 'search', label: `${FILTER_LABELS.search} box` });
    }
  }
  return hiding;
}

export default function App() {
  // Service-worker lifecycle is now owned by vite-plugin-pwa (see
  // vite.config.js Fix #3). The previous "unregister every SW on load"
  // block here defeated app-shell caching entirely — it ran on every
  // boot, killing any SW that vite-plugin-pwa had just installed and
  // forcing the next visit to refetch HTML/JS/CSS from the server.
  // Dev builds still get a one-shot unregister in main.jsx so leftover
  // production SWs don't intercept HMR; production no longer wipes its
  // own SW.
  // Styled dialog API — replaces window.alert / confirm / prompt. The
  // returned identities are stable across renders (see DialogProvider),
  // so closures over `alert` / `confirm` (e.g. inside processUploadQueue,
  // explainRejectConflict) stay valid even when the parent re-renders.
  const { alert, confirm } = useDialog();
  const wasOnline = useRef(window.navigator.onLine);
  const lastSyncStatusRef = useRef(null);

  // ── Service-worker update detection + push ─────────────────────────────
  // vite-plugin-pwa is configured with `registerType: 'prompt'` +
  // `skipWaiting: false` + `clientsClaim: false`, so a new deploy's SW
  // installs in the background and parks in the `waiting` state. This
  // effect pushes update checks via `registration.update()` so the worker
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
  // Published by the build-version poll effect below so the regular
  // poll-tick loop (which runs reliably on iOS PWA, where setInterval
  // alone is throttled) can piggyback a version check on every tick.
  // Without this, iOS PWA workers only saw the red "Update available"
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
    // The SW lifecycle and the version-poll path (further down in this
    // component) race on every deploy. Path B (version-poll) is the
    // faster signal source — it just GETs a tiny JSON file — so the
    // user typically sees the indicator and clicks "Update Now" while
    // the browser is still byte-comparing the new /sw.js. At that
    // moment swWaitingRef is null, so handleAppUpdate's postMessage
    // SKIP_WAITING is a no-op; the reload happens, the new bundle
    // loads, and APP_VERSION jumps to the new build. Then, *after* the
    // reload, the browser finishes installing the new SW and parks it
    // in `waiting` — at which point this listener fires for a SW that
    // matches the build the user is already running, producing a
    // confusing second "Update available" prompt that updates nothing.
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
      // the worker who closed the app during a deploy and reopens it a
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
    // loop succeeded — a hung cache op can no longer leave the worker
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
    // Without the throttle a worker tapping rapidly through forms could
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

    // Publish the checker so the regular poll-tick loop (defined in a
    // separate useEffect further down) can call it on every tick.
    // On desktop browsers the setInterval below is the primary trigger;
    // on iOS PWA, where WKWebView throttles setInterval even in
    // foreground, the poll-tick path is the one that fires reliably
    // because it's piggybacking on real network activity that iOS
    // doesn't pause.
    checkAppVersionRef.current = checkVersionThrottled;

    // Kick once on mount, then every 30 s, then on tab focus / back-online
    // so the worker who returned to the app right after a deploy sees the
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
    // throttling setInterval — and a worker actively logging spray
    // records is touching the screen every few seconds, so this
    // guarantees the red "Update available" dot lights up within
    // ~60 s of the next interaction after a deploy lands. Passive
    // listener on the capture phase so we never block a tap; and
    // pointerdown is the only DOM event that fires for both touch
    // and mouse on a single hook.
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
    setAccountMenuOpen(false);
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
  // Delta-sync watermarks: the `server_time` returned by the last successful
  // /api/*/delta call, to be passed back as `?since=` on the next poll. Null
  // means "no baseline yet — fall back to full fetch on the first call".
  const sitesSinceRef = useRef(null);
  const pipelinesSinceRef = useRef(null);
  const recentsSinceRef = useRef(null);
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sites, setSites] = useState([]);
  const [pendingSites, setPendingSites] = useState([]);
  // Lightweight count seeded from /api/sync-status (cheap ~100 B response)
  // and persisted alongside the delta watermarks. The full pending list
  // (`pendingSites`) is only fetched after canManagePins + an online check,
  // so on cold start the topbar's "Pending: N" badge used to flicker on
  // empty for ~1 s while the network call resolved. Keeping a separate
  // count lets the badge render the right number INSTANTLY from cache.
  // Falls back to the array length when null (first run, never online).
  const [pendingSitesCount, setPendingSitesCount] = useState(null);
  const [pendingPipelinesCount, setPendingPipelinesCount] = useState(null);
  const [deletedSites, setDeletedSites] = useState([]);
  const [deletedLeaseSheets, setDeletedLeaseSheets] = useState([]);
  const [deletedTMTickets, setDeletedTMTickets] = useState([]);
  const [deletedHydroseedDailies, setDeletedHydroseedDailies] = useState([]);
  const [deletedHydroseedTickets, setDeletedHydroseedTickets] = useState([]);
  const [deletedQuotes, setDeletedQuotes] = useState([]);
  const [selectedSite, setSelectedSite] = useState(null);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [markerRevision, setMarkerRevision] = useState(0);
  const [message, setMessage] = useState('Loading project data...');
  const [isOnline, setIsOnline] = useState(window.navigator.onLine);
  // Supabase Realtime channel status. Starts 'connecting' on mount and
  // flips to 'connected' after the first SUBSCRIBED event. On
  // CHANNEL_ERROR / TIMED_OUT / CLOSED we go to 'disconnected', which
  // (a) surfaces a subtle yellow badge in the topbar so the worker knows
  // updates may be lagging, and (b) speeds up the safety-net poll
  // cadence below so the UI still gets fresh data within ~60 s while
  // the SDK's internal reconnect is trying to recover.
  const [realtimeStatus, setRealtimeStatus] = useState('connecting');
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  // Tracks the manual Refresh button's busy state. Kept separate from
  // isSyncing (which represents the auto-reconnect sync) so the two
  // indicators don't fight over a single variable.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [submittingPin, setSubmittingPin] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [lastSync, setLastSync] = useState(null);

  const [activeTab, setActiveTab] = useState(TAB_MAP);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [fabOpen, setFabOpen] = useState(false);
  const [addPinType, setAddPinType] = useState(null);
  const [addPinLocation, setAddPinLocation] = useState(null);
  const [addPinForm, setAddPinForm] = useState({ lsd: '', client: '', area: '' });
  const [selectedAddPinLsdSuggestion, setSelectedAddPinLsdSuggestion] = useState(null);
  const [editPickLocation, setEditPickLocation] = useState(null);
  const [isEditPickingMode, setIsEditPickingMode] = useState(false);
  const [previewSiteLocation, setPreviewSiteLocation] = useState(null);
  const [zoomTarget, setZoomTarget] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  // Tracks the browser-reported geolocation permission state. Used by the
  // watchPosition effect below to AVOID calling watchPosition on every app
  // open when the user hasn't granted permission yet — that auto-call was
  // what made iOS PWA prompt for location access on every cold start, even
  // when the user just wanted to look at the map.
  //
  // Possible values:
  //   • 'granted'    — auto-start the watch silently (no prompt fires)
  //   • 'denied'     — never auto-start; the "center on me" tap will hit
  //                    the explicit error path with the actionable
  //                    "enable in Settings" message
  //   • 'prompt'     — never auto-start; let the user opt in by tapping
  //                    the location button, which is the ONE place we
  //                    intentionally surface the OS prompt
  //   • 'unsupported'— very old browsers / WKWebView versions without the
  //                    Permissions API; we fall through to the legacy
  //                    auto-start behaviour as a best-effort
  //   • 'unknown'    — initial value before the query resolves
  const [geoPermission, setGeoPermission] = useState('unknown');
  // Pipeline state
  const [pipelines, setPipelines] = useState([]);
  const [pendingPipelines, setPendingPipelines] = useState([]);
  const [deletedPipelines, setDeletedPipelines] = useState([]);
  const [selectedPipeline, setSelectedPipeline] = useState(null);
  const [pipelineDetailOpen, setPipelineDetailOpen] = useState(false);
  const [pipelineSprayRecords, setPipelineSprayRecords] = useState([]);
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  // Devices (registered iPads running OwnTracks). One row per truck with
  // its last-known position + color, used by MapView's TrucksLayer.
  // Hydrated from /api/devices on boot, then kept fresh via Supabase
  // Realtime on the `devices` table (added to the channel chain below).
  const [devices, setDevices] = useState([]);
  // Active check-in shifts with a passive last-known location, for the
  // map's CrewLayer (live worker/truck positions). Only populated for
  // pin-managers (admin/office/crew_lead) -- the source endpoint is gated
  // to MANAGES_PINS. Refreshed on the same triggers as the active-shift
  // load (mount, focus/visibility, Realtime shifts/checkins).
  const [crewShifts, setCrewShifts] = useState([]);
  // Composite "shiftId:userId" key of the crew pin/row that's open;
  // null when nothing is selected. One key per crew member because we
  // track each member's last-known location individually now (not just
  // the lead's truck position).
  const [selectedCrewKey, setSelectedCrewKey] = useState(null);
  // Toggles the manager-only "Crew on shift" list overlay on the map.
  const [showCrewPanel, setShowCrewPanel] = useState(false);
  // Shift ids whose crew members are expanded in the sidebar AND on the
  // map. Collapsed (default) = only the lead pin/row is shown so a
  // 5-crew shift doesn't bury the office in 5 stacked pins. Toggled from
  // the sidebar chevron and from a "Show crew (N)" button in the lead's
  // map popup. Set kept on the App so both surfaces stay in sync.
  const [expandedCrewShiftIds, setExpandedCrewShiftIds] = useState(() => new Set());
  const toggleCrewShiftExpanded = useCallback((shiftId) => {
    setExpandedCrewShiftIds((prev) => {
      const next = new Set(prev);
      if (next.has(shiftId)) next.delete(shiftId);
      else next.add(shiftId);
      return next;
    });
  }, []);
  // Drawing pipeline state
  const [isDrawingPipeline, setIsDrawingPipeline] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState([]);
  const [drawingForm, setDrawingForm] = useState({ name: '', client: '', area: '' });
  const [showDrawingForm, setShowDrawingForm] = useState(false);
  // Spray marking state
  const [isSprayMarking, setIsSprayMarking] = useState(false);
  // Differentiates the two segment-selection flows that share the spray-
  // marking infrastructure (banner, map taps, confirm popup):
  //   'inspection' — "Mark Inspection" entry from PipelineDetailSheet;
  //                  confirms a sprayed segment, forwards to lease sheet.
  //   'issue'      — "⚠ Issue with Pipeline" entry; reason has already
  //                  been captured, popup offers Yes-Fill-Sheet / Skip /
  //                  Cancel applied to the selected segment.
  // Drives the popup title, banner text, and which confirm handler
  // runs. Stays null when no marking is in progress.
  const [sprayMarkingMode, setSprayMarkingMode] = useState(null);
  const [sprayStartPoint, setSprayStartPoint] = useState(null);
  const [sprayEndPoint, setSprayEndPoint] = useState(null);
  const [showSprayConfirm, setShowSprayConfirm] = useState(false);
  // sprayForm holds the spray date typed in the spray-confirm popup
  // before the user is forwarded into the pipeline lease-sheet flow.
  // History: also held a `notes` string and an `is_avoided` flag that
  // drove a checkbox ("Issue with site — skip lease sheet") which
  // bypassed the lease sheet entirely. Both fields were removed once
  // the dedicated "Mark Not Inspected" prompt in PipelineDetailSheet
  // became the canonical way to record an issue, and the lease-sheet
  // flow itself collects any notes the worker wants to attach. Kept
  // as an object (rather than a flat sprayDate) so future fields
  // unique to the popup can be added without churning the call sites.
  const [sprayForm, setSprayForm] = useState({ date: localDateISO() });
  const [pendingPipelineSegment, setPendingPipelineSegment] = useState(null);
  const [highlightedSprayRecordId, setHighlightedSprayRecordId] = useState(null);
  const [isFollowingUser, setIsFollowingUser] = useState(false);
  // Lease sheet inspection state
  const [inspectionSite, setInspectionSite] = useState(null);
  const [inspectionPipeline, setInspectionPipeline] = useState(null);
  const [inspectionSiteStatus, setInspectionSiteStatus] = useState('inspected');
  const [inspectionReason, setInspectionReason] = useState('');
  // Upload queue state
  const [uploadQueueItems, setUploadQueueItems] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  // Per-batch counters for the header progress bar. `uploadTotal` is the
  // number of items in the batch when processUploadQueue started; queue
  // size in IDB shrinks as items finish, so we can't derive total from
  // there. `uploadCompleted` tracks how many of those have been
  // committed server-side.
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadCompleted, setUploadCompleted] = useState(0);
  // Per-file (current item) upload-byte percentage 0..100. Driven by
  // XHR `upload.onprogress` events on the active item — gives the
  // worker live "20% → 40% → 60% → ..." feedback within a single
  // record's upload, instead of jumping 0→100% atomically when the
  // request resolves. Server-side processing time after the bytes
  // land (PDF render + Dropbox push) is invisible to the client, so
  // we cap the displayed value at 95% during upload and let the
  // jump to 100% happen when the API call actually returns.
  const [currentItemPercent, setCurrentItemPercent] = useState(0);
  // Lane-2 (Dropbox/photos) byte-progress for the active upload item — only
  // populated for two-lane targets (lease sheets + hydroseed dailies). Lane 1
  // (the fast metadata POST) reuses `currentItemPercent`; lane 2 lives here
  // so FormsPanel's Uploading row can render the two bars side-by-side.
  const [currentItemLane2Percent, setCurrentItemLane2Percent] = useState(0);
  // Queue entry id (from offlineStore.uploadQueue) of the item that's
  // currently being uploaded. Null between items / when idle. FormsPanel
  // uses this to decide which row in its Uploading list should render
  // the live byte-progress bar vs. the static "Queued" state.
  const [activeUploadItemId, setActiveUploadItemId] = useState(null);
  // Bump counter used as a one-shot signal to tell FormsPanel to jump
  // to its In Progress → Uploading sub-tab. Triggered by the tiny
  // "Syncing X%" badge in the header: tapping it takes the worker
  // straight to the per-ticket progress view without forcing them to
  // drill down manually.
  const [uploadTabSignal, setUploadTabSignal] = useState(0);
  const uploadingRef = useRef(false);
  // Memoize the dynamic-import promises for the PDF-generator chunks so
  // processUploadQueue only triggers the network fetch once per session
  // (subsequent queue ticks re-await the resolved promise instantly).
  const pdfGenPromiseRef = useRef(null);
  const tmPdfGenPromiseRef = useRef(null);
  // Lease-sheet record preview state
  const [previewingRecord, setPreviewingRecord] = useState(null);
  // Edit spray record state
  const [editingSprayRecord, setEditingSprayRecord] = useState(null);
  // T&M ticket detail view
  const [activeTMTicketId, setActiveTMTicketId] = useState(null);
  // ── Hydroseed module overlays (Phase 6) ─────────────────────────────────
  // Daily form: open=true mounts the modal. `hydroseedDuplicateFrom` carries
  // the previous-daily snapshot when the user accepts the "duplicate?"
  // prompt on open. `resumingHydroseedDraft` carries an in-progress draft
  // selected from the drafts tab. `editingHydroseedRecord` swaps the form
  // into edit mode for an already-submitted record.
  const [hydroseedDailyOpen, setHydroseedDailyOpen] = useState(false);
  const [hydroseedDuplicateFrom, setHydroseedDuplicateFrom] = useState(null);
  const [resumingHydroseedDraft, setResumingHydroseedDraft] = useState(null);
  const [editingHydroseedRecord, setEditingHydroseedRecord] = useState(null);
  // Hydroseed ticket detail view (HT######).
  const [activeHydroseedTicketId, setActiveHydroseedTicketId] = useState(null);
  // Pre-fetched latest daily record for duplication logic (instant open)
  const [latestHydroseedDaily, setLatestHydroseedDaily] = useState(null);
  const [hasFetchedLatestDaily, setHasFetchedLatestDaily] = useState(false);
  // Lease sheet draft being resumed
  const [resumingDraft, setResumingDraft] = useState(null);
  // Standalone lease sheet (external, not tied to a map site)
  const [standaloneLeaseSheet, setStandaloneLeaseSheet] = useState(false);
  const [isStandaloneMapPicking, setIsStandaloneMapPicking] = useState(false);
  const [standalonePickedLocation, setStandalonePickedLocation] = useState(null);
  // Token used to force FormsPanel to refresh drafts list
  const [draftsRefreshToken, setDraftsRefreshToken] = useState(0);
  // Reports dashboard overlay. Only mounted when true — the lazy chunk
  // loads on first open and stays in memory for the session, but the
  // component itself does NO background work (no polls, no realtime, no
  // auto-fetch on mount). All network activity is driven by explicit
  // button clicks, so having it open vs closed has zero egress cost until
  // the user clicks Generate/Download.
  const [showReportsDashboard, setShowReportsDashboard] = useState(false);
  const [showQuoteBuilder, setShowQuoteBuilder] = useState(false);
  // Calendar overlay (admin/office) — same on-demand pattern as the two
  // above. Closes automatically if `roleCanAdmin` flips false (View as
  // Worker) thanks to the render-time guard further down.
  const [showCalendar, setShowCalendar] = useState(false);
  // ── Check-ins (Phase 2 unified) ─────────────────────────────────
  // Personal overlay open state. Triggered from:
  //   - Avatar popover "🛟 Check-ins" item (all roles)
  //   - Topbar countdown click
  //   - Soft morning banner "Start now" tap
  //   - SW notificationclick -> postMessage('open-checkin')
  const [showMyCheckins, setShowMyCheckins] = useState(false);
  // Admin dashboard overlay (Overview / Active / History / Settings).
  // Same role gating as Calendar/Reports/Quotes via roleCanAdmin guard.
  const [showCheckinsDashboard, setShowCheckinsDashboard] = useState(false);
  // Operations TV dashboard overlay (admin/office only). The dedicated
  // `tv` role gets it full-screen via the boot short-circuit; this is the
  // "open it on my own desktop for a glance" path.
  const [showTvDashboard, setShowTvDashboard] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkModalTargetSite, setLinkModalTargetSite] = useState(null);
  // The calling user's currently-active shift (or null). Loaded after
  // auth + refreshed via Realtime + after every POST /api/checkins.
  // Drives the topbar countdown, the forced overlay logic, and the
  // soft morning banner. Setting to null when the shift ends.
  const [activeShift, setActiveShift] = useState(null);
  // Forced-overlay state. When true, MyCheckInsOverlay renders in
  // force=true mode (no close, only I'm OK or End shift to dismiss).
  // Toggled by an effect that watches active shift + 30 s tick +
  // visibility/focus events. Suppressed for 60 s after a successful
  // check-in (handled inside shouldForceOverlay()).
  const [forceCheckinOverlay, setForceCheckinOverlay] = useState(false);
  // Soft morning banner dismissed flag. Persisted to localStorage with
  // today's date string so it re-appears tomorrow.
  const [softBannerDismissed, setSoftBannerDismissed] = useState(false);
  // Token bumped by the poll loop whenever sync-status reports
  // `tm_tickets_last_updated` has moved. FormsPanel listens to it and
  // re-fetches its Open / Recently Submitted T&M lists so users see
  // updates without a full page reload — at the cost of only one extra
  // MAX(updated_at) query in sync-status, which is already indexed.
  const [tmRefreshToken, setTmRefreshToken] = useState(0);
  // Same pattern for Hydroseed tickets. FormsPanel uses the unified
  // `hydroseedTickets` cache + `/api/hydroseed/tickets/delta` to keep
  // its Open / Recently Submitted hydroseed lists fresh; this token
  // wakes that sync up immediately when sync-status or Realtime says
  // something changed, instead of waiting for the 30 s local poll.
  const [hydroseedRefreshToken, setHydroseedRefreshToken] = useState(0);
  // Same pattern for hydroseed dailies (HD######). Bumped from the
  // sync-status poll when `hydroseed_dailies_last_updated` moves and
  // from Realtime daily inserts/updates so FormsPanel can run a cheap
  // delta sync of its dailies list instead of a full re-fetch.
  const [hydroseedDailiesRefreshToken, setHydroseedDailiesRefreshToken] = useState(0);
  // Recents cache (IndexedDB-backed, pre-loaded at startup)
  const [cachedRecents, setCachedRecents] = useState([]);
  // Lookups cache (IndexedDB-backed)
  const [cachedLookups, setCachedLookups] = useState({ herbicides: [], applicators: [], weeds: [], locations: [] });
  // Users cache (IndexedDB-backed)
  const [cachedUsers, setCachedUsers] = useState([]);
  const mapRef = useRef(null);
  const lastFollowUpdateRef = useRef(0);
  const smoothedLocationRef = useRef(null);
  const lastLocationUpdateRef = useRef(0);
  const isEditPickingModeRef = useRef(false);

  // Transient banner shown at the top of the map right after a pin is
  // submitted. Primary job: surface the "your new pending pin was about
  // to be hidden by a filter you had set" case that previously silently
  // swallowed the pin and forced a full-page refresh to recover. The
  // banner auto-dismisses after 6 s; the timer ref survives re-renders
  // so a second submission cleanly replaces the first without leaking
  // a stale timeout. Shape: `{ message: string } | null`.
  const [pinSubmitBanner, setPinSubmitBanner] = useState(null);
  const pinSubmitBannerTimerRef = useRef(null);
  const showPinSubmitBanner = useCallback((message) => {
    if (pinSubmitBannerTimerRef.current) {
      clearTimeout(pinSubmitBannerTimerRef.current);
    }
    setPinSubmitBanner({ message });
    pinSubmitBannerTimerRef.current = setTimeout(() => {
      setPinSubmitBanner(null);
      pinSubmitBannerTimerRef.current = null;
    }, 6000);
  }, []);
  useEffect(() => () => {
    if (pinSubmitBannerTimerRef.current) clearTimeout(pinSubmitBannerTimerRef.current);
  }, []);

  // Actual role from the Supabase session. Never changed by the view
  // toggle \u2014 used for identity, backend auth, and deciding whether the
  // "View as Worker" button is available at all.
  //
  // Three tiers in increasing privilege:
  //   actualIsCrewLead    \u2014 crew_lead only (sub-flag for read-only UI bits)
  //   actualCanManagePins \u2014 admin | office | crew_lead (pin & lease-sheet ops)
  //   actualCanAdmin      \u2014 admin | office only          (reports, quotes,
  //                          calendar, lookups, T&M / hydroseed approvals,
  //                          user management, etc.)
  const userRole = session?.user?.user_metadata?.role || 'worker';
  const actualCanAdmin = userRole === 'admin' || userRole === 'office';
  const actualIsCrewLead = userRole === 'crew_lead';
  const actualCanManagePins = actualCanAdmin || actualIsCrewLead;

  // Display label for the current user, computed once and reused by both
  // the inline (tablet/PC) name badge and the mobile avatar menu. Mirrors
  // the previous inline expression so existing accounts render identically.
  const userDisplayName = useMemo(() => {
    if (!user) return '';
    const metaName = user.user_metadata?.name || user.name;
    if (metaName) return metaName;
    const local = user.email ? user.email.split('@')[0] : '';
    if (local) return local.charAt(0).toUpperCase() + local.slice(1);
    return user.email || '';
  }, [user]);
  // Initial used inside the round avatar trigger on mobile.
  const userInitial = (userDisplayName || 'U').trim().charAt(0).toUpperCase() || 'U';

  // "View as Worker" override: admin/office can flip this on to get the
  // worker-level UI (no admin panel tab, no approve/delete buttons, no
  // Dropbox pricing links) AND see only their own forms \u2014 handy when
  // they're in the field and don't want extra buttons cluttering the view.
  // Pure frontend \u2014 the backend still knows them as admin/office, so no
  // permission loss, and the toggle survives a refresh via localStorage.
  const [viewAsWorker, setViewAsWorker] = useState(() => {
    try { return localStorage.getItem('pv_view_as_worker') === '1'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('pv_view_as_worker', viewAsWorker ? '1' : '0'); }
    catch { /* ignore */ }
  }, [viewAsWorker]);

  // ── Account menu (mobile-only avatar dropdown) ───────────────────────────
  // The topbar packs a lot into a small space on phones: Online/Offline,
  // Refresh, Pending alerts, Sync indicators, the user's name, View as
  // Worker, and Sign Out. On a 375 px screen those wrap to two rows and
  // crowd the map. This state powers a single avatar popover that
  // collapses the three identity-related items (name, View as Worker,
  // Sign Out) into one compact trigger on mobile only. Tablet/PC keeps
  // the inline layout unchanged via CSS (see `.topbar-account-menu` /
  // `.topbar-account-inline-only` in index.css).
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef(null);
  useEffect(() => {
    if (!accountMenuOpen) return;
    const handleOutside = (e) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target)) {
        setAccountMenuOpen(false);
      }
    };
    // pointerdown covers both mouse and touch in one listener and fires
    // before the click that would otherwise re-toggle the menu.
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [accountMenuOpen]);

  // If the user isn't actually admin/office/crew_lead, force the toggle
  // off so a stale localStorage value from a previous session/account
  // doesn't lock a real worker into some phantom "view as worker" state.
  // (No-op for actual workers since the effective roles are already false.)
  useEffect(() => {
    if (!actualCanManagePins && viewAsWorker) setViewAsWorker(false);
  }, [actualCanManagePins, viewAsWorker]);

  // If the user was sitting on the Admin tab when they flipped to worker
  // view, bounce them back to the Map tab so they don't end up staring
  // at a blank screen (the admin panel is hidden once canManagePins is
  // false, but `activeTab` would still be TAB_ADMIN without this snap).
  useEffect(() => {
    if (viewAsWorker && activeTab === TAB_ADMIN) setActiveTab(TAB_MAP);
  }, [viewAsWorker, activeTab]);

  // Effective permissions \u2014 downgraded to worker-level when the toggle
  // is on. Every role-gated render in the app reads these, not the raw
  // userRole, so flipping the toggle instantly updates the whole UI.
  //
  //   canManagePins   \u2014 admin | office | crew_lead. Used for pin/site
  //                     approve/edit/delete, link-lease-sheet modal, the
  //                     Admin tab/side-panel, pending-sites loaders, and
  //                     opening the (read-only-for-crew-lead) Check-ins
  //                     Dashboard.
  //   roleCanAdmin    \u2014 admin | office only. Used for Reports, Quote
  //                     Builder, Calendar, Lookups, User Management,
  //                     T&M / hydroseed approval, and the
  //                     "Permanently delete all" footer. Crew leads
  //                     never see these even though they sit in the
  //                     same Admin tab.
  //   isCrewLeadOnly  \u2014 sub-flag the AdminPanel uses to strip out
  //                     non-pin sections.
  const canManagePins = actualCanManagePins && !viewAsWorker;
  const roleCanAdmin = actualCanAdmin && !viewAsWorker;
  const isCrewLeadOnly = actualIsCrewLead && !viewAsWorker;

  // Current user's display name, matching the backend's derivation in
  // auth.py: user_metadata.name if set, else the email prefix run through
  // Python's str.title(). Used by FormsPanel to filter records to "mine
  // only" when viewAsWorker is on (records carry `created_by_name` /
  // `sprayed_by_name` \u2014 no email field).
  const currentUserName = useMemo(() => {
    const m = session?.user?.user_metadata?.name;
    if (m) return m;
    const email = session?.user?.email;
    if (!email) return '';
    // Python str.title() equivalent: first letter of each letter-run upper,
    // rest lower. 'randy.hp' -> 'Randy.Hp', 'randyhp' -> 'Randyhp'.
    return email.split('@')[0].replace(
      /[A-Za-z]+/g,
      (w) => w[0].toUpperCase() + w.slice(1).toLowerCase(),
    );
  }, [session?.user?.user_metadata?.name, session?.user?.email]);
  const isPlacingPin = addPinType !== null && addPinLocation === null;
  const isPickingLocationForEdit = isEditPickingMode;
  const showAddPopup = addPinType !== null && addPinLocation !== null;

  const serverFilters = useMemo(
    () => ({
      approval_state: filters.approval_state || undefined,
    }),
    [filters.approval_state]
  );

  const refreshQueueCount = useCallback(async () => {
    const queuedActions = await getQueuedActions();
    setQueuedCount(queuedActions.length);
    return queuedActions;
  }, []);

  const loadPendingSites = useCallback(async () => {
    if (!canManagePins || !window.navigator.onLine) {
      setPendingSites([]);
      setDeletedSites([]);
      // Deliberately don't flip the loaded ref when we're offline or
      // non-admin — we want the topbar badge to keep the last known
      // count from /api/sync-status until we've actually seen a fresh
      // list, otherwise a cached count of 3 would flash to 0.
      return;
    }
    try {
      const pending = await api.listPendingSites();
      setPendingSites(pending);
      pendingSitesLoadedRef.current = true;
    } catch {
      setPendingSites([]);
    }
    try {
      const deleted = await api.listDeletedSites();
      setDeletedSites(deleted);
    } catch {
      setDeletedSites([]);
    }
  }, [canManagePins]);

  const loadCachedSites = useCallback(async () => {
    const cachedSites = await getSites();
    setSites(cachedSites);
    const cachedLastSync = await getLastSyncAt();
    setLastSync(cachedLastSync);
  }, []);

  const loadServerSites = useCallback(async () => {
    const sitesPayload = await api.listSites(serverFilters);

    // Spread-merge against current state so a manual refresh while a site
    // detail is open doesn't wipe the heavy fields (spray_records, updates,
    // …) that were hydrated by /api/sites/{id}. The slim SiteListRead schema
    // omits those keys, and Object spread keeps existing values whenever the
    // incoming payload doesn't override them.
    setSites((prev) => {
      const byId = new Map(prev.map((s) => [siteIdentityKey(s), s]));
      return sitesPayload.map((item) => {
        const existing = byId.get(siteIdentityKey(item));
        return existing ? { ...existing, ...item } : item;
      });
    });
    await replaceSites(sitesPayload);
    const now = new Date().toISOString();
    await setLastSyncAt(now);
    setLastSync(now);
    await loadPendingSites();
  }, [loadPendingSites, serverFilters]);

  // Load recents: cached from IndexedDB instantly, then refresh from server
  const loadCachedRecents = useCallback(async () => {
    const cached = await getRecents();
    if (cached.length > 0) {
      // Sort by created_at desc (IndexedDB doesn't guarantee order)
      cached.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      setCachedRecents(cached);
    }
  }, []);

  const loadServerRecents = useCallback(async () => {
    if (!window.navigator.onLine) return;
    try {
      // Pull 100 rows on initial / full-refresh fetches so a freshly-installed
      // PWA (or any device whose IDB recents cache was wiped) shows ~3–6 weeks
      // of lease-sheet history immediately, instead of just the last day or two.
      // The FormsPanel "Load more" button still pages further back via the
      // server's ?before= cursor when this initial window runs out.
      const data = await api.listRecentSubmissions({ limit: 100 });
      setCachedRecents(data);
      await replaceRecents(data);
    } catch {
      console.error('[RECENTS] Failed to load from server');
    }
  }, []);

  // Load lookups: cached from IndexedDB instantly, then refresh from server
  const loadCachedLookups = useCallback(async () => {
    const all = await getAllLookups();
    if (Object.keys(all).length > 0) {
      setCachedLookups({
        herbicides: all.herbicides || [],
        applicators: all.applicators || [],
        weeds: all.weeds || [],
        locations: all.locations || [],
      });
    }
  }, []);

  const loadServerLookups = useCallback(async () => {
    if (!window.navigator.onLine) return;
    try {
      const [herbicides, applicators, weeds, locations] = await Promise.all([
        api.listHerbicides(),
        api.listApplicators(),
        api.listNoxiousWeeds(),
        api.listLocationTypes(),
      ]);
      setCachedLookups({ herbicides, applicators, weeds, locations });
      await Promise.all([
        replaceLookups('herbicides', herbicides),
        replaceLookups('applicators', applicators),
        replaceLookups('weeds', weeds),
        replaceLookups('locations', locations),
      ]);
    } catch {
      console.error('[LOOKUPS] Failed to load from server');
    }
  }, []);

  // Load users: cached from IndexedDB instantly, then refresh from server
  const loadCachedUsers = useCallback(async () => {
    const cached = await getUsers();
    if (cached.length > 0) setCachedUsers(cached);
  }, []);

  const loadServerUsers = useCallback(async () => {
    if (!window.navigator.onLine) return;
    if (!userRole) return;
    // Admins get the full Supabase-Auth list (includes last_sign_in_at,
    // email_confirmed_at, etc. for the User Management panel).
    // Non-admins fall back to the lightweight roster endpoint so crew
    // pickers (Hydroseed Daily roster, T&M crew picker) get populated for
    // worker / crew_lead / office roles too. Without this, those pickers
    // were empty for non-admins because /api/admin/users 403s.
    try {
      const data = userRole === 'admin'
        ? await api.listUsers()
        : await api.listRoster();
      setCachedUsers(data);
      await replaceUsers(data);
    } catch {
      console.error('[USERS] Failed to load from server');
    }
  }, [userRole]);

  // Devices: registered iPads running OwnTracks. No IndexedDB cache layer
  // because the fleet is tiny (single-digit row count) and the only
  // payload that matters is the position snapshot — stale cached
  // positions would be more misleading than a brief blank state. Realtime
  // keeps the in-memory array fresh after this initial load.
  const loadDevices = useCallback(async () => {
    if (!window.navigator.onLine || !actualCanManagePins) return;
    try {
      const data = await api.listDevices({ includeInactive: true });
      setDevices(Array.isArray(data) ? data : []);
    } catch (e) {
      // Soft-fail: an offline boot or transient 5xx shouldn't blow up
      // the whole app. The map keeps rendering site pins; trucks just
      // don't show until the next successful load / Realtime event.
      console.warn('[DEVICES] Failed to load devices from server:', e);
    }
  }, [actualCanManagePins]);

  // Pipelines: cached from IndexedDB instantly, then refreshed from server
  // when online. Mirror of loadCachedSites/loadServerSites so the boot path
  // can hydrate-from-cache and skip the network fetch on subsequent reloads.
  const loadCachedPipelines = useCallback(async () => {
    const cached = await getPipelines();
    if (cached.length > 0) setPipelines(cached);
  }, []);

  const loadPipelines = useCallback(async () => {
    if (!window.navigator.onLine) return;
    try {
      const data = await api.listPipelines();
      setPipelines(data);
      await replacePipelines(data);
    } catch {
      console.error('[PIPELINES] Failed to load pipelines');
    }
  }, []);

  const loadPendingPipelines = useCallback(async () => {
    if (!canManagePins || !window.navigator.onLine) {
      setPendingPipelines([]);
      return;
    }
    try {
      const pending = await api.listPendingPipelines();
      setPendingPipelines(pending);
      pendingPipelinesLoadedRef.current = true;
    } catch {
      setPendingPipelines([]);
    }
  }, [canManagePins]);

  const loadDeletedPipelines = useCallback(async () => {
    if (!canManagePins || !window.navigator.onLine) {
      setDeletedPipelines([]);
      return;
    }
    try {
      const deleted = await api.listDeletedPipelines();
      setDeletedPipelines(deleted);
    } catch {
      setDeletedPipelines([]);
    }
  }, [canManagePins]);

  const loadDeletedLeaseSheets = useCallback(async () => {
    if (!canManagePins || !window.navigator.onLine) {
      setDeletedLeaseSheets([]);
      return;
    }
    try {
      const deleted = await api.listDeletedLeaseSheets();
      setDeletedLeaseSheets(deleted);
    } catch {
      setDeletedLeaseSheets([]);
    }
  }, [canManagePins]);

  const loadDeletedTMTickets = useCallback(async () => {
    if (!roleCanAdmin || !window.navigator.onLine) {
      setDeletedTMTickets([]);
      return;
    }
    try {
      const deleted = await api.listDeletedTMTickets();
      setDeletedTMTickets(deleted);
    } catch {
      setDeletedTMTickets([]);
    }
  }, [roleCanAdmin]);

  const loadDeletedHydroseedDailies = useCallback(async () => {
    if (!roleCanAdmin || !window.navigator.onLine) {
      setDeletedHydroseedDailies([]);
      return;
    }
    try {
      const deleted = await api.listDeletedHydroseedDailies();
      setDeletedHydroseedDailies(deleted);
    } catch {
      setDeletedHydroseedDailies([]);
    }
  }, [roleCanAdmin]);

  const loadDeletedHydroseedTickets = useCallback(async () => {
    if (!roleCanAdmin || !window.navigator.onLine) {
      setDeletedHydroseedTickets([]);
      return;
    }
    try {
      const deleted = await api.listDeletedHydroseedTickets();
      setDeletedHydroseedTickets(deleted);
    } catch {
      setDeletedHydroseedTickets([]);
    }
  }, [roleCanAdmin]);

  // Quote Builder deleted-quotes loader — same shape as the other Recent
  // Deletes loaders so it can be slotted into AdminPanel without bespoke
  // wiring. Only admin/office can see deleted quotes.
  const loadDeletedQuotes = useCallback(async () => {
    if (!roleCanAdmin || !window.navigator.onLine) {
      setDeletedQuotes([]);
      return;
    }
    try {
      const deleted = await api.listDeletedQuotes();
      setDeletedQuotes(deleted);
    } catch {
      setDeletedQuotes([]);
    }
  }, [roleCanAdmin]);

  const refreshUploadQueue = useCallback(async () => {
    const items = await getUploadQueue();
    setUploadQueueItems(items);
    return items;
  }, []);

  // ── Upload-time PDF regeneration for offline-queued lease sheets ──
  //
  // When a sheet is submitted offline, HerbicideLeaseSheet skips
  // `getNextTicket()` and skips PDF rendering (a blank-ticket PDF would
  // otherwise be uploaded to Dropbox — see audit comment trail). At upload
  // time we now have the network back, so we:
  //   1. Reserve a real ticket number from herb_lease_seq
  //   2. Re-render the lease-sheet PDF with the real number embedded
  //   3. Re-render the linked T&M PDF body (if `tm_link.create`) so the
  //      site/area/date/rows match the now-finalized data
  //   4. Persist the patched payload back into the queue *before* posting
  //      so a crash mid-upload doesn't lose the work — next retry will
  //      see the already-stamped ticket and skip this branch.
  //
  // Returns the patched payload to use for the actual API call. If the
  // payload already has a ticket + PDF, returns it unchanged.
  const ensurePdfAndTicket = useCallback(async (item) => {
    const payload = item.payload || {};
    if (payload.ticket_number && payload.pdf_base64) {
      // Cache the already-generated PDF (online submit path) so its preview
      // opens instantly from IndexedDB instead of round-tripping Dropbox.
      try { putCachedPdf(`ticket:${payload.ticket_number}`, payload.pdf_base64); } catch { /* non-fatal */ }
      return payload;
    }

    // Reconstruct the PDF input shape the form used. lease_sheet_data is
    // the full form snapshot; herbicidesLookup / applicatorsLookup come
    // from the local cache so we still produce PCP and licence numbers
    // even when the API roundtrip would otherwise add latency to the
    // upload path. Empty arrays on miss are safe — the PDF formatters
    // gracefully fall back to plain names when no lookup match is found.
    const leaseData = payload.lease_sheet_data || {};
    const photoArr = Array.isArray(leaseData.photos) ? leaseData.photos : [];
    const photoDataUrls = photoArr
      .filter((p) => p && p.data)
      .map((p) => `data:${p.type || 'image/jpeg'};base64,${p.data}`);

    let herbicidesLookup = [];
    try { herbicidesLookup = await getLookups('herbicides'); } catch { /* fall through with empty lookup */ }
    let applicatorsLookup = [];
    try { applicatorsLookup = await getLookups('applicators'); } catch { /* fall through with empty lookup */ }

    let ticketNumber = payload.ticket_number;
    if (!ticketNumber) {
      try {
        const resp = await api.getNextTicket();
        ticketNumber = resp?.ticket_number;
      } catch (err) {
        // No network OR endpoint failed — bail out; caller leaves item in
        // queue for the next retry tick. Better to wait than to upload
        // another blank-ticket PDF.
        throw new Error(`Could not reserve ticket number: ${err?.message || err}`);
      }
    }

    let pdfBase64 = payload.pdf_base64;
    try {
      const { generateLeaseSheetPdf } = await (
        pdfGenPromiseRef.current
        || (pdfGenPromiseRef.current = importWithRetry(() => import('./lib/pdfGenerator')))
      );
      const out = await generateLeaseSheetPdf(
        { ...leaseData, ticket_number: ticketNumber, herbicidesLookup, applicatorsLookup },
        photoDataUrls
      );
      pdfBase64 = out.base64;
      // Cache by ticket number so the preview opens instantly right after
      // submit — even before Dropbox has the file (Phase 3).
      try { putCachedPdf(`ticket:${ticketNumber}`, pdfBase64); } catch { /* non-fatal */ }
    } catch (err) {
      throw new Error(`Could not regenerate lease-sheet PDF: ${err?.message || err}`);
    }

    // Re-render the linked T&M PDF body when offline submission deferred it.
    // We can't allocate the new T&M ticket number from here (that's done by
    // the backend's _allocate_ticket_number on commit), but the rest of the
    // PDF — site, area, date, row totals — renders correctly with the
    // tentative shape we already stored on the queue item.
    let tmLink = payload.time_materials_link || null;
    if (tmLink && !tmLink.tm_pdf_base64) {
      try {
        const tentativeMainRow = {
          location: leaseData.lsdOrPipeline || '',
          site_type: leaseData.isPipeline
            ? 'Pipeline'
            : (leaseData.mainSiteType || ''),
          herbicides: (leaseData.herbicidesUsed || []).length === 1
            ? leaseData.herbicidesUsed[0]
            : (leaseData.herbicidesUsed || []).length > 1
              ? `${Math.min(leaseData.herbicidesUsed.length, 3)} Herbicides`
              : '',
          liters_used: Number(leaseData.totalLiters) || 0,
          area_ha: leaseData.isPipeline
            ? (Number(leaseData.totalDistanceSprayed) || 0)
            : (Number(leaseData.areaTreated) || 0),
          cost_code: '',
        };
        const tentativeTicket = {
          ticket_number: '',  // backend allocates the real one on create
          spray_date: leaseData.date || payload.spray_date,
          client: leaseData.customer || '',
          area: leaseData.area || '',
          description_of_work: tmLink.description_of_work || '',
          rows: [tentativeMainRow],
        };
        const { generateTMTicketPdf } = await (
          tmPdfGenPromiseRef.current
          || (tmPdfGenPromiseRef.current = importWithRetry(() => import('./lib/tmTicketPdfGenerator')))
        );
        const out = await generateTMTicketPdf(tentativeTicket, { includeOfficeData: false });
        tmLink = { ...tmLink, tm_pdf_base64: out.base64 };
      } catch (err) {
        // T&M PDF regen is best-effort — leaving tm_pdf_base64 null just
        // means the linked T&M Dropbox copy won't be uploaded on this
        // submission (existing tickets keep their previous PDF). The DB
        // row + ticket linkage still get created correctly.
        console.warn('[UPLOAD_QUEUE] T&M PDF regen failed (continuing):', err?.message || err);
      }
    }

    const patched = {
      ...payload,
      ticket_number: ticketNumber,
      pdf_base64: pdfBase64,
      time_materials_link: tmLink,
      lease_sheet_data: { ...leaseData, ticket_number: ticketNumber },
    };

    // Persist the patched payload before posting so a crash here doesn't
    // lose the freshly-allocated ticket number. If the POST fails, the
    // next retry tick sees the stamped item and skips straight to the
    // network call (no second herb_lease_seq nextval).
    try { await updateUploadEntry(item.id, { payload: patched }); } catch { /* non-fatal */ }
    return patched;
  }, []);

  const processUploadQueue = useCallback(async () => {
    if (uploadingRef.current || !window.navigator.onLine) return;
    uploadingRef.current = true;
    // Pre-warm the PDF-generator chunks once at queue start so N items
    // don't each await a module resolution. These are dynamic imports
    // (chunks were evicted from the main bundle for cold-start perf);
    // the promises resolve once and ensurePdfAndTicket awaits them.
    pdfGenPromiseRef.current = pdfGenPromiseRef.current
      || importWithRetry(() => import('./lib/pdfGenerator'));
    tmPdfGenPromiseRef.current = tmPdfGenPromiseRef.current
      || importWithRetry(() => import('./lib/tmTicketPdfGenerator'));
    try {
      const items = await getUploadQueue();
      if (items.length === 0) { uploadingRef.current = false; return; }
      setIsUploading(true);
      setUploadProgress(0);
      const total = items.length;
      let completed = 0;
      // Expose the batch counters so the header progress bar can render
      // "Uploading 33% (1/3)" instead of just "Syncing…".
      setUploadTotal(total);
      setUploadCompleted(0);
      for (const item of items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        // Skip items that have been auto-paused after repeatedly failing
        // (see catch block below). They stay in the queue so the worker
        // can see them in the Uploading list; auto-retry is disabled
        // until they're explicitly re-queued or removed by the user.
        if (item.status === 'stalled') continue;
        try {
          // Lease sheets can carry a `time_materials_link` in their payload
          // which tells the backend to either (a) create a fresh T&M ticket
          // pre-populated with this sheet's hours or (b) append a row to an
          // existing open ticket. In both cases the Open Tickets list in
          // FormsPanel should refresh as soon as the upload finishes —
          // otherwise the worker waits up to 5 minutes (or has to bounce
          // off the Forms tab and back) before seeing the new/updated
          // ticket. We detect the link and bump `tmRefreshToken` at the
          // end of the branch so the delta fetch happens immediately.
          const bumpsTm = !!item.payload?.time_materials_link;

          // Per-item upload uses one of two progress models:
          //
          //  • TWO-LANE (lease sheets + hydroseed dailies): real byte
          //    progress for BOTH lanes. Lane 1 (`currentItemPercent`)
          //    is the tiny metadata POST — flushes in ms. Lane 2
          //    (`currentItemLane2Percent`) is the heavy Dropbox upload
          //    with real bytes 0-100%. No fake creep needed because
          //    Dropbox work is now in lane 2 with its own bar.
          //
          //  • SINGLE-LANE (edits / status updates): still goes through
          //    a single request that blocks on backend Dropbox after
          //    bytes flush. Keeps the 95→99 finalising creep so the
          //    bar doesn't park at 95% looking frozen.
          const itemsBefore = completed;
          const twoLane = isTwoLaneTargetType(item.targetType);
          // Throttle progress to ~10 Hz to avoid React re-render storms
          // that show as visible jitter on mobile.
          let lane1LastTs = 0;
          let lane2LastTs = 0;
          let finalizeTimer = null;
          const clearFinalizeTimer = () => {
            if (finalizeTimer != null) {
              clearInterval(finalizeTimer);
              finalizeTimer = null;
            }
          };
          const onLane1Bytes = (fraction) => {
            // Single-lane finalising creep — kept ONLY for the edit /
            // update branches that still block on backend Dropbox.
            // Two-lane items skip the creep because their lane 2 has
            // honest byte progress.
            if (!twoLane && fraction >= 1 && finalizeTimer == null) {
              const startTs = Date.now();
              finalizeTimer = setInterval(() => {
                const t = Math.min(1, (Date.now() - startTs) / 6000);
                const itemPct = 95 + Math.round(t * 4); // 95 → 99
                setCurrentItemPercent(itemPct);
                const overall = ((itemsBefore + 0.95 + t * 0.04) / total) * 100;
                setUploadProgress(Math.min(99, Math.round(overall)));
              }, 200);
              return;
            }
            const now = Date.now();
            if (fraction < 0.95 && now - lane1LastTs < 100) return;
            lane1LastTs = now;
            // For two-lane: let lane 1 go to 100% (it's the trivial
            // metadata POST — no backend stall to hide). For single-
            // lane: cap at 95% so the creep can take over.
            const ceiling = twoLane ? 1 : 0.95;
            const capped = Math.max(0, Math.min(ceiling, fraction));
            setCurrentItemPercent(Math.round(capped * 100));
            if (!twoLane) {
              const overall = ((itemsBefore + capped) / total) * 100;
              setUploadProgress(Math.min(99, Math.round(overall)));
            } else {
              // Two-lane overall — lane 1 contributes the first 20%,
              // lane 2 (which is where the bulk of the byte work is)
              // contributes the remaining 80%. Calibrated so the
              // overall bar doesn't jump from 0→50% on a tiny lane 1
              // metadata flush.
              const overall = ((itemsBefore + capped * 0.2) / total) * 100;
              setUploadProgress(Math.min(99, Math.round(overall)));
            }
          };
          const onLane2Bytes = (fraction) => {
            const now = Date.now();
            if (fraction < 0.95 && now - lane2LastTs < 100) return;
            lane2LastTs = now;
            const capped = Math.max(0, Math.min(1, fraction));
            setCurrentItemLane2Percent(Math.round(capped * 100));
            const overall = ((itemsBefore + 0.2 + capped * 0.8) / total) * 100;
            setUploadProgress(Math.min(99, Math.round(overall)));
          };
          // Reset both per-file readouts at the start of each item.
          setCurrentItemPercent(0);
          setCurrentItemLane2Percent(0);
          // Retry-after-lane-1-success: lane 1 already committed in a
          // previous pass, so show its bar at 100% from the start —
          // only lane 2 will visibly progress.
          if (item.lane === 'files') {
            setCurrentItemPercent(100);
          }
          // Mark this queue entry as the active uploader so FormsPanel's
          // Uploading tab can render a live progress bar on just this
          // row (and leave the rest showing "Queued").
          setActiveUploadItemId(item.id);

          if (twoLane) {
            // ════ TWO-LANE PATH ════════════════════════════════════════
            // Lane 1 — fast metadata POST; the backend creates the DB
            // row + linked ticket but DOESN'T touch Dropbox (we strip
            // the files). Returns in well under a second.
            //
            // Lane 2 — heavy files POST to /files; backend uploads
            // PDF + photos to Dropbox in parallel and patches the
            // record's pdf_url / photo_urls. Idempotent retries.
            //
            // The full payload (with files) stays in IDB across lanes,
            // so a tab close mid-lane-2 or a lane-2 failure never
            // loses the worker's bytes — next retry picks up where
            // we left off via `item.lane === 'files'`.
            let activePayload = item.payload || {};
            let recordId = item.recordId || null;

            if (item.lane !== 'files') {
              // ── Lane 1 ──
              let patched = activePayload;
              if (item.targetType !== 'hydroseed_daily') {
                // Lease sheets — allocate ticket number + render PDF
                // before lane 1 so the persisted payload carries them
                // for lane 2 even if the tab closes between lanes.
                patched = await ensurePdfAndTicket(item);
              }
              activePayload = patched;

              const lane1Body = stripFilesForLane1(item.targetType, patched);
              let lane1Endpoint;
              if (item.targetType === 'site') {
                lane1Endpoint = `/api/sites/${item.targetId}/spray`;
              } else if (item.targetType === 'pipeline') {
                lane1Endpoint = `/api/pipelines/${item.targetId}/spray`;
              } else if (item.targetType === 'external') {
                lane1Endpoint = `/api/external-lease-sheet`;
              } else {
                lane1Endpoint = `/api/hydroseed/dailies`;
              }

              let lane1Response;
              try {
                lane1Response = await requestWithUploadProgress(lane1Endpoint, {
                  method: 'POST',
                  body: lane1Body,
                  onProgress: onLane1Bytes,
                });
              } catch (err) {
                // External 409 — location already exists on the map.
                // Same surfacing as the old single-lane path.
                if (item.targetType === 'external' && err?.status === 409) {
                  clearFinalizeTimer();
                  const detail = err?.detail || {};
                  await alert({
                    title: 'Location already on map',
                    message: `This location already exists on the map (site #${detail.site_id || '?'}). Please select it from the Map tab.`,
                  });
                  await removeUploadEntry(item.id);
                  continue;
                }
                throw err;
              }

              recordId = lane1Response?.id || null;

              // Persist lane state + the patched payload (with the
              // freshly-allocated ticket_number + generated pdf_base64)
              // so a crash before lane 2 doesn't re-burn a ticket
              // number on retry.
              await updateUploadEntry(item.id, {
                lane: 'files',
                recordId,
                payload: activePayload,
              });

              // ── Refresh views NOW — the real record / ticket exists,
              //    so the worker should see their submit land immediately.
              //    pdf_url / photo_urls will fill in via delta-sync once
              //    lane 2 patches them on the server.
              if (item.targetType === 'site') {
                try {
                  let updated = await api.getSite(item.targetId);
                  if (patched.site_status === 'in_progress' && updated.status !== 'in_progress') {
                    updated = await api.updateSiteStatus(item.targetId, {
                      status: 'in_progress',
                      note: patched.notes || '',
                    });
                  }
                  setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
                  setSelectedSite((prev) => prev && prev.id === updated.id ? updated : prev);
                  await upsertSite(updated);
                } catch { /* non-fatal */ }
              } else if (item.targetType === 'pipeline') {
                try {
                  const updatedPipeline = await api.getPipeline(item.targetId);
                  setPipelines((prev) => prev.map((p) => (p.id === updatedPipeline.id ? updatedPipeline : p)));
                  setSelectedPipeline((prev) => {
                    if (prev && prev.id === updatedPipeline.id) {
                      setPipelineSprayRecords(updatedPipeline.spray_records || []);
                      return updatedPipeline;
                    }
                    return prev;
                  });
                } catch { /* non-fatal */ }
              } else if (item.targetType === 'hydroseed_daily') {
                setDraftsRefreshToken((x) => x + 1);
                setHydroseedRefreshToken((x) => x + 1);
                setHydroseedDailiesRefreshToken((x) => x + 1);
              }
              if (bumpsTm) setTmRefreshToken((x) => x + 1);
            }

            // ── Lane 2 ── (always runs once lane 1 has succeeded; on
            // retry-after-lane-1-success we skip lane 1 and come
            // straight here).
            if (recordId) {
              const rawLane2Body = buildLane2Payload(item.targetType, activePayload);
              if (rawLane2Body) {
                const lane2Endpoint = lane2EndpointFor(item.targetType, recordId);
                if (lane2Endpoint) {
                  // Compress photos client-side before the network round-trip.
                  // Full-res phone shots are 3-5 MB each; resizing to 1600px
                  // longest-edge at q=0.78 cuts them to ~300-600 KB with no
                  // visible quality loss on a lease sheet. Falls back silently
                  // to the original bytes on any canvas error.
                  const lane2Body = await compressLane2Photos(item.targetType, rawLane2Body);
                  const lane2Response = await requestWithUploadProgress(lane2Endpoint, {
                    method: 'POST',
                    body: lane2Body,
                    onProgress: onLane2Bytes,
                  });
                  // Cache the Dropbox PDF URL → we already have the base64 in
                  // activePayload (pdf_base64). Storing it now means the next
                  // "Preview PDF" tap on this record is an instant IDB hit
                  // instead of a Dropbox proxy round-trip.
                  const pdfUrlFromLane2 = lane2Response?.pdf_url;
                  if (pdfUrlFromLane2 && rawLane2Body?.pdf_base64) {
                    try { putCachedPdf(`url:${pdfUrlFromLane2}`, rawLane2Body.pdf_base64); } catch { /* non-fatal */ }
                  }
                }
              }
              // Lane 2 done — refresh the site so pdf_url / photo_urls
              // appear immediately in Spray History without waiting for
              // the next delta-sync tick (which may be up to 30 s away).
              if (item.targetType === 'site') {
                try {
                  const fresh = await api.getSite(item.targetId);
                  setSites((prev) => prev.map((s) => (s.id === fresh.id ? fresh : s)));
                  setSelectedSite((prev) => (prev && prev.id === fresh.id ? fresh : prev));
                  await upsertSite(fresh);
                } catch { /* non-fatal */ }
              } else if (item.targetType === 'pipeline') {
                try {
                  const fresh = await api.getPipeline(item.targetId);
                  setPipelines((prev) => prev.map((p) => (p.id === fresh.id ? fresh : p)));
                  setSelectedPipeline((prev) => {
                    if (prev && prev.id === fresh.id) {
                      setPipelineSprayRecords(fresh.spray_records || []);
                      return fresh;
                    }
                    return prev;
                  });
                } catch { /* non-fatal */ }
              }
            }
          } else if (item.targetType === 'site_spray_edit') {
            // Fix #2 — offline-queued lease-sheet edits. Mirrors the create
            // path but uses the PATCH endpoint. Edit payloads always carry
            // an existing ticket number (from the record being edited),
            // so we don't need to call ensurePdfAndTicket — the form
            // already produced a fresh PDF when the worker hit Save.
            await requestWithUploadProgress(`/api/site-spray-records/${item.targetId}`, {
              method: 'PATCH',
              body: item.payload,
              onProgress: onLane1Bytes,
            });
            try {
              const siteId = item.payload?.site_id || 0;
              if (Number.isInteger(siteId) && siteId > 0) {
                const updated = await api.getSite(siteId);
                if (updated && updated.id) {
                  setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
                  await upsertSite(updated);
                }
              }
            } catch { /* non-fatal */ }
            // Bump the T&M token (edits cascade to T&M rows). The recents
            // list refreshes automatically on the next poll tick — no
            // need to spend an extra round-trip here.
            setTmRefreshToken((x) => x + 1);
          } else if (item.targetType === 'tm_ticket') {
            // Worker "Mark as pending" on a T&M ticket. We queue instead of
            // awaiting so the worker doesn't sit on a spinner while the
            // backend talks to Dropbox for the PDF. Payload is the full
            // updateTMTicket body (description_of_work, office_data,
            // status: 'submitted', pdf_base64, and — for office/admin —
            // po_approval_number and row_updates).
            await requestWithUploadProgress(`/api/time-materials/${item.targetId}`, {
              method: 'PATCH',
              body: item.payload,
              onProgress: onLane1Bytes,
            });
            // Nudge FormsPanel to immediately delta-sync its ticket cache.
            // Without this, the worker would see the just-submitted ticket
            // stuck in "Open Tickets" for up to 5 minutes until the next
            // poll tick — visually the row appears in both Open Tickets
            // AND Recently Submitted because the local status is stale.
            // Bumping the token causes an instant `/api/time-materials/delta`
            // call which overwrites the cached row with status='submitted'.
            setTmRefreshToken((x) => x + 1);
          } else if (item.targetType === 'hydroseed_daily_edit') {
            // Edit of an existing HD###### record. PATCH to the same
            // endpoint structure as the lease-sheet `site_spray_edit`
            // branch above.
            await requestWithUploadProgress(`/api/hydroseed/dailies/${item.targetId}`, {
              method: 'PATCH',
              body: item.payload,
              onProgress: onLane1Bytes,
            });
            setDraftsRefreshToken((x) => x + 1);
          } else if (item.targetType === 'hydroseed_ticket_update') {
            // HT ticket office save / approve. Payload mirrors
            // HydroseedTicketUpdate (office_data, description, etc.).
            await requestWithUploadProgress(`/api/hydroseed/tickets/${item.targetId}`, {
              method: 'PATCH',
              body: item.payload,
              onProgress: onLane1Bytes,
            });
            setDraftsRefreshToken((x) => x + 1);
          }
          // Response arrived — stop the finalising creep before we set
          // 100%, otherwise the next interval tick would briefly drag
          // the bar back to 95-99% after the success bump.
          clearFinalizeTimer();
          await removeUploadEntry(item.id);
          completed++;
          setUploadCompleted(completed);
          setUploadProgress(Math.round((completed / total) * 100));
          // Item finished — show 100% briefly on the per-file readout
          // before the next iteration resets it back to 0%. Without this
          // the bar would jump from 95% (during upload) straight to the
          // next file's 0%, hiding the "this file is done" beat.
          setCurrentItemPercent(100);
          setCurrentItemLane2Percent(100);
        } catch (err) {
          // Always stop the finalising creep on any error path so the
          // bar doesn't keep drifting while we surface the failure or
          // sit on a dialog. Cheap no-op if the timer never started.
          clearFinalizeTimer();
          // ── Auth failure: try a one-shot session refresh ─────────────
          // 401/403 typically means the access token expired. Supabase's
          // auto-refresh covers most cases, but if the queue picked up
          // an item between the token's expiry and the SDK's refresh
          // call we hit this branch. Try `refreshSession()` once before
          // giving up; on success keep the queue moving (subsequent
          // items use the fresh token automatically because
          // `requestWithUploadProgress` reads from the current session
          // on every call). The failed item itself isn't retried this
          // pass — it'll come around on the next poll tick or the
          // SIGNED_IN/TOKEN_REFRESHED kick — and we deliberately do NOT
          // bump its attempts counter because the failure was
          // recoverable, not a payload problem.
          if (err?.status === 401 || err?.status === 403) {
            try {
              const { data, error } = await supabase.auth.refreshSession();
              if (!error && data?.session) {
                console.info('[UPLOAD_QUEUE] Session refreshed after', err.status, '— continuing with next item');
                continue;
              }
            } catch { /* fall through to break */ }
            console.warn('[UPLOAD_QUEUE] Auth failed (', err.status, ') and refresh failed — pausing queue until next cycle');
            break;
          }
          // ── Validation failure: permanent ─────────────────────────────
          // 400 / 422 means the payload will never be accepted as-is
          // (missing required field, malformed value, schema mismatch).
          // Retrying MAX_ATTEMPTS times before stalling wastes worker
          // bandwidth and delays surfacing the broken item in the
          // Uploading list. Flip to 'stalled' immediately.
          if (err?.status === 400 || err?.status === 422) {
            try {
              await updateUploadEntry(item.id, {
                attempts: (item.attempts || 0) + 1,
                lastErrorStatus: err.status,
                lastErrorMessage: String(err?.message || err).slice(0, 200),
                status: 'stalled',
              });
            } catch { /* non-fatal */ }
            console.warn('[UPLOAD_QUEUE] Permanent failure (', err.status, ') on item', item.id, ':', err?.message || err);
            continue;
          }
          // ── Transient failure: track attempts, ramp to stalled ────────
          // Persistent 5xx, network flakes, etc. After MAX_ATTEMPTS we
          // flip the item to 'stalled' (see skip-check above) — it
          // stays in IDB so the worker can still see it in their
          // Uploading list, but we stop auto-retrying. Short error
          // messages only so we don't bloat IDB with huge payload dumps
          // on 5xx HTML bodies.
          //
          // 10 attempts × 2-min poll interval = ~20 min of wall-clock
          // retrying before we mark the item stalled. Was previously 5
          // (~10 min), which was punishing slow-cellular workers whose
          // pre-upload calls (getNextTicket, etc.) routinely timed out
          // on a single round-trip — once the queue burned through 5
          // setup-phase timeouts, items got stuck stalled even though
          // the network would have eventually worked. Worker can still
          // hit the manual-refresh button to un-stall everything; this
          // just gives a generous default before they have to.
          const MAX_ATTEMPTS = 10;
          const attempts = (item.attempts || 0) + 1;
          try {
            await updateUploadEntry(item.id, {
              attempts,
              lastErrorStatus: err?.status || null,
              lastErrorMessage: String(err?.message || err).slice(0, 200),
              status: attempts >= MAX_ATTEMPTS ? 'stalled' : 'pending',
            });
          } catch { /* non-fatal: worst case we retry one extra time */ }
          console.warn('[UPLOAD_QUEUE] Upload failed (item', item.id, ', attempt', attempts + '/' + MAX_ATTEMPTS + '):', err?.message || err);
        }
      }
    } finally {
      uploadingRef.current = false;
      setIsUploading(false);
      setUploadProgress(0);
      setUploadTotal(0);
      setUploadCompleted(0);
      setCurrentItemPercent(0);
      setCurrentItemLane2Percent(0);
      setActiveUploadItemId(null);
      await refreshUploadQueue();
    }
  }, [refreshUploadQueue, ensurePdfAndTicket]);

  const syncQueuedActions = useCallback(async () => {
    if (!window.navigator.onLine) {
      return;
    }

    const queuedActions = await refreshQueueCount();
    for (const action of queuedActions.sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      if (action.type === 'create_site') {
        await api.createSite(action.payload);
      }
      if (action.type === 'update_status' && Number.isInteger(action.payload.siteId)) {
        await api.updateSiteStatus(action.payload.siteId, action.payload.body);
      }
      await removeQueuedAction(action.id);
    }
    await refreshQueueCount();
    // Also process upload queue
    await processUploadQueue();
  }, [refreshQueueCount, processUploadQueue]);

  const refreshAllData = useCallback(async () => {
    setIsLoading(true);
    setMessage('Loading...');

    try {
      // Load ALL cached data from IndexedDB in parallel for instant display
      await Promise.all([
        loadCachedSites(),
        loadCachedPipelines(),
        loadCachedRecents(),
        loadCachedLookups(),
        loadCachedUsers(),
      ]);
      setIsLoading(false); // Show app immediately with cached data

      // Then sync with server in background if online (non-blocking)
      if (window.navigator.onLine) {
        try {
          await Promise.all([
            loadServerSites(),
            loadServerRecents(),
            loadServerLookups(),
            loadServerUsers(),
            loadDevices(),
            loadPipelines(),
            loadPendingPipelines(),
            loadDeletedPipelines(),
            loadDeletedLeaseSheets(),
            loadDeletedTMTickets(),
            loadDeletedHydroseedDailies(),
            loadDeletedHydroseedTickets(),
            loadDeletedQuotes(),
          ]);

          // Seed delta-sync watermarks from sync-status RIGHT AFTER the full
          // load. The 2-min poll loop immediately uses the cheap
          // /api/*/delta endpoints — and the very first poll tick won't
          // re-download the same data we just fetched unless something has
          // actually changed. We ALSO persist the watermarks to IndexedDB
          // so the next browser reload can skip the full fetches entirely
          // and go straight to delta polling (hydrate-from-cache).
          try {
            const initial = await api.getSyncStatus();
            lastSyncStatusRef.current = initial;
            sitesSinceRef.current = initial.sites_last_updated || null;
            pipelinesSinceRef.current = initial.pipelines_last_updated || null;
            recentsSinceRef.current = initial.spray_records_last_updated || null;
            // Seed the count state right away so the topbar Pending badge
            // renders correctly without waiting for the dedicated
            // /api/pending-sites + /api/pending-pipelines fetches below.
            if (initial.pending_sites_count != null) setPendingSitesCount(initial.pending_sites_count);
            if (initial.pending_pipelines_count != null) setPendingPipelinesCount(initial.pending_pipelines_count);
            await setWatermarks({
              sites: sitesSinceRef.current,
              pipelines: pipelinesSinceRef.current,
              recents: recentsSinceRef.current,
              pending_sites_count: initial.pending_sites_count ?? null,
              pending_pipelines_count: initial.pending_pipelines_count ?? null,
            });
          } catch {
            // If sync-status fails, leave watermarks null — the poll loop
            // will fall back to full fetches, which is safe.
          }

          setMessage('Synced with server');
        } catch (error) {
          setMessage('Using cached data');
        }
      } else {
        setMessage('Offline mode');
      }
    } catch (error) {
      // Even if cache fails, show the app
      setIsLoading(false);
      setMessage('Ready');
    }
  }, [loadCachedSites, loadCachedPipelines, loadCachedRecents, loadCachedLookups, loadCachedUsers,
      loadServerSites, loadServerRecents, loadServerLookups, loadServerUsers, loadDevices,
      loadPipelines, loadPendingPipelines, loadDeletedPipelines,
      loadDeletedLeaseSheets, loadDeletedTMTickets,
      loadDeletedHydroseedDailies, loadDeletedHydroseedTickets]);

  // ── Boot hydration: hydrate-from-cache fast path ──────────────────────────
  // On first mount we used to unconditionally call refreshAllData(), which
  // redownloads the entire sites / pipelines / recents lists on every browser
  // refresh. That's the single biggest egress cost at scale (20 workers ×
  // ~10 reloads/day).
  //
  // This wrapper instead:
  //   1. Loads cached data + stored watermarks from IndexedDB.
  //   2. If all three caches are non-empty AND the stored watermark is fresh
  //      (< 24 h), seeds state + refs from the cache and SKIPS the initial
  //      full fetch. The 2-min poll tick picks up any true deltas.
  //   3. Otherwise falls through to the original full refreshAllData() path.
  //
  // Lookups / users / pending counts / deleted pipelines are still fetched
  // fresh — they're tiny and outside the delta pipeline.
  const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 h
  const bootHydrate = useCallback(async () => {
    try {
      const [cachedSites, cachedPipelines, cachedRecentsList, watermarks] = await Promise.all([
        getSites(),
        getPipelines(),
        getRecents(),
        getWatermarks(),
      ]);

      const now = Date.now();
      const storedAt = watermarks?.stored_at ? new Date(watermarks.stored_at).getTime() : 0;
      const cacheFresh = storedAt > 0 && (now - storedAt) < CACHE_MAX_AGE_MS;
      const haveAllCaches =
        cachedSites.length > 0 &&
        cachedPipelines.length > 0 &&
        cachedRecentsList.length > 0;
      const haveAllWatermarks =
        !!(watermarks?.sites && watermarks?.pipelines && watermarks?.recents);

      if (cacheFresh && haveAllCaches && haveAllWatermarks && window.navigator.onLine) {
        // ── Fast path: hydrate from cache, skip the full fetch ──
        setIsLoading(true);
        setMessage('Loading…');
        await Promise.all([
          loadCachedSites(),
          loadCachedPipelines(),
          loadCachedRecents(),
          loadCachedLookups(),
          loadCachedUsers(),
        ]);
        // Seed the poll loop's refs from the persisted watermarks so the
        // very next poll tick uses /api/*/delta instead of re-downloading.
        sitesSinceRef.current = watermarks.sites;
        pipelinesSinceRef.current = watermarks.pipelines;
        recentsSinceRef.current = watermarks.recents;
        lastSyncStatusRef.current = {
          sites_last_updated: watermarks.sites,
          pipelines_last_updated: watermarks.pipelines,
          spray_records_last_updated: watermarks.recents,
          pending_sites_count: watermarks.pending_sites_count ?? undefined,
          pending_pipelines_count: watermarks.pending_pipelines_count ?? undefined,
        };
        // Seed the topbar Pending badge from cache so admins see the right
        // number the moment the app paints, instead of a 1-second flicker
        // while /api/pending-sites is still in flight. The first delta
        // poll will overwrite this with the live count.
        if (watermarks.pending_sites_count != null) setPendingSitesCount(watermarks.pending_sites_count);
        if (watermarks.pending_pipelines_count != null) setPendingPipelinesCount(watermarks.pending_pipelines_count);

        setIsLoading(false);
        setMessage('Loaded from cache');

        // Still refresh the non-delta-tracked bits in the background so
        // the admin pending counts + lookups don't go stale silently.
        // Lookups get a 6-hour TTL: skip the server re-fetch when the
        // IndexedDB cache is fresh. Admin edits bypass this by calling
        // `loadServerLookups()` directly via `onLookupsChanged`.
        const LOOKUPS_TTL_MS = 6 * 60 * 60 * 1000;
        let lookupsStale = true;
        try {
          lookupsStale = (await getLookupsMaxAgeMs()) >= LOOKUPS_TTL_MS;
        } catch { /* treat as stale on error */ }
        void (async () => {
          try {
            await Promise.all([
              lookupsStale ? loadServerLookups() : Promise.resolve(),
              loadServerUsers(),
              loadDevices(),
              loadPendingSites(),
              loadPendingPipelines(),
              loadDeletedPipelines(),
            ]);
          } catch { /* non-fatal */ }
        })();

        return true; // tell caller we used the fast path
      }
    } catch {
      // Any cache read error → fall through to refreshAllData.
    }
    // Slow path: cold cache, stale cache, or offline → original behaviour.
    await refreshAllData();
    return false;
  }, [refreshAllData, loadCachedSites, loadCachedPipelines, loadCachedRecents,
      loadCachedLookups, loadCachedUsers, loadServerLookups, loadServerUsers,
      loadPendingSites, loadPendingPipelines, loadDeletedPipelines]);

  // Manual Refresh button handler. Always does the full path + queue resync
  // so "↻ Refresh" next to the Online indicator feels like a hard reset.
  //
  // Real-world scenario this also covers: worker had bad 5G, the queue
  // burned through MAX_ATTEMPTS retries on timeouts/network errors and
  // every item flipped to `status: 'stalled'`. The auto-retry path
  // (`processUploadQueue`) skips stalled items at the top of its loop,
  // so even after the worker reaches good Wi-Fi the queue sits there
  // doing nothing. The manual refresh button is the explicit user
  // signal to "try again now" — so we:
  //   1. Re-queue every TRANSIENTLY-stalled item (network errors,
  //      timeouts, 5xx) by flipping status back to 'pending' and
  //      zeroing attempts. We deliberately leave 400/422 stalls alone
  //      because those payloads are structurally broken and retrying
  //      will just re-stall them on the same error.
  //   2. Kick `processUploadQueue()` so the freshly-pending items run
  //      immediately, instead of waiting for the next poll tick.
  const handleManualRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refreshAllData();
      await refreshQueueCount();

      // ── Un-stall transient queue failures so the upload loop will
      //    pick them up again. Validation stalls (400/422) stay
      //    stalled — only the user can fix those by editing the
      //    record, and a bulk reset would just churn bandwidth.
      try {
        const items = await getUploadQueue();
        const transientlyStalled = items.filter(
          (it) => it.status === 'stalled'
            && it.lastErrorStatus !== 400
            && it.lastErrorStatus !== 422,
        );
        if (transientlyStalled.length > 0) {
          await Promise.all(transientlyStalled.map((it) =>
            updateUploadEntry(it.id, { status: 'pending', attempts: 0 })
          ));
          console.info('[UPLOAD_QUEUE] Manual refresh re-queued',
            transientlyStalled.length, 'stalled item(s) for retry.');
        }
      } catch (e) {
        console.warn('[UPLOAD_QUEUE] Re-queue on manual refresh failed (non-fatal):', e?.message || e);
      }

      await refreshUploadQueue();

      // Kick the queue. processUploadQueue is a no-op if already
      // uploading or if navigator.onLine is false, so this is safe to
      // call unconditionally.
      try { processUploadQueueRef.current?.(); } catch { /* non-fatal */ }
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, refreshAllData, refreshQueueCount, refreshUploadQueue]);

  // ── Per-item Retry / Discard from the Uploading tab ─────────────
  // FormsPanel renders a Retry + Discard button on every stalled
  // queue row. Both handlers route through here so we keep the
  // IndexedDB writes + queue-list refresh + processUploadQueue kick
  // in a single place; FormsPanel only ever sees the result via the
  // re-fetched `uploadQueue` prop.
  const handleRetryQueueItem = useCallback(async (itemId) => {
    if (!itemId) return;
    try {
      await updateUploadEntry(itemId, { status: 'pending', attempts: 0 });
    } catch (e) {
      console.warn('[UPLOAD_QUEUE] Retry failed to update entry:', e?.message || e);
      return;
    }
    await refreshUploadQueue();
    try { processUploadQueueRef.current?.(); } catch { /* non-fatal */ }
  }, [refreshUploadQueue]);

  const handleDiscardQueueItem = useCallback(async (itemId) => {
    if (!itemId) return;
    const ok = await confirm({
      title: 'Discard this upload?',
      message: (
        'This permanently removes the item from the upload queue. ' +
        'If the lease sheet has already been re-submitted by another ' +
        'route this is safe; otherwise, the data will be lost.'
      ),
      severity: 'danger',
      okLabel: 'Discard',
    });
    if (!ok) return;
    try {
      await removeUploadEntry(itemId);
    } catch (e) {
      console.warn('[UPLOAD_QUEUE] Discard failed:', e?.message || e);
      return;
    }
    await refreshUploadQueue();
    await refreshQueueCount();
  }, [confirm, refreshUploadQueue, refreshQueueCount]);

  // Ref-mirror of processUploadQueue so the auth-state-change listener
  // (whose useEffect runs once with [] deps) can call the latest version
  // without re-subscribing every time the callback identity updates. Used
  // for the SIGNED_IN / TOKEN_REFRESHED queue-drain trigger.
  const processUploadQueueRef = useRef(processUploadQueue);
  useEffect(() => {
    processUploadQueueRef.current = processUploadQueue;
  }, [processUploadQueue]);

  useEffect(() => {
    let mounted = true;
    
    const initAuth = async () => {
      try {
        const result = onAuthStateChange((event, authSession) => {
          if (mounted) {
            setSession(authSession);
            setUser(authSession?.user || null);
            setIsAuthLoading(false);
            
            if (authSession?.access_token) {
              localStorage.setItem('supabase-access-token', authSession.access_token);
            } else {
              localStorage.removeItem('supabase-access-token');
            }

            // Drain the upload queue when we get a fresh token. Covers
            // two cases that previously left items stuck for up to 5 min
            // (the next poll tick) before retry:
            //   • SIGNED_IN — worker logs back in after a sign-out
            //   • TOKEN_REFRESHED — Supabase auto-refresh succeeded
            //     (e.g. after the in-loop refresh in processUploadQueue
            //     above), so any remaining queue items can now go.
            if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && window.navigator.onLine) {
              try { processUploadQueueRef.current?.(); } catch { /* non-fatal */ }
            }
          }
        });
        
        // If onAuthStateChange returns null (Supabase not configured), set loading to false
        if (!result) {
          if (mounted) {
            setIsAuthLoading(false);
          }
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
        if (mounted) {
          setIsAuthLoading(false);
        }
      }
    };
    
    initAuth();
    
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // ── End-of-day auto sign-out for worker accounts ───────────────────────
  // Workers must sign in fresh each calendar day so they're never operating
  // under another teammate's session left over from a shared device. We
  // record the local date on every authenticated render and sign the worker
  // out as soon as the local calendar day rolls over (or if a stale session
  // from a previous day is detected on app load). Admin/office accounts are
  // exempt — they routinely keep long-lived sessions on office machines.
  useEffect(() => {
    if (!user) return;
    if (userRole !== 'worker') return;
    const KEY = 'pv:workerSignInDay';
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local tz
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch { /* ignore */ }
    if (!stored) {
      try { localStorage.setItem(KEY, today); } catch { /* ignore */ }
      stored = today;
    }
    const checkRollover = () => {
      const now = new Date().toLocaleDateString('en-CA');
      let last = today;
      try { last = localStorage.getItem(KEY) || today; } catch { /* ignore */ }
      if (last && last !== now) {
        try { localStorage.removeItem(KEY); } catch { /* ignore */ }
        signOut().catch(() => { /* non-fatal */ });
      }
    };
    if (stored !== today) {
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
      signOut().catch(() => { /* non-fatal */ });
      return;
    }
    const interval = window.setInterval(checkRollover, 60_000);
    const onVisible = () => { if (!document.hidden) checkRollover(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, userRole]);

  useEffect(() => {
    void refreshQueueCount();
    void refreshUploadQueue().then(() => {
      // Process any pending uploads from previous session
      if (window.navigator.onLine) processUploadQueue();
    });
    // Use the smart boot path: hydrate from cache when possible, otherwise
    // fall back to a full server fetch. See bootHydrate above.
    void bootHydrate();

    // ── Debug helpers for upload queue (dev only) ──
    // Previously attached unconditionally, which meant any production
    // user could open devtools and dump queue contents (which include
    // site notes, customer names, photo payloads). Gate behind
    // `import.meta.env.DEV` so the globals only exist during `vite dev`.
    if (import.meta.env.DEV) {
      window.debugQueue = async () => {
        const items = await getUploadQueue();
        console.log('[UPLOAD_QUEUE] Items in queue:', items);
        return items;
      };
      window.clearQueue = async () => {
        const items = await getUploadQueue();
        for (const item of items) {
          await removeUploadEntry(item.id);
        }
        console.log('[UPLOAD_QUEUE] Cleared all items:', items);
        await refreshUploadQueue();
      };
    }
  }, [bootHydrate, refreshQueueCount, refreshUploadQueue, processUploadQueue]);

  // Ref wired up by the auto-poll useEffect below. Lets the back-online
  // handler reuse the same delta-poll logic without duplicating it or pulling
  // the full site/pipeline lists on every wifi-to-cell handoff in the field.
  const runPollTickRef = useRef(null);
  // Mirrors of selectedSite / selectedPipeline so the long-lived Realtime
  // subscription useEffect can react to events on the currently-open pin
  // without re-subscribing every time the user opens or closes a different
  // one. Updated by tiny mirror effects below.
  const selectedSiteRef = useRef(null);
  const selectedPipelineRef = useRef(null);
  // Flips to true the first time loadPendingSites() / loadPendingPipelines()
  // comes back from the server with an authoritative list. From that moment
  // on the derivation effect below keeps `pendingSitesCount` locked to
  // `pendingSites.length`, so any local mutation (realtime push, admin
  // delete from the site sheet, approve / reject, restore, …) updates the
  // topbar "Pending: N" badge in the same React tick as the card vanishes.
  // Until loaded we leave the count alone so the cached seed value from
  // /api/sync-status renders instantly on cold start (vs flickering to 0
  // while the list fetch is in flight).
  const pendingSitesLoadedRef = useRef(false);
  const pendingPipelinesLoadedRef = useRef(false);

  // Stable callback children can invoke to force an immediate delta sync
  // (sync-status check + any dependent deltas). Used by FormsPanel when
  // the user opens Recently Submitted so newly uploaded lease sheets show
  // up without waiting for the 5-minute poll cycle. Cheap: sync-status is
  // ~100B and the deltas only fire for resources that actually changed.
  const handleRequestSync = useCallback(() => {
    try { runPollTickRef.current?.(); } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    if (!isOnline) {
      wasOnline.current = false;
      return;
    }
    if (wasOnline.current) {
      return;
    }
    wasOnline.current = true;
    void (async () => {
      setIsSyncing(true);
      try {
        await syncQueuedActions();
        // Prefer a cheap delta tick when watermarks are fresh. Field workers
        // flip online/offline often (truck → yard → truck), and refetching
        // the full sites+pipelines list on every flip was a major egress
        // hit. Cold cache (no watermark) still falls back to refreshAllData.
        const haveWatermark = !!(sitesSinceRef.current && pipelinesSinceRef.current);
        if (haveWatermark && runPollTickRef.current) {
          await runPollTickRef.current();
        } else {
          await refreshAllData();
        }
      } catch (error) {
        setMessage(error.message || 'Automatic sync failed.');
      } finally {
        setIsSyncing(false);
      }
    })();
  }, [isOnline, refreshAllData, syncQueuedActions]);

  // ── Auto-poll for real-time updates ──
  // Strategy:
  //   1. Every 2 min, call /api/sync-status (tiny — just a few timestamps).
  //      A manual "Refresh" button in the top bar lets users force an
  //      immediate full sync whenever they expect a fresh change.
  //   2. When a resource's max-timestamp bumps, fetch ONLY what changed via
  //      /api/<resource>/delta?since=<watermark>, not the full list.
  //   3. Merge `items` into state + IndexedDB, drop `ids_removed`. A typical
  //      delta is 0-3 rows instead of hundreds → ~100× less egress.
  //   4. If delta fails or no watermark yet, fall back to the full list.
  //   5. Skip the tick while the tab is hidden; re-run on visibility change.
  useEffect(() => {
    if (!isOnline) return;

    // Adaptive poll cadence:
    //   - Realtime connected  → 5 min. The WebSocket pushes row changes
    //                           instantly; polling is only a safety net
    //                           for things Realtime can't deliver (e.g.
    //                           sync-status aggregates) so 5 min is plenty.
    //   - Realtime disconnected → 60 s. Realtime is the primary push;
    //                           when it's broken we compensate by polling
    //                           faster so the field worker still sees
    //                           new approvals / deletes within a minute.
    // On visibility change the interval is paused entirely while the tab
    // is hidden, and a one-shot catch-up tick runs on visibility return.
    const POLL_MS = realtimeStatus === 'connected' ? 300000 : 60000;

    // ── Delta merge helpers ────────────────────────────────────────────────
    // Each is defined inline so it closes over the latest setState setters
    // without needing to live outside the effect. They update both React
    // state (instant UI) and IndexedDB (offline persistence).

    async function syncSitesIncrementally(syncStatus) {
      // Merge helper: /api/sites and /api/sites/delta ship the slim
      // SiteListRead schema (no spray_records / updates / raw_attributes /
      // nested users — egress saver). We spread-merge so any heavy fields
      // previously hydrated by handleOpenDetail's /api/sites/{id} call are
      // preserved across delta ticks. Keys omitted by the incoming payload
      // simply keep their existing value.
      const mergeSite = (existing, incoming) => (existing ? { ...existing, ...incoming } : incoming);
      const mergeFullSiteList = (prev, full) => {
        const byId = new Map(prev.map((s) => [siteIdentityKey(s), s]));
        return full.map((item) => mergeSite(byId.get(siteIdentityKey(item)), item));
      };

      // No watermark yet → do a full fetch, which also seeds the watermark
      // for future delta calls.
      if (!sitesSinceRef.current) {
        try {
          const full = await api.listSites(serverFilters);
          setSites((prev) => mergeFullSiteList(prev, full));
          await replaceSites(full);
          if (selectedSite && Number.isInteger(selectedSite.id)) {
            const updated = full.find((s) => matchSiteIdentity(s, selectedSite));
            if (updated) setSelectedSite((prev) => mergeSite(prev, updated));
          }
          sitesSinceRef.current = syncStatus.sites_last_updated || new Date().toISOString();
        } catch { /* silently fail */ }
        return;
      }

      try {
        const delta = await api.sitesDelta(sitesSinceRef.current);
        const items = Array.isArray(delta?.items) ? delta.items : [];
        const idsRemoved = Array.isArray(delta?.ids_removed) ? delta.ids_removed : [];

        if (items.length > 0 || idsRemoved.length > 0) {
          // Merge into React state (upsert by id, drop removed). Spread-merge
          // preserves heavy fields (spray_records, updates, ...) that the
          // slim delta schema doesn't ship.
          setSites((prev) => {
            const byId = new Map(prev.map((s) => [siteIdentityKey(s), s]));
            for (const item of items) byId.set(siteIdentityKey(item), mergeSite(byId.get(siteIdentityKey(item)), item));
            for (const id of idsRemoved) byId.delete(siteIdentityKey(id));
            return Array.from(byId.values());
          });

          // Keep the currently-viewed site in sync when the delta includes it.
          if (selectedSite && Number.isInteger(selectedSite.id)) {
            const hit = items.find((s) => matchSiteIdentity(s, selectedSite));
            if (hit) setSelectedSite((prev) => mergeSite(prev, hit));
          }

          // Persist to IndexedDB. We store the slim delta item as-is; the
          // heavy fields live in the in-memory state only and are refreshed
          // via /api/sites/{id} whenever the user opens a detail view.
          for (const item of items) await upsertSite(item);
          for (const id of idsRemoved) await removeSite({ id });
        }

        sitesSinceRef.current = delta.server_time || sitesSinceRef.current;
      } catch {
        // Delta failed — fall back to a full fetch and re-seed the watermark.
        try {
          const full = await api.listSites(serverFilters);
          setSites((prev) => mergeFullSiteList(prev, full));
          await replaceSites(full);
          if (selectedSite && Number.isInteger(selectedSite.id)) {
            const updated = full.find((s) => matchSiteIdentity(s, selectedSite));
            if (updated) setSelectedSite((prev) => mergeSite(prev, updated));
          }
          sitesSinceRef.current = syncStatus.sites_last_updated || new Date().toISOString();
        } catch { /* silently fail */ }
      }
    }

    async function syncPipelinesIncrementally(syncStatus) {
      if (!pipelinesSinceRef.current) {
        try {
          const full = await api.listPipelines();
          setPipelines(full);
          await replacePipelines(full);
          pipelinesSinceRef.current = syncStatus.pipelines_last_updated || new Date().toISOString();
        } catch { /* silently fail */ }
        return;
      }

      try {
        const delta = await api.pipelinesDelta(pipelinesSinceRef.current);
        const items = Array.isArray(delta?.items) ? delta.items : [];
        const idsRemoved = Array.isArray(delta?.ids_removed) ? delta.ids_removed : [];

        if (items.length > 0 || idsRemoved.length > 0) {
          setPipelines((prev) => {
            const byId = new Map(prev.map((p) => [p.id, p]));
            for (const item of items) byId.set(item.id, item);
            for (const id of idsRemoved) byId.delete(id);
            return Array.from(byId.values());
          });
          // Persist to IndexedDB so next reload can hydrate-from-cache.
          for (const item of items) await upsertPipeline(item);
          for (const id of idsRemoved) await removePipeline(id);
        }

        pipelinesSinceRef.current = delta.server_time || pipelinesSinceRef.current;
      } catch {
        try {
          const full = await api.listPipelines();
          setPipelines(full);
          await replacePipelines(full);
          pipelinesSinceRef.current = syncStatus.pipelines_last_updated || new Date().toISOString();
        } catch { /* silently fail */ }
      }
    }

    async function syncRecentsIncrementally(syncStatus) {
      if (!recentsSinceRef.current) {
        try {
          // Cold incremental sync (no watermark yet) — same 100-row history
          // window as the dedicated full-refresh path so users always get a
          // useful chunk of past lease sheets without paging.
          const full = await api.listRecentSubmissions({ limit: 100 });
          setCachedRecents(full);
          await replaceRecents(full);
          recentsSinceRef.current = syncStatus.spray_records_last_updated || new Date().toISOString();
        } catch { /* silently fail */ }
        return;
      }

      try {
        const delta = await api.recentSubmissionsDelta(recentsSinceRef.current);
        const items = Array.isArray(delta?.items) ? delta.items : [];
        const idsRemoved = Array.isArray(delta?.ids_removed) ? delta.ids_removed : [];

        if (items.length > 0 || idsRemoved.length > 0) {
          // Prepend new items, dedupe by id, keep the list bounded.
          setCachedRecents((prev) => {
            const byId = new Map();
            for (const item of items) byId.set(item.id, item);
            for (const row of prev) if (!byId.has(row.id)) byId.set(row.id, row);
            // Drop soft-deleted IDs
            for (const id of idsRemoved) byId.delete(id);
            return Array.from(byId.values())
              .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
          });
          for (const item of items) await upsertRecent(item);
          // Remove deleted items from IndexedDB
          for (const id of idsRemoved) await removeRecentById(id);
        }

        recentsSinceRef.current = delta.server_time || recentsSinceRef.current;
      } catch {
        try {
          // Delta sync errored — fall back to a fresh 100-row pull rather than
          // leaving the cache stale.
          const full = await api.listRecentSubmissions({ limit: 100 });
          setCachedRecents(full);
          await replaceRecents(full);
          recentsSinceRef.current = syncStatus.spray_records_last_updated || new Date().toISOString();
        } catch { /* silently fail */ }
      }
    }

    const runPollTick = async () => {
      // Don't poll while the document is hidden — huge bandwidth saver on mobile.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      try {
        const syncStatus = await api.getSyncStatus();

        const sitesChanged = !lastSyncStatusRef.current?.sites_last_updated ||
                           syncStatus.sites_last_updated !== lastSyncStatusRef.current.sites_last_updated;
        const pipelinesChanged = !lastSyncStatusRef.current?.pipelines_last_updated ||
                               syncStatus.pipelines_last_updated !== lastSyncStatusRef.current.pipelines_last_updated;
        const recentsChanged = !lastSyncStatusRef.current?.spray_records_last_updated ||
                              syncStatus.spray_records_last_updated !== lastSyncStatusRef.current.spray_records_last_updated;
        // T&M ticket watermark. Bumps whenever a ticket is created, edited,
        // submitted, or approved. The FormsPanel uses tmRefreshToken to
        // decide when to re-fetch its Open / Submitted lists so users see
        // updates without a full page reload — egress stays near zero when
        // nothing has changed (sync-status is ~100B).
        const tmTicketsChanged = !lastSyncStatusRef.current?.tm_tickets_last_updated ||
                                syncStatus.tm_tickets_last_updated !== lastSyncStatusRef.current.tm_tickets_last_updated;
        // Same MAX(updated_at) watermark for hydroseed_tickets. Backend
        // already ships `hydroseed_tickets_last_updated` in /api/sync-status.
        const hydroseedTicketsChanged = !lastSyncStatusRef.current?.hydroseed_tickets_last_updated ||
                                syncStatus.hydroseed_tickets_last_updated !== lastSyncStatusRef.current.hydroseed_tickets_last_updated;
        const hydroseedDailiesChanged = !lastSyncStatusRef.current?.hydroseed_dailies_last_updated ||
                                syncStatus.hydroseed_dailies_last_updated !== lastSyncStatusRef.current.hydroseed_dailies_last_updated;
        const devicesChanged = !lastSyncStatusRef.current?.devices_last_updated ||
                              syncStatus.devices_last_updated !== lastSyncStatusRef.current.devices_last_updated;

        // Snapshot prev pending counts BEFORE overwriting the ref so the
        // pending-list re-fetch guard below sees the real delta.
        const prevPendingSites = lastSyncStatusRef.current?.pending_sites_count;
        const prevPendingPipelines = lastSyncStatusRef.current?.pending_pipelines_count;

        lastSyncStatusRef.current = syncStatus;

        if (sitesChanged) await syncSitesIncrementally(syncStatus);
        if (pipelinesChanged) await syncPipelinesIncrementally(syncStatus);
        if (recentsChanged) await syncRecentsIncrementally(syncStatus);
        if (devicesChanged) await loadDevices();
        // Don't fetch tickets here — bumping the token lets the visible
        // FormsPanel decide whether to fetch (it only does when the
        // relevant tab is in view, saving egress when nobody's looking).
        if (tmTicketsChanged) setTmRefreshToken((x) => x + 1);
        if (hydroseedTicketsChanged) setHydroseedRefreshToken((x) => x + 1);
        if (hydroseedDailiesChanged) setHydroseedDailiesRefreshToken((x) => x + 1);

        // Persist the latest watermarks to IndexedDB so the NEXT browser
        // reload can take the hydrate-from-cache fast path and skip the
        // initial full fetch. Cheap (single keyed put). Only write if
        // something actually changed this tick — avoids thrashing the
        // `stored_at` timestamp and thus the 24 h staleness gate.
        if (sitesChanged || pipelinesChanged || recentsChanged) {
          try {
            await setWatermarks({
              sites: sitesSinceRef.current,
              pipelines: pipelinesSinceRef.current,
              recents: recentsSinceRef.current,
              pending_sites_count: syncStatus.pending_sites_count ?? null,
              pending_pipelines_count: syncStatus.pending_pipelines_count ?? null,
            });
          } catch { /* non-fatal */ }
        }

        // ── Pending list refresh ────────────────────────────────────────
        // We deliberately do NOT mirror syncStatus.pending_*_count straight
        // into pendingSitesCount / pendingPipelinesCount any more. That
        // used to fight the derivation effect that locks
        // pendingSitesCount = pendingSites.length: a stale sync-status
        // (replica lag, an in-flight DELETE that hadn't committed when
        // /api/sync-status read the row, or just the gap between an
        // optimistic local remove and the server roundtrip) would
        // resurrect the old count, leaving the topbar badge claiming
        // "Pending: 1" while the AdminPanel list was correctly empty —
        // the "ghost pending after delete" bug.
        //
        // The derivation effect is now the single source of truth for the
        // count. When the server-side count diverges from the local list
        // (another admin approved/rejected on a different device, a
        // worker added a pin while we were offline, …), the re-fetch
        // below pulls the authoritative list and the derivation effect
        // re-syncs the badge in the same React tick.
        if (canManagePins) {
          const sitesPendingChanged = syncStatus.pending_sites_count !== prevPendingSites;
          const pipelinesPendingChanged = syncStatus.pending_pipelines_count !== prevPendingPipelines;
          if (sitesPendingChanged) {
            if (syncStatus.pending_sites_count > 0) {
              try { setPendingSites(await api.listPendingSites()); } catch { /* silently fail */ }
            } else {
              setPendingSites([]);
            }
          }
          if (pipelinesPendingChanged) {
            if (syncStatus.pending_pipelines_count > 0) {
              try { setPendingPipelines(await api.listPendingPipelines()); } catch { /* silently fail */ }
            } else {
              setPendingPipelines([]);
            }
          }
        }
      } catch { /* silently fail polling to avoid spam */ }

      // Retry any stuck upload queue items on each tick (also visibility-gated).
      try { processUploadQueue(); } catch { /* ignore */ }

      // Piggyback the build-version check on this poll tick. The standalone
      // setInterval that drives version polling on desktop is throttled by
      // WKWebView on iOS PWA — runPollTick is firing reliably because it's
      // tied to real network activity that iOS doesn't pause, so this is
      // the path that actually lights the red "Update available" dot on
      // a worker's iPhone in the field. Cheap (~150 byte fetch with
      // no-store headers) and idempotent (setSwUpdateAvailable(true) is
      // a no-op once the dot is already lit).
      try { checkAppVersionRef.current?.(); } catch { /* non-fatal */ }
    };

    // Interval is started/cleared by the visibility handler so the
    // poll completely pauses while the tab is hidden (iOS Safari
    // keeps intervals alive in the background — without this, a
    // worker's phone in their pocket would still fire delta fetches
    // every POLL_MS forever).
    let pollInterval = null;
    const startInterval = () => {
      if (pollInterval != null) return;
      pollInterval = setInterval(runPollTick, POLL_MS);
    };
    const stopInterval = () => {
      if (pollInterval == null) return;
      clearInterval(pollInterval);
      pollInterval = null;
    };

    if (document.visibilityState === 'visible') startInterval();

    // Expose the latest tick to the back-online handler so it can trigger a
    // cheap delta sync instead of running a full refreshAllData() whenever
    // the network flaps.
    runPollTickRef.current = runPollTick;

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        startInterval();
        // Immediate catch-up tick on wake (covers phone-unlock, tab-switch).
        runPollTick();
      } else {
        stopInterval();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopInterval();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      runPollTickRef.current = null;
    };
  }, [isOnline, serverFilters, canManagePins, selectedSite, processUploadQueue, realtimeStatus, loadDevices]);

  // ── Mirror selectedSite / selectedPipeline into refs ────────────────────
  // The Realtime subscription useEffect below opens a single long-lived
  // WebSocket. Its handlers need to read "is the user currently looking at
  // this site?" so they can refresh the open detail sheet on the fly. Using
  // selectedSite directly would make the subscription a dependency of the
  // effect → the channel would tear down and re-open every time the user
  // taps a different pin, which is both wasteful AND drops events for the
  // ~100 ms reconnection window. Refs sidestep that entirely.
  useEffect(() => { selectedSiteRef.current = selectedSite; }, [selectedSite]);
  useEffect(() => { selectedPipelineRef.current = selectedPipeline; }, [selectedPipeline]);

  // ── Keep the topbar "Pending: N" badges locked to the live list length ──
  // Before this effect, only the admin action button handlers (approve,
  // reject, bulk-approve, pin-submit) decremented/incremented
  // pendingSitesCount explicitly. That left several routes that could
  // drain the pending list without touching the count — the most visible
  // being:
  //
  //   • Admin opens a pending pin in the detail sheet → clicks Delete.
  //     handleDeleteSite removed the row from `sites` and kicked off a
  //     background re-fetch of pendingSites, but the topbar badge still
  //     showed the old number until the next 5-min /api/sync-status poll.
  //
  //   • A Supabase Realtime DELETE / UPDATE event arrived for a row that
  //     was in pendingSites — the onSites handler removed it from the
  //     array, but pendingSitesCount was never adjusted, so the badge
  //     drifted out of sync across devices.
  //
  // Now that the load*Pending* callbacks set a "loaded" ref on first
  // successful online fetch, we can derive the count directly from the
  // array length. The ref gate is what prevents the cached seed count
  // from /api/sync-status getting clobbered by an initial length-zero
  // array on cold start.
  useEffect(() => {
    if (pendingSitesLoadedRef.current) {
      setPendingSitesCount(pendingSites.length);
    }
  }, [pendingSites]);
  useEffect(() => {
    if (pendingPipelinesLoadedRef.current) {
      setPendingPipelinesCount(pendingPipelines.length);
    }
  }, [pendingPipelines]);

  // ── Preload lazy chunks during browser idle time ────────────────────────
  // The code-split at the top of this file cuts ~500 kB off the initial
  // main bundle so the map + auth can paint fast, but the first time a
  // user taps a different tab or opens an inspection sheet we'd pay a
  // 50–200 ms chunk download over 4G. Kicking off the imports during the
  // post-auth idle window (via requestIdleCallback, or a setTimeout
  // fallback on Safari) warms the browser's JS cache + the service
  // worker's precache so those interactions feel instant on second touch.
  // We don't await any of them — a failed preload just means the chunk
  // downloads on demand like it used to.
  useEffect(() => {
    if (!user) return;
    const preload = () => {
      void import('./components/FormsPanel');
      void import('./components/HerbicideLeaseSheet');
      void import('./components/PdfPreviewOverlay');
      void import('./components/TMTicketDetailSheet');
      // Warm the PDF-generator chunks too so the first lease-sheet /
      // T&M PDF render after login feels instant. These were evicted
      // from the main bundle (cold-start win) and are otherwise loaded
      // on demand by ensurePdfAndTicket / HerbicideLeaseSheet.
      void import('./lib/pdfGenerator');
      void import('./lib/tmTicketPdfGenerator');
      if (canManagePins) {
        void import('./components/AdminPanel');
        void import('./components/ApproveEditModal');
      }
    };
    const ric = window.requestIdleCallback;
    if (typeof ric === 'function') {
      const handle = ric(preload, { timeout: 3000 });
      return () => {
        if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle);
      };
    }
    const timer = window.setTimeout(preload, 1500);
    return () => window.clearTimeout(timer);
  }, [user, canManagePins]);

  // ── Supabase Realtime: live row-level push from Postgres ───────────────
  //
  // Replaces the old "poll /api/sync-status every 5 minutes and re-fetch
  // delta endpoints on change" loop as the *primary* freshness path. The
  // poll useEffect above is still alive — it acts as a safety net when the
  // WebSocket is silently broken (corporate proxy strips upgrade headers,
  // server-side disconnect we miss, etc.) and as the catch-up mechanism
  // for resources Realtime doesn't (and can't) deliver in real time, like
  // T&M ticket aggregates that compose multiple tables.
  //
  // Architecture:
  //
  //   1. ONE Supabase channel subscribes to postgres_changes for all 12
  //      tables the frontend cares about (see database/enable_realtime.sql
  //      for the matching server-side configuration).
  //   2. Each table has a small handler that merges the event into local
  //      React state + IndexedDB. Handlers use functional setState so they
  //      don't need any of the Site/Pipeline arrays in the effect's deps —
  //      the channel stays mounted across all UI changes.
  //   3. On initial connect AND on every reconnect, we fire one cheap
  //      delta-poll-tick so any events that fired while the socket was
  //      down get picked up via the existing /api/*/delta endpoints.
  //
  // Soft-delete handling: every soft-deletable table in this app sets a
  // `deleted_at` timestamp instead of issuing a DDL DELETE, so almost all
  // "delete" events arrive as UPDATEs with `deleted_at != null`. The
  // handlers route those into the corresponding `deletedX` admin array and
  // remove the row from the visible list. Hard DELETEs are still handled
  // for completeness but should be very rare in normal operation.
  useEffect(() => {
    if (!supabase || !user || !window.navigator.onLine) return;

    // ── helpers used by every handler ────────────────────────────────────
    //
    // Supabase Realtime (via wal2json) can deliver integer column values
    // as strings, e.g. `id: "123"` instead of `id: 123`. The rest of the
    // app (API responses, IndexedDB cache, optimistic mutations) uses
    // numeric ids, so a string here creates a ghost duplicate in every
    // `setSites` Map/findIndex keyed by `row.id` — the root cause of the
    // "reject leaves orange ! on the map" bug.  We coerce all known
    // integer FK / id columns at this single gate so downstream
    // comparisons (`row.id === sel.id`, `r.site_id === selectedSite.id`,
    // …) don't have to repeat the check at every callsite.
    //
    // Why an explicit allowlist (and not a blanket "if value is a string
    // that parses to a number, coerce it"): some text columns happen to
    // be all-digits (ticket numbers like "00001", lsd labels, etc.) and
    // we don't want to silently re-type those.
    const INT_COLUMNS = [
      'id',
      'site_id',
      'pipeline_id',
      'tm_ticket_id',
      'spray_record_id',
      'created_by_user_id',
      'approved_by_user_id',
      'deleted_by_user_id',
    ];
    const coerceIntColumn = (row, key) => {
      if (row[key] == null || typeof row[key] !== 'string') return;
      const n = Number(row[key]);
      if (!Number.isNaN(n)) row[key] = n;
    };
    const rowOf = (payload) => {
      const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
      if (!row) return row;
      for (const key of INT_COLUMNS) coerceIntColumn(row, key);
      return row;
    };
    const merge = (existing, incoming) => (existing ? { ...existing, ...incoming } : incoming);
    const upsertById = (arr, row) => {
      const idx = arr.findIndex((x) => matchSiteIdentity(x, row));
      if (idx === -1) return [row, ...arr];
      const next = arr.slice();
      next[idx] = merge(next[idx], row);
      return next;
    };
    const removeById = (arr, id) => removeSitesByIdentity(arr, id);

    // ── sites: pins (LSD / water / quad / pipeline access / reclaimed) ──
    const onSites = (payload) => {
      const row = rowOf(payload);
      if (!row || row.id == null) return;

      const isHardDelete = payload.eventType === 'DELETE';
      const isSoftDeleted = !isHardDelete && row.deleted_at != null;
      const approval = row.approval_state;
      // Treat 'rejected' as "hidden from the map" — matches the backend's
      // list endpoint which already filters rejected rows out of
      // /api/sites. Before, realtime would upsert a rejected row back into
      // `sites` with approval_state='rejected' but NO map logic handles
      // that state, so the orange `!` marker stayed visible until a full
      // refresh. Dropping the row from `sites` on reject makes the
      // pending marker disappear instantly on the rejecter's device and
      // across every other device listening to realtime.
      const isHidden = isHardDelete || isSoftDeleted || approval === 'rejected';

      // Main map list
      setSites((prev) => {
        if (isHidden) return removeById(prev, row.id);
        return upsertById(prev, row);
      });
      if (isHardDelete) {
        void removeSite({ id: row.id });
      } else if (approval === 'rejected') {
        // Keep IndexedDB in sync — rejected rows get purged locally so a
        // cold start doesn't re-hydrate the orange marker from cache.
        void removeSite({ id: row.id });
      } else {
        void upsertSite(row);
      }

      // Admin pending list
      if (canManagePins) {
        setPendingSites((prev) => {
          const exists = prev.some((s) => matchSiteIdentity(s, row));
          const shouldBeIn = !isHardDelete && !isSoftDeleted && approval === 'pending_review';
          if (shouldBeIn && !exists) return [row, ...prev];
          if (!shouldBeIn && exists) return removeById(prev, row.id);
          if (shouldBeIn && exists) return prev.map((s) => (matchSiteIdentity(s, row) ? merge(s, row) : s));
          return prev;
        });
        // Admin recent-deletes list
        setDeletedSites((prev) => {
          const exists = prev.some((s) => matchSiteIdentity(s, row));
          if (isSoftDeleted && !exists) return [row, ...prev];
          if ((isHardDelete || !isSoftDeleted) && exists) return removeById(prev, row.id);
          return prev;
        });
      }

      // Currently-viewed detail sheet
      if (selectedSiteRef.current && matchSiteIdentity(selectedSiteRef.current, row)) {
        if (isHidden) {
          setDetailOpen(false);
          setSelectedSite(null);
        } else {
          setSelectedSite((prev) => (prev ? merge(prev, row) : prev));
        }
      }
    };

    // ── pipelines ────────────────────────────────────────────────────────
    const onPipelines = (payload) => {
      const row = rowOf(payload);
      if (!row || row.id == null) return;

      const isHardDelete = payload.eventType === 'DELETE';
      const isSoftDeleted = !isHardDelete && row.deleted_at != null;
      const approval = row.approval_state;
      // Same "rejected == hidden" treatment as onSites — the rendered
      // Polyline doesn't have a dedicated rejected style, so dropping the
      // row is the simplest way to make reject feel instant.
      const isHidden = isHardDelete || isSoftDeleted || approval === 'rejected';

      setPipelines((prev) => {
        if (isHidden) return removeById(prev, row.id);
        return upsertById(prev, row);
      });
      if (isHardDelete || approval === 'rejected') {
        void removePipeline(row.id);
      } else {
        void upsertPipeline(row);
      }

      if (canManagePins) {
        setPendingPipelines((prev) => {
          const exists = prev.some((p) => p.id === row.id);
          const shouldBeIn = !isHardDelete && !isSoftDeleted && approval === 'pending_review';
          if (shouldBeIn && !exists) return [row, ...prev];
          if (!shouldBeIn && exists) return removeById(prev, row.id);
          if (shouldBeIn && exists) return prev.map((p) => (p.id === row.id ? merge(p, row) : p));
          return prev;
        });
        setDeletedPipelines((prev) => {
          const exists = prev.some((p) => p.id === row.id);
          if (isSoftDeleted && !exists) return [row, ...prev];
          if ((isHardDelete || !isSoftDeleted) && exists) return removeById(prev, row.id);
          return prev;
        });
      }

      if (selectedPipelineRef.current && selectedPipelineRef.current.id === row.id) {
        if (isHardDelete) {
          setPipelineDetailOpen(false);
          setSelectedPipeline(null);
        } else {
          setSelectedPipeline((prev) => (prev ? merge(prev, row) : prev));
        }
      }
    };

    // ── spray_records: pipeline lease sheets (drives Recents feed) ──────
    const onSprayRecords = (payload) => {
      const row = rowOf(payload);
      if (!row || row.id == null) return;
      const isHardDelete = payload.eventType === 'DELETE';
      const isSoftDeleted = !isHardDelete && row.deleted_at != null;

      setCachedRecents((prev) => {
        if (isHardDelete || isSoftDeleted) return removeById(prev, row.id);
        // Sort by created_at desc, dedup
        const next = upsertById(prev, row);
        return next.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      });
      if (isHardDelete || isSoftDeleted) {
        try { void removeRecentById(row.id); } catch { /* ignore */ }
      } else {
        void upsertRecent(row);
      }

      // Patch the affected pipeline's `spray_records` array in-place so the
      // green/grey segment appears (or disappears) on every viewer's map
      // immediately, instead of waiting for the next 30s pipelines delta
      // poll. The Postgres realtime payload for the `pipelines` row only
      // carries base columns (no relationships), so without this branch
      // `MapView` never sees the new SprayRecord entry on remote devices.
      const pipelineId = row.pipeline_id;
      if (pipelineId != null) {
        const patchSprayRecords = (records) => {
          const arr = Array.isArray(records) ? records.slice() : [];
          if (isHardDelete) return arr.filter((r) => r.id !== row.id);
          const idx = arr.findIndex((r) => r.id === row.id);
          if (idx === -1) return [row, ...arr];
          arr[idx] = { ...arr[idx], ...row };
          return arr;
        };
        setPipelines((prev) => prev.map((p) => (
          p.id === pipelineId ? { ...p, spray_records: patchSprayRecords(p.spray_records) } : p
        )));
        if (selectedPipelineRef.current && selectedPipelineRef.current.id === pipelineId) {
          setSelectedPipeline((prev) => (
            prev ? { ...prev, spray_records: patchSprayRecords(prev.spray_records) } : prev
          ));
          setPipelineSprayRecords((prev) => patchSprayRecords(prev));
        }
      }

      // T&M aggregates can change when a spray record's status moves;
      // bump the token so the FormsPanel refreshes if it's open.
      setTmRefreshToken((x) => x + 1);
    };

    // ── site_spray_records: site lease sheets (also feed Recents) ───────
    const onSiteSprayRecords = (payload) => {
      const row = rowOf(payload);
      if (!row || row.id == null) return;
      const isHardDelete = payload.eventType === 'DELETE';
      const isSoftDeleted = !isHardDelete && row.deleted_at != null;

      setCachedRecents((prev) => {
        if (isHardDelete || isSoftDeleted) return removeById(prev, row.id);
        const next = upsertById(prev, row);
        return next.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      });
      if (isHardDelete || isSoftDeleted) {
        try { void removeRecentById(row.id); } catch { /* ignore */ }
      } else {
        void upsertRecent(row);
      }

      // If the user is viewing the site this lease sheet belongs to, refresh
      // its embedded `spray_records` list so the new row shows up live.
      const sel = selectedSiteRef.current;
      if (sel && Number.isInteger(sel.id) && sel.id === row.site_id) {
        setSelectedSite((prev) => {
          if (!prev) return prev;
          const records = Array.isArray(prev.spray_records) ? prev.spray_records.slice() : [];
          if (isHardDelete || isSoftDeleted) {
            return { ...prev, spray_records: records.filter((r) => r.id !== row.id) };
          }
          const idx = records.findIndex((r) => r.id === row.id);
          if (idx === -1) records.unshift(row);
          else records[idx] = merge(records[idx], row);
          return { ...prev, spray_records: records };
        });
      }

      setTmRefreshToken((x) => x + 1);
    };

    // ── site_updates: status-history rows on a pin ──────────────────────
    const onSiteUpdates = (payload) => {
      const row = rowOf(payload);
      if (!row || row.id == null) return;

      const sel = selectedSiteRef.current;
      if (!sel || !Number.isInteger(sel.id) || sel.id !== row.site_id) return;

      // Refresh the embedded `updates` list on the open site sheet.
      setSelectedSite((prev) => {
        if (!prev) return prev;
        const updates = Array.isArray(prev.updates) ? prev.updates.slice() : [];
        if (payload.eventType === 'DELETE') {
          return { ...prev, updates: updates.filter((u) => u.id !== row.id) };
        }
        const idx = updates.findIndex((u) => u.id === row.id);
        if (idx === -1) updates.unshift(row);
        else updates[idx] = merge(updates[idx], row);
        return { ...prev, updates };
      });
    };

    // ── time_materials_tickets / time_materials_rows ────────────────────
    // The FormsPanel re-fetches its Open / Submitted lists when the token
    // bumps. That's cheaper than maintaining a denormalised TM cache here,
    // since tickets aggregate across multiple tables.
    const onTMTickets = () => setTmRefreshToken((x) => x + 1);
    const onTMRows = () => setTmRefreshToken((x) => x + 1);

    // ── hydroseed_daily_records / hydroseed_tickets / hydroseed_ticket_rows
    // Same pattern as the T&M handlers above — bump a refresh token and let
    // FormsPanel re-fetch the affected list.
    //
    // Tickets + rows use the dedicated `hydroseedRefreshToken`, which kicks
    // the unified hydroseed-tickets cache (cold full-fetch on first call,
    // delta sync thereafter) the same way `tmRefreshToken` does for T&M.
    // Dailies still ride `draftsRefreshToken` since the FormsPanel daily
    // lists already depend on it (drafts + recents).
    const onHydroseedDailies = () => {
      // Bump both tokens so:
      //   - drafts pane refreshes (legacy behaviour)
      //   - the unified hydroseedDailies cache in FormsPanel runs a
      //     cheap delta sync immediately instead of waiting for the
      //     next sync-status tick.
      setDraftsRefreshToken((x) => x + 1);
      setHydroseedDailiesRefreshToken((x) => x + 1);
    };
    const onHydroseedTickets = () => setHydroseedRefreshToken((x) => x + 1);
    const onHydroseedRows = () => setHydroseedRefreshToken((x) => x + 1);

    // ── devices: registered iPads (OwnTracks). Each Realtime event is
    //    a position update, color/label change, or activation toggle.
    //    We just upsert; the map's TrucksLayer filters out is_active=false
    //    and rows missing a last_lat/last_lng on render.
    const onDevices = (payload) => {
      if (!actualCanManagePins) return;
      const row = rowOf(payload);
      if (!row || row.id == null) return;
      setDevices((prev) => {
        if (payload.eventType === 'DELETE') return removeById(prev, row.id);
        return upsertById(prev, row);
      });
    };

    // ── users: roster, role changes, deletions ──────────────────────────
    const onUsers = (payload) => {
      const row = rowOf(payload);
      if (!row || row.id == null) return;
      setCachedUsers((prev) => {
        if (payload.eventType === 'DELETE') return removeById(prev, row.id);
        return upsertById(prev, row);
      });
      // Persist the single-row change directly to IDB. Previously this
      // path called `replaceUsers(entire list)` which clear()s the
      // `users` store and re-puts every row — O(n) writes on every
      // Realtime user event. `putUser` / `removeUserById` are O(1) and
      // semantically equivalent because the store's keyPath is `id`.
      if (payload.eventType === 'DELETE') {
        void removeUserById(row.id);
      } else {
        void putUser(row);
      }
    };

    // ── lookup tables (herbicides / applicators / weeds / locations) ─────
    // The frontend keeps lookups in `cachedLookups` keyed by short names
    // (`herbicides`, `applicators`, `weeds`, `locations`) while IndexedDB
    // stores them by the same keys. Soft-delete on these is `is_active =
    // FALSE`, not `deleted_at`, so the predicate is different.
    const applyLookupChange = (stateKey, payload) => {
      const row = rowOf(payload);
      if (!row || row.id == null) return;
      const isHardDelete = payload.eventType === 'DELETE';
      const isSoftDeleted = !isHardDelete && row.is_active === false;

      setCachedLookups((prev) => {
        const arr = prev[stateKey] || [];
        let next;
        if (isHardDelete || isSoftDeleted) {
          next = removeById(arr, row.id);
        } else {
          const idx = arr.findIndex((x) => x.id === row.id);
          if (idx === -1) {
            next = [...arr, row].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
          } else {
            const cloned = arr.slice();
            cloned[idx] = merge(cloned[idx], row);
            next = cloned;
          }
        }
        // Fire-and-forget IndexedDB persist so the next cold start has the
        // up-to-date table without needing a /api/lookups/* fetch.
        void replaceLookups(stateKey, next);
        return { ...prev, [stateKey]: next };
      });
    };
    const onHerbicides = (p) => applyLookupChange('herbicides', p);
    const onApplicators = (p) => applyLookupChange('applicators', p);
    const onWeeds = (p) => applyLookupChange('weeds', p);
    const onLocationTypes = (p) => applyLookupChange('locations', p);

    // ── Subscribe ────────────────────────────────────────────────────────
    const channel = supabase
      .channel('pineview-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sites' }, onSites)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pipelines' }, onPipelines)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'spray_records' }, onSprayRecords)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'site_spray_records' }, onSiteSprayRecords)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'site_updates' }, onSiteUpdates)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_materials_tickets' }, onTMTickets)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_materials_rows' }, onTMRows)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hydroseed_daily_records' }, onHydroseedDailies)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hydroseed_tickets' }, onHydroseedTickets)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hydroseed_ticket_rows' }, onHydroseedRows)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, onUsers)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, onDevices)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'herbicides' }, onHerbicides)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'applicators' }, onApplicators)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'noxious_weeds' }, onWeeds)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'location_types' }, onLocationTypes)
      .subscribe((status) => {
        // Status values per @supabase/supabase-js: 'SUBSCRIBED' on initial
        // connect AND after a successful reconnect; 'CHANNEL_ERROR',
        // 'TIMED_OUT', 'CLOSED' otherwise. Catch-up only on a successful
        // (re)connect — the SDK auto-retries failures with backoff.
        if (status === 'SUBSCRIBED') {
          setRealtimeStatus('connected');
          // Fire one cheap delta tick to pick up any rows that changed
          // while we were disconnected.
          try { runPollTickRef.current?.(); } catch { /* ignore */ }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtimeStatus('disconnected');
          console.warn('[REALTIME] Channel status:', status);
        }
      });

    return () => {
      try { supabase.removeChannel(channel); } catch { /* ignore */ }
    };
  // user.id is the only auth-bound dep — recreate the channel only when
  // the logged-in user changes (login/logout). canManagePins gates the
  // pin-management state writes inside handlers but reading the latest
  // value via closure is fine because we re-create on user change anyway.
  }, [user?.id, canManagePins, isOnline]);

  // ── Check-ins: load active shift + subscribe to own shifts/checkins ──
  // Drives the topbar countdown, the forced overlay, and the soft
  // banner. Fetches once on login, then keeps the local copy fresh
  // via Realtime on `shifts` + `checkins`. No polling fallback --
  // the topbar countdown's local 1 s tick covers the deadline math
  // and Realtime is the source of truth for shift state changes.
  const loadActiveShift = useCallback(async () => {
    if (!user?.id) return;
    try {
      const data = await api.getMyTodayCheckin();
      setActiveShift(data?.shift && !data.shift.ended_at ? data.shift : null);
    } catch (err) {
      // Don't crash the app shell if the backend isn't ready yet
      // (e.g. fresh deploy before /api/checkins/me/today exists).
      console.warn('[checkin] loadActiveShift failed:', err);
    }
  }, [user?.id]);

  // Active shifts for the map's CrewLayer + the Crew sidebar. Only
  // pin-managers can read this -- workers don't see other people's
  // positions. We keep ALL active (non-off) shifts so the sidebar can
  // list everyone on shift; the map's CrewLayer filters to those that
  // actually have a position so it never plots a (0,0) pin.
  const loadCrewShifts = useCallback(async () => {
    if (!window.navigator.onLine || !actualCanManagePins) {
      setCrewShifts([]);
      return;
    }
    try {
      const data = await api.listAdminActiveShifts();
      const active = (Array.isArray(data) ? data : []).filter(
        (s) => !s.ended_at && s.mode !== 'off',
      );
      setCrewShifts(active);
    } catch (err) {
      // Soft-fail: the map keeps rendering everything else.
      console.warn('[checkin] loadCrewShifts failed:', err);
    }
  }, [actualCanManagePins]);

  useEffect(() => {
    if (!user?.id) {
      setActiveShift(null);
      setCrewShifts([]);
      return undefined;
    }
    loadActiveShift();
    loadCrewShifts();
    let debounceTimer = null;
    const scheduleRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        loadActiveShift();
        loadCrewShifts();
      }, 400);
    };
    // iPad/iOS-PWA safety net: iOS aggressively freezes service
    // workers + drops websockets while the app is backgrounded, so
    // the Supabase Realtime channel below is unreliable on tablets.
    // When the worker comes back to the tab/app, force a refetch so
    // the topbar countdown can't stay stale -- this is what made the
    // "have to close+reopen the iPad app to see the timer" bug
    // possible in the first place.
    const onFocus = () => scheduleRefresh();
    const onVisibility = () => { if (!document.hidden) scheduleRefresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    let channel = null;
    if (supabase) {
      channel = supabase
        .channel(`my-checkin-${user.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, scheduleRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'checkins' }, scheduleRefresh)
        .subscribe();
    }
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      if (channel) {
        try { supabase.removeChannel(channel); } catch { /* ignore */ }
      }
    };
  }, [user?.id, loadActiveShift, loadCrewShifts]);

  // ── Foreground location reporter ──────────────────────────────────
  // While the app is OPEN and the user has an ACTIVE shift, push the
  // device's location to the server so the office sees a fresh "last
  // known location" (truck position). Fires immediately on open, when
  // the app returns to the foreground (focus/visibility), and every
  // 5 min while it stays open.
  //
  // Privacy: this is a deliberately PASSIVE, foreground-only ping. The
  // moment the worker checks out (no active shift) the effect stops
  // running AND the backend rejects the ping with 400 -- so location
  // never updates off-shift. The last known spot is preserved but goes
  // stale. iOS can't report in the background anyway, which actually
  // reinforces the privacy boundary here.
  useEffect(() => {
    const shift = activeShift;
    const onShift =
      shift && !shift.ended_at && shift.mode !== 'off';
    if (!user?.id || !onShift) return undefined;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return undefined;
    }

    let cancelled = false;
    const reportLocation = () => {
      // Skip while offline -- the request would just fail; the next
      // foreground/interval tick retries once back online.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          api
            .postMyLocation({
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
              accuracyM: pos.coords.accuracy,
            })
            .catch(() => {
              /* 400 (checked out) or transient -- ignore, effect
                 re-gates on the next activeShift change. */
            });
        },
        () => {
          /* permission denied / unavailable -- nothing to report */
        },
        { timeout: 8000, maximumAge: 30_000, enableHighAccuracy: false },
      );
    };

    // Fire right away so opening the app refreshes the position.
    reportLocation();
    const id = setInterval(reportLocation, 5 * 60_000);
    const onFocus = () => reportLocation();
    const onVis = () => { if (!document.hidden) reportLocation(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [user?.id, activeShift?.id, activeShift?.ended_at, activeShift?.mode]);

  // ── Forced overlay watcher ────────────────────────────────────────
  // Recomputes shouldForceOverlay() every 30 s + on focus / visibility
  // change. The tick interval is intentionally coarse -- the countdown
  // pill's 1 s tick handles the smooth visual, this only flips the
  // *blocking* overlay on/off so we don't pay re-render cost on every
  // second when there's no state change to apply.
  useEffect(() => {
    const recompute = () => {
      setForceCheckinOverlay(shouldForceOverlay(activeShift, new Date()));
    };
    recompute();
    const id = setInterval(recompute, 30_000);
    const onFocus = () => recompute();
    const onVis = () => { if (!document.hidden) recompute(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [activeShift?.id, activeShift?.next_deadline_at, activeShift?.last_checkin_at, activeShift?.ended_at]);

  // ── Local (device-clock) backup check-in notifications ───────────
  // Belt-and-suspenders to the server-driven Web Push pipeline. Server
  // push only fires when the device has internet (it has to reach
  // Apple/FCM). A worker out of cell range would never hear a buzz,
  // come back into service hours later, and discover the office had
  // already escalated. This scheduler runs on the device's own clock
  // and fires showNotification() at the same threshold beats (T+0,
  // T+3, T+10, T+20, T+30, T+45, T+60) so the worker hears the alert
  // even with zero connectivity. Both channels use tag='checkin' so
  // when both fire, the OS tray collapses them into one notification.
  useEffect(() => {
    if (!activeShift) return undefined;
    if (activeShift.ended_at) return undefined;
    if (activeShift.mode === 'off') return undefined;
    const stop = scheduleLocalCheckinNotifications(activeShift);
    return stop;
  }, [activeShift?.id, activeShift?.next_deadline_at, activeShift?.ended_at, activeShift?.mode]);

  // ── Service worker message listener (open-checkin) ────────────────
  // When the worker taps a push notification, the SW's
  // notificationclick handler postMessages {type:'open-checkin'} into
  // whichever app tab is open. Catch that here and flip the personal
  // overlay open.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return undefined;
    const onMessage = (event) => {
      if (event?.data?.type === 'open-checkin') {
        setShowMyCheckins(true);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  // ── Auto-subscribe to push on login (if prefs allow) ──────────────
  // The user_profile.notify_push flag defaults to true, but we still
  // verify the OS notification permission was granted -- if it's
  // default/denied, the user has to grant it explicitly via the
  // prefs panel. iOS PWA + 16.4+ also gates this via pushSupported().
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        // pushClient is lazy-loaded so its (small) module doesn't sit in
        // the cold-start main bundle. We still gate on the synchronous
        // platform checks inside the loaded module before subscribing.
        const { ensurePushSubscribed, notificationPermission, pushSupported } =
          await import('./lib/pushClient');
        if (cancelled) return;
        if (!pushSupported() || notificationPermission() !== 'granted') return;
        const prefs = await api.getMyCheckinPrefs();
        if (cancelled) return;
        if (prefs?.notify_push) {
          await ensurePushSubscribed();
        }
      } catch (err) {
        console.warn('[checkin] auto push-subscribe skipped:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // ── Soft morning banner: hydrate dismiss flag from localStorage ──
  // The flag is stored as the local YYYY-MM-DD it was dismissed on.
  // If the stored date is older than today, we treat it as not
  // dismissed so the banner reappears the next day.
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      const stored = localStorage.getItem('checkinSoftBannerDismissed');
      const today = new Date().toISOString().slice(0, 10);
      setSoftBannerDismissed(stored === today);
    } catch {
      /* ignore -- private mode etc. */
    }
  }, []);

  // In-flight promise ref — lets handleStartHydroseedDaily await the same
  // fetch that's already in-flight instead of firing a second network call
  // when the user taps "Hydroseed Daily" before the background prefetch resolves.
  const latestDailyFetchRef = useRef(null);

  // Pre-fetch the latest Hydroseed Daily in the background whenever the user or drafts refresh
  useEffect(() => {
    if (user) {
      const p = api.getMyLatestHydroseedDaily();
      latestDailyFetchRef.current = p;
      p.then((res) => {
          setLatestHydroseedDaily(res);
          setHasFetchedLatestDaily(true);
        })
        .catch(() => {
          setHasFetchedLatestDaily(true);
        });
    } else {
      latestDailyFetchRef.current = null;
      setLatestHydroseedDaily(null);
      setHasFetchedLatestDaily(false);
    }
  }, [user, draftsRefreshToken]);

  const visibleSites = useMemo(() => {
    const normalizedSearch = filters.search.trim().toLowerCase();
    return sites.filter((site) => {
      // Hard guard: rejected or soft-deleted pins must NEVER render a
      // map marker, regardless of how they ended up in `sites` (stale
      // cache, delta race, realtime upsert before the isHidden check
      // ran, …).  This is the last line of defence — even if every
      // other cleanup path misses the row, the marker won't appear.
      if (isHiddenSite(site)) return false;
      const isWater = site.pin_type === 'water';
      // Layer visibility check
      if (site.pin_type && !layers[site.pin_type]) return false;
      // Case-insensitive client / area match — see getFiltersHidingSite.
      if (filters.client && nameKey(site.client) !== nameKey(filters.client) && !isWater) return false;
      if (filters.area && nameKey(site.area) !== nameKey(filters.area) && !isWater) return false;
      if (filters.status && site.status !== filters.status && !isWater) return false;
      if (filters.approval_state && site.approval_state !== filters.approval_state) return false;
      if (!normalizedSearch) return true;
      const haystack = [site.lsd, site.client, site.area, site.notes].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [filters, sites, layers]);

  const visiblePipelines = useMemo(() => {
    if (!layers.pipelines) return [];
    const normalizedSearch = filters.search.trim().toLowerCase();
    return pipelines.filter((p) => {
      if (p.deleted_at) return false;
      if (p.approval_state === 'rejected') return false;
      if (filters.client && nameKey(p.client) !== nameKey(filters.client)) return false;
      if (filters.area && nameKey(p.area) !== nameKey(filters.area)) return false;
      if (filters.approval_state && p.approval_state !== filters.approval_state) return false;
      if (!normalizedSearch) return true;
      const haystack = [p.name, p.client, p.area].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [filters, pipelines, layers.pipelines]);

  const mapSites = useMemo(() => {
    let baseSites = visibleSites;
    
    // Add preview location when in edit mode
    if (isPickingLocationForEdit && editPickLocation && editPickLocation !== 'requested' && selectedSite) {
      const previewSite = {
        ...selectedSite,
        latitude: editPickLocation.latitude,
        longitude: editPickLocation.longitude,
        id: `preview-${selectedSite.id}`,
        cacheId: `preview-${selectedSite.id}`,
        _isPreview: true
      };
      
      // Filter out the original site and add the preview
      baseSites = baseSites.filter((s) => !matchSiteIdentity(s, selectedSite));
      baseSites = [...baseSites, previewSite];
    }
    
    // Always overlay water pins if their layer is on, even when other filters are active
    if (layers.water) {
      const visibleIds = new Set(baseSites.map((s) => siteIdentityKey(s)));
      const waterOverlay = sites.filter((s) => s.pin_type === 'water' && !isHiddenSite(s) && !visibleIds.has(siteIdentityKey(s)));
      if (waterOverlay.length) return [...baseSites, ...waterOverlay];
    }
    return baseSites;
  }, [visibleSites, sites, layers.water, isPickingLocationForEdit, editPickLocation, selectedSite]);

  // Dedupe the dropdown by canonical (case-insensitive, whitespace-
  // collapsed) key so "ABC Energy" and "abc energy" don't both appear.
  // Display the Title-Case form so the visible label is consistent
  // regardless of how the underlying rows were typed.
  const clients = useMemo(() => {
    const seen = new Map();
    for (const value of [...sites.map((s) => s.client), ...pipelines.map((p) => p.client)]) {
      const key = nameKey(value);
      if (!key || seen.has(key)) continue;
      seen.set(key, normalizeName(value));
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [sites, pipelines]);
  // LSD-label suggestions shown under the "LSD or site label" input in the
  // add-pin popup. Sorted by label for predictable scanning — workers
  // usually know roughly what LSD they expect ("16-..."), so alphabetical
  // beats "most recent" here. The `sub` line surfaces client · area ·
  // pin-type so two sites that share an LSD string (e.g. a pipeline pull
  // and a valve across the quarter) are still distinguishable. Pending &
  // approved sites are both included so a worker editing their own
  // pending submission can still see the previous spelling.
  const lsdSuggestions = useMemo(() => {
    const seen = new Map();
    for (const s of sites) {
      const label = (s.lsd || '').trim();
      if (!label) continue;
      // Keep the first occurrence per (label + client + area) combo — a
      // Map keyed on that tuple prevents duplicates when the same LSD
      // row was fetched twice (e.g. during a delta-sync merge).
      const key = `${label.toLowerCase()}|${(s.client || '').toLowerCase()}|${(s.area || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      const subBits = [];
      if (s.client) subBits.push(s.client);
      if (s.area) subBits.push(s.area);
      if (s.pin_type && s.pin_type !== 'lsd') subBits.push(s.pin_type);
      seen.set(key, { label, sub: subBits.join(' · '), site: s });
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [sites]);

  // Same dedupe-by-canonical-key treatment as `clients` above.
  const areas = useMemo(() => {
    const seen = new Map();
    for (const value of [...sites.map((s) => s.area), ...pipelines.map((p) => p.area)]) {
      const key = nameKey(value);
      if (!key || seen.has(key)) continue;
      seen.set(key, normalizeName(value));
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [sites, pipelines]);

  // Area suggestions narrowed by a given client name. If the caller's
  // client field is empty or doesn't match any existing site/pipeline,
  // the full area list is returned so typing area-first still surfaces
  // useful suggestions. This mirrors FilterBar's client-scoped area
  // behaviour — keeps every form-with-client-and-area in sync.
  //
  // Lifted out of `areasForAddPinClient` (which used to be a one-off
  // useMemo wired to the in-map popup) so the same narrowing logic is
  // available to AddPinForm, SiteDetailSheet, PipelineDetailSheet, and
  // ApproveEditModal — i.e. every place a worker or admin types client
  // and area together.
  const getAreasForClient = useCallback((clientName) => {
    const clientKey = nameKey(clientName);
    if (!clientKey) return areas;
    // Dedupe by canonical key, display Title-Case — same approach as
    // the top-level `areas` memo so dropdown rows are consistent
    // whether the user has a client filter set or not.
    const seen = new Map();
    for (const s of sites) {
      if (nameKey(s.client) !== clientKey) continue;
      const k = nameKey(s.area);
      if (!k || seen.has(k)) continue;
      seen.set(k, normalizeName(s.area));
    }
    for (const p of pipelines) {
      if (nameKey(p.client) !== clientKey) continue;
      const k = nameKey(p.area);
      if (!k || seen.has(k)) continue;
      seen.set(k, normalizeName(p.area));
    }
    const result = [...seen.values()].sort((a, b) => a.localeCompare(b));
    // If the scoped list is empty (e.g. a brand-new client being typed
    // for the first time) fall back to the full list so we still offer
    // something useful instead of an invisible dropdown.
    return result.length > 0 ? result : areas;
  }, [sites, pipelines, areas]);

  const areasForAddPinClient = useMemo(
    () => getAreasForClient(addPinForm.client),
    [getAreasForClient, addPinForm.client]
  );

  // Duplicate-LSD detector for the add-pin popup. Important UX rule:
  // selecting an existing Client or Area must NEVER imply a duplicate
  // pin — workers routinely add brand-new LSDs under existing jobs.
  // Therefore the warning is tied only to an explicit selection from
  // the LSD/site-label suggestion list. Free-typed values (even if
  // they eventually match something) stay quiet; the suggestion list is
  // the duplicate-discovery UI, and the warning is just the confirmation
  // that "you picked an existing site label". This also prevents a
  // newly-saved optimistic site from warning about itself while the
  // popup is in the middle of closing.
  const duplicateLsdSite = useMemo(() => {
    if (!selectedAddPinLsdSuggestion?.site) return null;
    const selectedLabel = (selectedAddPinLsdSuggestion.label || '').trim().toLowerCase();
    const currentLabel = (addPinForm.lsd || '').trim().toLowerCase();
    if (!selectedLabel || selectedLabel !== currentLabel) return null;
    return selectedAddPinLsdSuggestion.site;
  }, [selectedAddPinLsdSuggestion, addPinForm.lsd]);

  function handleOpenDetail(site, options = {}) {
    setSelectedDevice(null);
    // Close pipeline detail if open
    if (pipelineDetailOpen) {
      setPipelineDetailOpen(false);
      setSelectedPipeline(null);
      setPipelineSprayRecords([]);
      setHighlightedSprayRecordId(null);
    }
    if (isHiddenSite(site)) {
      setSites((prev) => removeSitesByIdentity(prev, site));
      setSelectedSite(null);
      setDetailOpen(false);
      void removeSite(site);
      return;
    }
    setSelectedSite(site);
    setDetailOpen(true);
    // Only trigger zoomToSite on phones, or on PC/iPad if coming from sites list (just center, no zoom)
    const isPhone = (window.innerWidth <= 480 || window.innerHeight <= 600) &&
                    /Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isPhone || options.fromSitesList) {
      setZoomTarget({ ...site, _ts: Date.now(), _centerOnly: options.fromSitesList && !isPhone });
    }
    // Hydrate the heavy fields (spray_records, updates, raw_attributes,
    // nested user objects) that the slim list/delta schema doesn't ship.
    // Mirrors handleOpenPipelineDetail's /api/pipelines/{id} call — keeps
    // the map/list egress tiny while the detail view still shows full data.
    if (Number.isInteger(site.id) && window.navigator.onLine) {
      api.getSite(site.id).then((full) => {
        if (!full) return;
        if (isHiddenSite(full)) {
          setSites((prev) => removeSitesByIdentity(prev, full));
          setSelectedSite((prev) => (matchSiteIdentity(prev, full) ? null : prev));
          setDetailOpen(false);
          void removeSite(full);
          return;
        }
        setSelectedSite((prev) => (matchSiteIdentity(prev, full) ? { ...prev, ...full } : prev));
        // Also fold the heavy fields into the cached list so re-opening the
        // same site (or a sibling delta tick) doesn't wipe them.
        setSites((prev) => prev.map((s) => (matchSiteIdentity(s, full) ? { ...s, ...full } : s)));
      }).catch((error) => {
        if (error?.status === 404 || error?.status === 410) {
          setSites((prev) => removeSitesByIdentity(prev, site));
          setSelectedSite((prev) => (matchSiteIdentity(prev, site) ? null : prev));
          setDetailOpen(false);
          void removeSite(site);
        }
      });
    }
  }

  const touchStartY = useRef(null);
  const touchStartScrollTop = useRef(0);
  const pullDistance = useRef(0);
  const detailBodyRef = useRef(null);

  // Touch handlers for pipeline detail panel (swipe down to dismiss)
  const pipelineTouchStartY = useRef(null);
  const pipelineTouchStartScrollTop = useRef(0);
  const pipelinePullDistance = useRef(0);
  const pipelineDetailBodyRef = useRef(null);

  // Swipe detection refs for side panels
  const sitesPanelTouchStartX = useRef(null);
  const formsPanelTouchStartX = useRef(null);
  const adminPanelTouchStartX = useRef(null);
  const SWIPE_THRESHOLD = 50;

  // Live swipe state for side panels (track actual pixel offset during drag)
  const [sitesPanelDragOffset, setSitesPanelDragOffset] = useState(0);
  const [formsPanelDragOffset, setFormsPanelDragOffset] = useState(0);
  const [adminPanelDragOffset, setAdminPanelDragOffset] = useState(0);
  const [sitesPanelDragging, setSitesPanelDragging] = useState(false);
  const [formsPanelDragging, setFormsPanelDragging] = useState(false);
  const [adminPanelDragging, setAdminPanelDragging] = useState(false);

  // Live swipe state for bottom sheets (detail panels)
  const [detailDragOffset, setDetailDragOffset] = useState(0);
  const [pipelineDragOffset, setPipelineDragOffset] = useState(0);
  const [detailDragging, setDetailDragging] = useState(false);
  const [pipelineDragging, setPipelineDragging] = useState(false);

  // Live swipe handlers for side panels (left-to-right swipe to close with live tracking)
  // Panel width for calculating halfway threshold
  const getPanelWidth = () => {
    if (typeof window === 'undefined') return 380;
    return window.innerWidth <= 768 ? window.innerWidth : 380;
  };

  // Sites panel live swipe
  const handleSitesPanelTouchStart = (e) => {
    if (activeTab !== TAB_SITES) return;
    sitesPanelTouchStartX.current = e.touches[0].clientX;
    setSitesPanelDragging(true);
    setSitesPanelDragOffset(0);
  };

  const handleSitesPanelTouchMove = (e) => {
    if (sitesPanelTouchStartX.current === null) return;
    const currentX = e.touches[0].clientX;
    const delta = currentX - sitesPanelTouchStartX.current;
    // Only allow dragging to the right (positive delta)
    if (delta > 0) {
      setSitesPanelDragOffset(delta);
      e.preventDefault();
    }
  };

  const handleSitesPanelTouchEnd = (e) => {
    if (sitesPanelTouchStartX.current === null) return;
    const panelWidth = getPanelWidth();
    // If dragged more than halfway, close; otherwise snap back
    if (sitesPanelDragOffset > panelWidth / 2) {
      setActiveTab(TAB_MAP);
    }
    sitesPanelTouchStartX.current = null;
    setSitesPanelDragging(false);
    setSitesPanelDragOffset(0);
  };

  // Forms panel live swipe
  const handleFormsPanelTouchStart = (e) => {
    if (activeTab !== TAB_FORMS) return;
    formsPanelTouchStartX.current = e.touches[0].clientX;
    setFormsPanelDragging(true);
    setFormsPanelDragOffset(0);
  };

  const handleFormsPanelTouchMove = (e) => {
    if (formsPanelTouchStartX.current === null) return;
    const currentX = e.touches[0].clientX;
    const delta = currentX - formsPanelTouchStartX.current;
    if (delta > 0) {
      setFormsPanelDragOffset(delta);
      e.preventDefault();
    }
  };

  const handleFormsPanelTouchEnd = (e) => {
    if (formsPanelTouchStartX.current === null) return;
    const panelWidth = getPanelWidth();
    if (formsPanelDragOffset > panelWidth / 2) {
      setActiveTab(TAB_MAP);
    }
    formsPanelTouchStartX.current = null;
    setFormsPanelDragging(false);
    setFormsPanelDragOffset(0);
  };

  // Admin panel live swipe
  const handleAdminPanelTouchStart = (e) => {
    if (activeTab !== TAB_ADMIN) return;
    adminPanelTouchStartX.current = e.touches[0].clientX;
    setAdminPanelDragging(true);
    setAdminPanelDragOffset(0);
  };

  const handleAdminPanelTouchMove = (e) => {
    if (adminPanelTouchStartX.current === null) return;
    const currentX = e.touches[0].clientX;
    const delta = currentX - adminPanelTouchStartX.current;
    if (delta > 0) {
      setAdminPanelDragOffset(delta);
      e.preventDefault();
    }
  };

  const handleAdminPanelTouchEnd = (e) => {
    if (adminPanelTouchStartX.current === null) return;
    const panelWidth = getPanelWidth();
    if (adminPanelDragOffset > panelWidth / 2) {
      setActiveTab(TAB_MAP);
    }
    adminPanelTouchStartX.current = null;
    setAdminPanelDragging(false);
    setAdminPanelDragOffset(0);
  };

  function handleCloseDetail() {
    setDetailOpen(false);
  }

  // Bottom sheet height for calculating halfway threshold
  const getBottomSheetHeight = () => {
    if (typeof window === 'undefined') return window.innerHeight * 0.55;
    return window.innerHeight <= 768 ? window.innerHeight * 0.55 : 400;
  };

  // Live swipe handlers for site detail bottom sheet
  // Refs for tracking if touch started from header/drag handle
  const detailTouchFromHeader = useRef(false);
  const pipelineTouchFromHeader = useRef(false);

  function handleTouchStart(e) {
    const touchY = e.touches[0].clientY;
    const touchX = e.touches[0].clientX;

    // Check if touch is from header/drag handle area (target is header or its children)
    const target = e.target;
    const isHeader = target?.closest?.('.side-panel-header') || target?.classList?.contains('bottom-sheet-drag-handle');
    detailTouchFromHeader.current = !!isHeader;

    if (isHeader) {
      // Always allow swipe from header
      touchStartY.current = touchY;
      setDetailDragging(true);
      setDetailDragOffset(0);
      return;
    }

    // For body: check scroll position
    const bodyRect = detailBodyRef.current?.getBoundingClientRect();
    const scrollTop = detailBodyRef.current?.scrollTop || 0;
    // Allow swipe from anywhere in body if scrolled to top
    if (bodyRect && scrollTop <= 5) {
      touchStartY.current = touchY;
      setDetailDragging(true);
      setDetailDragOffset(0);
    } else {
      touchStartY.current = null;
    }
  }

  function handleTouchMove(e) {
    if (touchStartY.current === null) return;
    const currentY = e.touches[0].clientY;
    const delta = currentY - touchStartY.current;

    if (delta > 0) {
      setDetailDragOffset(delta);
      // Prevent scrolling while dragging down
      if (delta > 10) {
        e.preventDefault();
      }
    }
  }

  function handleTouchEnd(e) {
    if (touchStartY.current === null) return;
    const sheetHeight = getBottomSheetHeight();
    // If dragged more than halfway down, close; otherwise snap back
    if (detailDragOffset > sheetHeight / 2 && detailOpen) {
      handleCloseDetail();
    }
    touchStartY.current = null;
    detailTouchFromHeader.current = false;
    setDetailDragging(false);
    setDetailDragOffset(0);
  }

  // Live swipe handlers for pipeline detail bottom sheet
  function handlePipelineTouchStart(e) {
    const touchY = e.touches[0].clientY;

    // Check if touch is from header/drag handle area
    const target = e.target;
    const isHeader = target?.closest?.('.side-panel-header') || target?.classList?.contains('bottom-sheet-drag-handle');
    pipelineTouchFromHeader.current = !!isHeader;

    if (isHeader) {
      pipelineTouchStartY.current = touchY;
      setPipelineDragging(true);
      setPipelineDragOffset(0);
      return;
    }

    // For body: check scroll position
    const bodyRect = pipelineDetailBodyRef.current?.getBoundingClientRect();
    const scrollTop = pipelineDetailBodyRef.current?.scrollTop || 0;
    if (bodyRect && scrollTop <= 5) {
      pipelineTouchStartY.current = touchY;
      setPipelineDragging(true);
      setPipelineDragOffset(0);
    } else {
      pipelineTouchStartY.current = null;
    }
  }

  function handlePipelineTouchMove(e) {
    if (pipelineTouchStartY.current === null) return;
    const currentY = e.touches[0].clientY;
    const delta = currentY - pipelineTouchStartY.current;

    if (delta > 0) {
      setPipelineDragOffset(delta);
      if (delta > 10) {
        e.preventDefault();
      }
    }
  }

  function handlePipelineTouchEnd(e) {
    if (pipelineTouchStartY.current === null) return;
    const sheetHeight = getBottomSheetHeight();
    if (pipelineDragOffset > sheetHeight / 2 && pipelineDetailOpen) {
      handleClosePipelineDetail();
    }
    pipelineTouchStartY.current = null;
    pipelineTouchFromHeader.current = false;
    setPipelineDragging(false);
    setPipelineDragOffset(0);
  }

  function handleFabSelect(pinType) {
    setFabOpen(false);
    setAddPinType(pinType);
    setAddPinLocation(null);
    setAddPinForm({ lsd: '', client: '', area: '' });
    setSelectedAddPinLsdSuggestion(null);
  }

  function handleCancelAdd() {
    setAddPinType(null);
    setAddPinLocation(null);
    setAddPinForm({ lsd: '', client: '', area: '' });
    setSelectedAddPinLsdSuggestion(null);
  }

  // ── Pipeline handlers ──
  function handleOpenPipelineDetail(pipeline) {
    setSelectedDevice(null);
    setSelectedPipeline(pipeline);
    setPipelineDetailOpen(true);
    setDetailOpen(false);
    setSelectedSite(null);
    setZoomTarget(null); // Clear any pending site zoom
    // Fit pipeline bounds on map
    if (pipeline.coordinates && pipeline.coordinates.length >= 2 && mapRef.current && window.google) {
      const bounds = new window.google.maps.LatLngBounds();
      pipeline.coordinates.forEach(([lat, lng]) => bounds.extend({ lat, lng }));
      mapRef.current.fitBounds(bounds, { top: 50, bottom: 300, left: 50, right: 50 });
    }
    // Load spray records for this pipeline
    if (pipeline.id && window.navigator.onLine) {
      api.getPipeline(pipeline.id).then((full) => {
        setPipelineSprayRecords(full.spray_records || []);
        setSelectedPipeline(full);
      }).catch(() => {});
    }
  }

  function handleClosePipelineDetail() {
    setPipelineDetailOpen(false);
    setSelectedPipeline(null);
    setPipelineSprayRecords([]);
    setHighlightedSprayRecordId(null);
  }

  function handleLayerToggle(layerKey) {
    setLayers((prev) => ({ ...prev, [layerKey]: !prev[layerKey] }));
  }

  // Drawing pipeline on map
  function handleStartDrawingPipeline() {
    setFabOpen(false);
    setIsDrawingPipeline(true);
    setDrawingPoints([]);
    setDrawingForm({ name: '', client: '', area: '' });
    setShowDrawingForm(false);
  }

  function handleDrawingClick(point) {
    setDrawingPoints((prev) => [...prev, point]);
  }

  function handleUndoDrawingPoint() {
    setDrawingPoints((prev) => prev.slice(0, -1));
  }

  function handleFinishDrawing() {
    if (drawingPoints.length < 2) {
      setMessage('Pipeline needs at least 2 points.');
      return;
    }
    setShowDrawingForm(true);
  }

  function handleCancelDrawing() {
    setIsDrawingPipeline(false);
    setDrawingPoints([]);
    setDrawingForm({ name: '', client: '', area: '' });
    setShowDrawingForm(false);
  }

  async function handleSubmitDrawnPipeline() {
    if (drawingPoints.length < 2) return;
    setSubmittingPin(true);
    try {
      const created = await api.createPipeline({
        name: drawingForm.name || null,
        // Normalize on save so the row lands in DB in canonical Title-
        // Case form. Same canonical helper used by the dropdown dedupe,
        // so what the user picks from autocomplete and what they type
        // free-form both end up identical at rest.
        client: normalizeName(drawingForm.client) || null,
        area: normalizeName(drawingForm.area) || null,
        coordinates: drawingPoints,
      });
      setPipelines((prev) => [created, ...prev]);
      await loadPendingPipelines();
      setMessage(created.approval_state === 'approved' ? 'Pipeline added.' : 'Pipeline submitted for review.');
      handleCancelDrawing();
    } catch (error) {
      setMessage(error.message || 'Failed to create pipeline.');
    } finally {
      setSubmittingPin(false);
    }
  }

  // Spray marking. The optional `mode` arg distinguishes the
  // "Mark Inspection" entry (default 'inspection') from the
  // "⚠ Issue with Pipeline" entry ('issue'). Both flows reuse the
  // same map taps + confirm popup; the popup branches on mode to show
  // the right title and either a single Confirm button (inspection) or
  // Yes-Fill-Sheet / Skip / Cancel (issue).
  function handleStartSprayMarking(pipeline, mode = 'inspection') {
    if (!pipeline) return;
    setSelectedPipeline(pipeline);
    setIsSprayMarking(true);
    setSprayMarkingMode(mode);
    setSprayStartPoint(null);
    setSprayEndPoint(null);
    setShowSprayConfirm(false);
    setSprayForm({ date: localDateISO() });
    setPendingPipelineSegment(null);
    setPipelineDetailOpen(false); // Slide panel away
  }

  function handleCancelSprayMarking() {
    setIsSprayMarking(false);
    setSprayMarkingMode(null);
    setSprayStartPoint(null);
    setSprayEndPoint(null);
    setShowSprayConfirm(false);
    // If we were in issue mode, the reason captured by the prompt is
    // sitting in inspectionReason / inspectionSiteStatus — wipe both so
    // they don't leak into the next inspection or stale-render the
    // lease-sheet overlay if the user immediately starts a new flow.
    setInspectionReason('');
    setInspectionSiteStatus('inspected');
    if (selectedPipeline) {
      setPipelineDetailOpen(true); // Bring panel back
    }
  }

  function handleSprayClick(point) {
    if (!selectedPipeline || !selectedPipeline.coordinates) return;
    const coords = selectedPipeline.coordinates;
    const frac = nearestFraction(point, coords);

    // Prevent selecting a point that is inside an existing green area
    const isPointInside = selectedPipeline.spray_records?.some(r => {
      const minF = Math.min(r.start_fraction, r.end_fraction);
      const maxF = Math.max(r.start_fraction, r.end_fraction);
      return frac > minF + 0.001 && frac < maxF - 0.001;
    });

    if (isPointInside) {
      setMessage('Cannot select a point inside an already sprayed section.');
      return;
    }

    if (!sprayStartPoint) {
      setSprayStartPoint(point);
    } else if (!sprayEndPoint) {
      const startFrac = nearestFraction(sprayStartPoint, coords);
      const endFrac = frac;
      const minF = Math.min(startFrac, endFrac);
      const maxF = Math.max(startFrac, endFrac);

      // Prevent selecting a section that overlaps with an existing green area
      const segmentOverlaps = selectedPipeline.spray_records?.some(r => {
        const rMin = Math.min(r.start_fraction, r.end_fraction);
        const rMax = Math.max(r.start_fraction, r.end_fraction);
        return Math.max(minF, rMin) < Math.min(maxF, rMax) - 0.001;
      });

      if (segmentOverlaps) {
        setMessage('The selected section overlaps with an already sprayed area.');
        return;
      }

      setSprayEndPoint(point);
      setShowSprayConfirm(true);
    }
  }

  async function handleConfirmSpray() {
    if (!selectedPipeline || !sprayStartPoint || !sprayEndPoint) return;
    const coords = selectedPipeline.coordinates;
    if (!coords || coords.length < 2) return;

    const startFrac = nearestFraction(sprayStartPoint, coords);
    const endFrac = nearestFraction(sprayEndPoint, coords);
    const startFraction = Math.min(startFrac, endFrac);
    const endFraction = Math.max(startFrac, endFrac);
    const segmentDistanceMeters = Math.round(Math.abs(endFraction - startFraction) * (selectedPipeline.total_length_km || 0) * 1000);

    // Always forward into the pipeline lease-sheet flow. The previous
    // "is_avoided" branch (which created an avoided spray record
    // directly and skipped the lease sheet) was driven by a popup
    // checkbox that was removed once "Mark Not Inspected" in
    // PipelineDetailSheet became the canonical way to record an issue.
    setPendingPipelineSegment({
      pipelineId: selectedPipeline.id,
      start_fraction: startFraction,
      end_fraction: endFraction,
      spray_date: sprayForm.date,
      distance_meters: segmentDistanceMeters,
    });
    setInspectionSite(null);
    setInspectionPipeline(selectedPipeline);
    setIsSprayMarking(false);
    setSprayMarkingMode(null);
    setSprayStartPoint(null);
    setSprayEndPoint(null);
    setShowSprayConfirm(false);
  }

  // Issue-mode counterpart to handleConfirmSpray: instead of forwarding
  // the segment to the lease-sheet flow, create an is_avoided spray
  // record on the selected segment directly (the "Skip lease sheet"
  // path the user picked from the popup). The reason captured by the
  // ⚠ Issue with Pipeline prompt is in `inspectionReason` and gets
  // attached as the spray record's notes so it surfaces in Spray
  // History next to the segment.
  async function handleConfirmIssueSkip() {
    if (!selectedPipeline || !sprayStartPoint || !sprayEndPoint) return;
    const coords = selectedPipeline.coordinates;
    if (!coords || coords.length < 2) return;

    const startFrac = nearestFraction(sprayStartPoint, coords);
    const endFrac = nearestFraction(sprayEndPoint, coords);
    const startFraction = Math.min(startFrac, endFrac);
    const endFraction = Math.max(startFrac, endFrac);
    const reason = inspectionReason || '';
    // Treat ≥99% coverage as "the whole pipeline" so two near-end taps
    // still land on the legacy full-pipeline-issue behavior. For genuine
    // partial segments we let the backend's _update_pipeline_spray_status
    // derive the overall pipeline status from the new record set instead
    // of forcing 'issue_not_inspected' — a small problem segment on an
    // otherwise-inspected pipeline shouldn't repaint the entire line as
    // not-inspected.
    const isFullPipeline = startFraction <= 0.001 && endFraction >= 0.999;

    setAdminBusy(true);
    try {
      await api.createSprayRecord(selectedPipeline.id, {
        start_fraction: startFraction,
        end_fraction: endFraction,
        spray_date: sprayForm.date,
        notes: reason,
        is_avoided: true,
      });
      if (isFullPipeline) {
        // Same override the legacy handleMarkPipelineNotInspectedDirect
        // applied: a single is_avoided record covering 0–1 would otherwise
        // be auto-derived as 'not_sprayed' rather than 'issue_not_inspected'.
        const overridden = await api.updatePipelineStatus(selectedPipeline.id, { status: 'issue_not_inspected' });
        setPipelines((prev) => prev.map((p) => (p.id === overridden.id ? overridden : p)));
      }
      // Refresh so the detail panel shows the new spray record + final status.
      const refreshed = await api.getPipeline(selectedPipeline.id);
      setSelectedPipeline(refreshed);
      setPipelineSprayRecords(refreshed.spray_records || []);
      setPipelines((prev) => prev.map((p) => (p.id === refreshed.id ? refreshed : p)));
      setMessage(isFullPipeline ? 'Pipeline marked as issue (not inspected).' : 'Issue segment recorded.');
      setPipelineDetailOpen(true);
    } catch (err) {
      setMessage(err.message || 'Failed to save issue record.');
    } finally {
      setAdminBusy(false);
      setIsSprayMarking(false);
      setSprayMarkingMode(null);
      setSprayStartPoint(null);
      setSprayEndPoint(null);
      setShowSprayConfirm(false);
      setInspectionReason('');
      setInspectionSiteStatus('inspected');
    }
  }

  async function handleDeleteSprayRecord(recordId, pipelineId) {
    setAdminBusy(true);
    try {
      await api.deleteSprayRecord(recordId);
      const updated = await api.getPipeline(pipelineId);
      setSelectedPipeline(updated);
      setPipelineSprayRecords(updated.spray_records || []);
      setPipelines((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setMessage('Spray record deleted.');
    } catch (error) {
      setMessage(error.message || 'Failed to delete spray record.');
    } finally {
      setAdminBusy(false);
    }
  }

  async function handleUpdatePipeline(pipeline, payload) {
    if (!window.navigator.onLine) { setMessage('Online required.'); return false; }
    setAdminBusy(true);
    try {
      // Normalize free-text name fields on the way out — same rule
      // applied at create-time in handleSubmitDrawnPipeline. Only
      // touched when the caller actually included the field, so a
      // partial-update payload that doesn't change client/area stays
      // a partial update.
      const normalizedPayload = {
        ...payload,
        ...('client' in payload ? { client: normalizeName(payload.client) || null } : {}),
        ...('area' in payload ? { area: normalizeName(payload.area) || null } : {}),
      };
      const updated = await api.updatePipeline(pipeline.id, normalizedPayload);
      setPipelines((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setSelectedPipeline((prev) => prev?.id === updated.id ? { ...prev, ...updated } : prev);
      setMessage('Pipeline updated.');
      return true;
    } catch (error) {
      setMessage(error.message || 'Update failed.');
      return false;
    } finally {
      setAdminBusy(false);
    }
  }

  async function handleDeletePipeline(pipeline) {
    if (!window.navigator.onLine) { setMessage('Online required.'); return false; }
    if (!(await confirm({
      title: 'Delete pipeline',
      message: `Delete pipeline "${pipeline.name || 'Unnamed'}"? It will be moved to Recent Deletes.`,
      severity: 'danger',
      okLabel: 'Delete',
    }))) return false;
    setAdminBusy(true);

    // Snapshot for rollback on API failure.
    const wasPending = pipeline.approval_state === 'pending_review';
    const removedFromPipelines = pipelines.find((p) => p.id === pipeline.id) || null;

    // Optimistic remove from the map, admin pending list, and close the
    // detail sheet. The derivation effect keeps the "Pending: N" badge
    // in sync with the live pendingPipelines length.
    setPipelines((prev) => prev.filter((p) => p.id !== pipeline.id));
    if (wasPending) setPendingPipelines((prev) => prev.filter((p) => p.id !== pipeline.id));
    handleClosePipelineDetail();

    try {
      await api.deletePipeline(pipeline.id);
      setMessage('Pipeline moved to Recent Deletes.');
      // Background catch-up: keep loadDeletedPipelines() because the
      // deleted-pipelines list is NOT covered by runPollTick / sync-status.
      // Drop loadPendingPipelines() — runPollTick re-fetches it via
      // count-divergence detection, which would fire the same
      // /api/pending-pipelines request in parallel.
      void Promise.allSettled([
        loadDeletedPipelines(),
        runPollTickRef.current ? runPollTickRef.current() : Promise.resolve(),
      ]);
      return true;
    } catch (error) {
      // Roll back the optimistic removes so the pipeline reappears.
      if (removedFromPipelines) {
        setPipelines((prev) => (
          prev.some((p) => p.id === pipeline.id) ? prev : [removedFromPipelines, ...prev]
        ));
      }
      if (wasPending) {
        setPendingPipelines((prev) => (
          prev.some((p) => p.id === pipeline.id) ? prev : [pipeline, ...prev]
        ));
      }
      setMessage(error.message || 'Delete failed.');
      return false;
    } finally {
      setAdminBusy(false);
    }
  }

  function handleRequestEditMapPick() {
    setIsEditPickingMode(true);
    isEditPickingModeRef.current = true;
    setEditPickLocation(null);
  }

  async function handleCreateSiteSprayRecord(site, payload) {
    setStatusSaving(true);
    try {
      await api.createSiteSprayRecord(site.id, payload);
      // Refresh site data
      const updated = await api.getSite(site.id);
      setSelectedSite(updated);
      setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setMessage(payload.is_avoided ? 'Issue recorded.' : 'Spray record saved.');
    } catch (error) {
      setMessage(error.message || 'Failed to save spray record.');
    } finally {
      setStatusSaving(false);
    }
  }

  function handleImportLeaseSheet(site) {
    setLinkModalTargetSite(site);
    setShowLinkModal(true);
  }

  async function handleLinkLeaseSheetConfirm(updatedRecord, targetStatus) {
    setShowLinkModal(false);
    setLinkModalTargetSite(null);
    if (!updatedRecord?.site_id) return;
    try {
      const updated = await api.getSite(updatedRecord.site_id);
      if (updated) {
        setSites((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
        setSelectedSite((prev) => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
        await upsertSite(updated);
      }
      // Refresh recents so the moved record appears under the visible pin
      // and the standalone entry disappears. Full re-fetch is acceptable here
      // since moves are infrequent admin actions.
      loadServerRecents();
    } catch { /* non-fatal — sites delta will catch it on next tick */ }
    setMessage('Lease sheet linked successfully.');
  }

  async function handleDeleteSiteSprayRecord(recordId, siteId) {
    const ok = await confirm({ title: 'Delete spray record?', message: 'This will soft-delete the record. It can be restored from the trash.' });
    if (!ok) return;
    setAdminBusy(true);
    try {
      await api.deleteSiteSprayRecord(recordId);
      const updated = await api.getSite(siteId);
      setSelectedSite(updated);
      setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setMessage('Spray record deleted.');
    } catch (error) {
      setMessage(error.message || 'Failed to delete spray record.');
    } finally {
      setAdminBusy(false);
    }
  }

  // Lease sheet inspection handlers
  function handleStartInspection(siteOrPipeline, siteStatus = 'inspected') {
    // Close any open panels
    setDetailOpen(false);
    setPipelineDetailOpen(false);
    // Set the inspection target
    if (siteOrPipeline?.lsd !== undefined) {
      // It's a site
      setInspectionSite(siteOrPipeline);
      setInspectionPipeline(null);
      setPendingPipelineSegment(null);
      setInspectionSiteStatus(siteStatus === 'in_progress' ? 'in_progress' : 'inspected');
    } else {
      // Pipelines must start with segment selection workflow first
      setInspectionSiteStatus('inspected');
      handleStartSprayMarking(siteOrPipeline);
    }
  }

  function handleStartIssueNotInspected(siteOrPipeline, reason = '') {
    setDetailOpen(false);
    setPipelineDetailOpen(false);
    setInspectionSiteStatus('issue_not_inspected');
    setInspectionReason(reason || '');
    if (siteOrPipeline?.lsd !== undefined) {
      setInspectionSite(siteOrPipeline);
      setInspectionPipeline(null);
      setPendingPipelineSegment(null);
    } else {
      // For pipelines, drop into segment-selection mode (mode='issue')
      // so the user picks a stretch on the map; the popup that follows
      // offers Yes-Fill-Sheet (lease sheet for the segment) / Skip
      // (is_avoided record on the segment) / Cancel. The reason is
      // already in inspectionReason and inspectionSiteStatus is
      // 'issue_not_inspected', so the lease-sheet branch picks both up
      // automatically when handleConfirmSpray fires.
      setInspectionSite(null);
      handleStartSprayMarking(siteOrPipeline, 'issue');
    }
  }

  // Worker (and admin/office-impersonating-worker) "Mark as pending" on a
  // T&M ticket. Accepts an optional async `pdfFactory` — if provided, the
  // queue entry is written WITHOUT a PDF first so onClose fires immediately
  // (worker is back on the map in <1 s), then pdfFactory() runs in the
  // background and patches the IDB entry before the queue worker picks it up.
  // This removes the 2-3 s PDF generation delay from the critical path.
  async function handleQueueTMSubmit({ ticketId, payload, ticketNumber, sprayDate, pdfFactory }) {
    const queued = await queueUpload({
      targetType: 'tm_ticket',
      targetId: ticketId,
      payload,
      // Top-level display fields so the Uploading row can show something
      // useful without poking inside the API payload.
      ticket_number: ticketNumber || null,
      spray_date: sprayDate || null,
      form_type: 'tm_ticket',
    });
    await refreshUploadQueue();
    setMessage('Ticket queued for submission.');
    // Kick the queue immediately — if online it'll start uploading right
    // away; if offline it stays put and processUploadQueue retries on the
    // back-online handler.
    processUploadQueue();
    // Generate the PDF in the background AFTER returning so the sheet can
    // close instantly. updateUploadEntry patches the IDB row before the
    // queue worker reaches it (processUploadQueue runs on the next tick).
    if (typeof pdfFactory === 'function') {
      (async () => {
        try {
          const pdfBase64 = await pdfFactory();
          if (pdfBase64) {
            await updateUploadEntry(queued.id, {
              payload: { ...queued.payload, pdf_base64: pdfBase64 },
            });
          }
        } catch { /* non-fatal — upload proceeds without PDF */ }
      })();
    }
  }

  async function handleLeaseSheetSubmit(payload) {
    if (inspectionSite) {
      const sitePayload = {
        ...payload,
        site_status: inspectionSiteStatus === 'in_progress'
          ? 'in_progress'
          : inspectionSiteStatus === 'issue_not_inspected'
            ? 'issue_not_inspected'
            : 'inspected',
      };
      await queueUpload({
        targetType: 'site',
        targetId: inspectionSite.id,
        payload: sitePayload,
      });
      await refreshUploadQueue();
    } else if (inspectionPipeline && pendingPipelineSegment) {
      await queueUpload({
        targetType: 'pipeline',
        targetId: pendingPipelineSegment.pipelineId,
        payload: {
          ...payload,
          start_fraction: pendingPipelineSegment.start_fraction,
          end_fraction: pendingPipelineSegment.end_fraction,
          spray_date: payload.spray_date || pendingPipelineSegment.spray_date,
          is_avoided: false,
        },
      });
      await refreshUploadQueue();
    }

    if (inspectionSite) {
      const nextStatus = payload.is_avoided
        ? 'issue'
        : inspectionSiteStatus === 'in_progress'
          ? 'in_progress'
          : inspectionSiteStatus === 'issue_not_inspected'
            ? 'issue_not_inspected'
            : 'inspected';
      const optimistic = {
        ...inspectionSite,
        status: nextStatus,
        last_inspected_at: new Date().toISOString(),
      };
      setSites((prev) => prev.map((s) => (s.id === optimistic.id ? optimistic : s)));
      setSelectedSite(optimistic);
      await upsertSite(optimistic);
    }

    setMessage('Spray record queued for upload.');
    // Clear inspection state — user returns to map immediately
    setInspectionSite(null);
    setInspectionPipeline(null);
    setInspectionSiteStatus('inspected');
    setInspectionReason('');
    setPendingPipelineSegment(null);
    // Clear any draft-resume state and bump refresh token so drafts list re-reads IDB
    setResumingDraft(null);
    setDraftsRefreshToken((x) => x + 1);

    // Kick off background upload
    processUploadQueue();
  }

  /**
   * Open the lease-sheet editor for a recents/summary row.
   *
   * Since /api/recent-submissions and /api/sites/{id}/spray now return a
   * slimmer summary without lease_sheet_data, we have to fetch the full row
   * (with lease_sheet_data) from /api/site-spray-records/{id} before the form
   * has something to populate.
   *
   * @param {object} record   A summary row (must at least have `id`).
   * @param {object} [siteCtx] Optional site client/area/lsd overrides.
   */
  async function openEditRecord(record, siteCtx = {}) {
    if (!record?.id) return;
    setMessage('Loading record…');
    try {
      const full = await api.getSiteSprayRecord(record.id);
      setEditingSprayRecord({
        ...full,
        site_lsd: siteCtx.site_lsd ?? record.site_lsd ?? full.site_lsd,
        site_client: siteCtx.site_client ?? record.site_client ?? full.site_client,
        site_area: siteCtx.site_area ?? record.site_area ?? full.site_area,
      });
      setMessage('');
    } catch (error) {
      setMessage('Could not load record: ' + (error.message || 'unknown error'));
    }
  }

  async function handleEditSpraySubmit(payload) {
    if (!editingSprayRecord) return;
    const record = editingSprayRecord;
    // Close form immediately — upload happens in background
    setEditingSprayRecord(null);

    // Fix #2 — route through the upload queue instead of firing the PATCH
    // directly. Before this change, an edit attempted while offline threw
    // and the worker's changes were silently lost (only a transient toast
    // surfaced the error). Now the edit is durable: it persists in
    // IndexedDB until the device reconnects, and processUploadQueue
    // handles the retry loop just like the create path does.
    //
    // The edit endpoint is naturally idempotent (PATCH against the same
    // record id), so we don't need a client_submission_id here — even if
    // the request commits server-side and the client never sees the 200,
    // a retry just re-applies the same patch and produces the same row.
    await queueUpload({
      targetType: 'site_spray_edit',
      targetId: record.id,
      payload: { ...payload, site_id: record.site_id },
      // Top-level display fields so the Uploading row in FormsPanel can
      // show something meaningful for queued edits (no ticket number on
      // the queue entry — backend already assigned one to the record).
      ticket_number: record.ticket_number || payload?.ticket_number || null,
      spray_date: payload?.spray_date || record.spray_date || null,
      form_type: 'site_spray_edit',
    });
    await refreshUploadQueue();
    setMessage(window.navigator.onLine ? 'Updating record…' : 'Edit queued for upload.');
    processUploadQueue();
  }

  function handleLeaseSheetCancel() {
    if (inspectionPipeline) {
      setPipelineDetailOpen(true);
    }
    setInspectionSite(null);
    setInspectionPipeline(null);
    setInspectionSiteStatus('inspected');
    setInspectionReason('');
    setPendingPipelineSegment(null);
  }

  function handleStartStandaloneLeaseSheet() {
    setStandaloneLeaseSheet(true);
    setInspectionSite(null);
    setInspectionPipeline(null);
    setInspectionSiteStatus('inspected');
    setInspectionReason('');
    setPendingPipelineSegment(null);
    setStandalonePickedLocation(null);
    setIsStandaloneMapPicking(false);
  }

  function handleStandaloneLeaseSheetCancel() {
    setStandaloneLeaseSheet(false);
    setIsStandaloneMapPicking(false);
    setStandalonePickedLocation(null);
  }

  function handleRedirectToSite(site) {
    setStandaloneLeaseSheet(false);
    setIsStandaloneMapPicking(false);
    setStandalonePickedLocation(null);
    setInspectionSite(site);
    setInspectionSiteStatus('inspected');
    setActiveTab(TAB_MAP);
  }

  async function handleExternalLeaseSheetSubmit(payload) {
    await queueUpload({
      targetType: 'external',
      targetId: null,
      payload,
      spray_date: payload?.spray_date || null,
      form_type: 'external_lease_sheet',
    });
    await refreshUploadQueue();
    setStandaloneLeaseSheet(false);
    setIsStandaloneMapPicking(false);
    setStandalonePickedLocation(null);
    setResumingDraft(null);
    setDraftsRefreshToken((x) => x + 1);
    setMessage('External lease sheet queued for upload.');
    processUploadQueue();
  }

  function handleRequestStandaloneMapPick() {
    setIsStandaloneMapPicking(true);
    setStandalonePickedLocation(null);
    // Slide the Forms side-panel away so the worker has the full map to tap on.
    // The overlay's display:none keeps form state intact.
    setActiveTab(TAB_MAP);
  }

  // ── Hydroseed Daily Application Record (HD######) ───────────────────────
  // Opening flow: check for the user's most recent (non-deleted) daily; if
  // it exists, offer to duplicate it (carries over crew/ingredients/etc.).
  // Otherwise just open a blank form. `force` skips the prompt — used by
  // the per-record "Duplicate" button which always wants to clone.
  async function handleStartHydroseedDaily({ force = false, duplicateFrom = null } = {}) {
    setResumingHydroseedDraft(null);
    setEditingHydroseedRecord(null);
    if (duplicateFrom) {
      setHydroseedDuplicateFrom(duplicateFrom);
      setHydroseedDailyOpen(true);
      return;
    }
    if (force) {
      setHydroseedDuplicateFrom(null);
      setHydroseedDailyOpen(true);
      return;
    }
    let latest = latestHydroseedDaily;
    if (!hasFetchedLatestDaily) {
      // A background prefetch is already in-flight — await it instead of
      // firing a second network call. Falls back to a fresh fetch only if
      // the ref is somehow null (e.g. user logged in mid-render).
      try {
        latest = latestDailyFetchRef.current
          ? await latestDailyFetchRef.current
          : await api.getMyLatestHydroseedDaily();
      } catch {
        /* offline / new user — silent */
      }
    }
    if (latest) {
      const result = await confirm({
        title: 'Duplicate previous daily?',
        message: `Copy header + crew + ingredients from ${latest.record_number} (${latest.work_date}, ${latest.client || '—'} / ${latest.area || '—'})? Loads and photos will be cleared so today is a fresh entry.`,
        okLabel: 'Duplicate',
        neutralLabel: 'Start blank',
        cancelLabel: 'Cancel',
      });
      if (result === true) {
        setHydroseedDuplicateFrom(latest);
        setHydroseedDailyOpen(true);
      } else if (result === 'neutral') {
        setHydroseedDuplicateFrom(null);
        setHydroseedDailyOpen(true);
      } else {
        // result === false (Cancel or Escape or Backdrop click)
        // Abort the flow completely — do not open the modal!
        setHydroseedDuplicateFrom(null);
      }
    } else {
      // No prior daily found, start blank directly
      setHydroseedDuplicateFrom(null);
      setHydroseedDailyOpen(true);
    }
  }

  function handleHydroseedDailyCancel() {
    setHydroseedDailyOpen(false);
    setHydroseedDuplicateFrom(null);
    setResumingHydroseedDraft(null);
    setEditingHydroseedRecord(null);
    setDraftsRefreshToken((x) => x + 1);
  }

  // Receives `{ payload, mode, dailyId, draftId, recordNumber }` from
  // HydroseedDailyRecord. Queues the upload via IndexedDB so the worker
  // doesn't sit on a spinner while Dropbox + Render finish — mirroring
  // the lease-sheet `external` and TM `tm_ticket` patterns. Also wipes
  // the device-local draft (the upload-queue row is the new source of
  // truth) and kicks `processUploadQueue` immediately.
  async function handleHydroseedDailySubmit({ payload, mode, dailyId, draftId, recordNumber }) {
    setHydroseedDailyOpen(false);
    setHydroseedDuplicateFrom(null);
    setResumingHydroseedDraft(null);
    setEditingHydroseedRecord(null);

    try {
      await queueUpload({
        targetType: mode === 'edit' ? 'hydroseed_daily_edit' : 'hydroseed_daily',
        targetId: dailyId || null,
        payload,
        // Top-level display fields the FormsPanel "Uploading" row reads.
        // `record_number` is HD###### and acts as the visible label;
        // `spray_date` mirrors the lease-sheet/T&M field naming so the
        // shared FormsPanel row renderer works without a new code path.
        ticket_number: recordNumber || null,
        spray_date: payload?.work_date || null,
        form_type: mode === 'edit' ? 'hydroseed_daily_edit' : 'hydroseed_daily',
      });
      // Best-effort draft cleanup — the queue entry is now durable so we
      // don't need the local draft any more. Failures are non-fatal.
      if (draftId) {
        try { await deleteHydroseedDailyDraft(draftId); } catch { /* ignore */ }
      }
      await refreshUploadQueue();
      setDraftsRefreshToken((x) => x + 1);
      setMessage(window.navigator.onLine
        ? 'Hydroseed daily queued for upload.'
        : 'Hydroseed daily queued — will upload when online.');
      processUploadQueue();
    } catch (e) {
      setMessage('Could not queue daily: ' + (e?.message || 'unknown'));
    }
  }

  function handleCancelStandaloneMapPick() {
    setIsStandaloneMapPicking(false);
    setStandalonePickedLocation(null);
    // Return to the Forms tab so the overlay re-appears in its expected context.
    setActiveTab(TAB_FORMS);
  }

  function renderStandaloneLeaseSheet() {
    return (
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40, backgroundColor: 'rgba(0,0,0,0.5)', display: isStandaloneMapPicking ? 'none' : 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
        <Suspense fallback={null}>
          <HerbicideLeaseSheet
            standalone={true}
            isOpen={true}
            onSubmit={handleExternalLeaseSheetSubmit}
            onCancel={() => { handleStandaloneLeaseSheetCancel(); setResumingDraft(null); }}
            cachedLookups={cachedLookups}
            clients={clients}
            areas={areas}
            lsdSuggestions={lsdSuggestions}
            onRedirectToSite={handleRedirectToSite}
            onRequestMapPick={handleRequestStandaloneMapPick}
            onCancelMapPick={handleCancelStandaloneMapPick}
            pickedLocation={standalonePickedLocation}
            draft={resumingDraft}
            onDraftSaved={() => { setDraftsRefreshToken((x) => x + 1); }}
          />
        </Suspense>
      </div>
    );
  }

  function handleCancelEditMapPick() {
    setIsEditPickingMode(false);
    isEditPickingModeRef.current = false;
    setEditPickLocation(null);
    setPreviewSiteLocation(null);
  }

  function handleMapLocationPick(location) {
    if (addPinType !== null && addPinLocation === null) {
      setAddPinLocation(location);
    } else if (isEditPickingModeRef.current) {
      setEditPickLocation(location);
    } else if (isStandaloneMapPicking) {
      setStandalonePickedLocation(location);
      setIsStandaloneMapPicking(false);
      // Re-open the Forms tab so the standalone overlay (and the GPS
      // fields it just populated) is visible again.
      setActiveTab(TAB_FORMS);
    }
  }

  // Smooth location transition function
  function smoothLocationTransition(currentLocation, targetLocation, factor = 0.3) {
    if (!currentLocation) return targetLocation;
    return {
      lat: currentLocation.lat + (targetLocation.lat - currentLocation.lat) * factor,
      lng: currentLocation.lng + (targetLocation.lng - currentLocation.lng) * factor,
    };
  }

  // ── Geolocation permission tracking ───────────────────────────────────
  // Query the OS-reported permission state ONCE on mount, then subscribe
  // to changes so the watch effect below can react when the user grants
  // or revokes permission mid-session (e.g. they tapped "center on me",
  // got the prompt, and tapped Allow).
  //
  // Why this exists: without it, the watch effect below would call
  // watchPosition() on every Map-tab visibility transition, and iOS PWA
  // standalone mode treats that as a fresh permission request on every
  // cold launch — surfacing the OS prompt every time the worker opened
  // the app. By gating the watch on permission === 'granted' we only
  // surface the prompt at one well-defined moment: the first time the
  // user explicitly taps the "center on me" location button.
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoPermission('unsupported');
      return undefined;
    }
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
      // Old WKWebView versions and a few corporate browsers ship
      // navigator.geolocation without navigator.permissions. Fall back
      // to the legacy "auto-start watch on Map tab" behaviour by
      // pretending permission is granted — the watch's own error
      // callback will still surface PERMISSION_DENIED if it isn't.
      setGeoPermission('unsupported');
      return undefined;
    }

    let cancelled = false;
    let permissionStatus = null;

    const onChange = () => {
      if (cancelled || !permissionStatus) return;
      setGeoPermission(permissionStatus.state);
    };

    navigator.permissions
      .query({ name: 'geolocation' })
      .then((status) => {
        if (cancelled) return;
        permissionStatus = status;
        setGeoPermission(status.state);
        // PermissionStatus extends EventTarget; the 'change' event
        // fires when iOS / Android / a browser updates the permission
        // (user grants via prompt, revokes from Settings, etc.).
        status.addEventListener('change', onChange);
      })
      .catch(() => {
        if (cancelled) return;
        setGeoPermission('unsupported');
      });

    return () => {
      cancelled = true;
      if (permissionStatus) {
        try { permissionStatus.removeEventListener('change', onChange); } catch { /* ignore */ }
      }
    };
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) return;
    // Only auto-start the GPS watch when permission has actually been
    // granted (or the browser doesn't expose the Permissions API at all,
    // in which case we fall back to the legacy behaviour). This is the
    // change that stops iOS PWA from re-prompting on every app open: in
    // 'prompt' / 'denied' / 'unknown' states we simply don't call
    // watchPosition, so no OS prompt fires. The user can still tap the
    // "center on me" button to explicitly request location, which is
    // the one place we want the prompt to appear.
    if (geoPermission !== 'granted' && geoPermission !== 'unsupported') return;

    // Only run GPS while the Map tab is the active view AND the document
    // is actually visible. Previously the watch ran unconditionally —
    // which on an iPhone in a worker's pocket meant enableHighAccuracy
    // GPS polling at ~2 Hz for the entire shift even when the app was
    // in the background or they were on the Forms/Admin tabs. On a
    // typical 10-hour day that dominates battery drain.
    let watchId = null;

    const startWatch = () => {
      if (watchId != null) return;
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          const rawLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          };

          // Smooth location updates
          const now = Date.now();
          const timeSinceLastUpdate = now - lastLocationUpdateRef.current;

          // Update smoothing more frequently for smooth movement
          if (timeSinceLastUpdate > 50) { // Update every 50ms for smooth animation
            lastLocationUpdateRef.current = now;

            const smoothedLocation = smoothLocationTransition(smoothedLocationRef.current, rawLocation, 0.08);
            smoothedLocationRef.current = smoothedLocation;
            setUserLocation(smoothedLocation);

            // Auto-center on user if follow mode is enabled
            if (isFollowingUser && mapRef.current) {
              // Throttle follow updates to every 500ms for smooth tracking
              if (now - lastFollowUpdateRef.current > 500) {
                lastFollowUpdateRef.current = now;
                setZoomTarget({
                  latitude: smoothedLocation.lat,
                  longitude: smoothedLocation.lng,
                  _ts: Date.now(),
                  _isFollowMode: true // Mark as follow mode update
                });
              }
            }
          }
        },
        (error) => {
          console.error('Location tracking error:', error);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 5000 // Accept positions up to 5 seconds old
        }
      );
    };

    const stopWatch = () => {
      if (watchId == null) return;
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    };

    const shouldWatch = () =>
      activeTab === TAB_MAP && document.visibilityState === 'visible';

    if (shouldWatch()) startWatch();

    const onVisibilityChange = () => {
      if (shouldWatch()) startWatch();
      else stopWatch();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopWatch();
    };
  }, [isFollowingUser, activeTab, geoPermission]);

  // Continuous centering when follow mode is enabled (even when location isn't updating)
  useEffect(() => {
    if (!isFollowingUser || !userLocation) return;
    
    const interval = setInterval(() => {
      if (isFollowingUser && userLocation && mapRef.current) {
        setZoomTarget({ 
          latitude: userLocation.lat, 
          longitude: userLocation.lng, 
          _ts: Date.now(),
          _isFollowMode: true
        });
      }
    }, 1000); // Check every 1 second to allow smooth zooming
    
    return () => clearInterval(interval);
  }, [isFollowingUser, userLocation]);

  function handleMapLoad(map) {
    mapRef.current = map;
  }

  function handleCenterOnUserLocation() {
    if (!userLocation) {
      setMessage('Getting location…');
      // Request current position if we don't have one. Timeout tightened
      // from 15 s to 10 s: anything longer than that on a phone with
      // working GPS usually means permissions are denied or the OS is
      // stalling, and the worker is better served by a clear "check
      // permissions" message than waiting another 5 s for the same
      // answer.
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const location = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          };
          setUserLocation(location);
          setIsFollowingUser(true);
          setZoomTarget({ latitude: location.lat, longitude: location.lng, _ts: Date.now() });
          setMessage('Follow mode on');
          // Defensive: not every browser fires the PermissionStatus
          // 'change' event reliably (notably some iOS PWA versions),
          // so when we know the user just granted access we update the
          // tracked permission state ourselves. This unblocks the
          // watchPosition effect above so it starts continuous tracking
          // for the rest of the session — without this the worker
          // would have to keep tapping "center on me" repeatedly.
          setGeoPermission('granted');
        },
        (error) => {
          console.error('Error getting location:', error);
          // Distinguish permission-denied from timeout so the worker
          // gets an actionable message either way.
          if (error && error.code === error.PERMISSION_DENIED) {
            setMessage("Location access denied — enable in your phone's Settings → Safari/Pineview Maps → Location.");
            // Mirror the explicit denial into our tracked state so the
            // watch effect doesn't try to re-prompt on the next Map
            // tab transition. The user has to grant in Settings now;
            // tapping "center on me" again will hit this branch with
            // the same actionable message.
            setGeoPermission('denied');
          } else if (error && error.code === error.TIMEOUT) {
            setMessage("Couldn't get GPS in time. Make sure Location is on and try again.");
          } else {
            setMessage("Couldn't get location — check GPS permissions.");
          }
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        }
      );
      return;
    }
    
    // Toggle follow mode
    if (isFollowingUser) {
      setIsFollowingUser(false);
      setMessage('Follow mode off');
    } else {
      setIsFollowingUser(true);
      // Center map on current user location
      setZoomTarget({ latitude: userLocation.lat, longitude: userLocation.lng, _ts: Date.now() });
      setMessage('Follow mode on');
    }
  }

  function handleMapDismiss() {
  if (isDrawingPipeline || isSprayMarking) return; // Don't dismiss during drawing/spray
  setIsFilterOpen(false);
  setShowCrewPanel(false);
  setFabOpen(false);
  setDetailOpen(false);
  setSelectedSite(null);
  setPipelineDetailOpen(false);
  setSelectedPipeline(null);
  setPipelineSprayRecords([]);
  setHighlightedSprayRecordId(null);
  setIsEditPickingMode(false);
  setEditPickLocation(null);
  setPreviewSiteLocation(null);
  setSelectedDevice(null);
  if (activeTab !== TAB_MAP) setActiveTab(TAB_MAP);
}

  function handleSearchSelect(site) {
    // On PC/iPad, pan-only so we don't stomp the user's zoom level; on phones
    // we keep the existing behaviour (MapView will pan + zoom to 15).
    const isPhone = (window.innerWidth <= 480 || window.innerHeight <= 600) &&
                    /Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    setSelectedSite(site);
    setZoomTarget({ ...site, _ts: Date.now(), _centerOnly: !isPhone });
    setDetailOpen(true);
    setIsFilterOpen(false);
    setActiveTab(TAB_MAP);
  }

  function handleLocateDevice(device) {
    if (!device || device.last_lat == null || device.last_lng == null) return;
    const isPhone = (window.innerWidth <= 480 || window.innerHeight <= 600) &&
                    /Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    setSelectedDevice(device);
    setZoomTarget({ latitude: device.last_lat, longitude: device.last_lng, _ts: Date.now(), _centerOnly: !isPhone });
    setIsFilterOpen(false);
    setActiveTab(TAB_MAP);
  }

  // Pan/zoom the map to a crew member's last-known location and open
  // their pin popup. Triggered from the Crew sidebar's "Locate" button;
  // ``point`` is one row from ``crewMemberPoints(shift)`` -- per-member
  // so the office can locate any worker individually, not just the lead.
  function handleLocateCrew(point) {
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
    const isPhone = (window.innerWidth <= 480 || window.innerHeight <= 600) &&
                    /Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    setSelectedCrewKey(point.key);
    setZoomTarget({ latitude: point.lat, longitude: point.lon, _ts: Date.now(), _centerOnly: !isPhone });
    setActiveTab(TAB_MAP);
    // On phones the panel covers the map -- close it so the worker can
    // see the pin they just located. On desktop/iPad keep it open.
    if (isPhone) setShowCrewPanel(false);
  }

  async function handleSubmitNewPin() {
    if (!addPinLocation || !addPinType) return;
    setSubmittingPin(true);
    // Mint a UUID up front so both the online and offline paths can pass it
    // through to the backend's dedupe check (Site.raw_attributes._client_submission_id).
    // Online paths benefit too: a 504 from the gateway after the row was
    // committed would otherwise produce a duplicate pin on the user's
    // next manual retry.
    const clientSubmissionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = {
      pin_type: addPinType,
      status: 'not_inspected',
      lsd: addPinForm.lsd || null,
      // Normalize client / area on save so casing variants of the same
      // value ("ABC Energy" vs "abc energy") collapse to one canonical
      // form in DB. lsd is intentionally untouched — those are coded
      // labels with their own format conventions.
      client: normalizeName(addPinForm.client) || null,
      area: normalizeName(addPinForm.area) || null,
      latitude: addPinLocation.latitude,
      longitude: addPinLocation.longitude,
      client_submission_id: clientSubmissionId,
    };
    try {
      let submittedSite = null;
      if (window.navigator.onLine) {
        const created = await api.createSite(payload);
        setSites((current) => [created, ...current]);
        await upsertSite(created);
        // If the new pin is in pending_review, append it locally and bump
        // the count instead of awaiting a full /api/pending-sites fetch
        // (~200–600 ms on Wi-Fi). The poll loop will reconcile the server
        // truth on its next tick, but the worker sees the pending count
        // tick up immediately on submit.
        if (created.approval_state === 'pending_review' && canManagePins) {
          // Append to pendingSites; the derivation effect that locks
          // pendingSitesCount = pendingSites.length will set the topbar
          // badge. Do NOT also bump the count explicitly — if the Supabase
          // Realtime INSERT for this pin beat the HTTP response (common on
          // slow cellular), the realtime handler already added the row and
          // the derivation effect already set the count. A manual +1 on
          // top of that was the source of "Pending: 2 when I only added 1".
          setPendingSites((prev) => (prev.some((s) => s.id === created.id) ? prev : [created, ...prev]));
        }
        setMessage(created.approval_state === 'approved' ? 'Pin added.' : 'Pending pin submitted for review.');
        submittedSite = created;
      } else {
        const tempId = `temp-${crypto.randomUUID()}`;
        const optimisticSite = {
          ...payload,
          id: tempId,
          cacheId: tempId,
          approval_state: canManagePins ? 'approved' : 'pending_review',
          source: 'field_added',
          source_name: null,
          raw_attributes: null,
          gate_code: null,
          phone_number: null,
          notes: null,
          pending_pin_type: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_inspected_at: null,
          created_by_user_id: null,
          approved_by_user_id: canManagePins ? user?.id : null,
          updates: [],
        };
        await queueAction({ type: 'create_site', payload });
        await upsertSite(optimisticSite);
        setSites((current) => [optimisticSite, ...current]);
        await refreshQueueCount();
        setMessage('Offline: pin queued for sync.');
        submittedSite = optimisticSite;
      }

      // Detect whether the user's current filter / layer settings would
      // silently hide this fresh pin, which was the root cause of the
      // "shows up in pending but not on the map" glitch. If so, clear
      // the offending knobs in-place so the worker actually sees the
      // exclamation they just placed, and surface a toast-style banner
      // naming what was cleared. `canManagePins` pins are auto-approved
      // so the approval filter is the most common offender; tight
      // client/area filters can bite too on admin sessions that stayed
      // filtered to one job site.
      if (submittedSite) {
        const hidingEntries = getFiltersHidingSite(submittedSite, filters, layers);
        if (hidingEntries.length > 0) {
          const hasFilterHit = hidingEntries.some((h) => h.kind === 'filter');
          const hasLayerHit = hidingEntries.some((h) => h.kind === 'layer');
          if (hasFilterHit) {
            setFilters((prev) => {
              const next = { ...prev };
              for (const h of hidingEntries) {
                if (h.kind === 'filter') next[h.key] = '';
              }
              return next;
            });
          }
          if (hasLayerHit) {
            setLayers((prev) => {
              const next = { ...prev };
              for (const h of hidingEntries) {
                if (h.kind === 'layer') next[h.key] = true;
              }
              return next;
            });
          }
          const labels = hidingEntries.map((h) => h.label);
          const joined = labels.length === 1
            ? labels[0]
            : labels.length === 2
              ? `${labels[0]} and ${labels[1]}`
              : `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
          showPinSubmitBanner(`Pin added — cleared ${joined} so you can see it on the map.`);
        } else {
          const label = submittedSite.approval_state === 'approved' ? 'Pin added.' : 'Pending pin submitted — look for the ! marker.';
          showPinSubmitBanner(label);
        }
      }

      setSubmittingPin(false);
      handleCancelAdd();
    } catch (error) {
      console.error('[PIN] Error creating pin:', error);
      setSubmittingPin(false);
      setMessage(error.message || 'Unable to submit pin.');
    }
  }

  async function handleSyncCurrentView() {
    if (!window.navigator.onLine) {
      setMessage('You are offline.');
      return;
    }
    setIsSyncing(true);
    try {
      await syncQueuedActions();
      await loadServerSites();
      setMessage('Synced.');
    } catch (error) {
      setMessage(error.message || 'Sync failed.');
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleAdminUpdateSite(site, payload) {
    if (!Number.isInteger(site.id)) { setMessage('Sync this pin first.'); return false; }
    if (!window.navigator.onLine) { setMessage('Online required.'); return false; }
    setAdminBusy(true);
    try {
      // Normalize client / area on the way out — same rule applied at
      // create-time in handleSubmitNewPin. Only touched when the
      // caller actually included the field so partial updates stay
      // partial.
      const normalizedPayload = {
        ...payload,
        ...('client' in payload ? { client: normalizeName(payload.client) || null } : {}),
        ...('area' in payload ? { area: normalizeName(payload.area) || null } : {}),
      };
      const updated = await api.updateSite(site.id, normalizedPayload);
      setSites((current) => current.map((item) => (matchSiteIdentity(item, site) ? updated : item)));
      await upsertSite(updated);
      setSelectedSite(updated);
      await loadPendingSites();
      setMessage('Pin updated.');
      return true;
    } catch (error) {
      setMessage(error.message || 'Update failed.');
      return false;
    } finally { setAdminBusy(false); }
  }

  async function handleDeleteSite(site) {
    if (!Number.isInteger(site.id)) { setMessage('Sync this pin first.'); return false; }
    if (!window.navigator.onLine) { setMessage('Online required.'); return false; }
    setAdminBusy(true);

    // Snapshot for rollback on API failure.
    const wasPending = site.approval_state === 'pending_review';
    const removedFromSites = sites.find((item) => matchSiteIdentity(item, site)) || null;

    // Optimistic removal — pin disappears from the map, the admin pending
    // list, and the detail sheet closes INSTANTLY. The derivation effect
    // above picks up the pendingSites shrink and decrements the topbar
    // "Pending: N" badge in the same React tick.
    setSites((prev) => prev.filter((item) => !matchSiteIdentity(item, site)));
    if (wasPending) setPendingSites((prev) => prev.filter((s) => s.id !== site.id));
    setSelectedSite(null);
    setDetailOpen(false);

    try {
      await api.deleteSite(site.id);
      await removeSite(site);
      setMessage('Pin deleted.');
      // Background catch-up — runPollTick re-fetches pendingSites only
      // when the count actually diverges (which it will, since this
      // delete just shrunk the count by 1 if it was pending). Avoids
      // the parallel duplicate /api/pending-sites round-trip that
      // calling loadPendingSites() alongside would produce.
      // loadPendingSites() doubles as loadDeletedSites() (single
      // endpoint serves both) so the Recent Deletes list still
      // catches up — runPollTick triggers it on the next tick if
      // the count changes.
      try { runPollTickRef.current?.(); } catch { /* non-fatal */ }
      return true;
    } catch (error) {
      // Roll back optimistic state so the user doesn't lose the pin silently.
      if (removedFromSites) {
        setSites((prev) => (
          prev.some((s) => matchSiteIdentity(s, site)) ? prev : [removedFromSites, ...prev]
        ));
      }
      if (wasPending) {
        setPendingSites((prev) => (prev.some((s) => s.id === site.id) ? prev : [site, ...prev]));
      }
      setMessage(error.message || 'Delete failed.');
      return false;
    } finally { setAdminBusy(false); }
  }

  async function handleQuickEdit(site, payload) {
    if (!Number.isInteger(site.id)) { setMessage('Sync this pin first.'); return false; }
    if (!window.navigator.onLine) { setMessage('Online required.'); return false; }
    try {
      const updated = await api.quickEditSite(site.id, payload);
      setSites((current) => current.map((item) => (matchSiteIdentity(item, site) ? updated : item)));
      await upsertSite(updated);
      setSelectedSite(updated);
      setMessage('Details saved.');
      return true;
    } catch (error) {
      setMessage(error.message || 'Save failed.');
      return false;
    }
  }

  async function handleStatusChange(site, status, note) {
    if (!Number.isInteger(site.id)) { setMessage('Sync this pin first.'); return; }
    setStatusSaving(true);
    // Optimistic update: change color instantly on the device
    const optimistic = { ...site, status, updated_at: new Date().toISOString(), ...(status === 'inspected' || status === 'in_progress' ? { last_inspected_at: new Date().toISOString() } : {}) };
    setSites((current) => current.map((item) => (matchSiteIdentity(item, site) ? optimistic : item)));
    setSelectedSite(optimistic);
    try {
      if (window.navigator.onLine) {
        const updated = await api.updateSiteStatus(site.id, { status, note });
        setSites((current) => current.map((item) => (matchSiteIdentity(item, site) ? updated : item)));
        await upsertSite(updated);
        setSelectedSite(updated);
        setMessage('Status updated.');
      } else {
        const optimisticSite = { ...site, status, last_inspected_at: status === 'inspected' || status === 'in_progress' ? new Date().toISOString() : null, updated_at: new Date().toISOString() };
        await queueAction({ type: 'update_status', payload: { siteId: site.id, body: { status, note } } });
        await upsertSite(optimisticSite);
        setSites((current) => current.map((item) => (matchSiteIdentity(item, site) ? optimisticSite : item)));
        setSelectedSite(optimisticSite);
        await refreshQueueCount();
        setMessage('Offline: queued.');
      }
    } catch (error) { 
      console.error('[STATUS] Error updating status:', error);
      setMessage(error.message || 'Status update failed.'); 
    }
    finally { setStatusSaving(false); }
  }

  async function handleRequestTypeChange(site, newPinType) {
    if (!Number.isInteger(site.id)) { setMessage('Sync first.'); return; }
    if (!window.navigator.onLine) { setMessage('Online required.'); return; }
    setAdminBusy(true);
    try {
      const updated = await api.requestTypeChange(site.id, { pin_type: newPinType });
      setSites((current) => current.map((item) => (matchSiteIdentity(item, site) ? updated : item)));
      await upsertSite(updated);
      setSelectedSite(updated);
      await loadPendingSites();
      setMessage('Type change submitted.');
    } catch (error) { setMessage(error.message || 'Failed.'); }
    finally { setAdminBusy(false); }
  }

  // Target of the Approve & Edit review modal. Either null (modal closed)
  // or { kind: 'site'|'pipeline', target: <row> }.
  const [approveEditTarget, setApproveEditTarget] = useState(null);

  function handleApproveAndEdit(site) {
    setApproveEditTarget({ kind: 'site', target: site });
  }

  function handleApprovePipelineAndEdit(pipeline) {
    setApproveEditTarget({ kind: 'pipeline', target: pipeline });
  }

  // Surfaces a structured 409 from the approval endpoint (reject branch
  // only — the approve branch is handled inside ApproveEditModal). Keeps
  // the user's billable work intact by refusing to reject a pin that
  // still has linked lease sheets.
  // Async because the styled dialog returns a Promise (the previous
  // native alert was synchronous). Both callers below await this; the
  // boolean return value tells them whether they handled the error
  // surface themselves (true) or the caller should fall back to the
  // generic setMessage(...) toast (false).
  async function explainRejectConflict(error, kind = 'site') {
    const detail = error?.detail;
    if (!detail || detail.reason !== 'has_linked_spray_records') return false;
    const linked = detail.linked_spray_records || [];
    const lines = linked.map((r) => {
      const date = r.spray_date ? ` (${r.spray_date})` : '';
      const tn = r.ticket_number ? ` ${r.ticket_number}` : ` #${r.id}`;
      return `• Lease sheet${tn}${date}${r.is_avoided ? ' [avoided]' : ''}`;
    }).join('\n');
    await alert({
      title: `Cannot reject ${kind}`,
      message:
        `${linked.length} lease sheet(s) are still linked:\n\n${lines}\n\n` +
        'Delete those lease sheets (and any linked T&M rows) first, then retry reject.',
      severity: 'danger',
    });
    return true;
  }

  // Wrapper used by every admin action button (approve, reject, restore,
  // delete-permanent, bulk-reset, KML import, …). Previously this awaited
  // `refreshAllData()` after every success, which on Wi-Fi added ~1–2 s of
  // perceived latency between the click and the card disappearing — the
  // single most-common "feels sluggish" complaint. Now:
  //
  //   1. Caller can pass an `optimistic` thunk that mutates local state
  //      immediately (e.g. filter the approved row out of `pendingSites`)
  //      so the UI reacts before the network roundtrip.
  //   2. After the API call succeeds we kick off a CHEAP background refresh
  //      (delta poll + targeted pending re-fetch) WITHOUT awaiting it, so
  //      `setAdminBusy(false)` fires the moment the server confirms.
  //   3. On failure we still do a full `refreshAllData()` to undo whatever
  //      the optimistic mutation did and pick up the real server truth.
  //
  // Net: card vanishes in <50 ms instead of 1–2 s; egress drops because
  // we no longer re-download 9 list endpoints after every click.
  async function runAdminAction(action, successMessage, options = {}) {
    const { optimistic, pendingMessage } = options;
    setAdminBusy(true);
    if (typeof optimistic === 'function') {
      try { optimistic(); } catch { /* non-fatal */ }
    } else if (pendingMessage) {
      // Non-optimistic admin actions (bulk-reset, KML import, restore,
      // delete-permanent on items that don't have a local snapshot yet)
      // have no instant UI change the user can react to. Show the
      // caller-supplied "Working…" message up-front so the click feels
      // acknowledged instead of dead until the server ack arrives —
      // which for KML imports can be 5–20 s on a large file.
      setMessage(pendingMessage);
    }
    try {
      await action();
      setMessage(successMessage);
      // Background-only catch-up: the user has already seen the optimistic
      // change; this just confirms server-derived fields (e.g. server
      // timestamps) match.
      //
      // We deliberately call ONLY runPollTick here, not
      // loadPendingSites / loadPendingPipelines. runPollTick reads
      // /api/sync-status (~100B) and only re-fetches the pending
      // lists when the server-reported count diverges from what we
      // last saw — which is exactly when the action just changed
      // them. Calling the load helpers explicitly here used to fire
      // the SAME pending-list endpoints in parallel with the poll
      // tick (4 round-trips for 2 lists, every admin click), which
      // accounted for most of the post-action burst traffic that
      // showed up as orange p95 alerts on Render. No await on
      // purpose — the optimistic UI is already correct.
      try { runPollTickRef.current?.(); } catch { /* non-fatal */ }
    } catch (error) {
      setMessage(error.message || 'Admin action failed.');
      // Full refresh on failure so the optimistic change is rolled back
      // to whatever the server actually says.
      void refreshAllData();
    } finally {
      setAdminBusy(false);
    }
  }

  async function handleBulkApprovePending() {
    const items = [
      ...pendingSites.map((site) => ({ kind: 'pin', id: site.id })),
      ...pendingPipelines.map((pipeline) => ({ kind: 'pipeline', id: pipeline.id })),
    ];
    if (items.length === 0) return;
    setAdminBusy(true);
    setMessage(`Approving ${items.length} pending approval${items.length === 1 ? '' : 's'}…`);
    const failed = [];
    try {
      for (const item of items) {
        try {
          if (item.kind === 'pin') {
            await api.approveSite(item.id, { approval_state: 'approved' });
          } else {
            await api.approvePipeline(item.id, { approval_state: 'approved' });
          }
        } catch (error) {
          failed.push(error);
        }
      }
      await refreshAllData();
      const approved = items.length - failed.length;
      setMessage(failed.length > 0
        ? `Approved ${approved} of ${items.length}. ${failed.length} failed.`
        : `Approved ${approved} pending approval${approved === 1 ? '' : 's'}.`);
    } finally {
      setAdminBusy(false);
    }
  }

  async function handleBulkRejectPending() {
    const items = [
      ...pendingSites.map((site) => ({ kind: 'pin', id: site.id })),
      ...pendingPipelines.map((pipeline) => ({ kind: 'pipeline', id: pipeline.id })),
    ];
    if (items.length === 0) return;
    setAdminBusy(true);
    setMessage(`Rejecting ${items.length} pending approval${items.length === 1 ? '' : 's'}…`);

    // Optimistic remove from the live map arrays so the orange "!" markers
    // disappear in the same React tick as the click. refreshAllData() at
    // the bottom will reconcile any rejection that the server refused
    // (e.g. linked-lease-sheet 409s) by re-fetching the authoritative
    // sites list — rejected rows stay filtered out of /api/sites and
    // pinned rows that came back will reappear.
    const pinIds = new Set(items.filter((i) => i.kind === 'pin').map((i) => i.id));
    const pipelineIds = new Set(items.filter((i) => i.kind === 'pipeline').map((i) => i.id));
    if (pinIds.size > 0) setSites((prev) => prev.filter((s) => !pinIds.has(s.id)));
    if (pipelineIds.size > 0) setPipelines((prev) => prev.filter((p) => !pipelineIds.has(p.id)));
    setPendingSites((prev) => prev.filter((s) => !pinIds.has(s.id)));
    setPendingPipelines((prev) => prev.filter((p) => !pipelineIds.has(p.id)));

    const failed = [];
    try {
      for (const item of items) {
        try {
          if (item.kind === 'pin') {
            await api.approveSite(item.id, { approval_state: 'rejected' });
          } else {
            await api.approvePipeline(item.id, { approval_state: 'rejected' });
          }
        } catch (error) {
          failed.push(error);
        }
      }
      await refreshAllData();
      const rejected = items.length - failed.length;
      if (failed.length > 0) {
        const blocked = failed.filter((error) => error?.detail?.reason === 'has_linked_spray_records').length;
        setMessage(`Rejected ${rejected} of ${items.length}. ${failed.length} failed.${blocked > 0 ? ` ${blocked} blocked by linked lease sheets.` : ''}`);
      } else {
        setMessage(`Rejected ${rejected} pending approval${rejected === 1 ? '' : 's'}.`);
      }
    } finally {
      setAdminBusy(false);
    }
  }

  async function handleRestoreSite(siteId) {
    await runAdminAction(
      () => api.restoreSite(siteId),
      'Pin restored successfully.',
      {
        // Yank the row out of Recent Deletes immediately so the admin
        // sees the action take effect before the network roundtrip.
        optimistic: () => setDeletedSites((prev) => prev.filter((s) => s.id !== siteId)),
      }
    );
  }

  async function handleDeletePermanent(siteId) {
    await runAdminAction(
      () => api.deleteSitePermanent(siteId),
      'Pin permanently deleted.',
      {
        optimistic: () => setDeletedSites((prev) => prev.filter((s) => s.id !== siteId)),
      }
    );
  }

  async function handleRestoreLeaseSheet(record) {
    const isSite = record.site_id != null;
    await runAdminAction(async () => {
      if (isSite) {
        await api.restoreSiteSprayRecord(record.id);
      } else {
        await api.restoreSprayRecord(record.id);
      }
      await loadDeletedLeaseSheets();
      await handleRequestSync();
    }, 'Lease sheet restored successfully.', {
      optimistic: () => setDeletedLeaseSheets((prev) => prev.filter((r) => r.id !== record.id)),
    });
  }

  async function handleDeleteLeaseSheetPermanent(record) {
    const isSite = record.site_id != null;
    await runAdminAction(async () => {
      if (isSite) {
        await api.deleteSiteSprayRecordPermanent(record.id);
      } else {
        await api.deleteSprayRecordPermanent(record.id);
      }
      await loadDeletedLeaseSheets();
    }, 'Lease sheet permanently deleted.', {
      optimistic: () => setDeletedLeaseSheets((prev) => prev.filter((r) => r.id !== record.id)),
    });
  }

  async function handleRestoreTMTicket(ticketId) {
    await runAdminAction(async () => {
      await api.restoreTMTicket(ticketId);
      await loadDeletedTMTickets();
    }, 'T&M ticket restored successfully.', {
      optimistic: () => setDeletedTMTickets((prev) => prev.filter((t) => t.id !== ticketId)),
    });
  }

  async function handleDeleteTMTicketPermanent(ticketId) {
    await runAdminAction(async () => {
      await api.deleteTMTicketPermanent(ticketId);
      await loadDeletedTMTickets();
    }, 'T&M ticket permanently deleted.', {
      optimistic: () => setDeletedTMTickets((prev) => prev.filter((t) => t.id !== ticketId)),
    });
  }

  async function handleRestoreHydroseedDaily(dailyId) {
    await runAdminAction(async () => {
      await api.restoreHydroseedDaily(dailyId);
      await loadDeletedHydroseedDailies();
    }, 'Hydroseed daily restored successfully.', {
      optimistic: () => setDeletedHydroseedDailies((prev) => prev.filter((d) => d.id !== dailyId)),
    });
  }

  async function handleDeleteHydroseedDailyPermanent(dailyId) {
    await runAdminAction(async () => {
      await api.deleteHydroseedDailyPermanent(dailyId);
      await loadDeletedHydroseedDailies();
    }, 'Hydroseed daily permanently deleted.', {
      optimistic: () => setDeletedHydroseedDailies((prev) => prev.filter((d) => d.id !== dailyId)),
    });
  }

  async function handleRestoreHydroseedTicket(ticketId) {
    await runAdminAction(async () => {
      await api.restoreHydroseedTicket(ticketId);
      await loadDeletedHydroseedTickets();
    }, 'Hydroseed ticket restored successfully.', {
      optimistic: () => setDeletedHydroseedTickets((prev) => prev.filter((t) => t.id !== ticketId)),
    });
  }

  async function handleDeleteHydroseedTicketPermanent(ticketId) {
    await runAdminAction(async () => {
      await api.deleteHydroseedTicketPermanent(ticketId);
      await loadDeletedHydroseedTickets();
    }, 'Hydroseed ticket permanently deleted.', {
      optimistic: () => setDeletedHydroseedTickets((prev) => prev.filter((t) => t.id !== ticketId)),
    });
  }

  // Quote Builder soft-delete restore + permanent. Mirrors the TM ticket
  // handlers above so AdminPanel's per-row buttons can share their plumbing.
  async function handleRestoreQuote(quoteId) {
    await runAdminAction(async () => {
      await api.restoreQuote(quoteId);
      await loadDeletedQuotes();
    }, 'Quote restored successfully.', {
      optimistic: () => setDeletedQuotes((prev) => prev.filter((q) => q.id !== quoteId)),
    });
  }

  async function handleDeleteQuotePermanent(quoteId) {
    await runAdminAction(async () => {
      await api.deleteQuotePermanent(quoteId);
      await loadDeletedQuotes();
    }, 'Quote permanently deleted.', {
      optimistic: () => setDeletedQuotes((prev) => prev.filter((q) => q.id !== quoteId)),
    });
  }

  // Empty the Recent Deletes recycle bin in one action. Mirrors the
  // `handleBulkApprovePending` / `handleBulkRejectPending` shape above so
  // admins get the same "review-then-act-in-bulk" ergonomics in both
  // sections. Iterates sequentially instead of Promise.all() so a mid-run
  // failure on one item doesn't silently abort the rest, and so the
  // backend isn't hit with a thundering herd of permanent-delete calls.
  async function handleBulkDeleteAllPermanent() {
    const total =
      deletedSites.length +
      deletedPipelines.length +
      deletedLeaseSheets.length +
      deletedTMTickets.length +
      deletedHydroseedDailies.length +
      deletedHydroseedTickets.length +
      deletedQuotes.length;
    if (total === 0) return;
    setAdminBusy(true);
    setMessage(`Permanently deleting ${total} item${total === 1 ? '' : 's'}…`);
    const failed = [];
    try {
      for (const site of deletedSites) {
        try { await api.deleteSitePermanent(site.id); } catch (error) { failed.push(error); }
      }
      for (const pipeline of deletedPipelines) {
        try { await api.deletePipelinePermanent(pipeline.id); } catch (error) { failed.push(error); }
      }
      for (const record of deletedLeaseSheets) {
        try {
          // Same site-vs-standalone split as the single-item handler
          // (`handleDeleteLeaseSheetPermanent`) — spray records attached
          // to a site use a different endpoint than standalone ones.
          if (record.site_id != null) {
            await api.deleteSiteSprayRecordPermanent(record.id);
          } else {
            await api.deleteSprayRecordPermanent(record.id);
          }
        } catch (error) { failed.push(error); }
      }
      for (const ticket of deletedTMTickets) {
        try { await api.deleteTMTicketPermanent(ticket.id); } catch (error) { failed.push(error); }
      }
      for (const daily of deletedHydroseedDailies) {
        try { await api.deleteHydroseedDailyPermanent(daily.id); } catch (error) { failed.push(error); }
      }
      for (const ticket of deletedHydroseedTickets) {
        try { await api.deleteHydroseedTicketPermanent(ticket.id); } catch (error) { failed.push(error); }
      }
      for (const quote of deletedQuotes) {
        try { await api.deleteQuotePermanent(quote.id); } catch (error) { failed.push(error); }
      }
      // Refresh all deleted-item lists so the UI reflects the purge.
      // loadPendingSites doubles as loadDeletedSites (see its body) so we
      // call it here to refresh both lists in one shot.
      await loadPendingSites();
      await loadDeletedPipelines();
      await loadDeletedLeaseSheets();
      await loadDeletedTMTickets();
      await loadDeletedHydroseedDailies();
      await loadDeletedHydroseedTickets();
      await loadDeletedQuotes();
      const deleted = total - failed.length;
      setMessage(failed.length > 0
        ? `Permanently deleted ${deleted} of ${total}. ${failed.length} failed.`
        : `Permanently deleted ${deleted} item${deleted === 1 ? '' : 's'}.`);
    } finally {
      setAdminBusy(false);
    }
  }

  if (isAuthLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 flex items-center justify-center">
        <div className="text-white text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    // QR-code worker self-signup: when the URL contains ?invite=<secret>,
    // render the signup form instead of the login page. The SIGNUP_INVITE_SECRET
    // check happens on the backend at submit time — we're just switching UI here.
    const inviteCode = (() => {
      try {
        return new URLSearchParams(window.location.search).get('invite');
      } catch {
        return null;
      }
    })();
    if (inviteCode) {
      return (
        <Suspense fallback={<div style={{ padding: 24, textAlign: 'center', color: '#9ab1d6' }}>Loading…</div>}>
          <SignupPage
            inviteCode={inviteCode}
            onDone={() => {
              // Strip ?invite= so a back-button / refresh from "Check your email"
              // returns to the normal login screen rather than re-opening signup.
              try {
                const url = new URL(window.location.href);
                url.searchParams.delete('invite');
                window.history.replaceState({}, '', url.toString());
              } catch { /* ignore */ }
              // Force a re-render by kicking App back through its auth check;
              // easiest path is a full reload since we're not using a router.
              window.location.reload();
            }}
          />
        </Suspense>
      );
    }
    return <LoginPage onLoginSuccess={() => void refreshAllData()} />;
  }

  // Dedicated "Operations TV" kiosk account: boots straight into the
  // full-screen TV dashboard and nothing else. Bypasses the entire normal
  // app shell (map, tabs, overlays, push prompts, worker sign-in-day
  // reset) so the read-only `tv` role can only ever see the board.
  if (userRole === 'tv') {
    return (
      <Suspense fallback={<div style={{ padding: 24, textAlign: 'center', color: '#9ab1d6' }}>Loading…</div>}>
        <TVDashboard />
      </Suspense>
    );
  }

  return (
    <div className="app-shell">
      {/* One-time post-login "Add to Home Screen" instructions. Component
          self-suppresses after first dismissal (via localStorage) and when
          already running in PWA / standalone mode. */}
      <InstallAppPrompt />
      {/* ── Top bar ── */}
      <header className="topbar">
        <span className="topbar-title">Pineview Maps</span>
        {/* Live check-in countdown — visible on every screen size, between
            the title and the right-side status badges. Renders null when
            the user has no active shift today, so the slot stays clean
            for non-check-in workflows. Click opens MyCheckInsOverlay. */}
        <CheckinCountdown
          shift={activeShift}
          onOpen={() => setShowMyCheckins(true)}
        />
        <div className="topbar-right">
          <span className={`badge ${isOnline ? 'online' : 'offline'}`}>{isOnline ? 'Online' : 'Offline'}</span>
          {/* Realtime status badge intentionally removed — the Online/Offline
              indicator above is enough for field workers; a separate
              "Realtime: reconnecting" pill was deemed too noisy. The
              `realtimeStatus` state itself is still tracked because it drives
              the adaptive poll cadence (see POLL_MS in the poll useEffect). */}
          {/* Manual refresh: full resync on demand. The auto-poll now runs at
              2 min intervals to save egress, so this button is how users force
              an immediate refresh when they expect a just-submitted change. */}
          <button
            className="badge"
            style={{
              background: isRefreshing ? '#374151' : '#1f2937',
              color: isRefreshing ? '#9ca3af' : '#60a5fa',
              cursor: (isRefreshing || !isOnline) ? 'not-allowed' : 'pointer',
              border: '1px solid #374151',
              padding: '2px 10px',
            }}
            onClick={handleManualRefresh}
            disabled={isRefreshing || !isOnline}
            title={!isOnline ? 'Connect to the internet to refresh' : 'Refresh all data from server'}
          >
            {isRefreshing ? (
              <>↻<span className="topbar-label-desktop"> Refreshing…</span></>
            ) : (
              <>↻<span className="topbar-label-desktop"> Refresh</span></>
            )}
          </button>
          {(uploadQueueItems.length > 0 || isUploading) ? (
            // Compact "Syncing X%" / "Queued (N)" badge. Tapping it
            // deep-links to FormsPanel's In Progress → Uploading tab
            // where the worker can see per-ticket progress bars.
            // Kept small because the header is tight on mobile — the
            // detailed view belongs in the Uploading tab, not here.
            <button
              type="button"
              className="badge"
              style={{
                background: isUploading ? '#2563eb' : '#3b82f6',
                color: 'white',
                border: 'none',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                // tabular-nums forces every digit to the same advance
                // width. Combined with the nbsp-padded percentage below
                // ("Syncing  5%" vs "Syncing 95%" — both 11 chars) this
                // keeps the badge a constant width across the whole
                // 0–99 % range, so the adjacent "Pending: N" badge no
                // longer shifts on every progress tick. No min-width
                // is needed — that overshot and clipped Pending in
                // 1.1.21.
                fontVariantNumeric: 'tabular-nums',
              }}
              onClick={() => {
                // Jump to Forms tab and bump the signal so FormsPanel
                // picks up a subTab/ipTab switch in its effect.
                setActiveTab(TAB_FORMS);
                setDetailOpen(false);
                setUploadTabSignal((x) => x + 1);
              }}
              title={isUploading
                ? `Uploading ${uploadProgress}% — tap for details`
                : `${uploadQueueItems.length} queued — tap for details`}
            >
              {isUploading ? (
                // Desktop keeps the full "Syncing X%" label; mobile drops
                // the word and uses a ⟳ icon prefix instead so the
                // badge stack fits the phone topbar without clipping the
                // adjacent "Pending: N". The percentage itself is padded
                // to 2 chars with a non-breaking space (\u00A0 doesn't
                // collapse in HTML) so combined with tabular-nums the
                // badge stays a constant width across 0–99 %.
                <>
                  <span className="topbar-label-desktop">Syncing </span>
                  <span className="topbar-label-mobile">⟳ </span>
                  {String(uploadProgress).padStart(2, '\u00A0')}%
                </>
              ) : (
                `Queued (${uploadQueueItems.length})`
              )}
            </button>
          ) : null}
          {queuedCount > 0 ? (
            <button 
              className="badge" 
              style={{ background: '#3b82f6', color: 'white', cursor: 'pointer', border: 'none' }}
              onClick={handleSyncCurrentView}
              disabled={isSyncing || !isOnline}
              title={!isOnline ? "Must be online to sync" : "Sync queued offline changes"}
            >
              {isSyncing ? 'Syncing...' : `Sync (${queuedCount})`}
            </button>
          ) : null}
          {canManagePins && (() => {
            // Prefer the cheap count from /api/sync-status (and persisted
            // watermarks) over the array length, since it's available
            // immediately on cold start while the full pending lists are
            // still in flight. Falls through to the array length when the
            // count hasn't been seeded yet (e.g. first ever load offline).
            const sitesN = pendingSitesCount ?? pendingSites.length;
            const pipesN = pendingPipelinesCount ?? pendingPipelines.length;
            const total = sitesN + pipesN;
            return total > 0 ? (
              <span
                className="badge"
                style={{ background: '#f59e0b', color: '#422006', cursor: 'pointer' }}
                onClick={() => { setDetailOpen(false); setActiveTab(TAB_ADMIN); }}
              >
                Pending: {total}
              </span>
            ) : null;
          })()}
          {/* "View as Worker" toggle \u2014 only shown for users whose actual
              role is admin/office. Orange when active so the user can't
              forget they're in worker view and wonder where the admin
              tab went. Click toggles back. Lives in the topbar (not the
              admin panel) so it stays reachable in worker view.
              `.topbar-account-inline-only` hides this on mobile; the same
              toggle lives inside the avatar menu below. */}
          {actualCanManagePins ? (
            <button
              className="badge topbar-account-inline-only"
              onClick={() => setViewAsWorker((v) => !v)}
              style={{
                cursor: 'pointer',
                background: viewAsWorker ? '#f59e0b' : '#1f2937',
                color: viewAsWorker ? '#422006' : '#60a5fa',
                border: '1px solid #374151',
                padding: '2px 10px',
                fontWeight: viewAsWorker ? 700 : 500,
              }}
              title={viewAsWorker
                ? 'Currently viewing as Worker \u2014 click to restore your admin/office view'
                : 'Switch to a worker-level view (hides admin buttons, only shows your own forms)'}
            >
              {viewAsWorker ? '\ud83d\udc77 Viewing as Worker' : '\ud83d\udc64 View as Worker'}
            </button>
          ) : null}
          <span className="badge topbar-account-inline-only">{userDisplayName}</span>
          <button
            onClick={() => signOut()}
            className="badge topbar-account-inline-only"
            style={{ cursor: 'pointer', background: '#ef4444', color: 'white' }}
          >
            Sign Out
          </button>
          {/* Tiny build-version badge — auto-bumped on every push to main
              by .github/workflows/deploy.yml (VITE_APP_VERSION = 1.0.<run_number>).
              Lets a worker / office / admin confirm what build they have
              loaded without digging into devtools. Hidden on mobile via
              `topbar-account-inline-only`; mobile users get the same string
              inside the avatar popover below. The old swUpdateAvailable
              ternary that flipped this into a green "↑ Update available"
              pill was removed — the avatar dot + popover "Update Now" are
              the canonical update affordance on both desktop and mobile. */}
          <span
            className="badge topbar-account-inline-only"
            title={`Build ${APP_VERSION_LABEL}`}
            style={{ background: 'transparent', color: '#6b7280', fontSize: '0.7rem', padding: '2px 6px' }}
          >
            {APP_VERSION_LABEL}
          </span>

          {/* Mobile-only avatar menu: collapses name + View as Worker +
              Sign Out into a single 28 px circle with the user's initial.
              Hidden on tablet/PC via CSS so the existing inline badges
              keep their full-width layout. The orange dot on the trigger
              mirrors the View-as-Worker toggle so admins always see at a
              glance which view they're in, even with the menu closed. */}
          <div className="topbar-account-menu" ref={accountMenuRef}>
            <button
              type="button"
              className="topbar-account-trigger"
              onClick={() => setAccountMenuOpen((v) => !v)}
              aria-label="Account menu"
              aria-expanded={accountMenuOpen}
              aria-haspopup="menu"
              title={userDisplayName}
            >
              {userInitial}
              {/* Dot priority: red "update available" trumps orange
                  "viewing as worker" because the former is actionable
                  and transient, while the latter is a persistent mode
                  reminder. Orange returns once the update is applied. */}
              {swUpdateAvailable ? (
                <span className="topbar-account-trigger-dot topbar-account-trigger-dot--update" aria-hidden="true" />
              ) : viewAsWorker ? (
                <span className="topbar-account-trigger-dot" aria-hidden="true" />
              ) : null}
            </button>
            {accountMenuOpen ? (
              <div className="topbar-account-popover" role="menu">
                <div className="topbar-account-name" role="presentation">
                  {userDisplayName}
                  {viewAsWorker ? (
                    <span className="topbar-account-name-sub">Viewing as Worker</span>
                  ) : null}
                </div>
                {/* 🛟 Check-ins — visible to every signed-in user. Opens
                    the personal MyCheckInsOverlay (start-shift form if no
                    active shift, status panel if active). Admins have a
                    separate "Check-ins Dashboard" entry in the AdminPanel
                    Tools row for the office monitoring view. */}
                <button
                  type="button"
                  role="menuitem"
                  className="topbar-account-item"
                  onClick={() => { setAccountMenuOpen(false); setShowMyCheckins(true); }}
                >
                  🛟 Check-ins
                </button>
                {actualCanManagePins ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="topbar-account-item"
                    onClick={() => { setViewAsWorker((v) => !v); setAccountMenuOpen(false); }}
                  >
                    {viewAsWorker ? '\ud83d\udc64 Restore admin view' : '\ud83d\udc77 View as worker'}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="topbar-account-item topbar-account-item-danger"
                  onClick={() => { setAccountMenuOpen(false); signOut(); }}
                >
                  Sign out
                </button>
                <div
                  role="presentation"
                  style={{ padding: '0.4rem 0.75rem 0.5rem', textAlign: 'center', opacity: 0.6, fontSize: '0.7rem', color: '#9ab1d6' }}
                  title={`Build ${APP_VERSION_LABEL}`}
                >
                  {APP_VERSION_LABEL}
                </div>
                {swUpdateAvailable ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleAppUpdate}
                    style={{
                      display: 'block',
                      width: 'calc(100% - 1.5rem)',
                      margin: '0 0.75rem 0.5rem',
                      padding: '0.45rem 0.75rem',
                      background: '#2563eb',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      textAlign: 'center',
                    }}
                  >
                    ↑ Update Now
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* ── Soft morning check-in banner ────────────────────────────
          Subtle prompt to start a shift on first map load each day.
          Only shows when the user has NO active shift AND hasn't
          dismissed it today. Workers can always start later from the
          avatar-menu "🛟 Check-ins" entry; the banner is just a nudge. */}
      {user && !activeShift && !softBannerDismissed && !forceCheckinOverlay ? (
        <div className="soft-checkin-banner" role="status">
          <span className="soft-checkin-banner-icon" aria-hidden>🛟</span>
          <span className="soft-checkin-banner-text">
            You haven't started a shift today.
          </span>
          <button
            type="button"
            className="soft-checkin-banner-cta"
            onClick={() => setShowMyCheckins(true)}
          >
            Start now
          </button>
          <button
            type="button"
            className="soft-checkin-banner-dismiss"
            onClick={() => {
              try {
                localStorage.setItem(
                  'checkinSoftBannerDismissed',
                  new Date().toISOString().slice(0, 10),
                );
              } catch { /* ignore */ }
              setSoftBannerDismissed(true);
            }}
            aria-label="Dismiss for today"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* ── Main area: map is always behind ── */}
      <main className="main-area">
        <div className="map-container">
          <MapView
            apiKey={GOOGLE_MAPS_API_KEY}
            isOnline={isOnline}
            sites={mapSites}
            markerRevision={markerRevision}
            selectedSite={selectedSite}
            onSelectSite={handleOpenDetail}
            isPickingLocation={isPlacingPin || isPickingLocationForEdit || isStandaloneMapPicking}
            pickedLocation={addPinLocation}
            onPickLocation={handleMapLocationPick}
            onOpenDetail={handleOpenDetail}
            zoomToSite={zoomTarget}
            onMapClick={handleMapDismiss}
            userLocation={userLocation}
            onMapLoad={handleMapLoad}
            detailOpen={detailOpen || pipelineDetailOpen}
            pipelines={visiblePipelines}
            selectedPipeline={selectedPipeline}
            onSelectPipeline={handleOpenPipelineDetail}
            onShowSitesTab={() => { setActiveTab(TAB_SITES); setDetailOpen(false); }}
            activeTab={activeTab}
            isDrawingPipeline={isDrawingPipeline}
            drawingPoints={drawingPoints}
            onDrawingClick={handleDrawingClick}
            isSprayMarking={isSprayMarking}
            sprayStartPoint={sprayStartPoint}
            sprayEndPoint={sprayEndPoint}
            onSprayClick={handleSprayClick}
            highlightedSprayRecordId={highlightedSprayRecordId}
            onSprayRecordClick={(record) => setHighlightedSprayRecordId(prev => prev === record.id ? null : record.id)}
            devices={devices}
            showTrucksLayer={canManagePins && (layers.trucks ?? true)}
            selectedDevice={selectedDevice}
            onSelectDevice={setSelectedDevice}
            crewShifts={crewShifts}
            showCrewLayer={canManagePins && (layers.crew ?? true)}
            selectedCrewKey={selectedCrewKey}
            onSelectCrewKey={(key) => {
              setSelectedCrewKey(key);
              if (!key) return;
              // Auto-expand the shift and open the sidebar when a crew pin is clicked.
              const [shiftIdStr] = key.split(':');
              const shiftId = Number(shiftIdStr);
              if (!Number.isNaN(shiftId)) {
                setExpandedCrewShiftIds((prev) => {
                  if (prev.has(shiftId)) return prev;
                  const next = new Set(prev);
                  next.add(shiftId);
                  return next;
                });
                setShowCrewPanel(true);
                setIsFilterOpen(false);
              }
            }}
            expandedCrewShiftIds={expandedCrewShiftIds}
            onToggleCrewShiftExpanded={toggleCrewShiftExpanded}
          />
        </div>

        {/* floating filter button */}
        <div className="map-float-tl">
          <button
            className="float-btn"
            type="button"
            onClick={() => setIsFilterOpen((c) => {
              const next = !c;
              if (next) setShowCrewPanel(false);
              return next;
            })}
          >
            ☰ Filters
          </button>
          {canManagePins ? (
            <button
              className="float-btn"
              type="button"
              onClick={() => {
                setShowCrewPanel((c) => {
                  const next = !c;
                  if (next) setIsFilterOpen(false);
                  return next;
                });
              }}
            >
              🛟 Crew{crewShifts.length ? ` (${crewShifts.length})` : ''}
            </button>
          ) : null}
        </div>

        {canManagePins && showCrewPanel ? (
          <CrewSidebar
            shifts={crewShifts}
            selectedKey={selectedCrewKey}
            onLocate={handleLocateCrew}
            onClose={() => setShowCrewPanel(false)}
            expandedShiftIds={expandedCrewShiftIds}
            onToggleShiftExpanded={toggleCrewShiftExpanded}
          />
        ) : null}

        {isFilterOpen ? (
          <div className="filter-overlay">
            <FilterBar
              filters={filters}
              clients={clients}
              areas={areas}
              sites={sites}
              onChange={(key, value) => setFilters((c) => ({ ...c, [key]: value }))}
              onSearchSelect={handleSearchSelect}
              onClearAll={() => setFilters(DEFAULT_FILTERS)}
              layers={layers}
              onLayerToggle={handleLayerToggle}
              showTrucksOption={canManagePins}
              showCrewOption={canManagePins}
            />
          </div>
        ) : null}

        {/* ── Lease Sheet overlay ── */}
        {(inspectionSite || inspectionPipeline) && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 40,
            display: 'flex',
            flexDirection: 'column',
          }}>
            <Suspense fallback={null}>
              <HerbicideLeaseSheet
                site={inspectionSite}
                pipeline={inspectionPipeline}
                initialDistanceMeters={pendingPipelineSegment?.distance_meters ?? null}
                isOpen={true}
                requireComments={!!inspectionSite && inspectionSiteStatus === 'in_progress'}
                commentsLabel={inspectionSiteStatus === 'in_progress' ? 'Comments / what was completed' : 'Comments'}
                limitedRequiredFields={inspectionSiteStatus === 'issue_not_inspected'}
                initialComments={inspectionReason}
                onSubmit={handleLeaseSheetSubmit}
                onCancel={() => { handleLeaseSheetCancel(); setResumingDraft(null); }}
                cachedLookups={cachedLookups}
                draft={resumingDraft}
                onDraftSaved={() => { setDraftsRefreshToken((x) => x + 1); }}
              />
            </Suspense>
          </div>
        )}

        {standaloneLeaseSheet && renderStandaloneLeaseSheet()}

        {/* Floating "Cancel pick" banner for standalone map picking */}
        {isStandaloneMapPicking && (
          <div style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 35,
            background: '#1f2937',
            color: '#f9fafb',
            padding: '10px 16px',
            borderRadius: '8px',
            border: '1px solid #374151',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            fontSize: '0.9rem',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}>
            <span>Tap the map to choose a location</span>
            <button
              type="button"
              onClick={handleCancelStandaloneMapPick}
              style={{ background: '#374151', color: '#f9fafb', border: 'none', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── Edit Lease Sheet overlay ── */}
        {editingSprayRecord && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 40,
            display: 'flex',
            flexDirection: 'column',
          }}>
            <Suspense fallback={null}>
              <HerbicideLeaseSheet
                site={{ id: editingSprayRecord.site_id, client: editingSprayRecord.site_client, area: editingSprayRecord.site_area, lsd: editingSprayRecord.site_lsd }}
                isOpen={true}
                editingRecord={editingSprayRecord}
                onSubmit={handleEditSpraySubmit}
                onCancel={() => setEditingSprayRecord(null)}
                cachedLookups={cachedLookups}
              />
            </Suspense>
          </div>
        )}

        {/* ── Lease Sheet Preview overlay ── */}
        {previewingRecord && (
          <Suspense fallback={null}>
            <PdfPreviewOverlay
              record={previewingRecord}
              onClose={() => setPreviewingRecord(null)}
            />
          </Suspense>
        )}

        {/* ── T&M Ticket Detail overlay ── */}
        {activeTMTicketId != null && (
          <div style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 40,
            background: '#0b1220',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <Suspense fallback={null}>
              <TMTicketDetailSheet
                ticketId={activeTMTicketId}
                roleCanAdmin={roleCanAdmin}
                roleCanOffice={roleCanAdmin}
                currentUserEmail={user?.email}
                onClose={() => setActiveTMTicketId(null)}
                onQueueSubmit={handleQueueTMSubmit}
                canMergeTickets={canManagePins}
              />
            </Suspense>
          </div>
        )}

        {/* ── Hydroseed Daily Application Record overlay ── */}
        {hydroseedDailyOpen && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 40,
            display: 'flex', flexDirection: 'column',
          }}>
            <Suspense fallback={null}>
              <HydroseedDailyRecord
                isOpen={true}
                onSubmit={handleHydroseedDailySubmit}
                onCancel={handleHydroseedDailyCancel}
                clients={clients}
                areas={areas}
                duplicateFrom={hydroseedDuplicateFrom}
                draft={resumingHydroseedDraft}
                editingRecord={editingHydroseedRecord}
                users={cachedUsers}
              />
            </Suspense>
          </div>
        )}

        {/* ── Hydroseed Ticket Detail overlay ── */}
        {activeHydroseedTicketId != null && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 40,
            display: 'flex', flexDirection: 'column',
          }}>
            <Suspense fallback={null}>
              <HydroseedTicketDetailSheet
                ticketId={activeHydroseedTicketId}
                roleCanAdmin={roleCanAdmin}
                roleCanOffice={roleCanAdmin}
                currentUserEmail={user?.email}
                onClose={() => setActiveHydroseedTicketId(null)}
                onSaved={() => setDraftsRefreshToken((x) => x + 1)}
              />
            </Suspense>
          </div>
        )}

        {/* Place-pin banner */}
        {isPlacingPin ? (
          <div className="place-banner">
            {`Tap map to place ${pinTypeLabel(addPinType)} pin`}
            <button className="cancel-btn" type="button" onClick={handleCancelAdd}>Cancel</button>
          </div>
        ) : null}

        {/* Post-submit confirmation / "we cleared a filter" banner.
            Only renders when no other top banner (place-pin / drawing /
            spray) is active, otherwise two banners would stack and fight
            for the top 12 px of the map. `pinSubmitBanner` auto-clears
            after 6 s via `showPinSubmitBanner` above. */}
        {pinSubmitBanner && !isPlacingPin && !isDrawingPipeline && !isSprayMarking ? (
          <div className="place-banner post-submit-banner" role="status" aria-live="polite">
            <span>{pinSubmitBanner.message}</span>
            <button
              className="cancel-btn"
              type="button"
              onClick={() => setPinSubmitBanner(null)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        ) : null}

        {/* Drawing pipeline banner */}
        {isDrawingPipeline && !showDrawingForm ? (
          <div className="place-banner" style={{ flexDirection: 'column', gap: '0.5rem' }}>
            <div>Tap map to draw pipeline ({drawingPoints.length} point{drawingPoints.length !== 1 ? 's' : ''})</div>
            <div className="button-row" style={{ justifyContent: 'center' }}>
              {drawingPoints.length > 0 && (
                <button className="secondary-button" type="button" onClick={handleUndoDrawingPoint} style={{ fontSize: '0.8rem' }}>
                  Undo
                </button>
              )}
              {drawingPoints.length >= 2 && (
                <button className="primary-button" type="button" onClick={handleFinishDrawing} style={{ fontSize: '0.8rem' }}>
                  Done Drawing
                </button>
              )}
              <button className="cancel-btn" type="button" onClick={handleCancelDrawing}>Cancel</button>
            </div>
          </div>
        ) : null}

        {/* Drawing pipeline form.
            Client + area now use AutocompleteInput so existing values
            surface as the user types — same pattern as the in-map "Add
            pin" popup further down. The pipeline-name field stays as a
            plain input because pipeline names are unique to each
            pipeline; surfacing other pipelines' names there would only
            invite accidental name collisions. */}
        {isDrawingPipeline && showDrawingForm ? (
          <div className="add-pin-popup" style={{ bottom: 80, left: '50%', transform: 'translateX(-50%)' }}>
            <strong className="small-text">New Pipeline</strong>
            <input value={drawingForm.name} onChange={(e) => setDrawingForm((c) => ({ ...c, name: e.target.value }))} placeholder="Pipeline name" />
            <AutocompleteInput
              value={drawingForm.client}
              onChange={(next) => setDrawingForm((c) => ({ ...c, client: next }))}
              placeholder="Client"
              suggestions={clients}
            />
            <AutocompleteInput
              value={drawingForm.area}
              onChange={(next) => setDrawingForm((c) => ({ ...c, area: next }))}
              placeholder="Area"
              suggestions={getAreasForClient(drawingForm.client)}
            />
            <div className="button-row">
              <button className="primary-button" type="button" disabled={submittingPin} onClick={handleSubmitDrawnPipeline}>
                {submittingPin ? 'Saving…' : 'Submit'}
              </button>
              <button className="secondary-button" type="button" onClick={handleCancelDrawing}>Cancel</button>
            </div>
          </div>
        ) : null}

        {/* Spray marking banner. Reads "sprayed section" by default and
            "issue section" when the worker entered via ⚠ Issue with
            Pipeline, so the same map UI makes its purpose obvious. */}
        {isSprayMarking && !showSprayConfirm ? (
          <div className="place-banner" style={{ flexDirection: 'column', gap: '0.5rem' }}>
            <div>
              {(() => {
                const subject = sprayMarkingMode === 'issue' ? 'issue' : 'sprayed';
                return !sprayStartPoint
                  ? `Tap the START of the ${subject} section`
                  : `Tap the END of the ${subject} section`;
              })()}
            </div>
            <button className="cancel-btn" type="button" onClick={handleCancelSprayMarking}>Cancel</button>
          </div>
        ) : null}

        {/* Spray confirmation dialog. Two modes:
            • 'inspection' (default): single Confirm button → forwards the
              segment to the lease-sheet flow.
            • 'issue': displays the reason captured by the ⚠ Issue with
              Pipeline prompt and offers Yes-Fill-Sheet / Skip / Cancel.
              "Yes" reuses handleConfirmSpray (lease sheet picks up the
              already-set inspectionReason + 'issue_not_inspected'
              status); "Skip" calls handleConfirmIssueSkip to record an
              is_avoided spray record on the segment without a sheet. */}
        {showSprayConfirm ? (
          <div className="add-pin-popup" style={{ bottom: 80, left: '50%', transform: 'translateX(-50%)' }}>
            <strong className="small-text">
              {sprayMarkingMode === 'issue' ? 'Confirm Issue Segment' : 'Confirm Spray Record'}
            </strong>
            <input
              type="date"
              value={sprayForm.date}
              onChange={(e) => setSprayForm((c) => ({ ...c, date: e.target.value }))}
            />
            {sprayMarkingMode === 'issue' && inspectionReason ? (
              <div className="small-text" style={{ color: '#fbbf24', fontStyle: 'italic' }}>
                Reason: {inspectionReason}
              </div>
            ) : null}
            {sprayMarkingMode === 'issue' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <button
                  className="primary-button"
                  type="button"
                  disabled={adminBusy}
                  onClick={handleConfirmSpray}
                >
                  {adminBusy ? 'Saving…' : 'Yes — Fill Sheet'}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={adminBusy}
                  onClick={handleConfirmIssueSkip}
                  style={{ background: '#64748b' }}
                >
                  {adminBusy ? '…' : 'Skip'}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={handleCancelSprayMarking}
                  disabled={adminBusy}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="button-row">
                <button className="primary-button" type="button" disabled={adminBusy} onClick={handleConfirmSpray}>
                  {adminBusy ? 'Saving…' : 'Confirm'}
                </button>
                <button className="secondary-button" type="button" onClick={handleCancelSprayMarking}>Cancel</button>
              </div>
            )}
          </div>
        ) : null}

        {/* Add-pin popup form.
            All three fields use `AutocompleteInput` so existing values
            (LSDs, clients, areas) surface as the user types — same
            spelling, faster entry, and a duplicate-LSD warning below
            the label field so a worker can spot a pre-existing site
            before committing a pending pin. Typing a new value is still
            fully allowed (selection is optional) — the autocomplete is
            a suggestion layer, not a validator. */}
        {showAddPopup ? (
          <div className="add-pin-popup" style={{ bottom: 80, left: '50%', transform: 'translateX(-50%)' }}>
            <strong className="small-text">New {pinTypeLabel(addPinType)} pin</strong>
            <AutocompleteInput
              value={addPinForm.lsd}
              onChange={(next) => {
                // Manual typing means this is not an explicit "use this
                // existing LSD" choice anymore, so clear the advisory
                // duplicate state. This is what prevents a brand-new LSD
                // under an existing client/area from warning just because
                // those context fields came from autocomplete.
                setSelectedAddPinLsdSuggestion(null);
                setAddPinForm((c) => ({ ...c, lsd: next }));
              }}
              placeholder="LSD or site label"
              suggestions={lsdSuggestions}
              onSelect={(item) => {
                // When the worker picks an existing LSD, prefill the
                // client and area from that match (only if those fields
                // are still blank — don't stomp values they already
                // typed). Saves a couple of taps in the common "I'm
                // adding a second pin for the same site" flow.
                const [matchClient, matchArea] = (item.sub || '').split(' · ');
                setAddPinForm((c) => ({
                  ...c,
                  client: c.client || matchClient || '',
                  area: c.area || matchArea || '',
                }));
                setSelectedAddPinLsdSuggestion(item);
              }}
            />
            {(() => {
              if (!duplicateLsdSite) return null;
              // Build a compact "(client, area)" suffix, gracefully
              // omitting whichever field the existing row is missing
              // instead of rendering orphan parens / commas.
              const parts = [duplicateLsdSite.client, duplicateLsdSite.area].filter(Boolean);
              const context = parts.length > 0 ? ` (${parts.join(', ')})` : '';
              return (
                <div className="dup-lsd-warning" role="alert">
                  ⚠ An existing LSD is already labeled "{duplicateLsdSite.lsd}"{context}.
                  You can still submit if this is a separate pin.
                </div>
              );
            })()}
            <AutocompleteInput
              value={addPinForm.client}
              onChange={(next) => setAddPinForm((c) => ({ ...c, client: next }))}
              placeholder="Client"
              suggestions={clients}
            />
            <AutocompleteInput
              value={addPinForm.area}
              onChange={(next) => setAddPinForm((c) => ({ ...c, area: next }))}
              placeholder="Area"
              suggestions={areasForAddPinClient}
            />
            <div className="button-row">
              <button className="primary-button" type="button" disabled={submittingPin} onClick={handleSubmitNewPin}>
                {submittingPin ? 'Saving…' : 'Submit'}
              </button>
              <button className="secondary-button" type="button" onClick={handleCancelAdd}>Cancel</button>
            </div>
            {message && message.includes('fail') || message && message.includes('error') || message && message.includes('Unable') ? (
              <div className="small-text" style={{ color: '#fca5a5', marginTop: '0.35rem' }}>{message}</div>
            ) : null}
          </div>
        ) : null}

        {/* FAB + type menu */}
        {activeTab === TAB_MAP && !isPlacingPin && !showAddPopup && !isDrawingPipeline && !isSprayMarking ? (
          <>
            <button 
              className={`fab location-fab ${isFollowingUser ? 'following' : ''}`} 
              type="button" 
              onClick={handleCenterOnUserLocation}
              title={isFollowingUser ? "Stop following my location" : "Center on my location"}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>
              </svg>
            </button>
            <button className="fab" type="button" onClick={() => setFabOpen((c) => !c)}>+</button>
            {fabOpen ? (
              <div className="fab-menu">
                <button type="button" onClick={() => handleFabSelect('lsd')}>LSD</button>
                <button type="button" onClick={() => handleFabSelect('water')}>Water</button>
                <button type="button" onClick={() => handleFabSelect('quad_access')}>Quad Access</button>
                <button type="button" onClick={() => handleFabSelect('reclaimed')}>Reclaimed</button>
                <button type="button" onClick={handleStartDrawingPipeline} style={{ borderTop: '1px solid rgba(143,182,255,0.2)' }}>Pipeline</button>
              </div>
            ) : null}
          </>
        ) : null}

        {/* ── Detail side panel ── */}
        <div
          className={`side-panel detail-priority ${detailOpen && selectedSite ? 'open' : ''} ${detailDragging ? 'dragging' : ''}`}
          style={{
            transform: detailOpen && selectedSite
              ? `translateY(${detailDragOffset}px)`
              : 'translateY(100%)'
          }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div className="side-panel-header">
            <button className="back-btn" type="button" onClick={handleCloseDetail}>←</button>
            <h2>Site Details</h2>
            {canManagePins ? <span className="small-text">Admin</span> : null}
          </div>
          <div className="side-panel-body" ref={detailBodyRef}>
            {selectedSite ? (
              <SiteDetailSheet
                site={selectedSite}
                onStatusChange={handleStatusChange}
                statusSaving={statusSaving}
                canManagePin={canManagePins}
                onSavePin={handleAdminUpdateSite}
                onDeletePin={handleDeleteSite}
                onRequestTypeChange={handleRequestTypeChange}
                onQuickEdit={handleQuickEdit}
                adminBusy={adminBusy}
                onRequestMapPick={handleRequestEditMapPick}
                pickedLocation={editPickLocation}
                onCancelEditPick={handleCancelEditMapPick}
                sprayRecords={selectedSite?.spray_records || []}
                onCreateSprayRecord={handleCreateSiteSprayRecord}
                onDeleteSprayRecord={handleDeleteSiteSprayRecord}
                onStartInspection={handleStartInspection}
                onStartIssueNotInspected={handleStartIssueNotInspected}
                onViewPdf={(record) => {
                  setPreviewingRecord(record);
                }}
                onEditRecord={(record) => openEditRecord(record, { site_lsd: selectedSite?.lsd, site_client: selectedSite?.client, site_area: selectedSite?.area })}
                onImportLeaseSheet={canManagePins ? handleImportLeaseSheet : undefined}
                // Autofill data so the LSD / Client / Area inputs in the
                // admin edit panel surface existing values — same UX as
                // the in-map "Add pin" popup. Without these props the
                // edit panel was the only place an admin couldn't
                // benefit from the autocomplete a regular worker gets
                // when adding a pin in the field.
                clientSuggestions={clients}
                lsdSuggestions={lsdSuggestions}
                getAreasForClient={getAreasForClient}
              />
            ) : null}
          </div>
        </div>

        {/* ── Pipeline detail side panel ── */}
        <div
          className={`side-panel detail-priority ${pipelineDetailOpen && selectedPipeline ? 'open' : ''} ${pipelineDragging ? 'dragging' : ''}`}
          style={{
            transform: pipelineDetailOpen && selectedPipeline
              ? `translateY(${pipelineDragOffset}px)`
              : 'translateY(100%)'
          }}
          onTouchStart={handlePipelineTouchStart}
          onTouchMove={handlePipelineTouchMove}
          onTouchEnd={handlePipelineTouchEnd}
        >
          <div className="side-panel-header">
            <button className="back-btn" type="button" onClick={handleClosePipelineDetail}>←</button>
            <h2>Pipeline Details</h2>
            {canManagePins ? <span className="small-text">Admin</span> : null}
          </div>
          <div
            className="side-panel-body"
            ref={pipelineDetailBodyRef}
          >
            {selectedPipeline ? (
              <PipelineDetailSheet
                pipeline={selectedPipeline}
                canManage={canManagePins}
                onSavePipeline={handleUpdatePipeline}
                onDeletePipeline={handleDeletePipeline}
                onMarkInspection={handleStartSprayMarking}
                onMarkIssueNotInspected={handleStartIssueNotInspected}
                adminBusy={adminBusy}
                sprayRecords={pipelineSprayRecords}
                onDeleteSprayRecord={handleDeleteSprayRecord}
                highlightedSprayRecordId={highlightedSprayRecordId}
                onHighlightSprayRecord={setHighlightedSprayRecordId}
                onViewRecord={(record) => setPreviewingRecord(record)}
                // Autofill data for the Client / Area edit fields. The
                // pipeline-name field stays plain text (names are unique
                // per pipeline; suggesting other pipelines' names there
                // would just invite collisions).
                clientSuggestions={clients}
                getAreasForClient={getAreasForClient}
              />
            ) : null}
          </div>
        </div>

        {/* ── Sites list panel ── */}
        <div
          className={`side-panel ${activeTab === TAB_SITES ? 'open' : ''} ${sitesPanelDragging ? 'dragging' : ''}`}
          onTouchStart={handleSitesPanelTouchStart}
          onTouchMove={handleSitesPanelTouchMove}
          onTouchEnd={handleSitesPanelTouchEnd}
          style={{
            transform: activeTab === TAB_SITES
              ? `translateX(${sitesPanelDragOffset}px)`
              : 'translateX(100%)'
          }}
        >
          <div className="side-panel-header">
            <h2>Sites</h2>
            <span className="small-text">
              {isLoading ? 'Loading…' : `${visibleSites.length} site${visibleSites.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <div className="side-panel-body">
            <p className="small-text" style={{ marginBottom: '0.5rem' }}>{message}</p>
            <div className="legend" style={{ marginBottom: '0.75rem' }}>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#22c55e' }} /> Inspected</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#ef4444' }} /> Not inspected</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#94a3b8' }} /> Issue</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#3b82f6' }} /> Water</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#eab308' }} /> Quad</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#f59e0b' }} /> Pending</span>
            </div>
            <div className="list-grid">
              {visibleSites.length === 0 ? (
                <div className="site-row small-text">No sites match filters.</div>
              ) : (
                visibleSites.map((site) => (
                  <button className="site-row" key={site.id || site.cacheId} type="button" onClick={() => { handleOpenDetail(site, { fromSitesList: true }); setActiveTab(TAB_MAP); }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                      <strong>{site.lsd || 'Unnamed'}</strong>
                      {site.approval_state === 'pending_review' ? <span className="pending-badge">Pending</span> : null}
                    </div>
                    <div className="small-text">{pinTypeLabel(site.pin_type)} • {site.client || '—'} • {statusLabel(site.status)}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* ── Forms panel (formerly Recents) ── */}
        <div
          className={`side-panel ${activeTab === TAB_FORMS ? 'open' : ''} ${formsPanelDragging ? 'dragging' : ''}`}
          onTouchStart={handleFormsPanelTouchStart}
          onTouchMove={handleFormsPanelTouchMove}
          onTouchEnd={handleFormsPanelTouchEnd}
          style={{
            transform: activeTab === TAB_FORMS
              ? `translateX(${formsPanelDragOffset}px)`
              : 'translateX(100%)'
          }}
        >
          <div className="side-panel-header">
            <h2>Forms</h2>
          </div>
          <div className="side-panel-body">
            <Suspense fallback={<div className="small-text" style={{ padding: '1rem' }}>Loading…</div>}>
            <FormsPanel
              visible={activeTab === TAB_FORMS}
              cachedRecents={cachedRecents}
              uploadQueue={uploadQueueItems}
              // Per-ticket upload-progress info for the Uploading tab.
              // `activeUploadItemId` tells the panel which row is live,
              // `uploadCurrentItemPercent` is that row's byte progress.
              // `uploadTabSignal` is a one-shot bump that tells the
              // panel to jump to In Progress → Uploading (fired by the
              // header "Syncing X%" badge).
              activeUploadItemId={activeUploadItemId}
              uploadCurrentItemPercent={currentItemPercent}
              uploadLane2Percent={currentItemLane2Percent}
              uploadTabSignal={uploadTabSignal}
              // Per-row Retry / Discard for stalled queue items.
              // Retry = un-stall this single entry and kick the queue;
              // Discard = remove from IDB after a confirm dialog.
              onRetryQueueItem={handleRetryQueueItem}
              onDiscardQueueItem={handleDiscardQueueItem}
              clients={clients}
              areas={areas}
              // Same client→area narrowing helper used by every other
              // form (lease sheet, AddPin, ApproveEditModal, …) — keeps
              // the New T&M modal's Area dropdown scoped to the picked
              // client so workers don't see every area in the company.
              getAreasForClient={getAreasForClient}
              onViewPdf={(record) => setPreviewingRecord(record)}
              onEditRecord={(record) => openEditRecord(record)}
              onDeleteRecord={async (record) => {
                if (!(await confirm({
                  title: 'Delete lease sheet',
                  message: `Delete lease sheet ${record.ticket_number || ''}?`,
                  severity: 'danger',
                  okLabel: 'Delete',
                }))) return;
                // Optimistic: remove immediately so the acting admin doesn't
                // wait for Realtime (which can lag on iOS PWA / backgrounded tabs).
                setCachedRecents((prev) => prev.filter((r) => r.id !== record.id));
                try { void removeRecentById(record.id); } catch { /* ignore */ }
                try {
                  // Check if it's a site or pipeline lease sheet
                  if (record.site_id != null) {
                    await api.deleteSiteSprayRecord(record.id);
                  } else {
                    await api.deleteSprayRecord(record.id);
                  }
                  // Trigger delta sync to reconcile other clients
                  handleRequestSync();
                  setMessage('Lease sheet deleted');
                } catch (e) {
                  // Roll back the optimistic removal on failure
                  setCachedRecents((prev) => {
                    if (prev.some((r) => r.id === record.id)) return prev;
                    return [record, ...prev].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
                  });
                  try { void upsertRecent(record); } catch { /* ignore */ }
                  setMessage('Failed to delete lease sheet: ' + (e.message || 'unknown'));
                }
              }}
              onStartStandaloneLeaseSheet={handleStartStandaloneLeaseSheet}
              onStartHydroseedDaily={() => handleStartHydroseedDaily()}
              onOpenHydroseedTicket={(id) => setActiveHydroseedTicketId(id)}
              onResumeHydroseedDraft={(d) => {
                setResumingHydroseedDraft(d);
                setHydroseedDuplicateFrom(null);
                setEditingHydroseedRecord(null);
                setHydroseedDailyOpen(true);
              }}
              onEditHydroseedDaily={async (record) => {
                // List rows are slim (no daily_data) — fetch the full record
                // on demand so the form can hydrate all fields. This keeps
                // the recently-submitted list itself fast.
                setMessage('Loading record…');
                try {
                  const full = await api.getHydroseedDaily(record.id);
                  setEditingHydroseedRecord(full);
                  setResumingHydroseedDraft(null);
                  setHydroseedDuplicateFrom(null);
                  setHydroseedDailyOpen(true);
                  setMessage('');
                } catch (e) {
                  setMessage('Failed to load record: ' + (e?.message || 'unknown'));
                }
              }}
              onDuplicateHydroseedDaily={async (record) => {
                // Same on-demand fetch as Edit — duplication needs the full
                // daily_data snapshot to clone crew/ingredients/etc.
                setMessage('Loading record…');
                try {
                  const full = await api.getHydroseedDaily(record.id);
                  setMessage('');
                  handleStartHydroseedDaily({ duplicateFrom: full });
                } catch (e) {
                  setMessage('Failed to load record: ' + (e?.message || 'unknown'));
                }
              }}
              onStartLeaseSheetFromDraft={(draft) => {
                // Tapping a draft (or "New lease sheet") opens the lease sheet overlay.
                // When draft is null, the user needs to pick a site from the Map tab first.
                if (draft) {
                  setResumingDraft(draft);
                  // If draft has a site_id, focus that site; otherwise open the
                  // standalone (external) lease-sheet overlay so workers can
                  // resume drafts that were started from "New lease sheet".
                  if (draft.site_id) {
                    const foundSite = sites.find((s) => s.id === draft.site_id);
                    if (foundSite) {
                      setInspectionSite(foundSite);
                    } else {
                      setInspectionSite({ id: draft.site_id });
                    }
                    setInspectionSiteStatus(
                      draft.site_status === 'in_progress'
                        ? 'in_progress'
                        : draft.site_status === 'issue_not_inspected'
                          ? 'issue_not_inspected'
                          : 'inspected'
                    );
                  } else {
                    setInspectionSite(null);
                    setInspectionPipeline(null);
                    setInspectionSiteStatus('inspected');
                    setStandaloneLeaseSheet(true);
                  }
                } else {
                  setMessage('Select a site from the Map tab first, then tap "Mark as sprayed".');
                  setActiveTab(TAB_MAP);
                }
              }}
              onStartNewTMTicket={async ({ client, area, spray_date, description_of_work }) => {
                try {
                  const created = await api.createTMTicket({
                    spray_date,
                    client,
                    area,
                    description_of_work,
                  });
                  setActiveTMTicketId(created.id);
                } catch (e) {
                  setMessage('Failed to create T&M ticket: ' + (e.message || 'unknown'));
                }
              }}
              onOpenTMTicket={(ticketId) => setActiveTMTicketId(ticketId)}
              onRequestDraftsRefresh={() => setDraftsRefreshToken((x) => x + 1)}
              onRequestSync={handleRequestSync}
              draftsRefreshToken={draftsRefreshToken}
              tmRefreshToken={tmRefreshToken}
              hydroseedRefreshToken={hydroseedRefreshToken}
              hydroseedDailiesRefreshToken={hydroseedDailiesRefreshToken}
              roleCanAdmin={roleCanAdmin}
              viewAsWorker={viewAsWorker}
              currentUserName={currentUserName}
            />
            </Suspense>
          </div>
        </div>

        {/* ── Admin panel ── */}
        <div
          className={`side-panel ${activeTab === TAB_ADMIN && canManagePins ? 'open' : ''} ${adminPanelDragging ? 'dragging' : ''}`}
          onTouchStart={handleAdminPanelTouchStart}
          onTouchMove={handleAdminPanelTouchMove}
          onTouchEnd={handleAdminPanelTouchEnd}
          style={{
            transform: activeTab === TAB_ADMIN && canManagePins
              ? `translateX(${adminPanelDragOffset}px)`
              : 'translateX(100%)'
          }}
        >
          <div className="side-panel-header">
            <h2>Admin</h2>
          </div>
          <div className="side-panel-body">
            <Suspense fallback={<div className="small-text" style={{ padding: '1rem' }}>Loading admin tools…</div>}>
            <AdminPanel
              visible={true}
              devices={devices}
              onRefreshDevices={loadDevices}
              onLocateDevice={handleLocateDevice}
              canOnlyManagePins={isCrewLeadOnly}
              pendingSites={pendingSites}
              deletedSites={deletedSites}
              clients={clients}
              areas={areas}
              busy={adminBusy}
              onApprove={(siteId, overrides) => runAdminAction(
                () => api.approveSite(siteId, { approval_state: 'approved', ...overrides }),
                'Approved.',
                {
                  // Remove-then-reinsert instead of .map() because
                  // @react-google-maps/api's Marker component caches the
                  // initial `icon` prop and ignores subsequent updates.
                  // Removing the site forces the old "!" Marker to unmount;
                  // reinserting with approval_state='approved' mounts a
                  // fresh Marker with the correct pin-type icon. This
                  // mirrors how handleDeleteSite works (filter removes the
                  // site, marker unmounts cleanly).
                  optimistic: () => {
                    setPendingSites((prev) => removeSitesByIdentity(prev, siteId));
                    setSites((prev) => {
                      const match = prev.find((s) => matchSiteIdentity(s, siteId));
                      const without = removeSitesByIdentity(prev, siteId);
                      if (!match) return without;
                      return [...without, { ...match, approval_state: 'approved', ...overrides }];
                    });
                  },
                },
              )}
              onReject={async (siteId) => {
                setAdminBusy(true);
                // Optimistic remove BEFORE the API call so the card vanishes
                // immediately AND the orange "!" marker on the map is
                // dropped in the same React tick. Snapshot both rows so we
                // can put them back if the server refuses the reject (e.g.
                // structured 409 for linked spray records).
                const removedPending = pendingSites.find((s) => matchSiteIdentity(s, siteId)) || null;
                const removedFromSites = sites.find((s) => matchSiteIdentity(s, siteId)) || null;
                setPendingSites((prev) => removeSitesByIdentity(prev, siteId));
                setSites((prev) => removeSitesByIdentity(prev, siteId));
                setSelectedSite((prev) => (matchSiteIdentity(prev, siteId) ? null : prev));
                setDetailOpen((open) => (matchSiteIdentity(selectedSiteRef.current, siteId) ? false : open));
                // Also purge from IndexedDB so a cold-start can't resurrect it.
                void removeSite({ id: siteId });
                try {
                  await api.approveSite(siteId, { approval_state: 'rejected' });
                  setMessage('Rejected.');
                  // Belt-and-suspenders: force another removal pass in case
                  // a concurrent delta/realtime upserted the row back while
                  // the API call was in flight.
                  setSites((prev) => removeSitesByIdentity(prev, siteId));
                  void removeSite({ id: siteId });
                  // Background catch-up — runPollTick handles the
                  // pending-sites refetch via count-divergence; calling
                  // loadPendingSites() in parallel would fire the same
                  // endpoint twice.
                  try { runPollTickRef.current?.(); } catch { /* non-fatal */ }
                } catch (error) {
                  // Roll back both optimistic removes so the card and the
                  // map marker both come back with their original data.
                  if (removedPending) {
                    setPendingSites((prev) => (prev.some((s) => matchSiteIdentity(s, siteId)) ? prev : [removedPending, ...prev]));
                  }
                  if (removedFromSites) {
                    setSites((prev) => (prev.some((s) => matchSiteIdentity(s, siteId)) ? prev : [removedFromSites, ...prev]));
                  }
                  if (!(await explainRejectConflict(error, 'pin'))) {
                    setMessage(error?.message || 'Reject failed.');
                  }
                } finally {
                  setAdminBusy(false);
                }
              }}
              onApproveAndEdit={handleApproveAndEdit}
              onApprovePipelineAndEdit={handleApprovePipelineAndEdit}
              onBulkApprovePending={handleBulkApprovePending}
              onBulkRejectPending={handleBulkRejectPending}
              onBulkReset={(payload) => runAdminAction(
                () => api.bulkResetStatus(payload),
                'Reset complete.',
                { pendingMessage: 'Resetting statuses…' },
              )}
              onImport={(file) => runAdminAction(
                () => api.importKml(file),
                'KML imported.',
                { pendingMessage: 'Importing KML… this can take 10–20 s on large files.' },
              )}
              onRestore={handleRestoreSite}
              onDeletePermanent={handleDeletePermanent}
              onSelectSite={(site) => { setZoomTarget({ ...site, _ts: Date.now() }); setActiveTab(TAB_MAP); setSelectedSite(site); setDetailOpen(true); }}
              currentUserEmail={user?.email}
              pendingPipelines={pendingPipelines}
              onApprovePipeline={(pipelineId, payload) => runAdminAction(
                async () => { await api.approvePipeline(pipelineId, payload); await loadPipelines(); },
                'Pipeline approved.',
                {
                  // Array-only mutation; derivation effect handles the count.
                  optimistic: () => {
                    setPendingPipelines((prev) => prev.filter((p) => p.id !== pipelineId));
                  },
                },
              )}
              onRejectPipeline={async (pipelineId) => {
                setAdminBusy(true);
                // Same snapshot-then-remove pattern as the site reject
                // branch: card + polyline vanish instantly and we put them
                // back if the server refuses.
                const removedPending = pendingPipelines.find((p) => p.id === pipelineId) || null;
                const removedFromPipelines = pipelines.find((p) => p.id === pipelineId) || null;
                setPendingPipelines((prev) => prev.filter((p) => p.id !== pipelineId));
                setPipelines((prev) => prev.filter((p) => p.id !== pipelineId));
                try {
                  await api.approvePipeline(pipelineId, { approval_state: 'rejected' });
                  setMessage('Pipeline rejected.');
                  // runPollTick handles both the pipelines list (via
                  // syncPipelinesIncrementally + delta endpoint) and
                  // the pending-pipelines list (via count-divergence
                  // re-fetch). Explicit loadPipelines + loadPendingPipelines
                  // here would just fire the same endpoints in parallel.
                  try { runPollTickRef.current?.(); } catch { /* non-fatal */ }
                } catch (error) {
                  if (removedPending) {
                    setPendingPipelines((prev) => (prev.some((p) => p.id === pipelineId) ? prev : [removedPending, ...prev]));
                  }
                  if (removedFromPipelines) {
                    setPipelines((prev) => (prev.some((p) => p.id === pipelineId) ? prev : [removedFromPipelines, ...prev]));
                  }
                  if (!(await explainRejectConflict(error, 'pipeline'))) {
                    setMessage(error?.message || 'Reject failed.');
                  }
                } finally {
                  setAdminBusy(false);
                }
              }}
              onImportPipelineKml={(file) => runAdminAction(
                async () => { await api.importPipelineKml(file); await loadPipelines(); },
                'Pipeline KML imported.',
                { pendingMessage: 'Importing pipeline KML… this can take 10–20 s on large files.' },
              )}
              onBulkResetPipelines={(payload) => runAdminAction(
                async () => { await api.bulkResetPipelines(payload); await loadPipelines(); },
                'Pipelines reset to not sprayed.',
                { pendingMessage: 'Resetting pipelines…' },
              )}
              onSelectPipeline={(pipeline) => { handleOpenPipelineDetail(pipeline); setActiveTab(TAB_MAP); }}
              deletedPipelines={deletedPipelines}
              onRestorePipeline={(pipelineId) => runAdminAction(
                async () => { await api.restorePipeline(pipelineId); await loadPipelines(); await loadDeletedPipelines(); },
                'Pipeline restored.',
                { optimistic: () => setDeletedPipelines((prev) => prev.filter((p) => p.id !== pipelineId)) },
              )}
              onDeletePipelinePermanent={(pipelineId) => runAdminAction(
                async () => { await api.deletePipelinePermanent(pipelineId); await loadDeletedPipelines(); },
                'Pipeline permanently deleted.',
                { optimistic: () => setDeletedPipelines((prev) => prev.filter((p) => p.id !== pipelineId)) },
              )}
              deletedLeaseSheets={deletedLeaseSheets}
              onRestoreLeaseSheet={handleRestoreLeaseSheet}
              onDeleteLeaseSheetPermanent={handleDeleteLeaseSheetPermanent}
              deletedTMTickets={deletedTMTickets}
              onRestoreTMTicket={handleRestoreTMTicket}
              onDeleteTMTicketPermanent={handleDeleteTMTicketPermanent}
              deletedHydroseedDailies={deletedHydroseedDailies}
              onRestoreHydroseedDaily={handleRestoreHydroseedDaily}
              onDeleteHydroseedDailyPermanent={handleDeleteHydroseedDailyPermanent}
              deletedHydroseedTickets={deletedHydroseedTickets}
              onRestoreHydroseedTicket={handleRestoreHydroseedTicket}
              onDeleteHydroseedTicketPermanent={handleDeleteHydroseedTicketPermanent}
              onBulkDeleteAllPermanent={handleBulkDeleteAllPermanent}
              cachedLookups={cachedLookups}
              onLookupsChanged={loadServerLookups}
              cachedUsers={cachedUsers}
              onUsersChanged={loadServerUsers}
              // Only wired for admin/office sessions. Worker sessions
              // don't render AdminPanel at all, but guarding here too
              // makes the intent explicit and keeps the button from
              // appearing if an admin flips on "View as Worker".
              onOpenReports={roleCanAdmin ? () => setShowReportsDashboard(true) : undefined}
              onOpenQuotes={roleCanAdmin ? () => setShowQuoteBuilder(true) : undefined}
              onOpenCalendar={roleCanAdmin ? () => setShowCalendar(true) : undefined}
              // Check-ins Dashboard (Overview / Active / History / Settings).
              // Admin/office full controls, crew_lead read-only (the dashboard
              // hides force/override buttons via isAdmin={actualCanAdmin}).
              // Workers manage their own shift via the avatar-menu
              // "🛟 Check-ins" item which opens MyCheckInsOverlay.
              onOpenCheckins={canManagePins ? () => setShowCheckinsDashboard(true) : undefined}
              // Operations TV dashboard overlay. Admin/office only (the
              // read-only board with check-ins + progress donut + throughput).
              onOpenTvDashboard={roleCanAdmin ? () => setShowTvDashboard(true) : undefined}
              deletedQuotes={deletedQuotes}
              onRestoreQuote={handleRestoreQuote}
              onDeleteQuotePermanent={handleDeleteQuotePermanent}
            />
            </Suspense>
          </div>
        </div>
      </main>

      {/* ── Reports dashboard (admin/office full-page overlay) ──
          Only mounted when the user has explicitly opened it via the
          button in AdminPanel. Guarded by roleCanAdmin so the overlay
          can't stick around if the role downgrades (view-as-worker). */}
      {showReportsDashboard && roleCanAdmin ? (
        <Suspense fallback={null}>
          <ReportsDashboard
            onClose={() => setShowReportsDashboard(false)}
            cachedLookups={cachedLookups}
          />
        </Suspense>
      ) : null}

      {/* ── Quote Builder (admin/office full-page overlay) ──
          Same pattern as ReportsDashboard: only mounted while open, lazy
          chunk fetched on first open, no background polling. Closes if
          role downgrades (View as Worker) thanks to the roleCanAdmin
          guard, which mirrors the Reports overlay above. onQuotesChanged
          refreshes the deleted-quotes list so AdminPanel reflects soft
          deletes the user performs from the Recent Quotes tab. */}
      {showQuoteBuilder && roleCanAdmin ? (
        <Suspense fallback={null}>
          <QuoteBuilder
            onClose={() => setShowQuoteBuilder(false)}
            onQuotesChanged={loadDeletedQuotes}
            clients={clients}
            areas={areas}
          />
        </Suspense>
      ) : null}

      {/* ── Calendar overlay (admin/office full-page) ──
          Lazy-mounted, opens its own Supabase Realtime channel on mount
          for live tasks/events/bids/contacts sync across office devices,
          and tears it down on close. Guarded by roleCanAdmin so flipping
          "View as Worker" force-closes the overlay. `clients` is passed
          so the contacts drawer's "client" autocomplete reuses the same
          list as the rest of the app. */}
      {showCalendar && roleCanAdmin ? (
        <Suspense fallback={null}>
          <CalendarOverlay
            onClose={() => setShowCalendar(false)}
            clients={clients}
            currentUser={user}
          />
        </Suspense>
      ) : null}

      {/* ── My Check-ins (personal overlay) ────────────────────────────
          Open whenever the user explicitly invokes it (avatar menu /
          topbar countdown click / soft-banner / SW notificationclick)
          OR the forced-overlay effect has flipped on (T-5 + no recent
          check-in). The two flags are OR'd so a worker can manually
          open the overlay while it would also have been forced -- the
          forced-mode rendering (force={forceCheckinOverlay}) just
          strips the close button when true. */}
      {(showMyCheckins || forceCheckinOverlay) && user ? (
        <Suspense fallback={null}>
          <MyCheckInsOverlay
            force={forceCheckinOverlay}
            isOnline={isOnline}
            currentUserId={user?.id}
            onClose={() => {
              setShowMyCheckins(false);
              // Forced overlays only close via successful check-in (or
              // End shift, or Dismiss-while-offline). The overlay
              // itself calls onClose after those actions -- we honour
              // it by also clearing the force flag so a stale offline
              // dismiss doesn't sit on top forever.
              setForceCheckinOverlay(false);
            }}
            // Immediately mirror the worker's own shift mutations into
            // our state so the topbar countdown updates without waiting
            // for Supabase Realtime -- iOS PWAs frequently drop the
            // websocket while backgrounded, which is why workers used to
            // have to close+reopen the iPad app to see the timer.
            onShiftChanged={(next) => {
              setActiveShift(next && !next.ended_at && next.mode !== 'off' ? next : null);
            }}
          />
        </Suspense>
      ) : null}

      {/* ── Check-ins Dashboard (admin / office / crew_lead overlay) ──
          Lazy chunk, opens its own Realtime subscription. Closes if
          canManagePins flips false (View as Worker). Crew leads see the
          dashboard in read-only mode via isAdmin={actualCanAdmin}. */}
      {showCheckinsDashboard && canManagePins ? (
        <Suspense fallback={null}>
          <CheckInsOverlay
            onClose={() => setShowCheckinsDashboard(false)}
            isAdmin={actualCanAdmin}
          />
        </Suspense>
      ) : null}

      {/* ── Operations TV dashboard (admin/office overlay) ──
          Same component the dedicated `tv` kiosk role boots into, but
          opened here as a dismissible overlay. Gated on roleCanAdmin so it
          closes automatically if an admin flips on "View as Worker". */}
      {showTvDashboard && roleCanAdmin ? (
        <Suspense fallback={null}>
          <TVDashboard onClose={() => setShowTvDashboard(false)} />
        </Suspense>
      ) : null}

      {/* ── Import (link) standalone lease sheet to visible pin (pin managers) ── */}
      {showLinkModal && linkModalTargetSite && canManagePins ? (
        <Suspense fallback={null}>
          <LinkLeaseSheetModal
            targetSite={linkModalTargetSite}
            onConfirm={handleLinkLeaseSheetConfirm}
            onCancel={() => { setShowLinkModal(false); setLinkModalTargetSite(null); }}
          />
        </Suspense>
      ) : null}

      {/* ── Approve & Edit review modal (admin) ── */}
      {approveEditTarget ? (
        <Suspense fallback={null}>
          <ApproveEditModal
            kind={approveEditTarget.kind}
            target={approveEditTarget.target}
            onClose={() => setApproveEditTarget(null)}
            onSubmitted={async () => {
              await refreshAllData();
              if (approveEditTarget.kind === 'pipeline') {
                await loadPendingPipelines();
              }
              setMessage('Approved.');
            }}
            // Autofill data for the Approve & Edit modal so an admin
            // correcting a worker's pending submission sees existing
            // LSD/client/area values as suggestions — same pattern as
            // the in-map "Add pin" popup. lsdSuggestions is only
            // meaningful for site approvals (pipelines have unique
            // names that wouldn't suggest usefully); the modal itself
            // skips the LSD autocomplete when kind === 'pipeline'.
            clientSuggestions={clients}
            lsdSuggestions={lsdSuggestions}
            getAreasForClient={getAreasForClient}
            // Pass the herbicide + applicator lookup caches so the
            // PDF-regen path inside Approve & Edit can render PCP and
            // licence numbers (they live in the lookup tables, not in
            // the saved lease_sheet_data).
            cachedLookups={cachedLookups}
          />
        </Suspense>
      ) : null}

      {/* ── Bottom tabs ── */}
      <nav className="bottom-tabs">
        <button className={`tab-btn ${activeTab === TAB_MAP ? 'active' : ''}`} type="button" onClick={() => setActiveTab(TAB_MAP)}>
          <MapIcon />
          <span>Map</span>
        </button>
        <button className={`tab-btn ${activeTab === TAB_SITES ? 'active' : ''}`} type="button" onClick={() => { 
          if (activeTab === TAB_SITES) {
            setActiveTab(TAB_MAP);
          } else {
            setActiveTab(TAB_SITES);
          }
          setDetailOpen(false); 
        }}>
          <ListIcon />
          <span>Sites</span>
        </button>
        <button className={`tab-btn ${activeTab === TAB_FORMS ? 'active' : ''}`} type="button" onClick={() => { 
          if (activeTab === TAB_FORMS) {
            setActiveTab(TAB_MAP);
          } else {
            setActiveTab(TAB_FORMS);
            setDetailOpen(false);
          }
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          <span>Forms</span>
        </button>
        {canManagePins ? (
          <button className={`tab-btn ${activeTab === TAB_ADMIN ? 'active' : ''}`} type="button" onClick={() => { 
            if (activeTab === TAB_ADMIN) {
              setActiveTab(TAB_MAP);
            } else {
              setActiveTab(TAB_ADMIN);
              setDetailOpen(false);
            }
          }}>
            <GearIcon />
            <span>Admin</span>
          </button>
        ) : null}
      </nav>
    </div>
  );
}
