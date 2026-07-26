import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../lib/api';
import { nameKey, normalizeName, pinTypeLabel } from '../lib/mapUtils';
import { useAppUpdate } from '../lib/useAppUpdate';
import { APP_VERSION_LABEL } from '../version';
import AppSupportOverlay from './AppSupportCard';
import FilterBar from './FilterBar';
import MapView from './MapView';
import PipelineDetailSheet from './PipelineDetailSheet';
import SiteDetailSheet from './SiteDetailSheet';

const PdfPreviewOverlay = lazy(() => import('./PdfPreviewOverlay'));

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

const TAB_MAP = 'map';
const TAB_SITES = 'sites';

const DEFAULT_FILTERS = { search: '', client: '', area: '', status: '', approval_state: '' };
// No `trucks` / `crew` / `water` / `quad_access` keys: those layers are
// worker-internal and their FilterBar rows are hidden here. Water +
// quad_access pins are also stripped server-side for the client role.
const DEFAULT_LAYERS = { lsd: true, reclaimed: true, pipelines: true };

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
 * account's client_access. The client-side filtering below is purely
 * FilterBar UX, never a security boundary.
 */
function normalizeAccessEntry(entry) {
  const client = typeof entry?.client === 'string' ? entry.client.trim() : '';
  if (!client) return null;
  const areas = Array.isArray(entry?.areas)
    ? entry.areas.filter((a) => typeof a === 'string' && a.trim())
    : [];
  return { client, areas: areas.length > 0 ? areas : null };
}

function accessFromLegacy(clientName, clientAreas) {
  const name = typeof clientName === 'string' ? clientName.trim() : '';
  if (!name) return [];
  const areas = Array.isArray(clientAreas)
    ? clientAreas.filter((a) => typeof a === 'string' && a.trim())
    : [];
  return [{ client: name, areas: areas.length > 0 ? areas : null }];
}

function resolveAccessFromUser(user, fallbackName, fallbackAreas) {
  if (Array.isArray(user?.client_access) && user.client_access.length > 0) {
    return user.client_access.map(normalizeAccessEntry).filter(Boolean);
  }
  const fromLegacy = accessFromLegacy(user?.client_name, user?.client_areas);
  if (fromLegacy.length) return fromLegacy;
  return accessFromLegacy(fallbackName, fallbackAreas);
}

