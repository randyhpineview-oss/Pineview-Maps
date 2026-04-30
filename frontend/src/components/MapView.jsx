import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, Marker, OverlayView, Polyline, useJsApiLoader } from '@react-google-maps/api';

import { buildMarkerIcon, pinTypeLabel, nearestFraction } from '../lib/mapUtils';

const mapContainerStyle = { width: '100%', height: '100%' };

// Fort St. John, BC coordinates
const defaultCenter = { lat: 56.2498, lng: -120.8464 };

// Mobile detail bottom-sheet height (keep in sync with .side-panel.detail-priority in index.css)
const DETAIL_PANEL_VH = 0.55;

function isPhoneDevice() {
  if (typeof window === 'undefined') return false;
  return (
    (window.innerWidth <= 480 || window.innerHeight <= 600) &&
    /Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  );
}

// Pixel shift applied to the map center so the pin lands in the middle of the
// visible (non-overlapped) map area above the bottom sheet. The sheet covers
// the bottom `DETAIL_PANEL_VH * innerHeight` pixels; shifting the center south
// by half that amount centers the pin in the remaining visible strip.
function getDetailOffsetPx() {
  return window.innerHeight * (DETAIL_PANEL_VH / 2);
}

// Convert a pixel-space offset into a lat/lng at the map's current zoom via
// the Google Maps projection. Positive `pixelY` shifts the returned point
// south on screen (increases screen Y). Falls back to the input point if the
// projection is not yet available (e.g. before the first idle event).
function offsetLatLngByPixels(map, lat, lng, pixelX, pixelY) {
  const projection = map && typeof map.getProjection === 'function' ? map.getProjection() : null;
  if (!projection || !window.google) return { lat, lng };
  const scale = Math.pow(2, map.getZoom());
  const world = projection.fromLatLngToPoint(new window.google.maps.LatLng(lat, lng));
  const shifted = new window.google.maps.Point(
    world.x + pixelX / scale,
    world.y + pixelY / scale
  );
  const ll = projection.fromPointToLatLng(shifted);
  return { lat: ll.lat(), lng: ll.lng() };
}

function getInterpolatedSubPath(coords, startFrac, endFrac) {
  if (coords.length < 2) return coords;
  
  // Calculate total length and segment lengths
  let totalLength = 0;
  const segLengths = [];
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    const len = Math.sqrt(dx * dx + dy * dy);
    segLengths.push(len);
    totalLength += len;
  }
  
  if (totalLength === 0) return [coords[0], coords[0]];
  
  const targetStartDist = startFrac * totalLength;
  const targetEndDist = endFrac * totalLength;
  
  const subPath = [];
  let cumLength = 0;
  let started = false;
  
  for (let i = 0; i < segLengths.length; i++) {
    const segLen = segLengths[i];
    const segStartDist = cumLength;
    const segEndDist = cumLength + segLen;
    
    // Check if start point falls in this segment
    if (!started && targetStartDist >= segStartDist && targetStartDist <= segEndDist) {
      started = true;
      const t = segLen === 0 ? 0 : (targetStartDist - segStartDist) / segLen;
      const lat = coords[i][0] + t * (coords[i+1][0] - coords[i][0]);
      const lng = coords[i][1] + t * (coords[i+1][1] - coords[i][1]);
      subPath.push({ lat, lng });
    }
    
    // Check if end point falls in this segment
    if (started && targetEndDist >= segStartDist && targetEndDist <= segEndDist) {
      const t = segLen === 0 ? 0 : (targetEndDist - segStartDist) / segLen;
      const lat = coords[i][0] + t * (coords[i+1][0] - coords[i][0]);
      const lng = coords[i][1] + t * (coords[i+1][1] - coords[i][1]);
      subPath.push({ lat, lng });
      break; // Reached the end
    }
    
    // If we've started but haven't reached the end yet, and we're at a segment boundary, add the original point
    if (started && targetEndDist > segEndDist) {
      subPath.push({ lat: coords[i+1][0], lng: coords[i+1][1] });
    }
    
    cumLength += segLen;
  }
  
  return subPath;
}

// Preview line component for spray marking
function SprayPreviewLine({ pipeline, startPoint, endPoint }) {
  const coords = pipeline?.coordinates;
  if (!coords || coords.length < 2 || !startPoint) return null;
  
  const startFrac = nearestFraction(startPoint, coords);
  const endFrac = endPoint ? nearestFraction(endPoint, coords) : startFrac;
  
  const subPath = getInterpolatedSubPath(coords, startFrac, endFrac);
  if (subPath.length < 2) return null;
  
  return (
    <Polyline
      path={subPath}
      options={{
        strokeColor: '#f59e0b', // amber/yellow for preview
        strokeOpacity: 0.8,
        strokeWeight: 6,
        zIndex: 15,
        clickable: false,
      }}
    />
  );
}

