import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../lib/api';
import { nameKey } from '../lib/mapUtils';
import FilterBar from './FilterBar';
import MapView from './MapView';
import PipelineDetailSheet from './PipelineDetailSheet';
import SiteDetailSheet from './SiteDetailSheet';

const PdfPreviewOverlay = lazy(() => import('./PdfPreviewOverlay'));

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

const TAB_MAP = 'map';
const TAB_SITES = 'sites';

const DEFAULT_FILTERS = { search: '', client: '', area: '', status: '', approval_state: '' };
// No `trucks` / `crew` keys: those layers are worker/office-only and their
// FilterBar rows are hidden here, so carrying the flags would be dead state.
const DEFAULT_LAYERS = { lsd: true, water: true, quad_access: true, reclaimed: true, pipelines: true };

const MapIcon = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>);
const ListIcon = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>);

function isPhoneDevice() {
  if (typeof window === 'undefined') return false;
  return (
    (window.innerWidth <= 480 || window.innerHeight <= 600)
    && /Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  );
}

// Rows the server may still hand us but that must never draw a marker:
// soft-deleted or rejected pins. Mirrors App.jsx's `isHiddenSite` guard.
function isHiddenSite(site) {
  if (!site) return true;
  return Boolean(site.deleted_at) || site.approval_state === 'rejected';
}

function uniqueSorted(values) {
  const seen = new Map();
  values.forEach((value) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return;
    const key = nameKey(trimmed);
    if (!seen.has(key)) seen.set(key, trimmed);
  });
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

/**
 * Read-only, invite-only portal for external client accounts (Shell, CNRL,
 * etc.). Deliberately its own small component rather than a set of
 * `userRole === 'client'` branches threaded through the giant worker/admin
 * App.jsx shell (~7000+ lines of state, polling, and mutating actions that
 * a client-portal account should never be exposed to, even as unreachable
 * dead code).
 *
 * It does, however, reuse the *presentation* pieces the worker app uses —
 * `MapView`, `FilterBar`, `SiteDetailSheet`, `PipelineDetailSheet`, and the
 * `.app-shell` / `.topbar` / `.side-panel` / `.bottom-tabs` CSS — so the
 * client sees the same map (hybrid imagery with road + city labels), the
 * same tap-pin-then-"i" popup flow, and the same bottom sheets a worker
 * does. Parity is by construction, not by copied styles.
 *
 * Data scoping is enforced by the backend (see backend/app/auth.py's client
 * allowlist + apply_client_scope) — every `api.*` call here just uses the
 * normal endpoints and the server only ever returns rows within this
 * account's client_name/client_areas. The client-side filtering below is
 * purely FilterBar UX, never a security boundary.
 */
