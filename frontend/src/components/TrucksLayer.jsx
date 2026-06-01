import { useState, useEffect } from 'react';
import { Marker, OverlayView } from '@react-google-maps/api';

// Side-view pickup truck SVG. The body fills with `color`; everything
// else (wheels, window glint, stroke) stays constant so the truck reads
// as the SAME shape across the whole fleet, just colored differently.
//
// Width/height are intentionally larger than the LSD pin (~22x26) so a
// moving vehicle is easy to spot on a satellite view of a 160-acre lease
// alongside a bunch of stationary pins.
function truckSvg(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="32" viewBox="0 0 52 32">
    <!-- Ground Shadow -->
    <ellipse cx="26" cy="29" rx="22" ry="2.5" fill="rgba(0,0,0,0.35)"/>
    
    <!-- Truck Body (Silverado Crew Cab profile) -->
    <path d="M 2 20 
             L 2 13.5 
             L 16 13.5 
             L 18.5 7.8 
             L 33 7.8 
             L 38 13.5 
             L 47.5 13.5 
             L 48.5 14 
             L 48.5 19.5 
             L 47 20 
             L 45.5 20 
             A 4.8 4.8 0 0 0 36.5 20 
             L 16.5 20 
             A 4.8 4.8 0 0 0 7.5 20 
             Z" 
          fill="${color}" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>
          
    <!-- Black Fenders / Wheel Arches -->
    <path d="M 6.5 20 A 5.5 5.5 0 0 1 18.5 20" fill="none" stroke="#1e293b" stroke-width="1.8"/>
    <path d="M 35.5 20 A 5.5 5.5 0 0 1 47.5 20" fill="none" stroke="#1e293b" stroke-width="1.8"/>

    <!-- Crew Cab Windows (divided, dark tinted like photo) -->
    <path d="M 19 9 
             L 25 9 
             L 25 13 
             L 17.5 13 
             Z" 
          fill="#1f2937" fill-opacity="0.88" stroke="#0f172a" stroke-width="0.8"/>
    <path d="M 26 9 
             L 32.2 9 
             L 36.2 13 
             L 26 13 
             Z" 
          fill="#1f2937" fill-opacity="0.88" stroke="#0f172a" stroke-width="0.8"/>

    <!-- Aggressive Black Front Grille / Bumper -->
    <path d="M 46.5 13.5 L 48.5 14 L 48.5 18 L 47 19.5 L 45.5 19.5 Z" fill="#1e293b" stroke="#0f172a" stroke-width="1"/>
    <!-- Front C-clamp LED Headlight -->
    <path d="M 47.5 14.5 L 47.5 17 M 46.5 15.5 L 47.5 15.5" stroke="#ffffff" stroke-width="1.2"/>

    <!-- Silverado Hood Scoop Line -->
    <path d="M 39.5 13.5 L 43.5 13.5 L 42.5 12.5 Z" fill="#0f172a" fill-opacity="0.6"/>

    <!-- Big Black dual-arm towing mirrors (from the photo!) -->
    <path d="M 31.5 12 L 29 12 M 31.5 11 L 29 11" stroke="#0f172a" stroke-width="1.2"/>
    <rect x="28" y="9.5" width="2" height="4.5" rx="0.5" fill="#0f172a" stroke="#0f172a" stroke-width="0.5"/>

    <!-- Black Running Boards / Side Steps -->
    <rect x="17.5" y="20.5" width="18" height="1.2" rx="0.5" fill="#0f172a"/>

    <!-- Off-road Black Wheels (Rims + Tires) -->
    <!-- Rear Wheel -->
    <circle cx="12" cy="21.5" r="5" fill="#111827" stroke="#0f172a" stroke-width="1.5"/>
    <circle cx="12" cy="21.5" r="3.2" fill="#1f2937"/>
    <circle cx="12" cy="21.5" r="1.2" fill="#9ca3af"/>
    
    <!-- Front Wheel -->
    <circle cx="41.5" cy="21.5" r="5" fill="#111827" stroke="#0f172a" stroke-width="1.5"/>
    <circle cx="41.5" cy="21.5" r="3.2" fill="#1f2937"/>
    <circle cx="41.5" cy="21.5" r="1.2" fill="#9ca3af"/>
  </svg>`;
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`
    : '59, 130, 246';
}