export default function MapView({
  sites,
  markerRevision = 0,
  selectedSite,
  onSelectSite,
  onOpenDetail,
  apiKey,
  isOnline,
  isPickingLocation = false,
  pickedLocation = null,
  onPickLocation,
  zoomToSite = null,
  onMapClick,
  userLocation = null,
  onMapLoad,
  detailOpen = false,
  // Pipeline props
  pipelines = [],
  selectedPipeline = null,
  onSelectPipeline,
  // Drawing mode props
  isDrawingPipeline = false,
  drawingPoints = [],
  onDrawingClick,
  // Spray marking props
  isSprayMarking = false,
  sprayStartPoint = null,
  sprayEndPoint = null,
  onSprayClick,
  highlightedSprayRecordId = null,
  onSprayRecordClick,
  // Optional callback used by the cold-offline fallback to send the user
  // to the Sites tab when Google Maps JS can't load. Passed from App.jsx.
  onShowSitesTab,
  // Which tab the user is currently on ('map' | 'sites' | 'forms' |
  // 'admin'). Used by the auto-reload effect below to defer the page
  // refresh while the user is on a non-map tab — otherwise an
  // offline→online transition mid-form would wipe their lease sheet
  // / T&M ticket draft.
  activeTab = 'map',
}) {
  const mapRef = useRef(null);
  const lastFittedBoundsKey = useRef('');
  const hasInitiallyFitted = useRef(false);
  const markerInstancesRef = useRef(new Map());
  const [popupSite, setPopupSite] = useState(null);
  const [popupPipeline, setPopupPipeline] = useState(null);
  const lastZoomTarget = useRef(null);
  const lastZoomTime = useRef(0);
  const followModeZoomRef = useRef(null); // Store zoom level when entering follow mode
  
  // Double-tap hold zoom gesture refs
  const lastTapTimeRef = useRef(0);
  const isZoomGestureActiveRef = useRef(false);
  const zoomStartYRef = useRef(0);
  const zoomStartLevelRef = useRef(11);
  const gestureContainerRef = useRef(null);
  const lastZoomUpdateRef = useRef(0);
  const lastZoomValueRef = useRef(11);
  const isFollowModeRef = useRef(false);

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'pineview-google-map',
    googleMapsApiKey: apiKey,
  });

  // ── Auto-reload when network returns while we're in the fallback ──────
  // `useJsApiLoader` caches the rejected Maps-script promise at module
  // scope, so once it fails (cold-start with no network) it will NEVER
  // retry — even after `online` fires. A React remount doesn't help; only
  // a fresh page load does. The SW serves index.html + the JS bundle from
  // cache, so the reload itself is fast and offline-safe.
  //
  // We strictly gate the reload on a true offline → online TRANSITION
  // (tracked via `prevIsOnlineRef`), not just "in fallback while online".
  // On flaky connections like Starlink the OS often keeps reporting
  // `navigator.onLine === true` while individual fetches (like the Maps
  // script) still fail with packet loss. Firing on `loadError` alone
  // produced an infinite splash → fallback → reload cycle: each reload
  // re-failed the Maps fetch, set `loadError`, fired this effect again,
  // and so on. Gating on a real online-event transition keeps the
  // fallback card parked when the network is just lossy, while still
  // auto-recovering when the worker genuinely goes offline → online.
  //
  // The 4 s settle window gives the browser's `online` event time to
  // stabilise (some browsers fire it before the network is actually
  // usable, and Starlink commonly drops back offline within a second
  // or two of "returning"). Any offline blip during the window re-runs
  // the effect and clears the timer below, so the reload only fires
  // after 4 s of *continuous* online.
  //
  // Critically, the reload is ALSO gated on `activeTab === 'map'`. If
  // the worker tapped "Browse sites" out of the offline fallback and
  // started filling a herbicide lease sheet on the Forms tab, the
  // online transition sets `reloadPending` but does NOT fire the
  // refresh — that would wipe their in-progress draft. The reload
  // waits silently until they navigate back to the Map tab (form
  // submitted, or just returning to look at pins), at which point the
  // 4 s countdown starts. Switching back to a non-map tab during the
  // countdown cancels the pending refresh.
  const wasInFallbackRef = useRef(false);
  const prevIsOnlineRef = useRef(isOnline);
  const [reloadPending, setReloadPending] = useState(false);
  const [autoReloading, setAutoReloading] = useState(false);

  useEffect(() => {
    if (loadError || (!isLoaded && !isOnline)) {
      wasInFallbackRef.current = true;
    }
  }, [loadError, isLoaded, isOnline]);

  // Detector: watches isOnline / loadError / isLoaded and flips
  // `reloadPending` when a true offline → online transition happens
  // while we're showing the fallback. Doesn't touch the timer or
  // `activeTab` — that's the scheduler effect below.
  useEffect(() => {
    const wasOffline = prevIsOnlineRef.current === false;
    prevIsOnlineRef.current = isOnline;

    if (!isOnline) {
      // Going offline (or staying offline) cancels any pending reload.
      setReloadPending(false);
      return;
    }
    if (!wasInFallbackRef.current) return;
    if (!loadError && isLoaded) {
      // Already recovered without a reload (extremely rare given
      // useJsApiLoader's caching, but defensive).
      wasInFallbackRef.current = false;
      setReloadPending(false);
      return;
    }

    // Strict offline → online transition gate. If we were already online
    // when this effect ran (e.g. `loadError` flipped while the OS still
    // reported a connection), do nothing — the worker can pull-to-refresh
    // manually or tap "Browse sites".
    if (!wasOffline) return;

    setReloadPending(true);
  }, [isOnline, loadError, isLoaded]);

  // Scheduler: only fires the actual page refresh when `reloadPending`
  // AND the user is currently on the Map tab. Re-runs on activeTab
  // changes, so a worker who finishes a form on the Forms tab and
  // navigates back to the map sees the 4 s countdown then. The
  // cleanup function clears the timer if either flag flips, so a
  // mid-countdown tab change cancels the refresh.
  useEffect(() => {
    if (!reloadPending) {
      setAutoReloading(false);
      return;
    }
    if (activeTab !== 'map') {
      // Pending but on Forms / Sites / Admin — defer silently. The
      // fallback card isn't visible while the side panel is open
      // anyway, so showing a "Reloading map…" banner here would just
      // confuse the user.
      setAutoReloading(false);
      return;
    }

    setAutoReloading(true);
    const t = setTimeout(() => {
      if (window.navigator.onLine) {
        window.location.reload();
      } else {
        // Online flickered back off during the countdown — bail and
        // let the detector effect re-arm us when the network settles.
        setAutoReloading(false);
        setReloadPending(false);
      }
    }, 4000);
    return () => clearTimeout(t);
  }, [reloadPending, activeTab]);

  // ── Boot splash hand-off ──────────────────────────────────────────────
  // The HTML splash (#pv-splash, defined in index.html) is intentionally
  // kept visible past React-mount. We dismiss it here, once MapView has
  // reached a "terminal" render — either the real map is loaded, the
  // Maps script errored, or we're about to show the friendly offline
  // fallback card. Hiding earlier (on main.jsx mount) caused the user
  // to see "Loading map…" / fallback-card intermediate states flashing
  // between the fading splash and the first map paint.
  //
  // We also enforce a *minimum* splash-visible duration. On a warm
  // service-worker cache with fast internet the map can be fully loaded
  // in ~200 ms, which makes the splash vanish almost instantly and the
  // transition feels abrupt / busy. Holding the splash for at least
  // MIN_SPLASH_MS since page-load origin (performance.now() is zero at
  // nav start) guarantees a steady Pineview-logo moment every time,
  // regardless of connection speed. Anything else that would otherwise
  // render during that window (intermediate "Loading map…" text, a
  // brief offline-fallback flash if `isOnline` is momentarily false on
  // cold start) paints silently behind the splash's z-index: 9999 and
  // is never visible.
  //
  // The 15 s safety timer in index.html still forces a dismiss if this
  // effect never reaches a terminal state for some reason.
  const MIN_SPLASH_MS = 1500;
  useEffect(() => {
    const reachedTerminalMapState =
      isLoaded ||
      Boolean(loadError) ||
      (!isLoaded && !isOnline); // mirrors the fallback-card branch below
    if (!reachedTerminalMapState) return;
    const hide = () => {
      if (typeof window !== 'undefined' && typeof window.__pineviewHideSplash === 'function') {
        window.__pineviewHideSplash();
      }
    };
    const elapsed = typeof performance !== 'undefined' ? performance.now() : MIN_SPLASH_MS;
    const waitMs = Math.max(0, MIN_SPLASH_MS - elapsed);
    if (waitMs === 0) {
      hide();
      return;
    }
    const t = setTimeout(hide, waitMs);
    return () => clearTimeout(t);
  }, [isLoaded, loadError, isOnline]);

  const siteBoundsKey = useMemo(
    () => sites.map((s) => `${s.id ?? s.cacheId}:${s.latitude}:${s.longitude}`).join('|'),
    [sites]
  );

  useEffect(() => {
    if (!popupSite) return;
    const key = String(popupSite.id ?? popupSite.cacheId);
    const stillVisible = sites.some((site) => String(site.id ?? site.cacheId) === key);
    if (!stillVisible) setPopupSite(null);
  }, [popupSite, sites]);

  useEffect(() => {
    if (!isLoaded) return;
    const currentKeys = new Set(
      sites.map((s) => `${markerRevision}-${s.id || s.cacheId}`)
    );
    for (const [k, m] of Array.from(markerInstancesRef.current.entries())) {
      if (!currentKeys.has(k)) {
        try { m.setMap(null); } catch { /* ignore */ }
        markerInstancesRef.current.delete(k);
      }
    }
  }, [sites, markerRevision, isLoaded]);

  const userLocationIcon = useMemo(() => {
    if (!isLoaded || !userLocation) return null;
    return {
      path: window.google.maps.SymbolPath.CIRCLE,
      scale: 6,
      fillColor: '#3b82f6',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 2,
    };
  }, [isLoaded, userLocation]);

  const pickedLocationIcon = useMemo(() => {
    if (!isLoaded || !pickedLocation) return null;
    return {
      path: window.google.maps.SymbolPath.CIRCLE,
      scale: 9,
      fillColor: '#60a5fa',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 2,
    };
  }, [isLoaded, pickedLocation?.latitude, pickedLocation?.longitude]);

  const center = useMemo(() => defaultCenter, []);

  useEffect(() => {
    if (!isLoaded || !mapRef.current || !sites.length || !siteBoundsKey) return;
    // Skip fitBounds - users control their own zoom level
    // Center remains at Fort St. John on load
    hasInitiallyFitted.current = true;
  }, [isLoaded, siteBoundsKey, sites]);

  // Tracks the last logical zoomToSite we applied (keyed by its _ts) so that
  // detailOpen toggles or stale zoomToSite references don't re-issue setZoom(15)
  // and stomp the user's current zoom level.
  const lastZoomTsRef = useRef(0);

  useEffect(() => {
    if (!isLoaded || !mapRef.current || !zoomToSite) return;

    const isPhone = isPhoneDevice();

    // PC/iPad sites list click - center only, no zoom change
    if (zoomToSite._centerOnly) {
      mapRef.current.panTo({ lat: zoomToSite.latitude, lng: zoomToSite.longitude });
      return;
    }

    // Follow mode (user location tracking) - always center, regardless of device, no zoom change
    if (zoomToSite._isFollowMode) {
      isFollowModeRef.current = true;
      mapRef.current.panTo({ lat: zoomToSite.latitude, lng: zoomToSite.longitude });
      return;
    }

    // Pin taps on PC/iPad/tablet should stay put
    if (!isPhone) return;

    // Phone pin-open: pan with pixel-accurate offset when a detail sheet is open so
    // the pin ends up centered in the visible map area above the card.
    const target = detailOpen
      ? offsetLatLngByPixels(
          mapRef.current,
          zoomToSite.latitude,
          zoomToSite.longitude,
          0,
          getDetailOffsetPx()
        )
      : { lat: zoomToSite.latitude, lng: zoomToSite.longitude };
    mapRef.current.panTo(target);

    // Only force zoom when a new logical target arrives (new _ts). detailOpen
    // toggles or re-renders with the same zoomToSite must not reset the zoom.
    const ts = zoomToSite._ts || 0;
    if (ts && ts !== lastZoomTsRef.current) {
      lastZoomTsRef.current = ts;
      mapRef.current.setZoom(15);
    }
  }, [isLoaded, zoomToSite, detailOpen]);

  // Re-apply the offset when the detail sheet toggles without a fresh zoomToSite
  // (e.g. closing the sheet to recenter, or opening the same pin twice in a row).
  const prevDetailOpenRef = useRef(detailOpen);

  useEffect(() => {
    if (!isLoaded || !mapRef.current) {
      prevDetailOpenRef.current = detailOpen;
      return;
    }
    if (!isPhoneDevice()) {
      prevDetailOpenRef.current = detailOpen;
      return;
    }
    if (detailOpen === prevDetailOpenRef.current) return;

    const prev = prevDetailOpenRef.current;
    prevDetailOpenRef.current = detailOpen;

    // Pipeline detail positioning is handled by fitBounds in App.jsx; this
    // effect only handles the site-pin case.
    if (!selectedSite) return;

    if (detailOpen && !prev) {
      const shifted = offsetLatLngByPixels(
        mapRef.current,
        selectedSite.latitude,
        selectedSite.longitude,
        0,
        getDetailOffsetPx()
      );
      mapRef.current.panTo(shifted);
    } else if (!detailOpen && prev) {
      mapRef.current.panTo({
        lat: selectedSite.latitude,
        lng: selectedSite.longitude,
      });
    }
  }, [isLoaded, detailOpen, selectedSite]);

  if (!apiKey) {
    return (
      <div className="map-fallback">
        <div>
          <h3>Google Maps key required</h3>
          <p>Set VITE_GOOGLE_MAPS_API_KEY in frontend/.env</p>
        </div>
      </div>
    );
  }

  // Cold-offline fallback. Three distinct states funnel into one friendly
  // card so the worker never sees the raw "Google Maps JavaScript API
  // could not load" error message:
  //
  //   1. `loadError` set + offline   → script fetch failed because no
  //      network. The most common case (worker re-opens the PWA in the
  //      field with cell service dead).
  //   2. `loadError` set + online    → script blocked for some other
  //      reason (ad-blocker, bad API key, transient CDN failure). We
  //      still surface the underlying message so it's debuggable, just
  //      inside the friendly shell.
  //   3. `!isLoaded` + offline       → cold-start with no network. The
  //      script tag is still pending but will never resolve. Showing
  //      "Loading map…" forever is worse UX than just admitting we're
  //      offline.
  //
  // Online + still loading (legit loading state) keeps the original
  // "Loading map…" screen below.
  if (loadError || (!isLoaded && !isOnline)) {
    const sitesCount = sites?.length || 0;
    const pipelinesCount = pipelines?.length || 0;
    const isOfflineCase = !isOnline;
    return (
      <div className="map-fallback map-fallback-offline">
        <div className="map-fallback-card">
          <div className="map-fallback-icon" aria-hidden="true">📍</div>
          <h3>
            {autoReloading
              ? 'Network restored'
              : isOfflineCase
                ? 'Map unavailable offline'
                : "Map couldn't load"}
          </h3>
          <p>
            {autoReloading
              ? 'Reloading the map now…'
              : isOfflineCase
                ? "You're offline, so Google Maps can't load — but your cached data is still here."
                : 'Google Maps couldn\u2019t load. Your cached data is still available below.'}
          </p>
          {/* While auto-reloading, replace the cached-counts pill + CTA
              with a spinning indicator. The CTA would race the reload
              and a tap mid-animation could route the user to Sites just
              before the page refreshes — confusing. */}
          {autoReloading ? (
            <div className="map-fallback-reload" role="status" aria-live="polite">
              <span className="map-fallback-reload-spin" aria-hidden="true">↻</span>
              Reloading map…
            </div>
          ) : (
            <>
              {(sitesCount > 0 || pipelinesCount > 0) ? (
                <p className="map-fallback-meta">
                  <strong>{sitesCount}</strong> {sitesCount === 1 ? 'site' : 'sites'}
                  {' and '}
                  <strong>{pipelinesCount}</strong> {pipelinesCount === 1 ? 'pipeline' : 'pipelines'}
                  {' cached locally.'}
                </p>
              ) : null}
              {onShowSitesTab ? (
                <button
                  type="button"
                  className="map-fallback-cta"
                  onClick={onShowSitesTab}
                >
                  Browse sites
                </button>
              ) : null}
              {/* Surface the technical error only when it's NOT a plain
                  offline case (no point telling someone with no signal
                  that their script tag failed — they already know). */}
              {loadError && isOnline ? (
                <p className="map-fallback-detail">{loadError.message}</p>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  }

  if (!isLoaded) {
    return <div className="map-fallback"><div><h3>Loading map…</h3></div></div>;
  }

  // Double-tap hold zoom gesture handlers
  const handleTouchStart = (e) => {
    // Only handle single touch (ignore multi-touch pinch)
    if (e.touches.length !== 1) return;
    
    const now = Date.now();
    const timeSinceLastTap = now - lastTapTimeRef.current;
    
    // Check if this is a double-tap (within 300ms)
    if (timeSinceLastTap < 300) {
      // Double-tap detected - enter zoom gesture mode
      isZoomGestureActiveRef.current = true;
      zoomStartYRef.current = e.touches[0].clientY;
      if (mapRef.current) {
        zoomStartLevelRef.current = mapRef.current.getZoom() || 11;
        // Completely disable map interactions during our gesture
        mapRef.current.setOptions({ 
          gestureHandling: 'none',
          draggable: false,
          scrollwheel: false,
          disableDoubleClickZoom: true,
          keyboardShortcuts: false
        });
      }
      e.preventDefault();
      e.stopPropagation();
    } else {
      // Single tap - just record timestamp
      lastTapTimeRef.current = now;
    }
  };

  const handleTouchMove = (e) => {
    // Only handle if zoom gesture is active and single touch
    if (!isZoomGestureActiveRef.current || !mapRef.current || e.touches.length !== 1) return;
    
    const now = Date.now();
    // Throttle zoom updates to every 50ms max for smooth performance
    if (now - lastZoomUpdateRef.current < 50) return;
    lastZoomUpdateRef.current = now;
    
    const currentY = e.touches[0].clientY;
    const deltaY = zoomStartYRef.current - currentY; // Positive = up (zoom in), negative = down (zoom out)
    
    // Smooth continuous zoom - every 60px = 1 zoom level for controlled zooming
    const zoomChange = deltaY / 60;
    const newZoom = Math.max(1, Math.min(20, zoomStartLevelRef.current + zoomChange));
    
    // Only update if zoom actually changed (avoid redundant renders)
    if (newZoom !== lastZoomValueRef.current) {
      lastZoomValueRef.current = newZoom;
      mapRef.current.setZoom(newZoom);
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const handleTouchEnd = (e) => {
    if (isZoomGestureActiveRef.current) {
      isZoomGestureActiveRef.current = false;
      lastTapTimeRef.current = 0; // Reset tap timer
      
      // Force complete map state reset to clear any stored gesture momentum
      if (mapRef.current) {
        // Store current center and zoom
        const currentCenter = mapRef.current.getCenter();
        const currentZoom = mapRef.current.getZoom();
        
        // Completely disable the map
        mapRef.current.setOptions({ 
          gestureHandling: 'none',
          draggable: false,
          scrollwheel: false,
          disableDoubleClickZoom: true,
          keyboardShortcuts: false
        });
        
        // Force re-render to clear internal state
        setTimeout(() => {
          if (mapRef.current) {
            // Re-enable with same center/zoom to ensure no momentum
            mapRef.current.setOptions({ 
              gestureHandling: 'greedy',
              draggable: true,
              scrollwheel: true,
              disableDoubleClickZoom: false,
              keyboardShortcuts: true
            });
            
            // Force set center and zoom again to clear any residual state
            mapRef.current.setCenter(currentCenter);
            mapRef.current.setZoom(currentZoom);
          }
        }, 50);
      }
      
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <div className="map-shell" ref={gestureContainerRef}>
      <GoogleMap
        onLoad={(map) => { 
          mapRef.current = map;
          
          // Set up pan detection - don't disable follow mode on pan, let user manually toggle
          // const handleDragStart = () => {
          //   if (isFollowModeRef.current && onUserPan) {
          //     isFollowModeRef.current = false;
          //     onUserPan();
          //   }
          // };
          
          // map.addListener('dragstart', handleDragStart);
          
          // Set up zoom gesture handlers on the map container (capture phase)
          const mapContainer = gestureContainerRef.current;
          if (mapContainer) {
            mapContainer.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
            mapContainer.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
            mapContainer.addEventListener('touchend', handleTouchEnd, { passive: false, capture: true });
            mapContainer.addEventListener('touchcancel', handleTouchEnd, { passive: false, capture: true });
          }
          
          // Store current zoom when entering follow mode
          if (onMapLoad && typeof onMapLoad === 'function') {
            onMapLoad(map);
          }
        }}
        onUnmount={() => {
          const mapContainer = gestureContainerRef.current;
          if (mapContainer) {
            mapContainer.removeEventListener('touchstart', handleTouchStart);
            mapContainer.removeEventListener('touchmove', handleTouchMove);
            mapContainer.removeEventListener('touchend', handleTouchEnd);
            mapContainer.removeEventListener('touchcancel', handleTouchEnd);
          }
        }}
        onClick={(event) => {
          if (isDrawingPipeline && onDrawingClick && event.latLng) {
            onDrawingClick([
              Number(event.latLng.lat().toFixed(6)),
              Number(event.latLng.lng().toFixed(6)),
            ]);
          } else if (isSprayMarking && onSprayClick && event.latLng) {
            onSprayClick({
              lat: Number(event.latLng.lat().toFixed(6)),
              lng: Number(event.latLng.lng().toFixed(6)),
            });
          } else if (isPickingLocation && onPickLocation && event.latLng) {
            onPickLocation({
              latitude: Number(event.latLng.lat().toFixed(6)),
              longitude: Number(event.latLng.lng().toFixed(6)),
            });
          } else {
            setPopupSite(null);
            setPopupPipeline(null);
            if (onMapClick) onMapClick();
          }
        }}
        mapContainerStyle={mapContainerStyle}
        center={center}
        zoom={11}
        options={{
          mapTypeId: 'hybrid',
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          rotateControl: false,
          zoomControl: false,
          clickableIcons: false,
          draggableCursor: (isPickingLocation || isDrawingPipeline || isSprayMarking) ? 'crosshair' : undefined,
          gestureHandling: 'greedy',
        }}
      >
        {userLocation ? (
          <Marker
            position={{ lat: userLocation.lat, lng: userLocation.lng }}
            icon={userLocationIcon || undefined}
            zIndex={1000}
          />
        ) : null}

        {pickedLocation ? (
          <Marker
            position={{ lat: pickedLocation.latitude, lng: pickedLocation.longitude }}
            icon={pickedLocationIcon || undefined}
          />
        ) : null}

        {/*
          OverlayView pre-warm. `@react-google-maps/api`'s OverlayView wraps
          `google.maps.OverlayView`, whose first-ever mount on a given map
          instance triggers Google's internal pane setup (CSS + MVCObject
          subscriptions). If the user's network drops between map ready
          and their first pin tap, that first-mount can fail silently and
          the popup never appears — but every subsequent mount is fine.
          We mount one zero-size, off-pane overlay eagerly so the first
          *user-visible* popup is never the first OverlayView in the tree.
          display:none keeps it out of the layout; pointer-events:none
          guarantees it can never intercept a tap. Anchored on the default
          center so it has a valid projection from the start.
        */}
        <OverlayView
          position={defaultCenter}
          mapPaneName={OverlayView.OVERLAY_LAYER}
        >
          <div
            aria-hidden="true"
            style={{ display: 'none', width: 0, height: 0, pointerEvents: 'none' }}
          />
        </OverlayView>

        {(() => { const pending = sites.filter((s) => s.approval_state === 'pending_review'); if (pending.length) console.log('[MAP-DBG] rendering', sites.length, 'markers,', pending.length, 'pending:', pending.map((s) => ({ id: s.id, cacheId: s.cacheId, approval_state: s.approval_state }))); return null; })()}
        {sites.map((site) => {
          const mKey = `${markerRevision}-${site.id || site.cacheId}`;
          return (
            <Marker
              key={mKey}
              position={{ lat: site.latitude, lng: site.longitude }}
              icon={buildMarkerIcon(site,
                (popupSite && String(popupSite.id ?? popupSite.cacheId) === String(site.id ?? site.cacheId)) ||
                (selectedSite && String(selectedSite.id ?? selectedSite.cacheId) === String(site.id ?? site.cacheId))
              )}
              onLoad={(m) => { markerInstancesRef.current.set(mKey, m); }}
              onUnmount={(m) => { try { m.setMap(null); } catch { /* ignore */ } markerInstancesRef.current.delete(mKey); }}
              onClick={() => { setPopupSite(site); setPopupPipeline(null); }}
            />
          );
        })}

        {/* Pipeline polylines */}
        {pipelines.map((pipeline) => {
          const isSelected = selectedPipeline && selectedPipeline.id === pipeline.id;
          const isSprayed = pipeline.status === 'sprayed';
          const isPending = pipeline.approval_state === 'pending_review';
          return (
            <Polyline
              key={`pipeline-${pipeline.id}`}
              path={pipeline.coordinates.map(([lat, lng]) => ({ lat, lng }))}
              options={{
                strokeColor: isPending ? '#f59e0b' : (isSprayed ? '#22c55e' : '#ef4444'),
                strokeOpacity: 0.7,
                strokeWeight: 3,
                clickable: true,
                zIndex: 1,
              }}
              onClick={(e) => {
                if (isSprayMarking && onSprayClick && e.latLng) {
                  onSprayClick({ lat: e.latLng.lat(), lng: e.latLng.lng() });
                  return;
                }
                // Calculate click position for popup
                const clickPos = e.latLng ? { lat: e.latLng.lat(), lng: e.latLng.lng() } : null;
                setPopupPipeline({ ...pipeline, _popupLat: clickPos?.lat, _popupLng: clickPos?.lng });
                setPopupSite(null);
              }}
            />
          );
        })}

        {/* Spray record overlays (green sections on pipelines) */}
        {pipelines.map((pipeline) =>
          (pipeline.spray_records || []).map((record) => {
            const coords = pipeline.coordinates;
            if (!coords || coords.length < 2) return null;
            // Extract the interpolated sub-path for this spray record
            const subPath = getInterpolatedSubPath(coords, record.start_fraction, record.end_fraction);
            if (subPath.length < 2) return null;
            const isHighlighted = highlightedSprayRecordId === record.id;
            return (
              <Polyline
                key={`spray-${record.id}`}
                path={subPath}
                options={{
                  strokeColor: isHighlighted ? '#eab308' : (record.is_avoided ? '#94a3b8' : '#22c55e'),
                  strokeOpacity: isHighlighted ? 1.0 : 0.9,
                  strokeWeight: isHighlighted ? 7 : 5,
                  zIndex: isHighlighted ? 20 : 10,
                  clickable: true,
                }}
                onClick={(e) => {
                  if (isSprayMarking && onSprayClick && e.latLng) {
                    onSprayClick({ lat: e.latLng.lat(), lng: e.latLng.lng() });
                    return;
                  }
                  const clickPos = e.latLng ? { lat: e.latLng.lat(), lng: e.latLng.lng() } : null;
                  setPopupPipeline({ ...pipeline, _popupLat: clickPos?.lat, _popupLng: clickPos?.lng });
                  setPopupSite(null);
                }}
              />
            );
          })
        )}

        {/* Drawing mode polyline */}
        {isDrawingPipeline && drawingPoints.length >= 2 && (
          <Polyline
            path={drawingPoints.map((p) => ({ lat: p[0], lng: p[1] }))}
            options={{
              strokeColor: '#60a5fa',
              strokeOpacity: 1.0,
              strokeWeight: 4,
              clickable: false,
              zIndex: 20,
            }}
          />
        )}

        {/* Drawing mode point markers */}
        {isDrawingPipeline && drawingPoints.map((p, idx) => (
          <Marker
            key={`draw-pt-${idx}`}
            position={{ lat: p[0], lng: p[1] }}
            icon={{
              path: window.google.maps.SymbolPath.CIRCLE,
              scale: idx === 0 ? 7 : 5,
              fillColor: idx === 0 ? '#3b82f6' : '#60a5fa',
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 2,
            }}
            clickable={false}
          />
        ))}

        {/* Spray marking start point */}
        {isSprayMarking && sprayStartPoint && (
          <Marker
            position={{ lat: sprayStartPoint.lat, lng: sprayStartPoint.lng }}
            icon={{
              path: window.google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: '#22c55e',
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 2,
            }}
            clickable={false}
            zIndex={100}
          />
        )}

        {/* Spray marking end point */}
        {isSprayMarking && sprayEndPoint && (
          <Marker
            position={{ lat: sprayEndPoint.lat, lng: sprayEndPoint.lng }}
            icon={{
              path: window.google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: '#ef4444',
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 2,
            }}
            clickable={false}
            zIndex={100}
          />
        )}

        {/* Spray marking preview line between start and end points */}
        {isSprayMarking && selectedPipeline && sprayStartPoint && (
          <SprayPreviewLine
            pipeline={selectedPipeline}
            startPoint={sprayStartPoint}
            endPoint={sprayEndPoint}
          />
        )}

        {popupPipeline ? (
          <OverlayView
            position={{ lat: popupPipeline._popupLat || popupPipeline.coordinates?.[0]?.[0] || 0, lng: popupPipeline._popupLng || popupPipeline.coordinates?.[0]?.[1] || 0 }}
            mapPaneName={OverlayView.FLOAT_PANE}
            getPixelPositionOffset={(w, h) => ({ x: -(w / 2), y: -(h + 12) })}
          >
            <div
              style={{
                background: '#0f172a',
                color: '#e5eefb',
                padding: '10px 14px',
                borderRadius: '10px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                minWidth: '180px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                whiteSpace: 'nowrap',
                position: 'relative',
                WebkitTapHighlightColor: 'transparent',
              }}
              onClick={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>{popupPipeline.name || 'Unnamed pipeline'}</div>
                <div style={{ fontSize: '0.75rem', color: '#9ab1d6', marginTop: '2px' }}>
                  {[popupPipeline.client, popupPipeline.area].filter(Boolean).join(' • ') || 'Pipeline'}
                </div>
              </div>
              <button
                type="button"
                onTouchStart={(e) => { e.stopPropagation(); }}
                onTouchEnd={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const pl = popupPipeline;
                  setPopupPipeline(null);
                  if (onSelectPipeline) onSelectPipeline(pl);
                }}
                onClick={(e) => {
                  if (e.detail === 0) return;
                  e.stopPropagation();
                  e.preventDefault();
                  const pl = popupPipeline;
                  setPopupPipeline(null);
                  if (onSelectPipeline) onSelectPipeline(pl);
                }}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  border: '2px solid #3b82f6',
                  background: 'transparent',
                  color: '#3b82f6',
                  fontWeight: 700,
                  fontSize: '1rem',
                  display: 'grid',
                  placeItems: 'center',
                  cursor: 'pointer',
                  flexShrink: 0,
                  WebkitTapHighlightColor: 'transparent',
                  touchAction: 'manipulation',
                }}
              >
                i
              </button>
            </div>
          </OverlayView>
        ) : null}

        {popupSite ? (
          <OverlayView
            position={{ lat: popupSite.latitude, lng: popupSite.longitude }}
            mapPaneName={OverlayView.FLOAT_PANE}
            getPixelPositionOffset={(w, h) => ({ x: -(w / 2), y: -(h + 28) })}
          >
            <div
              style={{
                background: '#0f172a',
                color: '#e5eefb',
                padding: '10px 14px',
                borderRadius: '10px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                minWidth: '180px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                whiteSpace: 'nowrap',
                position: 'relative',
                WebkitTapHighlightColor: 'transparent',
              }}
              onClick={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>{popupSite.lsd || 'Unnamed'}</div>
                <div style={{ fontSize: '0.75rem', color: '#9ab1d6', marginTop: '2px' }}>
                  {popupSite.client || pinTypeLabel(popupSite.pin_type)}
                </div>
              </div>
              <button
                type="button"
                onTouchStart={(e) => {
                  e.stopPropagation();
                }}
                onTouchEnd={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const site = popupSite;
                  setPopupSite(null);
                  if (onOpenDetail) onOpenDetail(site);
                  else if (onSelectSite) onSelectSite(site);
                }}
                onClick={(e) => {
                  // Only handle click if not a touch device (desktop)
                  if (e.detail === 0) return; // Ignore synthetic clicks from touch
                  e.stopPropagation();
                  e.preventDefault();
                  const site = popupSite;
                  setPopupSite(null);
                  if (onOpenDetail) onOpenDetail(site);
                  else if (onSelectSite) onSelectSite(site);
                }}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  border: '2px solid #3b82f6',
                  background: 'transparent',
                  color: '#3b82f6',
                  fontWeight: 700,
                  fontSize: '1rem',
                  display: 'grid',
                  placeItems: 'center',
                  cursor: 'pointer',
                  flexShrink: 0,
                  WebkitTapHighlightColor: 'transparent',
                  touchAction: 'manipulation',
                }}
              >
                i
              </button>
            </div>
          </OverlayView>
        ) : null}
      </GoogleMap>
    </div>
  );
}
