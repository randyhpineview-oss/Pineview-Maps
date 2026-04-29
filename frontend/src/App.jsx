import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import AdminPanel from './components/AdminPanel';
import ApproveEditModal from './components/ApproveEditModal';
import AutocompleteInput from './components/AutocompleteInput';
import FilterBar from './components/FilterBar';
import HerbicideLeaseSheet from './components/HerbicideLeaseSheet';
import InstallAppPrompt from './components/InstallAppPrompt';
import LoginPage from './components/LoginPage';
import MapView from './components/MapView';
import SignupPage from './components/SignupPage';
import PipelineDetailSheet from './components/PipelineDetailSheet';
import PdfPreviewOverlay from './components/PdfPreviewOverlay';
import FormsPanel from './components/FormsPanel';
import TMTicketDetailSheet from './components/TMTicketDetailSheet';
import SiteDetailSheet from './components/SiteDetailSheet';
import { api } from './lib/api';
import { requestWithUploadProgress } from './lib/xhrUpload';
import { nearestFraction } from './lib/mapUtils';
import { generateLeaseSheetPdf } from './lib/pdfGenerator';
import { generateTMTicketPdf } from './lib/tmTicketPdfGenerator';
import { onAuthStateChange, signOut } from './lib/supabaseClient';
import { APP_VERSION_LABEL } from './version';
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
  queueUpload,
  removePipeline,
  removeQueuedAction,
  removeRecentById,
  removeUploadEntry,
  removeSite,
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
} from './lib/offlineStore';
import { formatDate, pinTypeLabel, statusLabel } from './lib/mapUtils';

const DEFAULT_FILTERS = { search: '', client: '', area: '', status: '', approval_state: '' };
const DEFAULT_LAYERS = { lsd: true, water: true, quad_access: true, reclaimed: true, pipelines: true };
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

