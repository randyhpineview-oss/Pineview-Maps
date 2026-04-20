import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import AdminPanel from './components/AdminPanel';
import FilterBar from './components/FilterBar';
import HerbicideLeaseSheet from './components/HerbicideLeaseSheet';
import LoginPage from './components/LoginPage';
import MapView from './components/MapView';
import PipelineDetailSheet from './components/PipelineDetailSheet';
import PdfPreviewOverlay from './components/PdfPreviewOverlay';
import FormsPanel from './components/FormsPanel';
import TMTicketDetailSheet from './components/TMTicketDetailSheet';
import SiteDetailSheet from './components/SiteDetailSheet';
import { api } from './lib/api';
import { nearestFraction } from './lib/mapUtils';
import { onAuthStateChange, signOut } from './lib/supabaseClient';
import {
  getAllLookups,
  getLastSyncAt,
  getQueuedActions,
  getRecents,
  getSites,
  getUploadQueue,
  getUsers,
  queueAction,
  queueUpload,
  removeQueuedAction,
  removeUploadEntry,
  removeSite,
  replaceLookups,
  replaceRecents,
  replaceSites,
  replaceUsers,
  setLastSyncAt,
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

export default function App() {
  // Unregister any stale service workers from previous PWA builds
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const registration of registrations) {
          registration.unregister();
        }
      });
    }
  }, []);
  const wasOnline = useRef(window.navigator.onLine);
  const lastSyncStatusRef = useRef(null);
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sites, setSites] = useState([]);
  const [pendingSites, setPendingSites] = useState([]);
  const [deletedSites, setDeletedSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState(null);
  const [message, setMessage] = useState('Loading project data...');
  const [isOnline, setIsOnline] = useState(window.navigator.onLine);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
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
  // Upload queue state
  const [uploadQueueItems, setUploadQueueItems] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
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

  const userRole = session?.user?.user_metadata?.role || 'worker';
  const canManagePins = userRole === 'admin' || userRole === 'office';
  const roleCanAdmin = userRole === 'admin' || userRole === 'office';
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

    setSites(sitesPayload);
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

  const loadPipelines = useCallback(async () => {
    if (!window.navigator.onLine) return;
    try {
      const data = await api.listPipelines();
      setPipelines(data);
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

  const refreshUploadQueue = useCallback(async () => {
    const items = await getUploadQueue();
    setUploadQueueItems(items);
    return items;
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
      for (const item of items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        try {
          if (item.targetType === 'site') {
            await api.createSiteSprayRecord(item.targetId, item.payload);
            // Refresh the site data in background (including pdf_url from Dropbox)
            try {
              const updated = await api.getSite(item.targetId);
              setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
              setSelectedSite((prev) => prev && prev.id === updated.id ? updated : prev);
              await upsertSite(updated);
            } catch { /* ignore refresh failure */ }
          } else if (item.targetType === 'pipeline') {
            await api.createSprayRecord(item.targetId, item.payload);
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
          }
          await removeUploadEntry(item.id);
          completed++;
          setUploadProgress(Math.round((completed / total) * 100));
        } catch (err) {
          console.warn('[UPLOAD_QUEUE] Failed to upload item', item.id, '— will retry next cycle:', err?.message || err);
          // Leave it in queue for retry on next poll cycle
        }
      }
    } finally {
      uploadingRef.current = false;
      setIsUploading(false);
      setUploadProgress(0);
      await refreshUploadQueue();
    }
  }, [refreshUploadQueue]);

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
          ]);
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
  }, [loadCachedSites, loadCachedRecents, loadCachedLookups, loadCachedUsers,
      loadServerSites, loadServerRecents, loadServerLookups, loadServerUsers]);

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
    void refreshAllData();

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
  }, [refreshAllData, refreshQueueCount, refreshUploadQueue, processUploadQueue]);

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
        await refreshAllData();
      } catch (error) {
        setMessage(error.message || 'Automatic sync failed.');
      } finally {
        setIsSyncing(false);
      }
    })();
  }, [isOnline, refreshAllData, syncQueuedActions]);

  // ── Auto-poll for real-time updates ──
  // Strategy:
  //   1. Always start with a lightweight /api/sync-status call (a few hundred bytes).
  //   2. Only re-fetch sites/pipelines/recents when the corresponding timestamp bumps.
  //   3. Skip the entire tick when the tab is hidden (phone in pocket, app in background).
  //   4. Run a single refresh immediately when the tab becomes visible again, so the
  //      user sees fresh data without waiting for the next interval.
  //   5. Base interval = 30 s (up from 10 s). With slim payloads this covers everyone.
  useEffect(() => {
    if (!isOnline) return;

    const POLL_MS = 30000;

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

        lastSyncStatusRef.current = syncStatus;

        if (sitesChanged) {
          try {
            const sitesPayload = await api.listSites(serverFilters);
            setSites(sitesPayload);
            await replaceSites(sitesPayload);
            if (selectedSite && Number.isInteger(selectedSite.id)) {
              const updated = sitesPayload.find((s) => s.id === selectedSite.id);
              if (updated) setSelectedSite(updated);
            }
          } catch { /* silently fail */ }
        }

        if (pipelinesChanged) {
          try {
            const pipelineData = await api.listPipelines();
            setPipelines(pipelineData);
          } catch { /* silently fail */ }
        }

        if (recentsChanged) {
          try {
            const data = await api.listRecentSubmissions();
            setCachedRecents(data);
            await replaceRecents(data);
          } catch { /* silently fail */ }
        }

        if (syncStatus.pending_sites_count !== undefined) setPendingSitesCount(syncStatus.pending_sites_count);
        if (syncStatus.pending_pipelines_count !== undefined) setPendingPipelinesCount(syncStatus.pending_pipelines_count);

        if ((syncStatus.pending_sites_count > 0 || syncStatus.pending_pipelines_count > 0) && roleCanAdmin) {
          try { setPendingSites(await api.listPendingSites()); } catch { /* silently fail */ }
          try { setPendingPipelines(await api.listPendingPipelines()); } catch { /* silently fail */ }
        }
      } catch { /* silently fail polling to avoid spam */ }

      // Retry any stuck upload queue items on each tick (also visibility-gated).
      try { processUploadQueue(); } catch { /* ignore */ }
    };

    const pollInterval = setInterval(runPollTick, POLL_MS);

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
  const areas = useMemo(
    () => [...new Set([
      ...sites.map((site) => site.area),
      ...pipelines.map((p) => p.area),
    ].filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [sites, pipelines]
  );

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

  // Swipe handlers for side panels (left-to-right swipe to close)
  const handleSitesPanelTouchStart = (e) => {
    sitesPanelTouchStartX.current = e.touches[0].clientX;
  };

  const handleSitesPanelTouchEnd = (e) => {
    if (sitesPanelTouchStartX.current === null) return;
    const endX = e.changedTouches[0].clientX;
    const diff = endX - sitesPanelTouchStartX.current;
    // Left-to-right swipe (positive diff) closes the panel
    if (diff > SWIPE_THRESHOLD && activeTab === TAB_SITES) {
      setActiveTab(TAB_MAP);
    }
    sitesPanelTouchStartX.current = null;
  };

  const handleFormsPanelTouchStart = (e) => {
    formsPanelTouchStartX.current = e.touches[0].clientX;
  };

  const handleFormsPanelTouchEnd = (e) => {
    if (formsPanelTouchStartX.current === null) return;
    const endX = e.changedTouches[0].clientX;
    const diff = endX - formsPanelTouchStartX.current;
    if (diff > SWIPE_THRESHOLD && activeTab === TAB_FORMS) {
      setActiveTab(TAB_MAP);
    }
    formsPanelTouchStartX.current = null;
  };

  const handleAdminPanelTouchStart = (e) => {
    adminPanelTouchStartX.current = e.touches[0].clientX;
  };

  const handleAdminPanelTouchEnd = (e) => {
    if (adminPanelTouchStartX.current === null) return;
    const endX = e.changedTouches[0].clientX;
    const diff = endX - adminPanelTouchStartX.current;
    // Left-to-right swipe (positive diff) closes the panel
    if (diff > SWIPE_THRESHOLD && activeTab === TAB_ADMIN) {
      setActiveTab(TAB_MAP);
    }
    adminPanelTouchStartX.current = null;
  };

  function handleCloseDetail() {
    setDetailOpen(false);
  }

  function handleTouchStart(e) {
    const bodyRect = detailBodyRef.current?.getBoundingClientRect();
    const touchY = e.touches[0].clientY;
    // Only enable pull-to-dismiss when starting from the top of the scrollable body
    // (within 80px of the body top) AND scroll is at top
    const scrollTop = detailBodyRef.current?.scrollTop || 0;
    if (bodyRect && (touchY - bodyRect.top) < 80 && scrollTop <= 0) {
      touchStartY.current = touchY;
      pullDistance.current = 0;
    } else {
      touchStartY.current = null;
    }
  }

  function handleTouchMove(e) {
    if (touchStartY.current === null) return;
    const currentY = e.touches[0].clientY;
    const delta = currentY - touchStartY.current;
    
    if (delta > 0) {
      pullDistance.current = delta;
      if (delta > 20) {
        e.preventDefault();
      }
    }
  }

  function handleTouchEnd(e) {
    if (touchStartY.current === null) return;
    if (pullDistance.current > 150 && detailOpen) {
      handleCloseDetail();
    }
    touchStartY.current = null;
    pullDistance.current = 0;
  }

  // Touch handlers for pipeline detail panel (swipe down to dismiss)
  function handlePipelineTouchStart(e) {
    const bodyRect = pipelineDetailBodyRef.current?.getBoundingClientRect();
    const touchY = e.touches[0].clientY;
    const scrollTop = pipelineDetailBodyRef.current?.scrollTop || 0;
    // Only enable pull-to-dismiss when starting from the top of the scrollable body
    if (bodyRect && (touchY - bodyRect.top) < 80 && scrollTop <= 0) {
      pipelineTouchStartY.current = touchY;
      pipelinePullDistance.current = 0;
    } else {
      pipelineTouchStartY.current = null;
    }
  }

  function handlePipelineTouchMove(e) {
    if (pipelineTouchStartY.current === null) return;
    const currentY = e.touches[0].clientY;
    const delta = currentY - pipelineTouchStartY.current;
    
    if (delta > 0) {
      pipelinePullDistance.current = delta;
      if (delta > 20) {
        e.preventDefault();
      }
    }
  }

  function handlePipelineTouchEnd(e) {
    if (pipelineTouchStartY.current === null) return;
    if (pipelinePullDistance.current > 150 && pipelineDetailOpen) {
      handleClosePipelineDetail();
    }
    pipelineTouchStartY.current = null;
    pipelinePullDistance.current = 0;
  }

  function handleFabSelect(pinType) {
    setFabOpen(false);
    setAddPinType(pinType);
    setAddPinLocation(null);
    setAddPinForm({ lsd: '', client: '', area: '' });
  }

  function handleCancelAdd() {
    setAddPinType(null);
    setAddPinLocation(null);
    setAddPinForm({ lsd: '', client: '', area: '' });
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
  function handleStartInspection(siteOrPipeline) {
    // Close any open panels
    setDetailOpen(false);
    setPipelineDetailOpen(false);
    // Set the inspection target
    if (siteOrPipeline?.lsd !== undefined) {
      // It's a site
      setInspectionSite(siteOrPipeline);
      setInspectionPipeline(null);
      setPendingPipelineSegment(null);
    } else {
      // Pipelines must start with segment selection workflow first
      handleStartSprayMarking(siteOrPipeline);
    }
  }

  async function handleLeaseSheetSubmit(payload) {
    if (inspectionSite) {
      await queueUpload({
        targetType: 'site',
        targetId: inspectionSite.id,
        payload,
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
      const optimistic = {
        ...inspectionSite,
        status: payload.is_avoided ? 'issue' : 'inspected',
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
    setMessage('Updating record…');

    // Fire off API call in background (don't await before closing form)
    (async () => {
      try {
        await api.updateSiteSprayRecord(record.id, payload);
        setMessage('Record updated.');
        // Refresh site data
        if (record.site_id) {
          try {
            const updated = await api.getSite(record.site_id);
            setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
            setSelectedSite((prev) => prev && prev.id === updated.id ? updated : prev);
          } catch { /* ignore */ }
        }
        // Refresh recents so View PDF button and data stay current
        loadServerRecents();
      } catch (error) {
        setMessage('Update failed: ' + (error.message || 'Unknown error'));
      }
    })();
  }

  function handleLeaseSheetCancel() {
    if (inspectionPipeline) {
      setPipelineDetailOpen(true);
    }
    setInspectionSite(null);
    setInspectionPipeline(null);
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
    setSelectedSite(site);
    setZoomTarget({ ...site, _ts: Date.now() });
    setDetailOpen(true);
    setIsFilterOpen(false);
    setActiveTab(TAB_MAP);
  }

  async function handleSubmitNewPin() {
    if (!addPinLocation || !addPinType) return;
    setSubmittingPin(true);
    const payload = {
      pin_type: addPinType,
      status: 'not_inspected',
      lsd: addPinForm.lsd || null,
      client: addPinForm.client || null,
      area: addPinForm.area || null,
      latitude: addPinLocation.latitude,
      longitude: addPinLocation.longitude,
    };
    try {
      console.log('[PIN] Creating pin:', payload);
      if (window.navigator.onLine) {
        const created = await api.createSite(payload);
        console.log('[PIN] Pin created successfully:', created);
        setSites((current) => [created, ...current]);
        await upsertSite(created);
        await loadPendingSites();
        setMessage(created.approval_state === 'approved' ? 'Pin added.' : 'Pending pin submitted for review.');
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
    const optimistic = { ...site, status, updated_at: new Date().toISOString(), ...(status === 'inspected' ? { last_inspected_at: new Date().toISOString() } : {}) };
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
        const optimisticSite = { ...site, status, last_inspected_at: status === 'inspected' ? new Date().toISOString() : null, updated_at: new Date().toISOString() };
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

  async function handleApproveAndEdit(site, overrides) {
    setAdminBusy(true);
    try {
      const approved = await api.approveSite(site.id, { approval_state: 'approved', ...overrides });
      await refreshAllData();
      const target = approved || site;
      setSelectedSite(target);
      // Don't zoom after approval - stay at current view to prevent flash
      setActiveTab(TAB_MAP);
      setDetailOpen(true);
      setMessage('Approved.');
    } catch (error) { setMessage(error.message || 'Approve failed.'); }
    finally { setAdminBusy(false); }
  }

  async function runAdminAction(action, successMessage) {
    setAdminBusy(true);
    try {
      await action();
      await refreshAllData();
      setMessage(successMessage);
    } catch (error) { setMessage(error.message || 'Admin action failed.'); }
    finally { setAdminBusy(false); }
  }

  async function handleRestoreSite(siteId) {
    await runAdminAction(
      () => api.restoreSite(siteId),
      'Pin restored successfully.'
    );
  }

  async function handleDeletePermanent(siteId) {
    await runAdminAction(
      () => api.deleteSitePermanent(siteId),
      'Pin permanently deleted.'
    );
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
    return <LoginPage onLoginSuccess={() => void refreshAllData()} />;
  }

  return (
    <div className="app-shell">
      {/* ── Top bar ── */}
      <header className="topbar">
        <span className="topbar-title">Pineview Maps</span>
        <div className="topbar-right">
          <span className={`badge ${isOnline ? 'online' : 'offline'}`}>{isOnline ? 'Online' : 'Offline'}</span>
          {(uploadQueueItems.length > 0 || isUploading) ? (
            <span
              className="badge"
              style={{
                background: isUploading
                  ? `linear-gradient(to right, #3b82f6 ${uploadProgress}%, #374151 ${uploadProgress}%)`
                  : '#3b82f6',
                color: 'white',
                cursor: 'pointer',
                transition: 'background 0.3s ease',
              }}
              onClick={async () => {
                const items = await getUploadQueue();
                console.log('[UPLOAD_QUEUE] Clicked badge — queued items:', items);
                alert(`${items.length} item(s) in queue. Check console for details or run window.clearQueue() to clear.`);
              }}
            >
              {isUploading ? `Syncing (${uploadQueueItems.length})…` : `Queued (${uploadQueueItems.length})`}
            </span>
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
          {roleCanAdmin && (pendingSites.length + pendingPipelines.length) > 0 ? (
            <span 
              className="badge" 
              style={{ background: '#f59e0b', color: '#422006', cursor: 'pointer' }}
              onClick={() => { setDetailOpen(false); setActiveTab(TAB_ADMIN); }}
            >
              Pending: {pendingSites.length + pendingPipelines.length}
            </span>
          ) : null}
          <span className="badge">{user?.user_metadata?.name || user?.name || user?.email?.split('@')[0]?.charAt(0).toUpperCase() + user?.email?.split('@')[0]?.slice(1) || user?.email}</span>
          <button 
            onClick={() => signOut()}
            className="badge"
            style={{ cursor: 'pointer', background: '#ef4444', color: 'white' }}
          >
            Sign Out
          </button>
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
              onRefresh={refreshAllData}
              onSyncCurrentView={handleSyncCurrentView}
              onSearchSelect={handleSearchSelect}
              syncing={isSyncing}
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
              onClose={() => setActiveTMTicketId(null)}
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

        {/* Add-pin popup form */}
        {showAddPopup ? (
          <div className="add-pin-popup" style={{ bottom: 80, left: '50%', transform: 'translateX(-50%)' }}>
            <strong className="small-text">New {pinTypeLabel(addPinType)} pin</strong>
            <input value={addPinForm.lsd} onChange={(e) => setAddPinForm((c) => ({ ...c, lsd: e.target.value }))} placeholder="LSD or site label" />
            <input value={addPinForm.client} onChange={(e) => setAddPinForm((c) => ({ ...c, client: e.target.value }))} placeholder="Client" />
            <input value={addPinForm.area} onChange={(e) => setAddPinForm((c) => ({ ...c, area: e.target.value }))} placeholder="Area" />
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
        <div className={`side-panel detail-priority ${detailOpen && selectedSite ? 'open' : ''}`}>
          <div className="side-panel-header">
            <button className="back-btn" type="button" onClick={handleCloseDetail}>←</button>
            <h2>Site Details</h2>
            {canManagePins ? <span className="small-text">Admin</span> : null}
          </div>
          <div className="side-panel-body" ref={detailBodyRef} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
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
        <div className={`side-panel detail-priority ${pipelineDetailOpen && selectedPipeline ? 'open' : ''}`}>
          <div className="side-panel-header">
            <button className="back-btn" type="button" onClick={handleClosePipelineDetail}>←</button>
            <h2>Pipeline Details</h2>
            {canManagePins ? <span className="small-text">Admin</span> : null}
          </div>
          <div 
            className="side-panel-body"
            ref={pipelineDetailBodyRef}
            onTouchStart={handlePipelineTouchStart}
            onTouchMove={handlePipelineTouchMove}
            onTouchEnd={handlePipelineTouchEnd}
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
          className={`side-panel ${activeTab === TAB_SITES ? 'open' : ''}`}
          onTouchStart={handleSitesPanelTouchStart}
          onTouchEnd={handleSitesPanelTouchEnd}
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
          className={`side-panel ${activeTab === TAB_FORMS ? 'open' : ''}`}
          onTouchStart={handleFormsPanelTouchStart}
          onTouchEnd={handleFormsPanelTouchEnd}
        >
          <div className="side-panel-header">
            <h2>Forms</h2>
          </div>
          <div className="side-panel-body">
            <FormsPanel
              visible={activeTab === TAB_FORMS}
              cachedRecents={cachedRecents}
              uploadQueue={uploadQueueItems}
              clients={clients}
              areas={areas}
              onViewPdf={(record) => setPreviewingRecord(record)}
              onEditRecord={(record) => openEditRecord(record)}
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
                  } else {
                    setInspectionSite(null);
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
              draftsRefreshToken={draftsRefreshToken}
              roleCanAdmin={roleCanAdmin}
            />
          </div>
        </div>

        {/* ── Admin panel ── */}
        <div 
          className={`side-panel ${activeTab === TAB_ADMIN && roleCanAdmin ? 'open' : ''}`}
          onTouchStart={handleAdminPanelTouchStart}
          onTouchEnd={handleAdminPanelTouchEnd}
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
              onApprove={(siteId, overrides) => runAdminAction(() => api.approveSite(siteId, { approval_state: 'approved', ...overrides }), 'Approved.')}
              onReject={(siteId) => runAdminAction(() => api.approveSite(siteId, { approval_state: 'rejected' }), 'Rejected.')}
              onApproveAndEdit={handleApproveAndEdit}
              onBulkReset={(payload) => runAdminAction(() => api.bulkResetStatus(payload), 'Reset complete.')}
              onImport={(file) => runAdminAction(() => api.importKml(file), 'KML imported.')}
              onRestore={handleRestoreSite}
              onDeletePermanent={handleDeletePermanent}
              onSelectSite={(site) => { setZoomTarget({ ...site, _ts: Date.now() }); setActiveTab(TAB_MAP); setSelectedSite(site); setDetailOpen(true); }}
              currentUserEmail={user?.email}
              pendingPipelines={pendingPipelines}
              onApprovePipeline={(pipelineId, payload) => runAdminAction(async () => { await api.approvePipeline(pipelineId, payload); await loadPipelines(); await loadPendingPipelines(); }, 'Pipeline approved.')}
              onRejectPipeline={(pipelineId) => runAdminAction(async () => { await api.approvePipeline(pipelineId, { approval_state: 'rejected' }); await loadPipelines(); await loadPendingPipelines(); }, 'Pipeline rejected.')}
              onImportPipelineKml={(file) => runAdminAction(async () => { await api.importPipelineKml(file); await loadPipelines(); }, 'Pipeline KML imported.')}
              onBulkResetPipelines={(payload) => runAdminAction(async () => { await api.bulkResetPipelines(payload); await loadPipelines(); }, 'Pipelines reset to not sprayed.')}
              onSelectPipeline={(pipeline) => { handleOpenPipelineDetail(pipeline); setActiveTab(TAB_MAP); }}
              deletedPipelines={deletedPipelines}
              onRestorePipeline={(pipelineId) => runAdminAction(async () => { await api.restorePipeline(pipelineId); await loadPipelines(); await loadDeletedPipelines(); }, 'Pipeline restored.')}
              onDeletePipelinePermanent={(pipelineId) => runAdminAction(async () => { await api.deletePipelinePermanent(pipelineId); await loadDeletedPipelines(); }, 'Pipeline permanently deleted.')}
              cachedLookups={cachedLookups}
              onLookupsChanged={loadServerLookups}
              cachedUsers={cachedUsers}
              onUsersChanged={loadServerUsers}
            />
          </div>
        </div>
      </main>

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
