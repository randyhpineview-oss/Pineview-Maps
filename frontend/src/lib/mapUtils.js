export function statusLabel(status) {
  if (status === 'inspected') {
    return 'Inspected';
  }
  return 'Not inspected';
}

export function pinTypeLabel(pinType) {
  if (pinType === 'water') {
    return 'Water';
  }
  if (pinType === 'quad_access') {
    return 'Quad access';
  }
  if (pinType === 'reclaimed') {
    return 'Reclaimed';
  }
  return 'LSD';
}

export function isInfoOnlyPin(pinType) {
  return pinType === 'water' || pinType === 'quad_access';
}

export function formatDate(value) {
  if (!value) {
    return 'Not yet inspected';
  }
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function stroke(isSelected) {
  return isSelected ? '#00e5ff' : '#0f172a';
}

function strokeWidth(isSelected) {
  return isSelected ? 4 : 2;
}

function pendingSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="14" fill="#f59e0b" stroke="#422006" stroke-width="2"/>
    <text x="16" y="22" text-anchor="middle" font-size="20" font-family="Arial,sans-serif" font-weight="700" fill="#422006">!</text>
  </svg>`;
}

function lsdSvg(site, isSelected) {
  const fill = site.status === 'inspected' ? '#22c55e' : '#ef4444';
  const s = stroke(isSelected);
  const sw = strokeWidth(isSelected);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="42" height="52" viewBox="0 0 42 52">
    <path d="M21 2C10.5 2 2 10.5 2 21c0 13.4 16.3 28.4 17 29 .6.5 1.5.5 2.1 0 .7-.6 17-15.6 17-29C38 10.5 29.5 2 21 2Z" fill="${fill}" stroke="${s}" stroke-width="${sw}"/>
    <circle cx="21" cy="21" r="9" fill="#fff" fill-opacity=".15"/>
    <text x="21" y="26" text-anchor="middle" font-size="14" font-family="Arial,sans-serif" font-weight="700" fill="#fff">L</text>
  </svg>`;
}

function waterSvg(isSelected) {
  const s = stroke(isSelected);
  const sw = strokeWidth(isSelected);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48">
    <path d="M18 44 C18 44 4 26 4 18 a14 14 0 0 1 28 0 C32 26 18 44 18 44Z" fill="#3b82f6" stroke="${s}" stroke-width="${sw}"/>
    <ellipse cx="18" cy="18" rx="7" ry="5" fill="#fff" fill-opacity=".18"/>
    <text x="18" y="22" text-anchor="middle" font-size="13" font-family="Arial,sans-serif" font-weight="700" fill="#fff">W</text>
  </svg>`;
}

function atvSvg(isSelected) {
  const s = stroke(isSelected);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="36" viewBox="0 0 48 36">
    <!-- rear wheel -->
    <circle cx="10" cy="27" r="7" fill="#4b5563" stroke="${s}" stroke-width="1.2"/>
    <circle cx="10" cy="27" r="4.5" fill="#6b7280"/>
    <circle cx="10" cy="27" r="2" fill="#9ca3af"/>
    <!-- front wheel -->
    <circle cx="38" cy="27" r="7" fill="#4b5563" stroke="${s}" stroke-width="1.2"/>
    <circle cx="38" cy="27" r="4.5" fill="#6b7280"/>
    <circle cx="38" cy="27" r="2" fill="#9ca3af"/>
    <!-- rear fender -->
    <path d="M4 20 Q10 12 18 18 L16 22 Q10 20 6 22Z" fill="#d4a017"/>
    <!-- body/frame -->
    <path d="M14 22 L18 14 L30 12 L36 16 L38 22 L10 22Z" fill="#e8a820" stroke="${s}" stroke-width="0.8"/>
    <!-- seat -->
    <ellipse cx="24" cy="13" rx="6" ry="3" fill="#c48a15"/>
    <!-- tank -->
    <path d="M28 10 Q32 8 36 12 L32 14 L28 12Z" fill="#d4a017"/>
    <!-- handlebars -->
    <path d="M34 12 L38 6 M34 12 L40 8" stroke="#374151" stroke-width="2" stroke-linecap="round"/>
    <!-- front fender -->
    <path d="M34 20 Q38 14 44 18 L42 22 Q38 20 36 22Z" fill="#d4a017"/>
    <!-- headlight -->
    <circle cx="40" cy="16" r="1.5" fill="#fbbf24"/>
  </svg>`;
}