function matchSiteIdentity(site, selectedSite) {
  if (!selectedSite) {
    return false;
  }
  return String(site.id ?? site.cacheId) === String(selectedSite.id ?? selectedSite.cacheId);
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
  if (filters.client && site.client !== filters.client && !isWater) {
    hiding.push({ kind: 'filter', key: 'client', label: `${FILTER_LABELS.client} filter` });
  }
  if (filters.area && site.area !== filters.area && !isWater) {
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
  const wasOnline = useRef(window.navigator.onLine);
  const lastSyncStatusRef = useRef(null);
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
  // (`pendingSites`) is only fetched after roleCanAdmin + an online check,
  // so on cold start the topbar's "Pending: N" badge used to flicker on
  // empty for ~1 s while the network call resolved. Keeping a separate
  // count lets the badge render the right number INSTANTLY from cache.
  // Falls back to the array length when null (first run, never online).
  const [pendingSitesCount, setPendingSitesCount] = useState(null);
  const [pendingPipelinesCount, setPendingPipelinesCount] = useState(null);
  const [deletedSites, setDeletedSites] = useState([]);
  const [deletedLeaseSheets, setDeletedLeaseSheets] = useState([]);
  const [deletedTMTickets, setDeletedTMTickets] = useState([]);
  const [selectedSite, setSelectedSite] = useState(null);
  const [message, setMessage] = useState('Loading project data...');
  const [isOnline, setIsOnline] = useState(window.navigator.onLine);
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
  // Pipeline state
  const [pipelines, setPipelines] = useState([]);
  const [pendingPipelines, setPendingPipelines] = useState([]);
  const [deletedPipelines, setDeletedPipelines] = useState([]);
  const [selectedPipeline, setSelectedPipeline] = useState(null);
  const [pipelineDetailOpen, setPipelineDetailOpen] = useState(false);
  const [pipelineSprayRecords, setPipelineSprayRecords] = useState([]);
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  // Drawing pipeline state
  const [isDrawingPipeline, setIsDrawingPipeline] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState([]);
  const [drawingForm, setDrawingForm] = useState({ name: '', client: '', area: '' });
  const [showDrawingForm, setShowDrawingForm] = useState(false);
  // Spray marking state
  const [isSprayMarking, setIsSprayMarking] = useState(false);
  const [sprayStartPoint, setSprayStartPoint] = useState(null);
  const [sprayEndPoint, setSprayEndPoint] = useState(null);
  const [showSprayConfirm, setShowSprayConfirm] = useState(false);
  const [sprayForm, setSprayForm] = useState({ date: new Date().toISOString().split('T')[0], notes: '', is_avoided: false });
  const [pendingPipelineSegment, setPendingPipelineSegment] = useState(null);
  const [highlightedSprayRecordId, setHighlightedSprayRecordId] = useState(null);
  const [isFollowingUser, setIsFollowingUser] = useState(false);
  // Lease sheet inspection state
  const [inspectionSite, setInspectionSite] = useState(null);
  const [inspectionPipeline, setInspectionPipeline] = useState(null);
  const [inspectionSiteStatus, setInspectionSiteStatus] = useState('inspected');
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
  // Lease-sheet record preview state
  const [previewingRecord, setPreviewingRecord] = useState(null);
  // Edit spray record state
  const [editingSprayRecord, setEditingSprayRecord] = useState(null);
  // T&M ticket detail view
  const [activeTMTicketId, setActiveTMTicketId] = useState(null);
  // Lease sheet draft being resumed
  const [resumingDraft, setResumingDraft] = useState(null);
  // Token used to force FormsPanel to refresh drafts list
  const [draftsRefreshToken, setDraftsRefreshToken] = useState(0);
  // Token bumped by the poll loop whenever sync-status reports
  // `tm_tickets_last_updated` has moved. FormsPanel listens to it and
  // re-fetches its Open / Recently Submitted T&M lists so users see
  // updates without a full page reload — at the cost of only one extra
  // MAX(updated_at) query in sync-status, which is already indexed.
  const [tmRefreshToken, setTmRefreshToken] = useState(0);
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
  const userRole = session?.user?.user_metadata?.role || 'worker';
  const actualCanAdmin = userRole === 'admin' || userRole === 'office';

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

  // If the user isn't actually admin/office, force the toggle off so a
  // stale localStorage value from a previous session/account doesn't lock
  // a real worker into some phantom "view as worker" state. (No-op for
  // actual workers since the effective roles are already false.)
  useEffect(() => {
    if (!actualCanAdmin && viewAsWorker) setViewAsWorker(false);
  }, [actualCanAdmin, viewAsWorker]);

  // If the user was sitting on the Admin tab when they flipped to worker
  // view, bounce them back to the Map tab so they don't end up staring
  // at a blank screen (the admin panel is hidden once roleCanAdmin is
  // false, but `activeTab` would still be TAB_ADMIN without this snap).
  useEffect(() => {
    if (viewAsWorker && activeTab === TAB_ADMIN) setActiveTab(TAB_MAP);
  }, [viewAsWorker, activeTab]);

  // Effective permissions \u2014 downgraded to worker-level when the toggle
  // is on. Every role-gated render in the app reads these, not the raw
  // userRole, so flipping the toggle instantly updates the whole UI.
  const canManagePins = actualCanAdmin && !viewAsWorker;
  const roleCanAdmin = actualCanAdmin && !viewAsWorker;

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
    if (!roleCanAdmin || !window.navigator.onLine) {
      setPendingSites([]);
      setDeletedSites([]);
      return;
    }
    try {
      const pending = await api.listPendingSites();
      setPendingSites(pending);
    } catch {
      setPendingSites([]);
    }
    try {
      const deleted = await api.listDeletedSites();
      setDeletedSites(deleted);
    } catch {
      setDeletedSites([]);
    }
  }, [roleCanAdmin]);

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
      const byId = new Map(prev.map((s) => [s.id, s]));
      return sitesPayload.map((item) => {
        const existing = byId.get(item.id);
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
      const data = await api.listRecentSubmissions();
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
    // Only admins can list users — skip the call for office/worker to avoid
    // a 403 on every page load (harmless but noisy in the Render logs).
    if (userRole !== 'admin') return;
    try {
      const data = await api.listUsers();
      setCachedUsers(data);
      await replaceUsers(data);
    } catch {
      console.error('[USERS] Failed to load from server');
    }
  }, [userRole]);

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
    if (!roleCanAdmin || !window.navigator.onLine) {
      setPendingPipelines([]);
      return;
    }
    try {
      const pending = await api.listPendingPipelines();
      setPendingPipelines(pending);
    } catch {
      setPendingPipelines([]);
    }
  }, [roleCanAdmin]);

  const loadDeletedPipelines = useCallback(async () => {
    if (!roleCanAdmin || !window.navigator.onLine) {
      setDeletedPipelines([]);
      return;
    }
    try {
      const deleted = await api.listDeletedPipelines();
      setDeletedPipelines(deleted);
    } catch {
      setDeletedPipelines([]);
    }
  }, [roleCanAdmin]);

  const loadDeletedLeaseSheets = useCallback(async () => {
    if (!roleCanAdmin || !window.navigator.onLine) {
      setDeletedLeaseSheets([]);
      return;
    }
    try {
      const deleted = await api.listDeletedLeaseSheets();
      setDeletedLeaseSheets(deleted);
    } catch {
      setDeletedLeaseSheets([]);
    }
  }, [roleCanAdmin]);

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
    if (payload.ticket_number && payload.pdf_base64) return payload;

    // Reconstruct the PDF input shape the form used. lease_sheet_data is
    // the full form snapshot; herbicidesLookup comes from the local cache
    // so we still produce PCP numbers even when the API roundtrip would
    // otherwise add latency to the upload path.
    const leaseData = payload.lease_sheet_data || {};
    const photoArr = Array.isArray(leaseData.photos) ? leaseData.photos : [];
    const photoDataUrls = photoArr
      .filter((p) => p && p.data)
      .map((p) => `data:${p.type || 'image/jpeg'};base64,${p.data}`);

    let herbicidesLookup = [];
    try { herbicidesLookup = await getLookups('herbicides'); } catch { /* fall through with empty lookup */ }

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
      const out = await generateLeaseSheetPdf(
        { ...leaseData, ticket_number: ticketNumber, herbicidesLookup },
        photoDataUrls
      );
      pdfBase64 = out.base64;
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

          // Per-file progress callback. Cap at 0.95 during the upload
          // phase: once XHR fires `upload.onload` (fraction === 1) the
          // bytes are sent, but the backend still has to render the PDF
          // and push it to Dropbox — we have no client-side signal for
          // that work, so 95% says "almost done" without lying. The
          // jump to 100% happens via setUploadProgress below once the
          // promise actually resolves.
          const itemsBefore = completed;
          // Throttle progress to ~10 Hz. XHR upload.onprogress fires every
          // ~50 ms on Wi-Fi, which causes a React re-render storm in
          // FormsPanel + interrupts the bar's CSS transition mid-ease,
          // showing visible jitter on mobile. 100 ms cadence is plenty
          // for a smooth-looking bar without thrashing the render loop.
          let lastProgressTs = 0;
          const onItemBytes = (fraction) => {
            const now = Date.now();
            const isComplete = fraction >= 0.95;
            if (!isComplete && now - lastProgressTs < 100) return;
            lastProgressTs = now;
            const capped = Math.max(0, Math.min(0.95, fraction));
            setCurrentItemPercent(Math.round(capped * 100));
            const overall = ((itemsBefore + capped) / total) * 100;
            setUploadProgress(Math.min(99, Math.round(overall)));
          };
          // Reset the per-file readout at the start of each item so the
          // bar visibly restarts "file 2/3 — 0% ..." rather than carrying
          // the previous file's 95% across the boundary.
          setCurrentItemPercent(0);
          // Mark this queue entry as the active uploader so FormsPanel's
          // Uploading tab can render a live progress bar on just this
          // row (and leave the rest showing "Queued").
          setActiveUploadItemId(item.id);

          if (item.targetType === 'site') {
            // Offline-queued sheets may not have a ticket / PDF yet —
            // render and reserve at upload time so Dropbox gets a PDF
            // with the real ticket number printed on it.
            const patched = await ensurePdfAndTicket(item);
            await requestWithUploadProgress(`/api/sites/${item.targetId}/spray`, {
              method: 'POST',
              body: patched,
              onProgress: onItemBytes,
            });
            // Refresh the site data in background (including pdf_url from Dropbox)
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
            } catch { /* ignore refresh failure */ }
            if (bumpsTm) setTmRefreshToken((x) => x + 1);
          } else if (item.targetType === 'pipeline') {
            const patched = await ensurePdfAndTicket(item);
            await requestWithUploadProgress(`/api/pipelines/${item.targetId}/spray`, {
              method: 'POST',
              body: patched,
              onProgress: onItemBytes,
            });
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
            } catch { /* ignore refresh failure */ }
            if (bumpsTm) setTmRefreshToken((x) => x + 1);
          } else if (item.targetType === 'site_spray_edit') {
            // Fix #2 — offline-queued lease-sheet edits. Mirrors the create
            // path but uses the PATCH endpoint. Edit payloads always carry
            // an existing ticket number (from the record being edited),
            // so we don't need to call ensurePdfAndTicket — the form
            // already produced a fresh PDF when the worker hit Save.
            await requestWithUploadProgress(`/api/site-spray-records/${item.targetId}`, {
              method: 'PATCH',
              body: item.payload,
              onProgress: onItemBytes,
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
              onProgress: onItemBytes,
            });
            // Nudge FormsPanel to immediately delta-sync its ticket cache.
            // Without this, the worker would see the just-submitted ticket
            // stuck in "Open Tickets" for up to 5 minutes until the next
            // poll tick — visually the row appears in both Open Tickets
            // AND Recently Submitted because the local status is stale.
            // Bumping the token causes an instant `/api/time-materials/delta`
            // call which overwrites the cached row with status='submitted'.
            setTmRefreshToken((x) => x + 1);
          }
          await removeUploadEntry(item.id);
          completed++;
          setUploadCompleted(completed);
          setUploadProgress(Math.round((completed / total) * 100));
          // Item finished — show 100% briefly on the per-file readout
          // before the next iteration resets it back to 0%. Without this
          // the bar would jump from 95% (during upload) straight to the
          // next file's 0%, hiding the "this file is done" beat.
          setCurrentItemPercent(100);
        } catch (err) {
          console.warn('[UPLOAD_QUEUE] Failed to upload item', item.id, '— will retry next cycle:', err?.message || err);
          // Leave it in queue for retry on next poll cycle
        }
      }
    } finally {
      uploadingRef.current = false;
      setIsUploading(false);
      setUploadProgress(0);
      setUploadTotal(0);
      setUploadCompleted(0);
      setCurrentItemPercent(0);
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
            loadPipelines(),
            loadPendingPipelines(),
            loadDeletedPipelines(),
            loadDeletedLeaseSheets(),
            loadDeletedTMTickets(),
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
      loadServerSites, loadServerRecents, loadServerLookups, loadServerUsers,
      loadPipelines, loadPendingPipelines, loadDeletedPipelines,
      loadDeletedLeaseSheets, loadDeletedTMTickets]);

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
  const handleManualRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refreshAllData();
      await refreshQueueCount();
      await refreshUploadQueue();
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, refreshAllData, refreshQueueCount, refreshUploadQueue]);

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

  useEffect(() => {
    void refreshQueueCount();
    void refreshUploadQueue().then(() => {
      // Process any pending uploads from previous session
      if (window.navigator.onLine) processUploadQueue();
    });
    // Use the smart boot path: hydrate from cache when possible, otherwise
    // fall back to a full server fetch. See bootHydrate above.
    void bootHydrate();

    // ── Debug helpers for upload queue ──
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
  }, [bootHydrate, refreshQueueCount, refreshUploadQueue, processUploadQueue]);

  // Ref wired up by the auto-poll useEffect below. Lets the back-online
  // handler reuse the same delta-poll logic without duplicating it or pulling
  // the full site/pipeline lists on every wifi-to-cell handoff in the field.
  const runPollTickRef = useRef(null);

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

    // 5-minute poll cadence. Visibility change still triggers an immediate
    // tick when the tab becomes visible, so users get fresh data on wake
    // without the 2-min background drum-beat that used to churn the pooler.
    const POLL_MS = 300000;

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

      // No watermark yet → do a full fetch, which also seeds the watermark
      // for future delta calls.
      if (!sitesSinceRef.current) {
        try {
          const full = await api.listSites(serverFilters);
          setSites((prev) => {
            const byId = new Map(prev.map((s) => [s.id, s]));
            return full.map((item) => mergeSite(byId.get(item.id), item));
          });
          await replaceSites(full);
          if (selectedSite && Number.isInteger(selectedSite.id)) {
            const updated = full.find((s) => s.id === selectedSite.id);
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
            const byId = new Map(prev.map((s) => [s.id, s]));
            for (const item of items) byId.set(item.id, mergeSite(byId.get(item.id), item));
            for (const id of idsRemoved) byId.delete(id);
            return Array.from(byId.values());
          });

          // Keep the currently-viewed site in sync when the delta includes it.
          if (selectedSite && Number.isInteger(selectedSite.id)) {
            const hit = items.find((s) => s.id === selectedSite.id);
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
          setSites((prev) => {
            const byId = new Map(prev.map((s) => [s.id, s]));
            return full.map((item) => mergeSite(byId.get(item.id), item));
          });
          await replaceSites(full);
          if (selectedSite && Number.isInteger(selectedSite.id)) {
            const updated = full.find((s) => s.id === selectedSite.id);
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
          const full = await api.listRecentSubmissions();
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
          for (const id of idsRemoved) await deleteRecent(id);
        }

        recentsSinceRef.current = delta.server_time || recentsSinceRef.current;
      } catch {
        try {
          const full = await api.listRecentSubmissions();
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

        // Snapshot prev pending counts BEFORE overwriting the ref so the
        // pending-list re-fetch guard below sees the real delta.
        const prevPendingSites = lastSyncStatusRef.current?.pending_sites_count;
        const prevPendingPipelines = lastSyncStatusRef.current?.pending_pipelines_count;

        lastSyncStatusRef.current = syncStatus;

        if (sitesChanged) await syncSitesIncrementally(syncStatus);
        if (pipelinesChanged) await syncPipelinesIncrementally(syncStatus);
        if (recentsChanged) await syncRecentsIncrementally(syncStatus);
        // Don't fetch tickets here — bumping the token lets the visible
        // FormsPanel decide whether to fetch (it only does when the
        // relevant tab is in view, saving egress when nobody's looking).
        if (tmTicketsChanged) setTmRefreshToken((x) => x + 1);

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

        if (syncStatus.pending_sites_count !== undefined) setPendingSitesCount(syncStatus.pending_sites_count);
        if (syncStatus.pending_pipelines_count !== undefined) setPendingPipelinesCount(syncStatus.pending_pipelines_count);

        // Only re-fetch the pending lists when the counts actually moved
        // since the last tick. Before, we'd re-download the full pending
        // list every 2 minutes as long as ANY rows were pending, which
        // dominated the egress of any admin session. `prevPending*` was
        // snapshot above before `lastSyncStatusRef.current = syncStatus`.
        if (roleCanAdmin) {
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
    };

    const pollInterval = setInterval(runPollTick, POLL_MS);

    // Expose the latest tick to the back-online handler so it can trigger a
    // cheap delta sync instead of running a full refreshAllData() whenever
    // the network flaps.
    runPollTickRef.current = runPollTick;

    // Immediate refresh when tab becomes visible again (covers phone-unlock, tab-switch).
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runPollTick();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      runPollTickRef.current = null;
    };
  }, [isOnline, serverFilters, roleCanAdmin, selectedSite, processUploadQueue]);

  const visibleSites = useMemo(() => {
    const normalizedSearch = filters.search.trim().toLowerCase();
    return sites.filter((site) => {
      const isWater = site.pin_type === 'water';
      // Layer visibility check
      if (site.pin_type && !layers[site.pin_type]) return false;
      if (filters.client && site.client !== filters.client && !isWater) return false;
      if (filters.area && site.area !== filters.area && !isWater) return false;
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
      if (filters.client && p.client !== filters.client) return false;
      if (filters.area && p.area !== filters.area) return false;
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
      baseSites = baseSites.filter(s => (s.id ?? s.cacheId) !== (selectedSite.id ?? selectedSite.cacheId));
      baseSites = [...baseSites, previewSite];
    }
    
    // Always overlay water pins if their layer is on, even when other filters are active
    if (layers.water) {
      const visibleIds = new Set(baseSites.map((s) => s.id ?? s.cacheId));
      const waterOverlay = sites.filter((s) => s.pin_type === 'water' && !visibleIds.has(s.id ?? s.cacheId));
      if (waterOverlay.length) return [...baseSites, ...waterOverlay];
    }
    return baseSites;
  }, [visibleSites, sites, layers.water, isPickingLocationForEdit, editPickLocation, selectedSite]);

  const clients = useMemo(
    () => [...new Set([
      ...sites.map((site) => site.client),
      ...pipelines.map((p) => p.client),
    ].filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [sites, pipelines]
  );
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

  const areas = useMemo(
    () => [...new Set([
      ...sites.map((site) => site.area),
      ...pipelines.map((p) => p.area),
    ].filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [sites, pipelines]
  );

  // Area suggestions shown in the add-pin popup's Area field. If the
  // user already picked a client (or typed one that matches an existing
  // client exactly), narrow the list to areas that appear alongside that
  // client. Otherwise fall back to the full area list so typing Area
  // first still gives useful suggestions. This mirrors FilterBar's
  // client-scoped area behaviour — keeps the two in sync.
  const areasForAddPinClient = useMemo(() => {
    const client = (addPinForm.client || '').trim().toLowerCase();
    if (!client) return areas;
    const scoped = new Set(
      sites
        .filter((s) => s.client && s.client.toLowerCase() === client)
        .map((s) => s.area)
        .filter(Boolean)
    );
    // Also pull from pipelines so a client's pipeline-only areas show up.
    for (const p of pipelines) {
      if (p.client && p.client.toLowerCase() === client && p.area) scoped.add(p.area);
    }
    const result = [...scoped].sort((a, b) => a.localeCompare(b));
    // If the scoped list is empty (e.g. a brand-new client being typed
    // for the first time) fall back to the full list so we still offer
    // something useful instead of an invisible dropdown.
    return result.length > 0 ? result : areas;
  }, [sites, pipelines, areas, addPinForm.client]);

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
    // Close pipeline detail if open
    if (pipelineDetailOpen) {
      setPipelineDetailOpen(false);
      setSelectedPipeline(null);
      setPipelineSprayRecords([]);
      setHighlightedSprayRecordId(null);
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
        setSelectedSite((prev) => (prev && prev.id === full.id ? { ...prev, ...full } : prev));
        // Also fold the heavy fields into the cached list so re-opening the
        // same site (or a sibling delta tick) doesn't wipe them.
        setSites((prev) => prev.map((s) => (s.id === full.id ? { ...s, ...full } : s)));
      }).catch(() => { /* non-fatal — cached data is fine */ });
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
        client: drawingForm.client || null,
        area: drawingForm.area || null,
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

  // Spray marking
  function handleStartSprayMarking(pipeline) {
    if (!pipeline) return;
    setSelectedPipeline(pipeline);
    setIsSprayMarking(true);
    setSprayStartPoint(null);
    setSprayEndPoint(null);
    setShowSprayConfirm(false);
    setSprayForm({ date: new Date().toISOString().split('T')[0], notes: '', is_avoided: false });
    setPendingPipelineSegment(null);
    setPipelineDetailOpen(false); // Slide panel away
  }

  function handleCancelSprayMarking() {
    setIsSprayMarking(false);
    setSprayStartPoint(null);
    setSprayEndPoint(null);
    setShowSprayConfirm(false);
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

    if (sprayForm.is_avoided && !(sprayForm.notes || '').trim()) {
      setMessage('Please add an issue note when marking not sprayed/issue.');
      return;
    }

    if (!sprayForm.is_avoided) {
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
      setSprayStartPoint(null);
      setSprayEndPoint(null);
      setShowSprayConfirm(false);
      return;
    }

    setAdminBusy(true);
    try {
      await api.createSprayRecord(selectedPipeline.id, {
        start_fraction: startFraction,
        end_fraction: endFraction,
        spray_date: sprayForm.date,
        notes: sprayForm.notes || null,
        is_avoided: sprayForm.is_avoided,
      });
      // Refresh pipeline data
      const updated = await api.getPipeline(selectedPipeline.id);
      setSelectedPipeline(updated);
      setPipelineSprayRecords(updated.spray_records || []);
      setPipelines((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setMessage('Issue/not sprayed segment saved.');
      setIsSprayMarking(false);
      setSprayStartPoint(null);
      setSprayEndPoint(null);
      setShowSprayConfirm(false);
      setPipelineDetailOpen(true); // Bring panel back
    } catch (error) {
      setMessage(error.message || 'Failed to save spray record.');
    } finally {
      setAdminBusy(false);
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
      const updated = await api.updatePipeline(pipeline.id, payload);
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
    if (!window.confirm(`Delete pipeline "${pipeline.name || 'Unnamed'}"? It will be moved to Recent Deletes.`)) return false;
    setAdminBusy(true);
    try {
      await api.deletePipeline(pipeline.id);
      setPipelines((prev) => prev.filter((p) => p.id !== pipeline.id));
      handleClosePipelineDetail();
      setMessage('Pipeline moved to Recent Deletes.');
      loadDeletedPipelines();
      return true;
    } catch (error) {
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

  async function handleDeleteSiteSprayRecord(recordId, siteId) {
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

  // Worker (and admin/office-impersonating-worker) "Mark as pending" on a
  // T&M ticket. The sheet builds the full updateTMTicket payload (including
  // pdf_base64 from regenerateCurrentPdf) and hands it here; we queue it
  // through the same upload queue used by lease sheets so the user doesn't
  // sit on a spinner while the backend talks to Dropbox, and the item shows
  // up in "In Progress → Uploading" with progress.
  async function handleQueueTMSubmit({ ticketId, payload, ticketNumber, sprayDate }) {
    await queueUpload({
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
  }

  async function handleLeaseSheetSubmit(payload) {
    if (inspectionSite) {
      const sitePayload = {
        ...payload,
        site_status: inspectionSiteStatus === 'in_progress' ? 'in_progress' : 'inspected',
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
      const nextStatus = payload.is_avoided ? 'issue' : (inspectionSiteStatus === 'in_progress' ? 'in_progress' : 'inspected');
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
    setPendingPipelineSegment(null);
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

  useEffect(() => {
    if (!navigator.geolocation) return;
    
    // Initial location fetch
    const watchId = navigator.geolocation.watchPosition(
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
              console.log('[APP] Sending follow mode update:', smoothedLocation.lat, smoothedLocation.lng);
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
    
    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [isFollowingUser]);

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
      setMessage('Getting location...');
      // Request current position if we don't have one
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
        },
        (error) => {
          console.error('Error getting location:', error);
          setMessage('Unable to get location. Check GPS permissions.');
        },
        { 
          enableHighAccuracy: true, 
          timeout: 15000, 
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
      client: addPinForm.client || null,
      area: addPinForm.area || null,
      latitude: addPinLocation.latitude,
      longitude: addPinLocation.longitude,
      client_submission_id: clientSubmissionId,
    };
    try {
      console.log('[PIN] Creating pin:', payload);
      let submittedSite = null;
      if (window.navigator.onLine) {
        const created = await api.createSite(payload);
        console.log('[PIN] Pin created successfully:', created);
        setSites((current) => [created, ...current]);
        await upsertSite(created);
        // If the new pin is in pending_review, append it locally and bump
        // the count instead of awaiting a full /api/pending-sites fetch
        // (~200–600 ms on Wi-Fi). The poll loop will reconcile the server
        // truth on its next tick, but the worker sees the pending count
        // tick up immediately on submit.
        if (created.approval_state === 'pending_review' && roleCanAdmin) {
          setPendingSites((prev) => (prev.some((s) => s.id === created.id) ? prev : [created, ...prev]));
          setPendingSitesCount((c) => (c == null ? 1 : c + 1));
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
      const updated = await api.updateSite(site.id, payload);
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
    try {
      await api.deleteSite(site.id);
      const next = sites.filter((item) => !matchSiteIdentity(item, site));
      setSites(next);
      await removeSite(site);
      setSelectedSite(null);
      setDetailOpen(false);
      await loadPendingSites();
      setMessage('Pin deleted.');
      return true;
    } catch (error) {
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
  function explainRejectConflict(error, kind = 'site') {
    const detail = error?.detail;
    if (!detail || detail.reason !== 'has_linked_spray_records') return false;
    const linked = detail.linked_spray_records || [];
    const lines = linked.map((r) => {
      const date = r.spray_date ? ` (${r.spray_date})` : '';
      const tn = r.ticket_number ? ` ${r.ticket_number}` : ` #${r.id}`;
      return `• Lease sheet${tn}${date}${r.is_avoided ? ' [avoided]' : ''}`;
    }).join('\n');
    alert(
      `Cannot reject this ${kind} — ${linked.length} lease sheet(s) are still linked:\n\n` +
      `${lines}\n\n` +
      `Delete those lease sheets (and any linked T&M rows) first, then retry reject.`
    );
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
    const { optimistic } = options;
    setAdminBusy(true);
    if (typeof optimistic === 'function') {
      try { optimistic(); } catch { /* non-fatal */ }
    }
    try {
      await action();
      setMessage(successMessage);
      // Background-only refresh: the user has already seen the optimistic
      // change; this just catches up server-derived fields (e.g. server
      // timestamps) and the deleted-* lists which the poll loop doesn't
      // touch. No await on purpose.
      void Promise.allSettled([
        roleCanAdmin ? loadPendingSites() : Promise.resolve(),
        roleCanAdmin ? loadPendingPipelines() : Promise.resolve(),
        runPollTickRef.current ? runPollTickRef.current() : Promise.resolve(),
      ]);
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
      deletedTMTickets.length;
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
      // Refresh all four deleted-item lists so the UI reflects the purge.
      // loadPendingSites doubles as loadDeletedSites (see its body) so we
      // call it here to refresh both lists in one shot.
      await loadPendingSites();
      await loadDeletedPipelines();
      await loadDeletedLeaseSheets();
      await loadDeletedTMTickets();
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
      );
    }
    return <LoginPage onLoginSuccess={() => void refreshAllData()} />;
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
        <div className="topbar-right">
          <span className={`badge ${isOnline ? 'online' : 'offline'}`}>{isOnline ? 'Online' : 'Offline'}</span>
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
          {roleCanAdmin && (() => {
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
          {actualCanAdmin ? (
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
              inside the avatar popover below. */}
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
              {viewAsWorker ? <span className="topbar-account-trigger-dot" aria-hidden="true" /> : null}
            </button>
            {accountMenuOpen ? (
              <div className="topbar-account-popover" role="menu">
                <div className="topbar-account-name" role="presentation">
                  {userDisplayName}
                  {viewAsWorker ? (
                    <span className="topbar-account-name-sub">Viewing as Worker</span>
                  ) : null}
                </div>
                {actualCanAdmin ? (
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
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* ── Main area: map is always behind ── */}
      <main className="main-area">
        <div className="map-container">
          <MapView
            apiKey={GOOGLE_MAPS_API_KEY}
            isOnline={isOnline}
            sites={mapSites}
            selectedSite={selectedSite}
            onSelectSite={handleOpenDetail}
            isPickingLocation={isPlacingPin || isPickingLocationForEdit}
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
          />
        </div>

        {/* floating filter button */}
        <div className="map-float-tl">
          <button className="float-btn" type="button" onClick={() => setIsFilterOpen((c) => !c)}>
            ☰ Filters
          </button>
        </div>

        {isFilterOpen ? (
          <div className="filter-overlay">
            <FilterBar
              filters={filters}
              clients={clients}
              areas={areas}
              sites={sites}
              onChange={(key, value) => setFilters((c) => ({ ...c, [key]: value }))}
              onSearchSelect={handleSearchSelect}
              layers={layers}
              onLayerToggle={handleLayerToggle}
            />
          </div>
        ) : null}

        {/* ── Lease Sheet overlay ── */}
        {(inspectionSite || inspectionPipeline) && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 30,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
          }}>
            <HerbicideLeaseSheet
              site={inspectionSite}
              pipeline={inspectionPipeline}
              initialDistanceMeters={pendingPipelineSegment?.distance_meters ?? null}
              isOpen={true}
              requireComments={!!inspectionSite && inspectionSiteStatus === 'in_progress'}
              commentsLabel={inspectionSiteStatus === 'in_progress' ? 'Comments / what was completed' : 'Comments'}
              onSubmit={handleLeaseSheetSubmit}
              onCancel={() => { handleLeaseSheetCancel(); setResumingDraft(null); }}
              cachedLookups={cachedLookups}
              draft={resumingDraft}
              onDraftSaved={() => { setDraftsRefreshToken((x) => x + 1); }}
            />
          </div>
        )}

        {/* ── Edit Lease Sheet overlay ── */}
        {editingSprayRecord && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 30,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
          }}>
            <HerbicideLeaseSheet
              site={{ id: editingSprayRecord.site_id, client: editingSprayRecord.site_client, area: editingSprayRecord.site_area, lsd: editingSprayRecord.site_lsd }}
              isOpen={true}
              editingRecord={editingSprayRecord}
              onSubmit={handleEditSpraySubmit}
              onCancel={() => setEditingSprayRecord(null)}
              cachedLookups={cachedLookups}
            />
          </div>
        )}

        {/* ── Lease Sheet Preview overlay ── */}
        {previewingRecord && (
          <PdfPreviewOverlay
            record={previewingRecord}
            onClose={() => setPreviewingRecord(null)}
          />
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
            <TMTicketDetailSheet
              ticketId={activeTMTicketId}
              roleCanAdmin={roleCanAdmin}
              roleCanOffice={roleCanAdmin}
              currentUserEmail={user?.email}
              onClose={() => setActiveTMTicketId(null)}
              onQueueSubmit={handleQueueTMSubmit}
            />
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

        {/* Drawing pipeline form */}
        {isDrawingPipeline && showDrawingForm ? (
          <div className="add-pin-popup" style={{ bottom: 80, left: '50%', transform: 'translateX(-50%)' }}>
            <strong className="small-text">New Pipeline</strong>
            <input value={drawingForm.name} onChange={(e) => setDrawingForm((c) => ({ ...c, name: e.target.value }))} placeholder="Pipeline name" />
            <input value={drawingForm.client} onChange={(e) => setDrawingForm((c) => ({ ...c, client: e.target.value }))} placeholder="Client" />
            <input value={drawingForm.area} onChange={(e) => setDrawingForm((c) => ({ ...c, area: e.target.value }))} placeholder="Area" />
            <div className="button-row">
              <button className="primary-button" type="button" disabled={submittingPin} onClick={handleSubmitDrawnPipeline}>
                {submittingPin ? 'Saving…' : 'Submit'}
              </button>
              <button className="secondary-button" type="button" onClick={handleCancelDrawing}>Cancel</button>
            </div>
          </div>
        ) : null}

        {/* Spray marking banner */}
        {isSprayMarking && !showSprayConfirm ? (
          <div className="place-banner" style={{ flexDirection: 'column', gap: '0.5rem' }}>
            <div>
              {!sprayStartPoint
                ? 'Tap the START of the sprayed section'
                : 'Tap the END of the sprayed section'}
            </div>
            <button className="cancel-btn" type="button" onClick={handleCancelSprayMarking}>Cancel</button>
          </div>
        ) : null}

        {/* Spray confirmation dialog */}
        {showSprayConfirm ? (
          <div className="add-pin-popup" style={{ bottom: 80, left: '50%', transform: 'translateX(-50%)' }}>
            <strong className="small-text">Confirm Spray Record</strong>
            <input
              type="date"
              value={sprayForm.date}
              onChange={(e) => setSprayForm((c) => ({ ...c, date: e.target.value }))}
            />
            <input
              value={sprayForm.notes}
              onChange={(e) => setSprayForm((c) => ({ ...c, notes: e.target.value }))}
              placeholder={sprayForm.is_avoided ? 'Issue reason (required)' : 'Notes (optional)'}
            />
            <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="checkbox"
                checked={sprayForm.is_avoided}
                onChange={(e) => setSprayForm((c) => ({ ...c, is_avoided: e.target.checked }))}
              />
              <span className="small-text">Issue with site — skip lease sheet</span>
            </label>
            <div className="button-row">
              <button className="primary-button" type="button" disabled={adminBusy} onClick={handleConfirmSpray}>
                {adminBusy ? 'Saving…' : 'Confirm'}
              </button>
              <button className="secondary-button" type="button" onClick={handleCancelSprayMarking}>Cancel</button>
            </div>
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
                onViewPdf={(record) => {
                  setPreviewingRecord(record);
                }}
                onEditRecord={(record) => openEditRecord(record, { site_lsd: selectedSite?.lsd, site_client: selectedSite?.client, site_area: selectedSite?.area })}
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
                adminBusy={adminBusy}
                sprayRecords={pipelineSprayRecords}
                onDeleteSprayRecord={handleDeleteSprayRecord}
                highlightedSprayRecordId={highlightedSprayRecordId}
                onHighlightSprayRecord={setHighlightedSprayRecordId}
                onViewRecord={(record) => setPreviewingRecord(record)}
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
              uploadTabSignal={uploadTabSignal}
              clients={clients}
              areas={areas}
              onViewPdf={(record) => setPreviewingRecord(record)}
              onEditRecord={(record) => openEditRecord(record)}
              onDeleteRecord={async (record) => {
                if (!window.confirm(`Delete lease sheet ${record.ticket_number || ''}?`)) return;
                try {
                  // Check if it's a site or pipeline lease sheet
                  if (record.site_id != null) {
                    await api.deleteSiteSprayRecord(record.id);
                  } else {
                    await api.deleteSprayRecord(record.id);
                  }
                  // Trigger delta sync to remove from cachedRecents
                  handleRequestSync();
                  setMessage('Lease sheet deleted');
                } catch (e) {
                  setMessage('Failed to delete lease sheet: ' + (e.message || 'unknown'));
                }
              }}
              onStartLeaseSheetFromDraft={(draft) => {
                // Tapping a draft (or "New lease sheet") opens the lease sheet overlay.
                // When draft is null, the user needs to pick a site from the Map tab first.
                if (draft) {
                  setResumingDraft(draft);
                  // If draft has a site_id, try to focus it; otherwise open a generic overlay
                  if (draft.site_id) {
                    const foundSite = sites.find((s) => s.id === draft.site_id);
                    if (foundSite) {
                      setInspectionSite(foundSite);
                    } else {
                      setInspectionSite({ id: draft.site_id });
                    }
                    setInspectionSiteStatus(draft.site_status === 'in_progress' ? 'in_progress' : 'inspected');
                  } else {
                    setInspectionSite(null);
                    setInspectionSiteStatus('inspected');
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
              roleCanAdmin={roleCanAdmin}
              viewAsWorker={viewAsWorker}
              currentUserName={currentUserName}
            />
          </div>
        </div>

        {/* ── Admin panel ── */}
        <div
          className={`side-panel ${activeTab === TAB_ADMIN && roleCanAdmin ? 'open' : ''} ${adminPanelDragging ? 'dragging' : ''}`}
          onTouchStart={handleAdminPanelTouchStart}
          onTouchMove={handleAdminPanelTouchMove}
          onTouchEnd={handleAdminPanelTouchEnd}
          style={{
            transform: activeTab === TAB_ADMIN && roleCanAdmin
              ? `translateX(${adminPanelDragOffset}px)`
              : 'translateX(100%)'
          }}
        >
          <div className="side-panel-header">
            <h2>Admin</h2>
          </div>
          <div className="side-panel-body">
            <AdminPanel
              visible={true}
              pendingSites={pendingSites}
              deletedSites={deletedSites}
              clients={clients}
              areas={areas}
              busy={adminBusy}
              onApprove={(siteId, overrides) => runAdminAction(
                () => api.approveSite(siteId, { approval_state: 'approved', ...overrides }),
                'Approved.',
                {
                  optimistic: () => {
                    setPendingSites((prev) => prev.filter((s) => s.id !== siteId));
                    setPendingSitesCount((c) => (c == null ? null : Math.max(0, c - 1)));
                  },
                },
              )}
              onReject={async (siteId) => {
                setAdminBusy(true);
                // Optimistic remove BEFORE the API call so the card vanishes
                // immediately. We snapshot the row so we can restore it if
                // the server returns the structured 409 (linked spray
                // records) and refuses to reject.
                const removed = pendingSites.find((s) => s.id === siteId) || null;
                setPendingSites((prev) => prev.filter((s) => s.id !== siteId));
                setPendingSitesCount((c) => (c == null ? null : Math.max(0, c - 1)));
                try {
                  await api.approveSite(siteId, { approval_state: 'rejected' });
                  setMessage('Rejected.');
                  // Background catch-up only — no awaiting refreshAllData.
                  void Promise.allSettled([
                    loadPendingSites(),
                    runPollTickRef.current ? runPollTickRef.current() : Promise.resolve(),
                  ]);
                } catch (error) {
                  // Roll back the optimistic remove on any failure so the
                  // card reappears with its original data.
                  if (removed) setPendingSites((prev) => (prev.some((s) => s.id === siteId) ? prev : [removed, ...prev]));
                  setPendingSitesCount((c) => (c == null ? null : c + 1));
                  if (!explainRejectConflict(error, 'pin')) {
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
              onBulkReset={(payload) => runAdminAction(() => api.bulkResetStatus(payload), 'Reset complete.')}
              onImport={(file) => runAdminAction(() => api.importKml(file), 'KML imported.')}
              onRestore={handleRestoreSite}
              onDeletePermanent={handleDeletePermanent}
              onSelectSite={(site) => { setZoomTarget({ ...site, _ts: Date.now() }); setActiveTab(TAB_MAP); setSelectedSite(site); setDetailOpen(true); }}
              currentUserEmail={user?.email}
              pendingPipelines={pendingPipelines}
              onApprovePipeline={(pipelineId, payload) => runAdminAction(
                async () => { await api.approvePipeline(pipelineId, payload); await loadPipelines(); },
                'Pipeline approved.',
                {
                  optimistic: () => {
                    setPendingPipelines((prev) => prev.filter((p) => p.id !== pipelineId));
                    setPendingPipelinesCount((c) => (c == null ? null : Math.max(0, c - 1)));
                  },
                },
              )}
              onRejectPipeline={async (pipelineId) => {
                setAdminBusy(true);
                // Same snapshot-then-remove pattern as the site reject branch:
                // the card vanishes instantly and we put it back if the
                // server returns a 409 / other failure.
                const removed = pendingPipelines.find((p) => p.id === pipelineId) || null;
                setPendingPipelines((prev) => prev.filter((p) => p.id !== pipelineId));
                setPendingPipelinesCount((c) => (c == null ? null : Math.max(0, c - 1)));
                try {
                  await api.approvePipeline(pipelineId, { approval_state: 'rejected' });
                  setMessage('Pipeline rejected.');
                  void Promise.allSettled([
                    loadPipelines(),
                    loadPendingPipelines(),
                    runPollTickRef.current ? runPollTickRef.current() : Promise.resolve(),
                  ]);
                } catch (error) {
                  if (removed) setPendingPipelines((prev) => (prev.some((p) => p.id === pipelineId) ? prev : [removed, ...prev]));
                  setPendingPipelinesCount((c) => (c == null ? null : c + 1));
                  if (!explainRejectConflict(error, 'pipeline')) {
                    setMessage(error?.message || 'Reject failed.');
                  }
                } finally {
                  setAdminBusy(false);
                }
              }}
              onImportPipelineKml={(file) => runAdminAction(async () => { await api.importPipelineKml(file); await loadPipelines(); }, 'Pipeline KML imported.')}
              onBulkResetPipelines={(payload) => runAdminAction(async () => { await api.bulkResetPipelines(payload); await loadPipelines(); }, 'Pipelines reset to not sprayed.')}
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
              onBulkDeleteAllPermanent={handleBulkDeleteAllPermanent}
              cachedLookups={cachedLookups}
              onLookupsChanged={loadServerLookups}
              cachedUsers={cachedUsers}
              onUsersChanged={loadServerUsers}
            />
          </div>
        </div>
      </main>

      {/* ── Approve & Edit review modal (admin) ── */}
      {approveEditTarget ? (
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
        />
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
        {roleCanAdmin ? (
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
