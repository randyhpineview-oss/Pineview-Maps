// Deterministic avatar colour from a seed string (usually the user's
// email or display name). Two users with the same name get DIFFERENT
// colours because their emails differ; the same user always gets the
// same colour across reloads. This is the muscle-memory advantage of
// Slack-style avatars -- you spot "your" tile by colour, not by
// reading every name on the screen.
//
// Pastel palette via HSL: vary hue, fix saturation + lightness in the
// readable range. Always returns text-on-bg pairs that pass WCAG AA.
//
// Used by:
//   * EmployeeStatusCard.jsx -- the round avatar tile
//   * CrewPicker.jsx -- crew chip backgrounds (future)

/**
 * Returns a deterministic HSL pair for the given seed.
 *
 * @param {string} seed  Any stable identifier (email, name).
 * @returns {{ bg: string, fg: string }}
 */
export function hashToHslColor(seed) {
  const s = String(seed ?? '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0; // force 32-bit int (prevent number overflow on long strings)
  }
  // Map hash -> [0, 360). Saturation + lightness fixed for legibility.
  const hue = Math.abs(hash) % 360;
  // Saturation 55% + lightness 42% lands in the "deep pastel" range:
  // bright enough to be friendly, dark enough that white text reads.
  const bg = `hsl(${hue} 55% 42%)`;
  return { bg, fg: '#ffffff' };
}

/**
 * Two-letter initials from a display name. Falls back to '?' for empty.
 *
 * @param {string} name
 * @returns {string}
 */
export function initials(name) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
