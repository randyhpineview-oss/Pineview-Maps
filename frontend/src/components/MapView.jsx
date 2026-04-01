import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, OverlayView, useJsApiLoader } from '@react-google-maps/api';

import { buildMarkerSvg, pinTypeLabel } from '../lib/mapUtils';

const mapContainerStyle = { width: '100%', height: '100%' };

// Google Maps libraries - static to prevent reloads
const GOOGLE_MAPS_LIBRARIES = ['marker'];

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
}) {
  const mapRef = useRef(null);
  const lastFittedBoundsKey = useRef('');
  const hasInitiallyFitted = useRef(false);
  const [popupSite, setPopupSite] = useState(null);
  const lastZoomTarget = useRef(null);
  const lastZoomTime = useRef(0);

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'pineview-google-map',
    googleMapsApiKey: apiKey,
    libraries: GOOGLE_MAPS_LIBRARIES,
  });

  const firstSite = sites[0] || null;
  const firstSiteKey = firstSite ? String(firstSite.id ?? firstSite.cacheId) : '';
  const siteBoundsKey = useMemo(
    () => sites.map((s) => `${s.id ?? s.cacheId}:${s.latitude}:${s.longitude}`).join('|'),
    [sites]
  );

  // Refs to track marker elements for cleanup
  const siteMarkersRef = useRef(new Map());
  const pickedMarkerRef = useRef(null);

  // Effect to render AdvancedMarkerElement for sites
  useEffect(() => {
    if (!isLoaded || !mapRef.current) return;
    
    const map = mapRef.current;
    const { AdvancedMarkerElement } = window.google.maps.marker;
    
    // Create or update site markers
    sites.forEach((site) => {
      const key = `${site.id || site.cacheId}`;
      const existingMarker = siteMarkersRef.current.get(key);
      
      const isSelected = (popupSite && String(popupSite.id ?? popupSite.cacheId) === String(site.id ?? site.cacheId)) ||
                        (selectedSite && String(selectedSite.id ?? selectedSite.cacheId) === String(site.id ?? site.cacheId));
      
      const iconSvg = buildMarkerSvg(site, isSelected);
      
      if (existingMarker) {
        // Update position if changed
        existingMarker.position = { lat: site.latitude, lng: site.longitude };
        // Update content if needed (rebuild the icon)
        existingMarker.content.innerHTML = iconSvg;
      } else {
        // Create new marker
        const marker = new AdvancedMarkerElement({
          position: { lat: site.latitude, lng: site.longitude },
          map: map,
          content: createMarkerElement(iconSvg),
        });
        
        marker.addEventListener('gmp-click', () => {
          setPopupSite(site);
        });
        
        siteMarkersRef.current.set(key, marker);
      }
    });
    
    // Remove markers for sites that no longer exist
    const currentSiteKeys = new Set(sites.map(s => `${s.id || s.cacheId}`));
    siteMarkersRef.current.forEach((marker, key) => {
      if (!currentSiteKeys.has(key)) {
        marker.map = null;
        siteMarkersRef.current.delete(key);
      }
    });
  }, [isLoaded, sites, popupSite, selectedSite]);

  // Effect to render AdvancedMarkerElement for picked location
  useEffect(() => {
    if (!isLoaded || !mapRef.current || !pickedLocation) return;
    
    const map = mapRef.current;
    const { AdvancedMarkerElement } = window.google.maps.marker;
    
    if (pickedMarkerRef.current) {
      pickedMarkerRef.current.position = { lat: pickedLocation.latitude, lng: pickedLocation.longitude };
    } else {
      const marker = new AdvancedMarkerElement({
        position: { lat: pickedLocation.latitude, lng: pickedLocation.longitude },
        map: map,
        content: createPickedLocationElement(),
      });
      pickedMarkerRef.current = marker;
    }
    
    return () => {
      if (pickedMarkerRef.current) {
        pickedMarkerRef.current.map = null;
        pickedMarkerRef.current = null;
      }
    };
  }, [isLoaded, pickedLocation]);

  const center = useMemo(() => {
    if (firstSite) return { lat: firstSite.latitude, lng: firstSite.longitude };
    return defaultCenter;
  }, [firstSite?.latitude, firstSite?.longitude, firstSiteKey]);

  // Helper function to create marker element
  function createMarkerElement(svgHtml) {
    const div = document.createElement('div');
    div.innerHTML = svgHtml;
    div.style.cursor = 'pointer';
    return div;
  }

  // Helper function to create picked location element
  function createPickedLocationElement() {
    const div = document.createElement('div');
    div.style.width = '18px';
    div.style.height = '18px';
    div.style.borderRadius = '50%';
    div.style.backgroundColor = '#60a5fa';
    div.style.border = '2px solid #ffffff';
    div.style.boxShadow = '0 0 4px rgba(0,0,0,0.3)';
    return div;
  }

  useEffect(() => {
    if (!isLoaded || !mapRef.current || !sites.length || !siteBoundsKey) return;
    // Skip fitBounds - users control their own zoom level
    // Only set initial center once if no sites were loaded before
    if (!hasInitiallyFitted.current && sites.length > 0) {
      hasInitiallyFitted.current = true;
      // Just center on first site, don't zoom out
      mapRef.current.panTo({ lat: sites[0].latitude, lng: sites[0].longitude });
    }
  }, [isLoaded, siteBoundsKey, sites]);

  useEffect(() => {
    if (!isLoaded || !mapRef.current || !zoomToSite) return;
    const key = zoomToSite._ts ? String(zoomToSite._ts) : String(zoomToSite.id ?? zoomToSite.cacheId);
    if (lastZoomTarget.current === key) return;
    lastZoomTarget.current = key;
    lastZoomTime.current = Date.now();
    mapRef.current.panTo({ lat: zoomToSite.latitude, lng: zoomToSite.longitude });
    mapRef.current.setZoom(15);
  }, [isLoaded, zoomToSite]);

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

  return (
    <div className="map-shell">
      <GoogleMap
        onLoad={(map) => { mapRef.current = map; }}
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
          mapId: 'pineview-maps',
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          rotateControl: false,
          zoomControl: false,
          clickableIcons: false,
          draggableCursor: isPickingLocation ? 'crosshair' : undefined,
        }}
      >
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