function buildTruckIcon(colorHex, isSelected) {
  const svg = truckSvg(colorHex || '#1E88E5');
  // Bottom-center anchor so the truck sits ON its position instead of
  // hovering above it.
  // Selected truck is full size (64x40). Unselected is half size (32x20).
  const w = isSelected ? 64 : 32;
  const h = isSelected ? 40 : 20;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: window.google ? new window.google.maps.Size(w, h) : undefined,
    anchor: window.google ? new window.google.maps.Point(w / 2, h - (isSelected ? 5 : 2.5)) : undefined,
  };
}

// Human-friendly "last seen" delta. Same logic as DeviceAdmin's helper
// but inlined here so the popup doesn't import an admin component.
function relativeTime(iso) {
  if (!iso) return '—';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '—';
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Renders one Marker per active device plus a tooltip OverlayView for
 * the currently selected truck. Must be a child of `<GoogleMap>` (uses
 * Marker + OverlayView from @react-google-maps/api).
 *
 * Marker-key discipline (matching the iOS PWA stale-icon fix on Sites):
 * the key includes `color_hex` so an admin color change unmounts the
 * old marker and mounts a new one with the new icon. Position is NOT
 * in the key — @react-google-maps/api syncs the `position` prop fine
 * without a remount, and position changes every 15 min so remounting
 * each time would be wasteful + visually janky on iOS Safari.
 *
 * Props:
 *   - devices: array of DeviceRead from /api/devices (only `is_active`
 *              rows that have at least one ping pass the render filter)
 *   - visible: bool — when false, the entire layer is hidden (toggle
 *              from the layer panel). Defaults to true; the App-level
 *              toggle decides what to pass.
 */
export default function TrucksLayer({
  devices = [],
  visible = true,
  selectedDevice = null,
  onSelectDevice,
}) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  if (!visible) return null;

  // Filter out any device without a position yet. A freshly-registered
  // iPad with no pings doesn't render until OwnTracks lands its first
  // payload — putting it at lat 0 / lng 0 would slap a pin off the
  // coast of Africa, which has bitten approximately every map app ever.
  const renderable = devices.filter(
    (d) => d.is_active && Number.isFinite(d.last_lat) && Number.isFinite(d.last_lng),
  );

  // Resolve the popup target against the LATEST device row so a Realtime
  // update (new position, new color, etc.) keeps the popup in sync.
  // Without this, opening the popup snapshots the device and the popup
  // shows stale data until the user closes and reopens it.
  const activePopup = selectedDevice
    ? devices.find((d) => d.id === selectedDevice.id) || null
    : null;

  return (
    <>
      <style>{`
        @keyframes truckPulse {
          0% {
            transform: scale(0.5);
            opacity: 0.85;
          }
          100% {
            transform: scale(2.2);
            opacity: 0;
          }
        }
      `}</style>

      {renderable.map((device) => {
        const isSelected = selectedDevice && selectedDevice.id === device.id;
        // Key includes color_hex and selection status so a toggle triggers a clean
        // unmount/remount. Position updates apply via the `position`
        // prop without a remount.
        const mKey = `truck-${device.id}-${device.color_hex}-${isSelected ? 'selected' : 'normal'}`;
        return (
          <Marker
            key={mKey}
            position={{ lat: device.last_lat, lng: device.last_lng }}
            icon={buildTruckIcon(device.color_hex, isSelected)}
            // High zIndex so the truck floats above site pins — moving
            // vehicles are usually what an admin is actively watching.
            // If selected, float even higher.
            zIndex={isSelected ? 600 : 500}
            onClick={() => {
              if (onSelectDevice) onSelectDevice(device);
            }}
          />
        );
      })}

      {/* Render a pulsing circle for any truck active/seen in the last 15 minutes.
          If selected, the pulse is larger (60px) to match the enlarged truck icon.
          Otherwise, it is smaller (30px). */}
      {renderable.map((device) => {
        const isRecent = device.last_seen_at && (Date.now() - new Date(device.last_seen_at).getTime() < 15 * 60000);
        if (!isRecent) return null;
        const isSelected = selectedDevice && selectedDevice.id === device.id;
        const size = isSelected ? 60 : 30;
        const h = isSelected ? 40 : 20;
        const anchorOffset = isSelected ? 5 : 2.5;
        const xOffset = -(size / 2);
        // Mathematically center the pulsing circle on the middle of the truck icon,
        // compensating for the bottom-center anchor.
        const yOffset = -(size / 2) - (h / 2 - anchorOffset);
        return (
          <OverlayView
            key={`pulse-${device.id}`}
            position={{ lat: device.last_lat, lng: device.last_lng }}
            mapPaneName={OverlayView.OVERLAY_LAYER}
            getPixelPositionOffset={() => ({ x: 0, y: 0 })}
          >
            <div
              style={{
                position: 'absolute',
                left: `${xOffset}px`,
                top: `${yOffset}px`,
                width: `${size}px`,
                height: `${size}px`,
                borderRadius: '50%',
                background: `rgba(${hexToRgb(device.color_hex)}, 0.22)`,
                border: `2px solid ${device.color_hex}`,
                // High-contrast white halo + color glow makes dark colors pop on dark maps
                boxShadow: `0 0 6px rgba(${hexToRgb(device.color_hex)}, 0.8), 0 0 10px rgba(255, 255, 255, 0.5)`,
                animation: 'truckPulse 2.2s infinite ease-out',
                pointerEvents: 'none',
              }}
            />
          </OverlayView>
        );
      })}

      {activePopup ? (
        <OverlayView
          position={{ lat: activePopup.last_lat, lng: activePopup.last_lng }}
          mapPaneName={OverlayView.FLOAT_PANE}
          // Center horizontally, anchor above the truck so the tooltip
          // doesn't cover the marker the user just tapped.
          getPixelPositionOffset={(w, h) => ({ x: -(w / 2), y: -(h + 44) })}
        >
          <div
            style={{
              background: '#0f1c33',
              color: '#e5eefb',
              border: '1px solid rgba(143,182,255,0.2)',
              borderRadius: '0.5rem',
              padding: '0.6rem 0.8rem',
              minWidth: '10rem',
              maxWidth: '15rem',
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              fontSize: '0.85rem',
              lineHeight: 1.35,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: activePopup.color_hex,
                  border: '1px solid rgba(255,255,255,0.25)',
                  flexShrink: 0,
                }}
              />
              <strong style={{ flexGrow: 1, minWidth: 0 }}>{activePopup.label}</strong>
              <button
                type="button"
                aria-label="Close"
                onClick={() => {
                  if (onSelectDevice) onSelectDevice(null);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#9ab1d6',
                  cursor: 'pointer',
                  padding: '0 0.25rem',
                  fontSize: '1rem',
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
            <div style={{ marginTop: '0.4rem', color: '#9ab1d6', fontSize: '0.78rem' }}>
              {activePopup.assigned_user_name ? (
                <div>👤 {activePopup.assigned_user_name}</div>
              ) : (
                <div>👤 Unassigned</div>
              )}
              <div>🕒 {relativeTime(activePopup.last_seen_at)}</div>
              {activePopup.last_battery_pct != null ? (
                <div>🔋 {activePopup.last_battery_pct}%</div>
              ) : null}
              {activePopup.last_speed_kph != null && Number(activePopup.last_speed_kph) > 1 ? (
                <div>💨 {Math.round(Number(activePopup.last_speed_kph))} km/h</div>
              ) : null}
            </div>
          </div>
        </OverlayView>
      ) : null}
    </>
  );
}