export default function ClientPortal({
  clientName,
  clientAreas,
  clientAccess,
  userDisplayName,
  onSignOut,
  isOnline = true,
}) {
  const [activeTab, setActiveTab] = useState(TAB_MAP);
  const [sites, setSites] = useState([]);
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [listSearch, setListSearch] = useState('');

  // Live scope from GET /api/session (DB-authoritative). JWT app_metadata
  // props can lag an admin re-scope until the token refreshes; the session
  // endpoint uses the same DB preference as site/pipeline list queries.
  // Props seed the first paint only; once session answers, they are ignored.
  const [liveClientAccess, setLiveClientAccess] = useState(() => {
    if (Array.isArray(clientAccess) && clientAccess.length > 0) {
      return clientAccess.map(normalizeAccessEntry).filter(Boolean);
    }
    return accessFromLegacy(clientName, clientAreas);
  });
  const [scopeFromSession, setScopeFromSession] = useState(false);

  const [selectedSite, setSelectedSite] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [sprayRecords, setSprayRecords] = useState([]);

  const [selectedPipeline, setSelectedPipeline] = useState(null);
  const [pipelineDetailOpen, setPipelineDetailOpen] = useState(false);
  const [pipelineSprayRecords, setPipelineSprayRecords] = useState([]);
  const [highlightedSprayRecordId, setHighlightedSprayRecordId] = useState(null);

  const [zoomTarget, setZoomTarget] = useState(null);
  const [previewingRecord, setPreviewingRecord] = useState(null);

  // Mirror App.jsx's "center on me" / follow-mode stack so clients get the
  // same locate FAB + blue user-dot + follow toggle workers already have.
  const [userLocation, setUserLocation] = useState(null);
  const [isFollowingUser, setIsFollowingUser] = useState(false);
  // 'granted' | 'denied' | 'prompt' | 'unsupported' | 'unknown'
  const [geoPermission, setGeoPermission] = useState('unknown');
  const [locationMessage, setLocationMessage] = useState('');

  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [showAppSupport, setShowAppSupport] = useState(false);
  const accountMenuRef = useRef(null);

  // Same SW + /version.json "Update Now" flow as the worker/admin App —
  // clients install the same PWA and need the same reload affordance.
  const { swUpdateAvailable, handleAppUpdate: applyAppUpdate, checkAppVersion } = useAppUpdate();
  const handleAppUpdate = useCallback(async () => {
    setAccountMenuOpen(false);
    await applyAppUpdate();
  }, [applyAppUpdate]);
  const mapRef = useRef(null);
  const lastFollowUpdateRef = useRef(0);
  const smoothedLocationRef = useRef(null);
  const lastLocationUpdateRef = useRef(0);
  const locationMessageTimerRef = useRef(null);

  // ── Data loading ──────────────────────────────────────────────────────
  // Light periodic refresh — no delta-sync machinery needed for a single
  // read-only account with a small, scoped dataset. Session is fetched
  // alongside so FilterBar options track admin scope edits without
  // waiting for a JWT refresh.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const [siteResult, pipelineResult, sessionResult] = await Promise.allSettled([
        api.listSites(),
        api.listPipelines(),
        api.getSession(),
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
      if (sessionResult.status === 'fulfilled') {
        const user = sessionResult.value?.user;
        if (user) {
          const access = resolveAccessFromUser(user, clientName, clientAreas);
          // Must overwrite a stale JWT seed — empty access stays empty
          // (fail closed for FilterBar options).
          setLiveClientAccess(access);
          setScopeFromSession(true);
        }
      }
      setLoading(false);
    };

    void load();
    const interval = setInterval(() => {
      void load();
      // Piggyback version check on the same tick (iOS PWA-friendly) —
      // mirrors App.jsx's runPollTick → checkAppVersion path.
      checkAppVersion();
    }, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [checkAppVersion]);

  // JWT props are only a bootstrap until /api/session lands. Never let
  // them stomp a DB-authoritative scope we already fetched.
  useEffect(() => {
    if (scopeFromSession) return;
    if (Array.isArray(clientAccess) && clientAccess.length > 0) {
      setLiveClientAccess(clientAccess.map(normalizeAccessEntry).filter(Boolean));
      return;
    }
    setLiveClientAccess(accessFromLegacy(clientName, clientAreas));
  }, [clientAccess, clientName, clientAreas, scopeFromSession]);

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

  function showLocationMessage(text) {
    setLocationMessage(text);
    if (locationMessageTimerRef.current) {
      clearTimeout(locationMessageTimerRef.current);
    }
    locationMessageTimerRef.current = setTimeout(() => {
      setLocationMessage('');
      locationMessageTimerRef.current = null;
    }, 4000);
  }

  useEffect(() => () => {
    if (locationMessageTimerRef.current) clearTimeout(locationMessageTimerRef.current);
  }, []);

  // ── Geolocation permission tracking (mirrors App.jsx) ─────────────────
  // Gate watchPosition on an explicit grant so iOS PWA doesn't re-prompt
  // on every cold launch. The locate FAB is the one intentional prompt.
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoPermission('unsupported');
      return undefined;
    }
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
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
    if (!navigator.geolocation) return undefined;
    if (geoPermission !== 'granted' && geoPermission !== 'unsupported') return undefined;

    let watchId = null;

    const smoothLocationTransition = (currentLocation, targetLocation, factor = 0.3) => {
      if (!currentLocation) return targetLocation;
      return {
        lat: currentLocation.lat + (targetLocation.lat - currentLocation.lat) * factor,
        lng: currentLocation.lng + (targetLocation.lng - currentLocation.lng) * factor,
      };
    };

    const startWatch = () => {
      if (watchId != null) return;
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          const rawLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          };
          const now = Date.now();
          const timeSinceLastUpdate = now - lastLocationUpdateRef.current;
          if (timeSinceLastUpdate > 50) {
            lastLocationUpdateRef.current = now;
            const smoothedLocation = smoothLocationTransition(
              smoothedLocationRef.current,
              rawLocation,
              0.08,
            );
            smoothedLocationRef.current = smoothedLocation;
            setUserLocation(smoothedLocation);
            if (isFollowingUser && mapRef.current && now - lastFollowUpdateRef.current > 500) {
              lastFollowUpdateRef.current = now;
              setZoomTarget({
                latitude: smoothedLocation.lat,
                longitude: smoothedLocation.lng,
                _ts: Date.now(),
                _isFollowMode: true,
              });
            }
          }
        },
        (error) => {
          console.error('Location tracking error:', error);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 5000,
        },
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

  useEffect(() => {
    if (!isFollowingUser || !userLocation) return undefined;
    const interval = setInterval(() => {
      if (isFollowingUser && userLocation && mapRef.current) {
        setZoomTarget({
          latitude: userLocation.lat,
          longitude: userLocation.lng,
          _ts: Date.now(),
          _isFollowMode: true,
        });
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isFollowingUser, userLocation]);

  // ── Filter scope ──────────────────────────────────────────────────────
  // Prefer live DB scope from /api/session. For unrestricted companies,
  // area options are derived from loaded pins (same approach as App.jsx).
  // Restricted companies contribute only their allowlisted areas.
  const scopedClients = useMemo(() => {
    if (liveClientAccess.length > 0) {
      return uniqueSorted(liveClientAccess.map((e) => e.client));
    }
    return uniqueSorted([
      ...sites.map((s) => s.client),
      ...pipelines.map((p) => p.client),
    ]);
  }, [liveClientAccess, sites, pipelines]);

  const allowedClientKeys = useMemo(
    () => new Set(liveClientAccess.map((e) => nameKey(e.client)).filter(Boolean)),
    [liveClientAccess],
  );

  // Areas from pins that belong to unrestricted allowed companies (or, when
  // FilterBar has a client selected, only that company).
  const pinAreasForUnrestricted = useMemo(() => {
    const unrestrictedKeys = new Set(
      liveClientAccess
        .filter((e) => !e.areas)
        .map((e) => nameKey(e.client))
        .filter(Boolean),
    );
    // No structured access yet — treat all loaded pins as in-scope.
    const acceptAllUnrestricted = liveClientAccess.length === 0;
    const seen = new Map();
    const consider = (client, area) => {
      const cKey = nameKey(client);
      if (!acceptAllUnrestricted) {
        if (!cKey || !unrestrictedKeys.has(cKey)) return;
      } else if (allowedClientKeys.size > 0 && cKey && !allowedClientKeys.has(cKey)) {
        return;
      }
      const key = nameKey(area);
      if (!key || seen.has(key)) return;
      seen.set(key, normalizeName(area));
    };
    for (const s of sites) consider(s.client, s.area);
    for (const p of pipelines) consider(p.client, p.area);
    if (seen.size === 0) {
      for (const s of sites) consider(null, s.area);
      for (const p of pipelines) consider(null, p.area);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [liveClientAccess, allowedClientKeys, sites, pipelines]);

  const scopedAreas = useMemo(() => {
    const restricted = [];
    let hasUnrestricted = liveClientAccess.length === 0;
    for (const entry of liveClientAccess) {
      if (entry.areas && entry.areas.length > 0) {
        restricted.push(...entry.areas);
      } else {
        hasUnrestricted = true;
      }
    }
    const fromPins = hasUnrestricted ? pinAreasForUnrestricted : [];
    return uniqueSorted([...restricted, ...fromPins]);
  }, [liveClientAccess, pinAreasForUnrestricted]);

  const companiesLabel = useMemo(() => {
    if (liveClientAccess.length === 0) return clientName || 'Client portal';
    return liveClientAccess.map((e) => e.client).join(', ');
  }, [liveClientAccess, clientName]);

  const areasLabel = useMemo(() => {
    const parts = liveClientAccess.map((entry) => {
      if (entry.areas && entry.areas.length > 0) {
        return `${entry.client}: ${entry.areas.join(', ')}`;
      }
      return `${entry.client}: all areas`;
    });
    if (parts.length === 0) return 'All areas';
    if (parts.length === 1 && liveClientAccess[0]?.areas) {
      return liveClientAccess[0].areas.join(', ');
    }
    if (parts.length === 1) return 'All areas';
    return parts.join(' · ');
  }, [liveClientAccess]);

  // Drop filter selections that no longer exist in the effective scope
  // (e.g. admin renamed the company or swapped areas). Without this, a
  // stale selected client/area hides every newly-scoped pin.
  useEffect(() => {
    setFilters((current) => {
      let next = current;
      if (current.client) {
        const stillValid = scopedClients.some(
          (c) => nameKey(c) === nameKey(current.client),
        );
        if (!stillValid) next = { ...next, client: '' };
      }
      const areaValue = next.area || current.area;
      if (areaValue) {
        const stillValid = scopedAreas.some(
          (a) => nameKey(a) === nameKey(areaValue),
        );
        if (!stillValid) next = { ...next, area: '' };
      }
      return next;
    });
  }, [scopedClients, scopedAreas]);

  const visibleSites = useMemo(() => {
    const normalizedSearch = filters.search.trim().toLowerCase();
    return sites.filter((site) => {
      if (isHiddenSite(site)) return false;
      // Defense in depth: water / quad_access are internal pins. Backend
      // already strips them for the client role; keep them off the map
      // even if a stale cache or older API still handed one over.
      if (site.pin_type === 'water' || site.pin_type === 'quad_access') return false;
      if (site.pin_type && layers[site.pin_type] === false) return false;
      if (filters.client && nameKey(site.client) !== nameKey(filters.client)) return false;
      if (filters.area && nameKey(site.area) !== nameKey(filters.area)) return false;
      if (filters.status && site.status !== filters.status) return false;
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

  // Unified Sites-tab rows: pins + pipelines, searchable together.
  const listItems = useMemo(() => {
    const needle = listSearch.trim().toLowerCase();
    const siteItems = visibleSites
      .filter((site) => {
        if (!needle) return true;
        return [site.lsd, site.client, site.area].filter(Boolean).join(' ').toLowerCase().includes(needle);
      })
      .map((site) => ({
        kind: 'site',
        key: `site-${site.id}`,
        sortLabel: (site.lsd || 'Unnamed pin').toLowerCase(),
        site,
      }));
    const pipelineItems = visiblePipelines
      .filter((pipeline) => {
        if (!needle) return true;
        return [pipeline.name, pipeline.client, pipeline.area].filter(Boolean).join(' ').toLowerCase().includes(needle);
      })
      .map((pipeline) => ({
        kind: 'pipeline',
        key: `pipeline-${pipeline.id}`,
        sortLabel: (pipeline.name || 'Unnamed pipeline').toLowerCase(),
        pipeline,
      }));
    return [...siteItems, ...pipelineItems].sort((a, b) => a.sortLabel.localeCompare(b.sortLabel));
  }, [visibleSites, visiblePipelines, listSearch]);

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

  function handleCenterOnUserLocation() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      showLocationMessage("Couldn't get location — GPS is not available on this device.");
      return;
    }

    if (!userLocation) {
      showLocationMessage('Getting location…');
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const location = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          };
          setUserLocation(location);
          setIsFollowingUser(true);
          setZoomTarget({
            latitude: location.lat,
            longitude: location.lng,
            _ts: Date.now(),
            _isFollowMode: true,
          });
          showLocationMessage('Follow mode on');
          setGeoPermission('granted');
        },
        (error) => {
          console.error('Error getting location:', error);
          if (error && error.code === error.PERMISSION_DENIED) {
            showLocationMessage("Location access denied — enable in your phone's Settings → Safari/Pineview Maps → Location.");
            setGeoPermission('denied');
          } else if (error && error.code === error.TIMEOUT) {
            showLocationMessage("Couldn't get GPS in time. Make sure Location is on and try again.");
          } else {
            showLocationMessage("Couldn't get location — check GPS permissions.");
          }
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        },
      );
      return;
    }

    if (isFollowingUser) {
      setIsFollowingUser(false);
      showLocationMessage('Follow mode off');
    } else {
      setIsFollowingUser(true);
      setZoomTarget({
        latitude: userLocation.lat,
        longitude: userLocation.lng,
        _ts: Date.now(),
        _isFollowMode: true,
      });
      showLocationMessage('Follow mode on');
    }
  }

  function handleSearchSelect(site) {
    const isPhone = isPhoneDevice();
    setSelectedSite(site);
    setZoomTarget({ ...site, _ts: Date.now(), _centerOnly: !isPhone });
    setDetailOpen(true);
    setIsFilterOpen(false);
  }

  // ── Swipe-to-dismiss for Sites side panel (right swipe, same as App.jsx) ──
  const sitesPanelTouchStartX = useRef(null);
  const [sitesPanelDragOffset, setSitesPanelDragOffset] = useState(0);
  const [sitesPanelDragging, setSitesPanelDragging] = useState(false);

  const getPanelWidth = () => {
    if (typeof window === 'undefined') return 380;
    return window.innerWidth <= 768 ? window.innerWidth : 380;
  };

  function handleSitesPanelTouchStart(event) {
    if (activeTab !== TAB_SITES) return;
    sitesPanelTouchStartX.current = event.touches[0].clientX;
    setSitesPanelDragging(true);
    setSitesPanelDragOffset(0);
  }

  function handleSitesPanelTouchMove(event) {
    if (sitesPanelTouchStartX.current === null) return;
    const delta = event.touches[0].clientX - sitesPanelTouchStartX.current;
    // Only allow dragging to the right (positive delta)
    if (delta > 0) {
      setSitesPanelDragOffset(delta);
      event.preventDefault();
    }
  }

  function handleSitesPanelTouchEnd() {
    if (sitesPanelTouchStartX.current === null) return;
    if (sitesPanelDragOffset > getPanelWidth() / 2) {
      setActiveTab(TAB_MAP);
    }
    sitesPanelTouchStartX.current = null;
    setSitesPanelDragging(false);
    setSitesPanelDragOffset(0);
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

  const userInitial = (userDisplayName || companiesLabel || clientName || 'C').trim().charAt(0).toUpperCase() || 'C';

  return (
    <div className="app-shell">
      {/* ── Top bar ── */}
      <header className="topbar">
        <span className="topbar-title">Pineview Maps</span>
        <div className="topbar-right">
          <span className={`badge ${isOnline ? 'online' : 'offline'}`}>{isOnline ? 'Online' : 'Offline'}</span>
          {/* Companies + allowed areas live inside this popover rather than as
              an inline topbar badge — on a phone the badge wrapped onto a
              second row and pushed the map down. */}
          <div className="topbar-account-menu" ref={accountMenuRef}>
            <button
              type="button"
              className={`topbar-account-trigger${swUpdateAvailable ? ' topbar-account-trigger--update' : ''}`}
              onClick={() => setAccountMenuOpen((open) => !open)}
              aria-label="Account menu"
              aria-expanded={accountMenuOpen}
              aria-haspopup="menu"
              title={userDisplayName}
            >
              {userInitial}
              {swUpdateAvailable ? (
                <span className="topbar-account-trigger-dot topbar-account-trigger-dot--update" aria-hidden="true" />
              ) : null}
            </button>
            {accountMenuOpen ? (
              <div className="topbar-account-popover" role="menu">
                <div className="topbar-account-name" role="presentation">
                  {userDisplayName}
                  <span className="topbar-account-name-scope">
                    {companiesLabel}
                  </span>
                  {liveClientAccess.length > 0 ? (
                    <span className="topbar-account-name-scope" style={{ display: 'block', marginTop: 4 }}>
                      {areasLabel}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className="topbar-account-item topbar-account-item-danger"
                  onClick={() => { setAccountMenuOpen(false); onSignOut?.(); }}
                >
                  Sign out
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="topbar-account-item topbar-account-item-quiet"
                  onClick={() => { setAccountMenuOpen(false); setShowAppSupport(true); }}
                >
                  App support
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

      {showAppSupport ? <AppSupportOverlay onClose={() => setShowAppSupport(false)} /> : null}

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
            userLocation={userLocation}
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

        {!error && locationMessage ? (
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
              background: 'rgba(9, 17, 31, 0.92)',
              color: '#e5eefb',
              borderColor: 'rgba(143, 182, 255, 0.18)',
            }}
          >
            {locationMessage}
          </div>
        ) : null}

        {activeTab === TAB_MAP ? (
          <button
            className={`fab location-fab location-fab--solo ${isFollowingUser ? 'following' : ''}`}
            type="button"
            onClick={handleCenterOnUserLocation}
            title={isFollowingUser ? 'Stop following my location' : 'Center on my location'}
            aria-label={isFollowingUser ? 'Stop following my location' : 'Center on my location'}
            aria-pressed={isFollowingUser}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            </svg>
          </button>
        ) : null}

        {/* floating filter button */}
        <div className="map-float-tl">
          <button
            className="float-btn"
            type="button"
            onClick={() => setIsFilterOpen((open) => !open)}
            aria-expanded={isFilterOpen}
            aria-label={isFilterOpen ? 'Hide filters' : 'Show filters'}
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
              pipelines={pipelines}
              onChange={(key, value) => setFilters((current) => ({ ...current, [key]: value }))}
              onSearchSelect={handleSearchSelect}
              onClearAll={() => setFilters(DEFAULT_FILTERS)}
              layers={layers}
              onLayerToggle={(key) => setLayers((current) => ({ ...current, [key]: !current[key] }))}
              showTrucksOption={false}
              showCrewOption={false}
              showWaterOption={false}
              showQuadAccessOption={false}
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
            <button className="back-btn" type="button" onClick={handleCloseDetail} aria-label="Close site details">←</button>
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
            <button className="back-btn" type="button" onClick={closePipelineDetail} aria-label="Close pipeline details">←</button>
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
                showDropboxLink={false}
              />
            ) : null}
          </div>
        </div>

        {/* ── Sites list panel ──
            Same left-to-right live swipe-to-dismiss as App.jsx Sites panel. */}
        <div
          className={`side-panel ${activeTab === TAB_SITES ? 'open' : ''} ${sitesPanelDragging ? 'dragging' : ''}`}
          onTouchStart={handleSitesPanelTouchStart}
          onTouchMove={handleSitesPanelTouchMove}
          onTouchEnd={handleSitesPanelTouchEnd}
          style={{
            transform: activeTab === TAB_SITES
              ? `translateX(${sitesPanelDragOffset}px)`
              : 'translateX(100%)',
          }}
        >
          <div className="side-panel-header">
            <h2>Sites</h2>
            <span className="small-text">
              {loading
                ? 'Loading…'
                : `${listItems.length} result${listItems.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <div className="side-panel-body">
            <input
              type="text"
              value={listSearch}
              onChange={(event) => setListSearch(event.target.value)}
              placeholder="Search sites or pipelines…"
              style={{ marginBottom: '0.75rem' }}
            />
            <div className="legend" style={{ marginBottom: '0.75rem' }}>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#22c55e' }} /> Inspected</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#ef4444' }} /> Not inspected</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#94a3b8' }} /> Issue</span>
              <span className="legend-chip"><span className="legend-dot" style={{ background: '#38bdf8' }} /> Pipeline</span>
            </div>
            {loading ? (
              <p className="small-text">Loading sites…</p>
            ) : listItems.length === 0 ? (
              <p className="small-text">No sites or pipelines found.</p>
            ) : (
              <div className="list-grid">
                {listItems.map((item) => (
                  item.kind === 'pipeline' ? (
                    <button
                      className="site-row site-row-pipeline"
                      key={item.key}
                      type="button"
                      onClick={() => { handleOpenPipelineDetail(item.pipeline); setActiveTab(TAB_MAP); }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center' }}>
                        <div style={{ fontWeight: 600 }}>{item.pipeline.name || 'Unnamed pipeline'}</div>
                        <span className="pipeline-badge">Pipeline</span>
                      </div>
                      <div className="small-text">
                        {[item.pipeline.client, item.pipeline.area].filter(Boolean).join(' • ') || 'No area set'}
                        {` • ${item.pipeline.status === 'sprayed' ? 'Sprayed' : 'Not sprayed'}`}
                      </div>
                    </button>
                  ) : (
                    <button
                      className="site-row"
                      key={item.key}
                      type="button"
                      onClick={() => { handleOpenDetail(item.site, { fromSitesList: true }); setActiveTab(TAB_MAP); }}
                    >
                      <div style={{ fontWeight: 600 }}>{item.site.lsd || 'Unnamed pin'}</div>
                      <div className="small-text">
                        {pinTypeLabel(item.site.pin_type)}
                        {' • '}
                        {[item.site.client, item.site.area].filter(Boolean).join(' • ') || 'No area set'}
                      </div>
                    </button>
                  )
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
            showDropboxLink={false}
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
