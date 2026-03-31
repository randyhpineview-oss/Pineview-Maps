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
}) {
  const mapRef = useRef(null);
  const lastFittedBoundsKey = useRef('');
  const [popupSite, setPopupSite] = useState(null);
  const lastZoomTarget = useRef(null);
  const lastZoomTime = useRef(0);

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'pineview-google-map',
    googleMapsApiKey: apiKey,
  });

  const firstSite = sites[0] || null;
  const firstSiteKey = firstSite ? String(firstSite.id ?? firstSite.cacheId) : '';
  const siteBoundsKey = useMemo(
    () => sites.map((s) => `${s.id ?? s.cacheId}:${s.latitude}:${s.longitude}`).join('|'),
    [sites]
  );

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

  const center = useMemo(() => {
    if (firstSite) return { lat: firstSite.latitude, lng: firstSite.longitude };
    return defaultCenter;
  }, [firstSite?.latitude, firstSite?.longitude, firstSiteKey]);

  useEffect(() => {
    if (!isLoaded || !mapRef.current || !sites.length || !siteBoundsKey) return;
    // Skip fitBounds if we recently zoomed to a specific site (prevents zoom-out after approve)
    if (Date.now() - lastZoomTime.current < 500) return;
    if (lastFittedBoundsKey.current === siteBoundsKey) return;
    lastFittedBoundsKey.current = siteBoundsKey;

    const bounds = new window.google.maps.LatLngBounds();
    sites.forEach((s) => bounds.extend({ lat: s.latitude, lng: s.longitude }));
    if (sites.length === 1) {
      mapRef.current.panTo(bounds.getCenter());
      mapRef.current.setZoom(13);
      return;
    }
    mapRef.current.fitBounds(bounds, 64);
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
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          rotateControl: false,
          zoomControl: false,
          clickableIcons: false,
          draggableCursor: isPickingLocation ? 'crosshair' : undefined,
        }}
      >
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
