import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import AdminPanel from './components/AdminPanel';
import FilterBar from './components/FilterBar';
import HerbicideLeaseSheet from './components/HerbicideLeaseSheet';
import LoginPage from './components/LoginPage';
import MapView from './components/MapView';
import PipelineDetailSheet from './components/PipelineDetailSheet';
import RecentsPanel from './components/RecentsPanel';
import SiteDetailSheet from './components/SiteDetailSheet';
import { api } from './lib/api';
import { nearestFraction } from './lib/mapUtils';
import { onAuthStateChange, signOut } from './lib/supabaseClient';
import {
  getLastSyncAt,
  getQueuedActions,
  getSites,
  getUploadQueue,
  queueAction,
  queueUpload,
  removeQueuedAction,
  removeUploadEntry,
  removeSite,
  replaceSites,
  setLastSyncAt,
  upsertSite,
} from './lib/offlineStore';
import { formatDate, pinTypeLabel, statusLabel } from './lib/mapUtils';

const DEFAULT_FILTERS = { search: '', client: '', area: '', status: '', approval_state: '' };
const DEFAULT_LAYERS = { lsd: true, water: true, quad_access: true, reclaimed: true, pipelines: true };
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

const TAB_MAP = 'map';
const TAB_SITES = 'sites';
const TAB_RECENTS = 'recents';
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
  const [highlightedSprayRecordId, setHighlightedSprayRecordId] = useState(null);
  const [isFollowingUser, setIsFollowingUser] = useState(false);
  // Lease sheet inspection state
  const [inspectionSite, setInspectionSite] = useState(null);
  const [inspectionPipeline, setInspectionPipeline] = useState(null);
  // Upload queue state
  const [uploadQueueItems, setUploadQueueItems] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const uploadingRef = useRef(false);
  // PDF preview state
  const [previewingPdfUrl, setPreviewingPdfUrl] = useState(null);
  // Edit spray record state
  const [editingSprayRecord, setEditingSprayRecord] = useState(null);
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
    setIsUploading(true);
    try {
      const items = await getUploadQueue();
      for (const item of items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        try {
          if (item.targetType === 'site') {
            await api.createSiteSprayRecord(item.targetId, item.payload);
            // Refresh the site data in background
            try {
              const updated = await api.getSite(item.targetId);
              setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
              await upsertSite(updated);
            } catch { /* ignore refresh failure */ }
          } else if (item.targetType === 'pipeline') {
            await api.createSprayRecord(item.targetId, item.payload);
          }
          await removeUploadEntry(item.id);
        } catch (err) {
          console.error('[UPLOAD_QUEUE] Failed to upload:', item.id, err);
          // Leave it in queue for retry
        }
      }
    } finally {
      uploadingRef.current = false;
      setIsUploading(false);
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
      // Load cached data immediately for instant display
      await loadCachedSites();
      setIsLoading(false); // Show app immediately with cached data
      
      // Then sync with server in background if online (non-blocking)
      if (window.navigator.onLine) {
        try {
          await loadServerSites();
          await loadPipelines();
          await loadPendingPipelines();
          await loadDeletedPipelines();
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
  }, [loadCachedSites, loadServerSites]);

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

  // Auto-poll for real-time updates every 10 seconds when online using bandwidth-efficient sync-status
  useEffect(() => {
    if (!isOnline) return;

    const pollInterval = setInterval(async () => {
      try {
        // Get lightweight sync status (~200 bytes vs ~100KB-1MB for full data)
        const syncStatus = await api.getSyncStatus();
        
        // Check if data has changed by comparing timestamps
        const sitesChanged = !lastSyncStatusRef.current?.sites_last_updated || 
                           syncStatus.sites_last_updated !== lastSyncStatusRef.current.sites_last_updated;
        const pipelinesChanged = !lastSyncStatusRef.current?.pipelines_last_updated || 
                               syncStatus.pipelines_last_updated !== lastSyncStatusRef.current.pipelines_last_updated;
        
        // Update stored sync status
        lastSyncStatusRef.current = syncStatus;
        
        // Only fetch full data if something changed
        if (sitesChanged) {
          try {
            const sitesPayload = await api.listSites(serverFilters);
            setSites(sitesPayload);
            await replaceSites(sitesPayload);
            
            // Update selectedSite if it exists in the new payload
            if (selectedSite && Number.isInteger(selectedSite.id)) {
              const updated = sitesPayload.find((s) => s.id === selectedSite.id);
              if (updated) {
                setSelectedSite(updated);
              }
            }
          } catch {
            // Silently fail
          }
        }
        
        if (pipelinesChanged) {
          try {
            const pipelineData = await api.listPipelines();
            setPipelines(pipelineData);
          } catch {
            // Silently fail
          }
        }
        
        // Always refresh pending counts (lightweight from sync status)
        if (syncStatus.pending_sites_count !== undefined) {
          setPendingSitesCount(syncStatus.pending_sites_count);
        }
        if (syncStatus.pending_pipelines_count !== undefined) {
          setPendingPipelinesCount(syncStatus.pending_pipelines_count);
        }
        
        // Also fetch pending lists if admin and counts changed
        if ((syncStatus.pending_sites_count > 0 || syncStatus.pending_pipelines_count > 0) && roleCanAdmin) {
          try {
            const pending = await api.listPendingSites();
            setPendingSites(pending);
          } catch {
            // Silently fail
          }
          try {
            const pendingPipes = await api.listPendingPipelines();
            setPendingPipelines(pendingPipes);
          } catch {
            // Silently fail
          }
        }
      } catch (error) {
        // Silently fail polling to avoid spam
      }
    }, 10000); // Poll every 10 seconds for updates

    return () => clearInterval(pollInterval);
  }, [isOnline, serverFilters, roleCanAdmin, selectedSite]);

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
    touchStartY.current = e.touches[0].clientY;
    touchStartScrollTop.current = detailBodyRef.current?.scrollTop || 0;
    pullDistance.current = 0;
  }

  function handleTouchMove(e) {
    if (touchStartY.current === null) return;
    const currentY = e.touches[0].clientY;
    const delta = currentY - touchStartY.current;
    
    // If at top of scroll and pulling down (delta > 0), track as pull distance
    if (touchStartScrollTop.current <= 0 && delta > 0) {
      pullDistance.current = delta;
      // Prevent default to stop scroll bounce, but only if we're pulling to dismiss
      if (delta > 10) {
        e.preventDefault();
      }
    }
  }

  function handleTouchEnd(e) {
    if (touchStartY.current === null) return;
    // Require a significant pull (100px) to dismiss
    if (pullDistance.current > 100 && detailOpen) {
      handleCloseDetail();
    }
    touchStartY.current = null;
    pullDistance.current = 0;
    touchStartScrollTop.current = 0;
  }

  // Touch handlers for pipeline detail panel (swipe down to dismiss)
  function handlePipelineTouchStart(e) {
    pipelineTouchStartY.current = e.touches[0].clientY;
    pipelineTouchStartScrollTop.current = pipelineDetailBodyRef.current?.scrollTop || 0;
    pipelinePullDistance.current = 0;
  }

  function handlePipelineTouchMove(e) {
    if (pipelineTouchStartY.current === null) return;
    const currentY = e.touches[0].clientY;
    const delta = currentY - pipelineTouchStartY.current;
    
    // If at top of scroll and pulling down (delta > 0), track as pull distance
    if (pipelineTouchStartScrollTop.current <= 0 && delta > 0) {
      pipelinePullDistance.current = delta;
      // Prevent default to stop scroll bounce, but only if we're pulling to dismiss
      if (delta > 10) {
        e.preventDefault();
      }
    }
  }

  function handlePipelineTouchEnd(e) {
    if (pipelineTouchStartY.current === null) return;
    // Require a significant pull (100px) to dismiss
    if (pipelinePullDistance.current > 100 && pipelineDetailOpen) {
      handleClosePipelineDetail();
    }
    pipelineTouchStartY.current = null;
    pipelinePullDistance.current = 0;
    pipelineTouchStartScrollTop.current = 0;
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
    setIsSprayMarking(true);
    setSprayStartPoint(null);
    setSprayEndPoint(null);
    setShowSprayConfirm(false);
    setSprayForm({ date: new Date().toISOString().split('T')[0], notes: '' });
    setPipelineDetailOpen(false); // Slide panel away
  }

  function handleSprayClick(point) {
    if (!sprayStartPoint) {
      setSprayStartPoint(point);
    } else if (!sprayEndPoint) {
      setSprayEndPoint(point);
      setShowSprayConfirm(true);
    }
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

    setAdminBusy(true);
    try {
      await api.createSprayRecord(selectedPipeline.id, {
        start_fraction: Math.min(startFrac, endFrac),
        end_fraction: Math.max(startFrac, endFrac),
        spray_date: sprayForm.date,
        notes: sprayForm.notes || null,
        is_avoided: sprayForm.is_avoided,
      });
      // Refresh pipeline data
      const updated = await api.getPipeline(selectedPipeline.id);
      setSelectedPipeline(updated);
      setPipelineSprayRecords(updated.spray_records || []);
      setPipelines((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setMessage('Spray record saved.');
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
    } else {
      // It's a pipeline
      setInspectionPipeline(siteOrPipeline);
      setInspectionSite(null);
    }
  }

  async function handleLeaseSheetSubmit(payload) {
    // Queue the upload in background and close the sheet immediately
    const targetType = inspectionSite ? 'site' : 'pipeline';
    const targetId = inspectionSite ? inspectionSite.id : inspectionPipeline?.id;

    await queueUpload({
      targetType,
      targetId,
      payload,
    });
    await refreshUploadQueue();

    // Optimistically update site status
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

    setMessage(payload.is_avoided ? 'Issue queued for upload.' : 'Spray record queued for upload.');
    // Clear inspection state — user returns to map immediately
    setInspectionSite(null);
    setInspectionPipeline(null);

    // Kick off background upload
    processUploadQueue();
  }

  async function handleEditSpraySubmit(payload) {
    if (!editingSprayRecord) return;
    setStatusSaving(true);
    try {
      await api.updateSiteSprayRecord(editingSprayRecord.id, payload);
      setMessage('Record updated.');
      setEditingSprayRecord(null);
      // Refresh site data
      if (editingSprayRecord.site_id) {
        try {
          const updated = await api.getSite(editingSprayRecord.site_id);
          setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
          setSelectedSite(updated);
        } catch { /* ignore */ }
      }
    } catch (error) {
      setMessage(error.message || 'Failed to update record.');
    } finally {
      setStatusSaving(false);
    }
  }

  function handleLeaseSheetCancel() {
    setInspectionSite(null);
    setInspectionPipeline(null);
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
              style={{ background: '#3b82f6', color: 'white', animation: isUploading ? 'pulse 1.5s infinite' : 'none' }}
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
              isOpen={true}
              onSubmit={handleLeaseSheetSubmit}
              onCancel={handleLeaseSheetCancel}
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
            />
          </div>
        )}

        {/* ── PDF Preview overlay ── */}
        {previewingPdfUrl && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 50,
            backgroundColor: '#1f2937',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #374151' }}>
              <span style={{ color: '#f9fafb', fontWeight: 600 }}>PDF Preview</span>
              <button
                onClick={() => setPreviewingPdfUrl(null)}
                style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}
              >×</button>
            </div>
            <iframe
              src={previewingPdfUrl}
              style={{ flex: 1, border: 'none', width: '100%' }}
              title="PDF Preview"
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
              placeholder="Notes (optional)"
            />
            <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="checkbox"
                checked={sprayForm.is_avoided}
                onChange={(e) => setSprayForm((c) => ({ ...c, is_avoided: e.target.checked }))}
              />
              <span className="small-text">Mark as Issue / Not Sprayed</span>
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
                  if (record.pdf_url) {
                    // Convert Dropbox shared link to direct download for iframe embed
                    const url = record.pdf_url.replace('dl=0', 'dl=1').replace('?raw=1', '?dl=1');
                    setPreviewingPdfUrl(url);
                  }
                }}
                onEditRecord={(record) => setEditingSprayRecord({ ...record, site_lsd: selectedSite?.lsd, site_client: selectedSite?.client, site_area: selectedSite?.area })}
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
                onMarkInspection={handleStartInspection}
                adminBusy={adminBusy}
                sprayRecords={pipelineSprayRecords}
                onDeleteSprayRecord={handleDeleteSprayRecord}
                highlightedSprayRecordId={highlightedSprayRecordId}
                onHighlightSprayRecord={setHighlightedSprayRecordId}
                onStartInspection={handleStartInspection}
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

        {/* ── Recents panel ── */}
        <div className={`side-panel ${activeTab === TAB_RECENTS ? 'open' : ''}`}>
          <div className="side-panel-header">
            <h2>Recents</h2>
          </div>
          <div className="side-panel-body">
            <RecentsPanel
              visible={activeTab === TAB_RECENTS}
              onViewPdf={(record) => {
                if (record.pdf_url) {
                  const url = record.pdf_url.replace('dl=0', 'dl=1').replace('?raw=1', '?dl=1');
                  setPreviewingPdfUrl(url);
                }
              }}
              onEditRecord={(record) => setEditingSprayRecord(record)}
              roleCanAdmin={roleCanAdmin}
              uploadQueue={uploadQueueItems}
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
        <button className={`tab-btn ${activeTab === TAB_RECENTS ? 'active' : ''}`} type="button" onClick={() => { 
          if (activeTab === TAB_RECENTS) {
            setActiveTab(TAB_MAP);
          } else {
            setActiveTab(TAB_RECENTS);
            setDetailOpen(false);
          }
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>Recents</span>
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
