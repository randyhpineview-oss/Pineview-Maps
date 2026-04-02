import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, Marker, OverlayView, useJsApiLoader } from '@react-google-maps/api';

import { buildMarkerIcon, pinTypeLabel } from '../lib/mapUtils';

const mapContainerStyle = { width: '100%', height: '100%' };

// Fort St. John, BC coordinates
const defaultCenter = { lat: 56.2498, lng: -120.8464 };

export default function MapView({
  sites,
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
}) {
  const mapRef = useRef(null);
  const lastFittedBoundsKey = useRef('');
  const hasInitiallyFitted = useRef(false);
  const [popupSite, setPopupSite] = useState(null);
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

  const siteBoundsKey = useMemo(
    () => sites.map((s) => `${s.id ?? s.cacheId}:${s.latitude}:${s.longitude}`).join('|'),
    [sites]
  );

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

  useEffect(() => {
    if (!isLoaded || !mapRef.current || !zoomToSite) return;
    
    // Check if mobile phone
    const isPhone = (window.innerWidth <= 480 || window.innerHeight <= 600) && 
                    /Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    // Handle PC/iPad sites list click - center only, no zoom
    if (zoomToSite._centerOnly) {
      mapRef.current.panTo({ lat: zoomToSite.latitude, lng: zoomToSite.longitude });
      return;
    }
    
    // Always center for follow mode (user location tracking) regardless of device
    if (zoomToSite._isFollowMode) {
      isFollowModeRef.current = true;
      mapRef.current.panTo({ lat: zoomToSite.latitude, lng: zoomToSite.longitude });
      // Don't force zoom level - allow user to zoom in/out while following
      return;
    }
    
    // Only zoom/center on phones - PC/iPad/tablet pin taps should stay put
    if (!isPhone) {
      return;
    }
    
    // On phones, offset center to account for bottom panel
    const targetLat = zoomToSite.latitude;
    const targetLng = zoomToSite.longitude;
    
    if (detailOpen) {
      // Center pin in visible map area (above slide-up panel)
      const visibleHeight = window.innerHeight * 0.6; // 60% of screen height
      const centerLat = targetLat + (visibleHeight / 111000); // Move center north so pin appears in visible area
      mapRef.current.panTo({ lat: centerLat, lng: targetLng });
    } else {
      // No detail panel - center exactly
      mapRef.current.panTo({ lat: targetLat, lng: targetLng });
    }
    
    // Only set zoom if this is not a follow mode update
    if (!zoomToSite._isFollowMode) {
      mapRef.current.setZoom(15);
    }
  }, [isLoaded, zoomToSite, detailOpen]);

  // Simplified: whenever detail panel is open on mobile, center pin in visible area
  const prevDetailOpen = useRef(detailOpen);
  const originalSitePosition = useRef(null);
  
  useEffect(() => {
    console.log('[DEBUG] Detail panel effect:', { detailOpen, prevDetailOpen: prevDetailOpen.current, selectedSite: selectedSite?.id });
    
    if (!isLoaded || !mapRef.current || !selectedSite) return;
    
    const isPhone = (window.innerWidth <= 480 || window.innerHeight <= 600) && 
                    /Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    console.log('[DEBUG] Phone check:', { isPhone, innerHeight: window.innerHeight, innerWidth: window.innerWidth });
    
    // If detail panel just opened, store position and apply offset on mobile
    if (detailOpen && !prevDetailOpen.current) {
      console.log('[DEBUG] Panel just opened, applying offset');
      originalSitePosition.current = {
        lat: selectedSite.latitude,
        lng: selectedSite.longitude
      };
      
      if (isPhone) {
        const visibleHeight = window.innerHeight * 0.45;
        const centerLat = selectedSite.latitude - (visibleHeight / 111000);
        console.log('[DEBUG] Applying mobile offset:', { originalLat: selectedSite.latitude, centerLat });
        mapRef.current.panTo({ lat: centerLat, lng: selectedSite.longitude });
      }
    }
    
    // If detail panel just closed, re-center to original position
    if (!detailOpen && prevDetailOpen.current && originalSitePosition.current) {
      console.log('[DEBUG] Panel just closed, re-centering');
      mapRef.current.panTo({ 
        lat: originalSitePosition.current.lat, 
        lng: originalSitePosition.current.lng 
      });
      originalSitePosition.current = null;
    }
    
    prevDetailOpen.current = detailOpen;
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

  if (loadError) {
    return <div className="map-fallback"><div><h3>Map failed to load</h3><p>{loadError.message}</p></div></div>;
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
          if (isPickingLocation && onPickLocation && event.latLng) {
            onPickLocation({
              latitude: Number(event.latLng.lat().toFixed(6)),
              longitude: Number(event.latLng.lng().toFixed(6)),
            });
          } else {
            setPopupSite(null);
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
          draggableCursor: isPickingLocation ? 'crosshair' : undefined,
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

        {sites.map((site) => (
          <Marker
            key={`${site.id || site.cacheId}-${site.approval_state || ''}`}
            position={{ lat: site.latitude, lng: site.longitude }}
            icon={buildMarkerIcon(site,
              (popupSite && String(popupSite.id ?? popupSite.cacheId) === String(site.id ?? site.cacheId)) ||
              (selectedSite && String(selectedSite.id ?? selectedSite.cacheId) === String(site.id ?? site.cacheId))
            )}
            onClick={() => setPopupSite(site)}
          />
        ))}

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
                  border: '2px solid #22c55e',
                  background: 'transparent',
                  color: '#22c55e',
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
