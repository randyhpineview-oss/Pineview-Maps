import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import AdminPanel from './components/AdminPanel';
import FilterBar from './components/FilterBar';
import LoginPage from './components/LoginPage';
import MapView from './components/MapView';
import SiteDetailSheet from './components/SiteDetailSheet';
import { api } from './lib/api';
import { onAuthStateChange, signOut } from './lib/supabaseClient';
import {
  getLastSyncAt,
  getQueuedActions,
  getSites,
  queueAction,
  removeQueuedAction,
  removeSite,
  replaceSites,
  setLastSyncAt,
  upsertSite,
} from './lib/offlineStore';
import { formatDate, pinTypeLabel, statusLabel } from './lib/mapUtils';

const DEFAULT_FILTERS = { search: '', client: '', area: '', pin_type: '', status: '', approval_state: '' };
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

const TAB_MAP = 'map';
const TAB_SITES = 'sites';
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
  const wasOnline = useRef(window.navigator.onLine);
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
  const [zoomTarget, setZoomTarget] = useState(null);
  const [editPickMode, setEditPickMode] = useState(false);
  const [editPickedLocation, setEditPickedLocation] = useState(null);

  const userRole = session?.user?.user_metadata?.role || 'worker';
  const canManagePins = userRole === 'admin' || userRole === 'office';
  const roleCanAdmin = userRole === 'admin' || userRole === 'office';
  const isPlacingPin = (addPinType !== null && addPinLocation === null) || editPickMode;
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
  }, [refreshQueueCount]);

  const refreshAllData = useCallback(async () => {
    setIsLoading(true);
    
    // Load cached data immediately for instant display
    await loadCachedSites();
    setMessage('Loading cached data...');
    setIsLoading(false); // Show cached data immediately
    
    // Then sync with server in background if online
    if (window.navigator.onLine) {
      try {
        await loadServerSites();
        setMessage('Loaded live data from the API.');
      } catch (error) {
        setMessage(error.message || 'Using cached data - sync failed.');
      }
    } else {
      setMessage('Offline mode: using the last synced site data.');
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
    void refreshAllData();
  }, [refreshAllData, refreshQueueCount]);

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

  const visibleSites = useMemo(() => {
    const normalizedSearch = filters.search.trim().toLowerCase();
    return sites.filter((site) => {
      const isWater = site.pin_type === 'water';
      if (filters.client && site.client !== filters.client && !isWater) return false;
      if (filters.area && site.area !== filters.area && !isWater) return false;
      if (filters.pin_type && site.pin_type !== filters.pin_type) return false;
      if (filters.status && site.status !== filters.status && !isWater) return false;
      if (filters.approval_state && site.approval_state !== filters.approval_state) return false;
      if (!normalizedSearch) return true;
      const haystack = [site.lsd, site.client, site.area, site.notes].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [filters, sites]);

  const mapSites = useMemo(() => {
    const hideWater = filters.pin_type && filters.pin_type !== 'water';
    if (hideWater) {
      const visibleIds = new Set(visibleSites.map((s) => s.id ?? s.cacheId));
      const waterOverlay = sites.filter((s) => s.pin_type === 'water' && !visibleIds.has(s.id ?? s.cacheId));
      return [...visibleSites, ...waterOverlay];
    }
    return visibleSites;
  }, [visibleSites, sites, filters.pin_type]);

  const clients = useMemo(
    () => [...new Set(sites.map((site) => site.client).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [sites]
  );
  const areas = useMemo(
    () => [...new Set(sites.map((site) => site.area).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [sites]
  );

  function handleOpenDetail(site) {
    setSelectedSite(site);
    setDetailOpen(true);
  }

  function handleCloseDetail() {
    setDetailOpen(false);
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

  function handleMapLocationPick(location) {
    if (editPickMode) {
      setEditPickedLocation(location);
      setEditPickMode(false);
      setDetailOpen(true);
      return;
    }
    if (addPinType !== null && addPinLocation === null) {
      setAddPinLocation(location);
    }
  }

  function handleEditPickRequest() {
    setEditPickMode(true);
    setEditPickedLocation(null);
    setDetailOpen(false);
  }

  function handleMapDismiss() {
    setIsFilterOpen(false);
    setFabOpen(false);
    setDetailOpen(false);
    setSelectedSite(null);
    if (editPickMode) {
      setEditPickMode(false);
      setDetailOpen(true);
    }
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
      if (window.navigator.onLine) {
        const created = await api.createSite(payload);
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
    } catch (error) {
      setMessage(error.message || 'Unable to submit pin.');
    } finally {
      setSubmittingPin(false);
      handleCancelAdd();
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

  async function handleStatusChange(site, status, note) {
    if (!Number.isInteger(site.id)) { setMessage('Sync this pin first.'); return; }
    setStatusSaving(true);
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
    } catch (error) { setMessage(error.message || 'Status update failed.'); }
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
      setZoomTarget({ ...target, _ts: Date.now() });
      setActiveTab(TAB_MAP);
      setDetailOpen(true);
      setMessage('Approved — showing pin on map.');
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

  if (isAuthLoading) {
    return <div className="flex items-center justify-center h-screen">Loading...</div>;
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
          {roleCanAdmin && pendingSites.length > 0 ? (
            <span 
              className="badge" 
              style={{ background: '#f59e0b', color: '#422006', cursor: 'pointer' }}
              onClick={() => setActiveTab(TAB_ADMIN)}
            >
              Pending: {pendingSites.length}
            </span>
          ) : null}
          {queuedCount > 0 ? <span className="badge">Queued: {queuedCount}</span> : null}
          <span className="badge">{user?.email}</span>
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
            isPickingLocation={isPlacingPin}
            pickedLocation={addPinLocation}
            onPickLocation={handleMapLocationPick}
            onOpenDetail={handleOpenDetail}
            zoomToSite={zoomTarget}
            onMapClick={handleMapDismiss}
          />
        </div>

        {/* floating filter button */}
        <div className="map-float-tl">
          <button className="float-btn" type="button" onClick={() => setIsFilterOpen((c) => !c)}>
            ☰ Filters
          </button>
          {!isOnline ? <div className="badge offline">Offline mode</div> : null}
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
            />
          </div>
        ) : null}

        {/* Place-pin banner */}
        {isPlacingPin ? (
          <div className="place-banner">
            {editPickMode
              ? 'Tap map to set new pin location'
              : `Tap map to place ${pinTypeLabel(addPinType)} pin`}
            <button className="cancel-btn" type="button" onClick={() => {
              if (editPickMode) {
                setEditPickMode(false);
                setDetailOpen(true);
              } else {
                handleCancelAdd();
              }
            }}>Cancel</button>
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
          </div>
        ) : null}

        {/* FAB + type menu */}
        {activeTab === TAB_MAP && !isPlacingPin && !showAddPopup ? (
          <>
            <button className="fab" type="button" onClick={() => setFabOpen((c) => !c)}>+</button>
            {fabOpen ? (
              <div className="fab-menu">
                <button type="button" onClick={() => handleFabSelect('lsd')}>LSD</button>
                <button type="button" onClick={() => handleFabSelect('water')}>Water</button>
                <button type="button" onClick={() => handleFabSelect('quad_access')}>Quad Access</button>
                <button type="button" onClick={() => handleFabSelect('reclaimed')}>Reclaimed</button>
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
          <div className="side-panel-body">
            {selectedSite ? (
              <SiteDetailSheet
                site={selectedSite}
                onStatusChange={handleStatusChange}
                statusSaving={statusSaving}
                canManagePin={canManagePins}
                onSavePin={handleAdminUpdateSite}
                onDeletePin={handleDeleteSite}
                onRequestTypeChange={handleRequestTypeChange}
                adminBusy={adminBusy}
                onRequestMapPick={canManagePins ? handleEditPickRequest : undefined}
                pickedLocation={editPickedLocation}
              />
            ) : null}
          </div>
        </div>

        {/* ── Sites list panel ── */}
        <div className={`side-panel ${activeTab === TAB_SITES ? 'open' : ''}`}>
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
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#3b82f6' }} /> Water</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#eab308' }} /> Quad</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#f59e0b' }} /> Pending</span>
            </div>
            <div className="list-grid">
              {visibleSites.length === 0 ? (
                <div className="site-row small-text">No sites match filters.</div>
              ) : (
                visibleSites.map((site) => (
                  <button className="site-row" key={site.id || site.cacheId} type="button" onClick={() => { handleOpenDetail(site); setActiveTab(TAB_MAP); }}>
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

        {/* ── Admin panel ── */}
        <div className={`side-panel ${activeTab === TAB_ADMIN && roleCanAdmin ? 'open' : ''}`}>
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
              onApprove={(siteId, overrides) => runAdminAction(() => api.approveSite(siteId, { approval_state: 'approved', ...overrides }, demoUser), 'Approved.')}
              onReject={(siteId) => runAdminAction(() => api.approveSite(siteId, { approval_state: 'rejected' }, demoUser), 'Rejected.')}
              onApproveAndEdit={handleApproveAndEdit}
              onBulkReset={(payload) => runAdminAction(() => api.bulkResetStatus(payload, demoUser), 'Reset complete.')}
              onImport={(file) => runAdminAction(() => api.importKml(file, demoUser), 'KML imported.')}
              onRestore={handleRestoreSite}
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
        <button className={`tab-btn ${activeTab === TAB_SITES ? 'active' : ''}`} type="button" onClick={() => { setActiveTab(TAB_SITES); setDetailOpen(false); }}>
          <ListIcon />
          <span>Sites</span>
        </button>
        {roleCanAdmin ? (
          <button className={`tab-btn ${activeTab === TAB_ADMIN ? 'active' : ''}`} type="button" onClick={() => { setActiveTab(TAB_ADMIN); setDetailOpen(false); }}>
            <GearIcon />
            <span>Admin</span>
          </button>
        ) : null}
      </nav>
    </div>
  );
}