function treeSvg(site, isSelected) {
  const fill = site.status === 'inspected' ? '#22c55e' : '#ef4444';
  const s = stroke(isSelected);
  const sw = strokeWidth(isSelected);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="38" height="50" viewBox="0 0 38 50">
    <rect x="16" y="34" width="6" height="12" rx="1.5" fill="#92400e"/>
    <polygon points="19,2 4,22 12,22 6,34 32,34 26,22 34,22" fill="${fill}" stroke="${s}" stroke-width="${sw}" stroke-linejoin="round"/>
    <polygon points="19,8 12,18 26,18" fill="#fff" fill-opacity=".12"/>
  </svg>`;
}

// Returns raw SVG string for AdvancedMarkerElement
export function buildMarkerSvg(site, isSelected = false) {
  if (site.approval_state === 'pending_review') {
    return pendingSvg();
  }
  switch (site.pin_type) {
    case 'water':
      return waterSvg(isSelected);
    case 'quad_access':
      return atvSvg(isSelected);
    case 'reclaimed':
      return treeSvg(site, isSelected);
    default:
      return lsdSvg(site, isSelected);
  }
}

export function buildMarkerIcon(site, isSelected = false) {
  // Special handling for preview sites
  if (site._isPreview) {
    let svg;
    let size;
    const scale = isSelected ? 1.5 : 1;

    switch (site.pin_type) {
      case 'water':
        svg = waterSvg(isSelected).replace(/fill="#3b82f6"/g, 'fill="#60a5fa"').replace(/stroke-width="[^"]*"/g, 'stroke-width="3" stroke-dasharray="5,5"');
        size = [18 * scale, 24 * scale];
        break;
      case 'quad_access':
        svg = atvSvg(isSelected).replace(/fill="#eab308"/g, 'fill="#fbbf24"').replace(/stroke-width="[^"]*"/g, 'stroke-width="3" stroke-dasharray="5,5"');
        size = [24 * scale, 18 * scale];
        break;
      case 'reclaimed':
        svg = treeSvg(site, isSelected).replace(/fill="#22c55e"/g, 'fill="#4ade80"').replace(/fill="#ef4444"/g, 'fill="#f87171"').replace(/stroke-width="[^"]*"/g, 'stroke-width="3" stroke-dasharray="5,5"');
        size = [19 * scale, 25 * scale];
        break;
      default:
        svg = lsdSvg(site, isSelected).replace(/fill="#22c55e"/g, 'fill="#4ade80"').replace(/fill="#ef4444"/g, 'fill="#f87171"').replace(/stroke-width="[^"]*"/g, 'stroke-width="3" stroke-dasharray="5,5"');
        size = [21 * scale, 26 * scale];
        break;
    }

    return {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      scaledSize: window.google ? new window.google.maps.Size(size[0], size[1]) : undefined,
      anchor: window.google ? new window.google.maps.Point(size[0] / 2, size[1]) : undefined,
    };
  }

  if (site.approval_state === 'pending_review') {
    const svg = pendingSvg();
    return {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      scaledSize: window.google ? new window.google.maps.Size(16, 16) : undefined,
    };
  }

  let svg;
  let size;
  const scale = isSelected ? 1.5 : 1;

  switch (site.pin_type) {
    case 'water':
      svg = waterSvg(isSelected);
      size = [18 * scale, 24 * scale];
      break;
    case 'quad_access':
      svg = atvSvg(isSelected);
      size = [24 * scale, 18 * scale];
      break;
    case 'reclaimed':
      svg = treeSvg(site, isSelected);
      size = [19 * scale, 25 * scale];
      break;
    default:
      svg = lsdSvg(site, isSelected);
      size = [21 * scale, 26 * scale];
      break;
  }

  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: window.google ? new window.google.maps.Size(size[0], size[1]) : undefined,
  };
}

export function getDirectionsUrl(site) {
  const lat = site.latitude;
  const lng = site.longitude;
  const label = encodeURIComponent(site.lsd || site.client || 'Pineview site');

  // Use Google Maps for all devices (including iPhone)
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&destination_place_id=${label}`;
}
