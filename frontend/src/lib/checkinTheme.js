/**
 * Shared dark-theme tokens for the Check-ins feature.
 *
 * The whole Pineview app is on a dark navy palette (see :root in
 * index.css and the FullCalendar overrides). Early Check-ins screens
 * accidentally shipped with a light/Bootstrap-ish look, which made the
 * dashboard feel like a different application. This module is the
 * single source of truth so the four Check-ins tabs + the prefs panel
 * + the Active/History rows all read identical to the rest of the app.
 *
 * Colour reference (matches index.css):
 *   - Page bg            #0b1220
 *   - Panel / card bg    #0f172a (and #111c33 a touch lighter for headers)
 *   - Text               #e5eefb
 *   - Muted text         #9ab1d6 / #c9d6ee
 *   - Border             rgba(143, 182, 255, 0.16)
 *   - Accent (focus)     #60a5fa
 *   - Accent (CTA)       #2563eb
 *   - Success            #86efac
 *   - Warning            #fbbf24
 *   - Danger             #ef4444 / #dc2626
 */
export const t = {
  // Surfaces
  pageBg: '#0b1220',
  cardBg: '#0f172a',
  cardBgRaised: '#111c33',
  rowHover: 'rgba(143, 182, 255, 0.06)',
  // Text
  text: '#e5eefb',
  textMuted: '#9ab1d6',
  textSubtle: '#c9d6ee',
  textOnAccent: '#ffffff',
  // Borders / dividers
  border: 'rgba(143, 182, 255, 0.16)',
  borderSoft: 'rgba(143, 182, 255, 0.10)',
  divider: 'rgba(143, 182, 255, 0.08)',
  // Accents / state
  accent: '#60a5fa',
  accentStrong: '#2563eb',
  success: '#86efac',
  successBg: 'rgba(134, 239, 172, 0.10)',
  successBorder: 'rgba(134, 239, 172, 0.35)',
  warning: '#fbbf24',
  warningBg: 'rgba(251, 191, 36, 0.10)',
  warningBorder: 'rgba(251, 191, 36, 0.35)',
  danger: '#ef4444',
  dangerStrong: '#dc2626',
  dangerBg: 'rgba(239, 68, 68, 0.10)',
  dangerBorder: 'rgba(239, 68, 68, 0.35)',
};

// Common reusable button / input styles. Returning fresh objects so
// callers can safely spread + override.
export const btnPrimary = () => ({
  padding: '6px 14px',
  background: t.accentStrong,
  color: t.textOnAccent,
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
});

export const btnGhost = () => ({
  padding: '6px 12px',
  background: 'transparent',
  color: t.text,
  border: `1px solid ${t.border}`,
  borderRadius: 6,
  fontSize: 13,
  cursor: 'pointer',
});

export const btnDangerSm = () => ({
  padding: '4px 10px',
  background: t.dangerBg,
  color: t.danger,
  border: `1px solid ${t.dangerBorder}`,
  borderRadius: 6,
  fontSize: 12,
  cursor: 'pointer',
});

export const inp = (extra = {}) => ({
  padding: '6px 10px',
  background: t.cardBgRaised,
  color: t.text,
  border: `1px solid ${t.border}`,
  borderRadius: 6,
  fontSize: 13,
  minWidth: 0,
  ...extra,
});

export const card = () => ({
  background: t.cardBg,
  border: `1px solid ${t.border}`,
  borderRadius: 10,
  padding: 16,
  marginBottom: 14,
});