export default function ClientPortal({ clientName, clientAreas, userDisplayName, onSignOut, isOnline = true }) {
  const [activeTab, setActiveTab] = useState(TAB_MAP);
  const [sites, setSites] = useState([]);
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [listSearch, setListSearch] = useState('');

  const [selectedSite, setSelectedSite] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [sprayRecords, setSprayRecords] = useState([]);

  const [selectedPipeline, setSelectedPipeline] = useState(null);
  const [pipelineDetailOpen, setPipelineDetailOpen] = useState(false);
  const [pipelineSprayRecords, setPipelineSprayRecords] = useState([]);
  const [highlightedSprayRecordId, setHighlightedSprayRecordId] = useState(null);

  const [zoomTarget, setZoomTarget] = useState(null);
  const [previewingRecord, setPreviewingRecord] = useState(null);

  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef(null);
  const mapRef = useRef(null);

  // ── Data loading ──────────────────────────────────────────────────────
  // Light periodic refresh — no delta-sync machinery needed for a single
  // read-only account with a small, scoped dataset.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const [siteResult, pipelineResult] = await Promise.allSettled([
        api.listSites(),
        api.listPipelines(),
      ]);
      if (cancelled) return;
      if (siteResult.status === 'fulfilled') {
        setSites(Array.isArray(siteResult.value) ? siteResult.value : []);
        setError('');
      } else {
        setError(siteResult.reason?.message || 'Could not load sites.');
      }
      if (pipelineResult.status === 'fulfilled') {
        setPipelines(Array.isArray(pipelineResult.value) ? pipelineResult.value : []);
      }
      setLoading(false);
    };

    void load();
    const interval = setInterval(() => { void load(); }, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Keep the selected site's fields fresh across refresh ticks without
  // stomping the sheet when the row disappears mid-view.
  useEffect(() => {
    if (!selectedSite) return;
    const fresh = sites.find((s) => s.id === selectedSite.id);
    if (fresh && fresh !== selectedSite) setSelectedSite((prev) => (prev ? { ...prev, ...fresh } : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites]);

  useEffect(() => {
    const siteId = selectedSite?.id;
    if (!siteId) {
      setSprayRecords([]);
      return;
    }
    let cancelled = false;
    api.listSiteSprayRecords(siteId)
      .then((records) => { if (!cancelled) setSprayRecords(Array.isArray(records) ? records : []); })
      .catch(() => { if (!cancelled) setSprayRecords([]); });
    return () => { cancelled = true; };
  }, [selectedSite?.id]);

  // ── Account popover: close on outside pointerdown ─────────────────────
  useEffect(() => {
    if (!accountMenuOpen) return;
    const handleOutside = (event) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target)) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [accountMenuOpen]);

  // ── Filter scope ──────────────────────────────────────────────────────
  // `clientAreas` empty/null means "all areas for that client", so in that
  // case the area dropdown is derived from whatever the server actually
  // returned for this account.
  const scopedClients = useMemo(() => {
    if (clientName) return [clientName];
    return uniqueSorted(sites.map((s) => s.client));
  }, [clientName, sites]);

  const scopedAreas = useMemo(() => {
    if (Array.isArray(clientAreas) && clientAreas.length > 0) return uniqueSorted(clientAreas);
    return uniqueSorted([...sites.map((s) => s.area), ...pipelines.map((p) => p.area)]);
  }, [clientAreas, sites, pipelines]);

  const visibleSites = useMemo(() => {
    const normalizedSearch = filters.search.trim().toLowerCase();
    return sites.filter((site) => {
      if (isHiddenSite(site)) return false;
      const isWater = site.pin_type === 'water';
      if (site.pin_type && !layers[site.pin_type]) return false;
      if (filters.client && nameKey(site.client) !== nameKey(filters.client) && !isWater) return false;
      if (filters.area && nameKey(site.area) !== nameKey(filters.area) && !isWater) return false;
      if (filters.status && site.status !== filters.status && !isWater) return false;
      if (filters.approval_state && site.approval_state !== filters.approval_state) return false;
      if (!normalizedSearch) return true;
      const haystack = [site.lsd, site.client, site.area].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [filters, sites, layers]);

  const visiblePipelines = useMemo(() => {
    if (!layers.pipelines) return [];
    const normalizedSearch = filters.search.trim().toLowerCase();
    return pipelines.filter((pipeline) => {
      if (pipeline.deleted_at) return false;
      if (pipeline.approval_state === 'rejected') return false;
      if (filters.client && nameKey(pipeline.client) !== nameKey(filters.client)) return false;
      if (filters.area && nameKey(pipeline.area) !== nameKey(filters.area)) return false;
      if (filters.approval_state && pipeline.approval_state !== filters.approval_state) return false;
      if (!normalizedSearch) return true;
      const haystack = [pipeline.name, pipeline.client, pipeline.area].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [filters, pipelines, layers.pipelines]);

  const listSites = useMemo(() => {
    const needle = listSearch.trim().toLowerCase();
    if (!needle) return visibleSites;
    return visibleSites.filter((site) => (
      [site.lsd, site.client, site.area].filter(Boolean).join(' ').toLowerCase().includes(needle)
    ));
  }, [visibleSites, listSearch]);

  // ── Selection handlers ────────────────────────────────────────────────
  function closePipelineDetail() {
    setPipelineDetailOpen(false);
    setSelectedPipeline(null);
    setPipelineSprayRecords([]);
    setHighlightedSprayRecordId(null);
  }

  function handleOpenDetail(site, options = {}) {
    if (!site || isHiddenSite(site)) return;
    closePipelineDetail();
    setSelectedSite(site);
    setDetailOpen(true);
    const isPhone = isPhoneDevice();
    if (isPhone || options.fromSitesList) {
      setZoomTarget({ ...site, _ts: Date.now(), _centerOnly: options.fromSitesList && !isPhone });
    }
  }

  function handleCloseDetail() {
    setDetailOpen(false);
  }

  function handleOpenPipelineDetail(pipeline) {
    if (!pipeline) return;
    setDetailOpen(false);
    setSelectedSite(null);
    setZoomTarget(null);
    setSelectedPipeline(pipeline);
    setPipelineDetailOpen(true);
    setPipelineSprayRecords([]);
    setHighlightedSprayRecordId(null);
    // Frame the pipeline the same way App.jsx does, leaving room for the
    // bottom sheet.
    if (pipeline.coordinates && pipeline.coordinates.length >= 2 && mapRef.current && window.google) {
      const bounds = new window.google.maps.LatLngBounds();
      pipeline.coordinates.forEach(([lat, lng]) => bounds.extend({ lat, lng }));
      mapRef.current.fitBounds(bounds, { top: 50, bottom: 300, left: 50, right: 50 });
    }
    if (pipeline.id && window.navigator.onLine) {
      api.listSprayRecords(pipeline.id)
        .then((records) => setPipelineSprayRecords(Array.isArray(records) ? records : []))
        .catch(() => {});
    }
  }

  function handleMapDismiss() {
    setIsFilterOpen(false);
    setDetailOpen(false);
    setSelectedSite(null);
    closePipelineDetail();
    if (activeTab !== TAB_MAP) setActiveTab(TAB_MAP);
  }

  function handleSearchSelect(site) {
    const isPhone = isPhoneDevice();
    setSelectedSite(site);
    setZoomTarget({ ...site, _ts: Date.now(), _centerOnly: !isPhone });
    setDetailOpen(true);
    setIsFilterOpen(false);
  }

  // ── Swipe-to-dismiss for the two bottom sheets ────────────────────────
  const detailTouchStartY = useRef(null);
  const detailBodyRef = useRef(null);
  const [detailDragOffset, setDetailDragOffset] = useState(0);
  const [detailDragging, setDetailDragging] = useState(false);

  const pipelineTouchStartY = useRef(null);
  const pipelineDetailBodyRef = useRef(null);
  const [pipelineDragOffset, setPipelineDragOffset] = useState(0);
  const [pipelineDragging, setPipelineDragging] = useState(false);

  const getBottomSheetHeight = () => {
    if (typeof window === 'undefined') return 400;
    return window.innerHeight <= 768 ? window.innerHeight * 0.55 : 400;
  };

  function beginSheetDrag(event, bodyRef, startYRef, setDragging, setOffset) {
    const touchY = event.touches[0].clientY;
    const target = event.target;
    const isHeader = target?.closest?.('.side-panel-header');
    if (isHeader) {
      startYRef.current = touchY;
      setDragging(true);
      setOffset(0);
      return;
    }
    const scrollTop = bodyRef.current?.scrollTop || 0;
    if (scrollTop <= 5) {
      startYRef.current = touchY;
      setDragging(true);
      setOffset(0);
    } else {
      startYRef.current = null;
    }
  }

  function moveSheetDrag(event, startYRef, setOffset) {
    if (startYRef.current === null) return;
    const delta = event.touches[0].clientY - startYRef.current;
    if (delta > 0) {
      setOffset(delta);
      if (delta > 10) event.preventDefault();
    }
  }

  function handleDetailTouchStart(event) {
    beginSheetDrag(event, detailBodyRef, detailTouchStartY, setDetailDragging, setDetailDragOffset);
  }
  function handleDetailTouchMove(event) {
    moveSheetDrag(event, detailTouchStartY, setDetailDragOffset);
  }
  function handleDetailTouchEnd() {
    if (detailTouchStartY.current === null) return;
    if (detailDragOffset > getBottomSheetHeight() / 2 && detailOpen) handleCloseDetail();
    detailTouchStartY.current = null;
    setDetailDragging(false);
    setDetailDragOffset(0);
  }

  function handlePipelineTouchStart(event) {
    beginSheetDrag(event, pipelineDetailBodyRef, pipelineTouchStartY, setPipelineDragging, setPipelineDragOffset);
  }
  function handlePipelineTouchMove(event) {
    moveSheetDrag(event, pipelineTouchStartY, setPipelineDragOffset);
  }
  function handlePipelineTouchEnd() {
    if (pipelineTouchStartY.current === null) return;
    if (pipelineDragOffset > getBottomSheetHeight() / 2 && pipelineDetailOpen) closePipelineDetail();
    pipelineTouchStartY.current = null;
    setPipelineDragging(false);
    setPipelineDragOffset(0);
  }

  const userInitial = (userDisplayName || clientName || 'C').trim().charAt(0).toUpperCase() || 'C';
  const areasLabel = Array.isArray(clientAreas) && clientAreas.length > 0
    ? clientAreas.join(', ')
    : 'All areas';

  return (
    <div className="app-shell">
      {/* ── Top bar ── */}
      <header className="topbar">
        <span className="topbar-title">Pineview Maps</span>
        <div className="topbar-right">
          <span className={`badge ${isOnline ? 'online' : 'offline'}`}>{isOnline ? 'Online' : 'Offline'}</span>
          {/* Company + allowed areas live inside this popover rather than as
              an inline topbar badge — on a phone the badge wrapped onto a
              second row and pushed the map down. */}
          <div className="topbar-account-menu" ref={accountMenuRef}>
            <button
              type="button"
              className="topbar-account-trigger"
              onClick={() => setAccountMenuOpen((open) => !open)}
              aria-label="Account menu"
              aria-expanded={accountMenuOpen}
              aria-haspopup="menu"
              title={userDisplayName}
            >
              {userInitial}
            </button>
            {accountMenuOpen ? (
              <div className="topbar-account-popover" role="menu">
                <div className="topbar-account-name" role="presentation">
                  {userDisplayName}
                  <span className="topbar-account-name-scope">
                    {clientName || 'Client portal'}
                    {' — '}
                    {areasLabel}
                  </span>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className="topbar-account-item topbar-account-item-danger"
                  onClick={() => { setAccountMenuOpen(false); onSignOut?.(); }}
                >
                  Sign out
                </button>
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
            sites={visibleSites}
            selectedSite={selectedSite}
            onSelectSite={handleOpenDetail}
            onOpenDetail={handleOpenDetail}
            onMapClick={handleMapDismiss}
            onMapLoad={(map) => { mapRef.current = map; }}
            zoomToSite={zoomTarget}
            detailOpen={detailOpen || pipelineDetailOpen}
            pipelines={visiblePipelines}
            selectedPipeline={selectedPipeline}
            onSelectPipeline={handleOpenPipelineDetail}
            highlightedSprayRecordId={highlightedSprayRecordId}
            onSprayRecordClick={(record) => setHighlightedSprayRecordId((prev) => (prev === record.id ? null : record.id))}
            onShowSitesTab={() => { setActiveTab(TAB_SITES); setDetailOpen(false); }}
            activeTab={activeTab}
            showTrucksLayer={false}
            showCrewLayer={false}
          />
        </div>

        {error ? (
          <div
            className="float-btn"
            role="status"
            style={{
              position: 'absolute',
              top: 12,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 14,
              maxWidth: 'calc(100% - 24px)',
              background: 'rgba(127,29,29,0.94)',
              color: '#fecaca',
              borderColor: 'rgba(254,202,202,0.3)',
            }}
          >
            {error}
          </div>
        ) : null}

        {/* floating filter button */}
        <div className="map-float-tl">
          <button
            className="float-btn"
            type="button"
            onClick={() => setIsFilterOpen((open) => !open)}
          >
            ☰ Filters
          </button>
        </div>

        {isFilterOpen ? (
          <div className="filter-overlay">
            <FilterBar
              filters={filters}
              clients={scopedClients}
              areas={scopedAreas}
              sites={sites}
              onChange={(key, value) => setFilters((current) => ({ ...current, [key]: value }))}
              onSearchSelect={handleSearchSelect}
              onClearAll={() => setFilters(DEFAULT_FILTERS)}
              layers={layers}
              onLayerToggle={(key) => setLayers((current) => ({ ...current, [key]: !current[key] }))}
              showTrucksOption={false}
              showCrewOption={false}
            />
          </div>
        ) : null}

        {/* ── Site detail bottom sheet ──
            Same element/inline-transform pairing App.jsx uses: `.side-panel`
            defaults to translateX(100%) (off-screen) and the inline
            translateY below is what actually drives the sheet, so both must
            stay together — dropping either one hides the panel entirely. */}
        <div
          className={`side-panel detail-priority ${detailOpen && selectedSite ? 'open' : ''} ${detailDragging ? 'dragging' : ''}`}
          style={{
            transform: detailOpen && selectedSite
              ? `translateY(${detailDragOffset}px)`
              : 'translateY(100%)',
          }}
          onTouchStart={handleDetailTouchStart}
          onTouchMove={handleDetailTouchMove}
          onTouchEnd={handleDetailTouchEnd}
        >
          <div className="side-panel-header">
            <button className="back-btn" type="button" onClick={handleCloseDetail}>←</button>
            <h2>Site Details</h2>
          </div>
          <div className="side-panel-body" ref={detailBodyRef}>
            {selectedSite ? (
              <SiteDetailSheet
                site={selectedSite}
                sprayRecords={sprayRecords}
                canManagePin={false}
                canAdmin={false}
                showDirections={false}
                canEditStatus={false}
                canViewPdf={true}
                showSprayHistory={true}
                onViewPdf={(record) => setPreviewingRecord(record)}
              />
            ) : null}
          </div>
        </div>

        {/* ── Pipeline detail bottom sheet ── */}
        <div
          className={`side-panel detail-priority ${pipelineDetailOpen && selectedPipeline ? 'open' : ''} ${pipelineDragging ? 'dragging' : ''}`}
          style={{
            transform: pipelineDetailOpen && selectedPipeline
              ? `translateY(${pipelineDragOffset}px)`
              : 'translateY(100%)',
          }}
          onTouchStart={handlePipelineTouchStart}
          onTouchMove={handlePipelineTouchMove}
          onTouchEnd={handlePipelineTouchEnd}
        >
          <div className="side-panel-header">
            <button className="back-btn" type="button" onClick={closePipelineDetail}>←</button>
            <h2>Pipeline Details</h2>
          </div>
          <div className="side-panel-body" ref={pipelineDetailBodyRef}>
            {selectedPipeline ? (
              <PipelineDetailSheet
                pipeline={selectedPipeline}
                canManage={false}
                canEditStatus={false}
                sprayRecords={pipelineSprayRecords}
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
          style={{ transform: activeTab === TAB_SITES ? 'translateX(0)' : 'translateX(100%)' }}
        >
          <div className="side-panel-header">
            <h2>Sites</h2>
            <span className="small-text">
              {loading ? 'Loading…' : `${listSites.length} site${listSites.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <div className="side-panel-body">
            <input
              type="text"
              value={listSearch}
              onChange={(event) => setListSearch(event.target.value)}
              placeholder="Search by LSD, client or area…"
              style={{ marginBottom: '0.75rem' }}
            />
            <div className="legend" style={{ marginBottom: '0.75rem' }}>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#22c55e' }} /> Inspected</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#ef4444' }} /> Not inspected</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#94a3b8' }} /> Issue</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#3b82f6' }} /> Water</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#eab308' }} /> Quad</span>
            </div>
            {loading ? (
              <p className="small-text">Loading sites…</p>
            ) : listSites.length === 0 ? (
              <p className="small-text">No sites found.</p>
            ) : (
              <div className="list-grid">
                {listSites.map((site) => (
                  <button
                    className="site-row"
                    key={site.id}
                    type="button"
                    onClick={() => { handleOpenDetail(site, { fromSitesList: true }); setActiveTab(TAB_MAP); }}
                  >
                    <div style={{ fontWeight: 600 }}>{site.lsd || 'Unnamed pin'}</div>
                    <div className="small-text">
                      {[site.client, site.area].filter(Boolean).join(' • ') || 'No area set'}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      {previewingRecord ? (
        <Suspense fallback={null}>
          <PdfPreviewOverlay
            record={previewingRecord}
            onClose={() => setPreviewingRecord(null)}
            canRegenerate={false}
          />
        </Suspense>
      ) : null}

      {/* ── Bottom tabs ── */}
      <nav className="bottom-tabs">
        <button
          className={`tab-btn ${activeTab === TAB_MAP ? 'active' : ''}`}
          type="button"
          onClick={() => setActiveTab(TAB_MAP)}
        >
          <MapIcon />
          <span>Map</span>
        </button>
        <button
          className={`tab-btn ${activeTab === TAB_SITES ? 'active' : ''}`}
          type="button"
          onClick={() => {
            setActiveTab(activeTab === TAB_SITES ? TAB_MAP : TAB_SITES);
            setDetailOpen(false);
          }}
        >
          <ListIcon />
          <span>Sites</span>
        </button>
      </nav>
    </div>
  );
}
