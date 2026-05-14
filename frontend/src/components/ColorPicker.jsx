import { useState } from 'react';

// 12-color preset palette used as truck-pin colors. Picked to be high-
// contrast against satellite imagery (no greens that blend into trees,
// no blues that blend into water). The order matters: DeviceAdmin's
// "Add Device" path auto-selects the first unused color from this list,
// so heavy fleets cycle through visually distinct colors before
// repeating.
export const TRUCK_COLOR_PALETTE = [
  '#E53935', // red
  '#FB8C00', // orange
  '#FDD835', // yellow
  '#43A047', // green
  '#00ACC1', // cyan
  '#1E88E5', // blue
  '#3949AB', // indigo
  '#8E24AA', // purple
  '#D81B60', // pink
  '#6D4C41', // brown
  '#546E7A', // slate
  '#000000', // black
];

// Pick the first palette color not already used by another device, with
// graceful wrap-around when the fleet exceeds 12 trucks (12-truck fleet
// is unusually large for this app; if it ever matters we extend the
// palette rather than introduce a perceptual-distance picker).
export function pickNextUnusedColor(usedColors = []) {
  const usedSet = new Set(
    (usedColors || []).filter(Boolean).map((c) => String(c).toUpperCase())
  );
  for (const color of TRUCK_COLOR_PALETTE) {
    if (!usedSet.has(color.toUpperCase())) return color;
  }
  // All presets exhausted — fall back to a random palette pick rather
  // than dumping everyone on the same default.
  return TRUCK_COLOR_PALETTE[Math.floor(Math.random() * TRUCK_COLOR_PALETTE.length)];
}

function isValidHex(s) {
  return /^#([0-9a-fA-F]{6})$/.test(String(s || '').trim());
}

/**
 * Reusable color picker: 12-color preset grid + collapsible "Custom hex"
 * input. Designed for the DeviceAdmin truck-color flow but generic enough
 * to plug into any other surface that needs a small color choice (we
 * intentionally do NOT expose it on user/profile screens per the plan —
 * trucks have colors, employees do not).
 *
 * Props:
 *   - value: current #RRGGBB (string)
 *   - onChange: (hex) => void
 *   - usedColors: optional array of hex strings already in use — those
 *     swatches get a small "used" badge to discourage duplicates but are
 *     NOT disabled (admin may want intentional duplicates).
 *   - size: 'sm' (28px) | 'md' (36px, default)
 */
export default function ColorPicker({ value, onChange, usedColors = [], size = 'md' }) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customInput, setCustomInput] = useState(
    value && !TRUCK_COLOR_PALETTE.includes(String(value).toUpperCase()) ? value : ''
  );

  const dim = size === 'sm' ? 28 : 36;
  const usedSet = new Set((usedColors || []).filter(Boolean).map((c) => String(c).toUpperCase()));

  function selectPreset(color) {
    onChange?.(color);
  }

  function commitCustom() {
    const trimmed = String(customInput || '').trim();
    if (!isValidHex(trimmed)) return;
    // Normalize to uppercase so the dedup logic on usedColors works.
    onChange?.(trimmed.toUpperCase());
  }

  const selectedUpper = String(value || '').toUpperCase();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(6, ${dim}px)`,
          gap: '0.4rem',
        }}
      >
        {TRUCK_COLOR_PALETTE.map((color) => {
          const isSelected = selectedUpper === color.toUpperCase();
          const isUsed = usedSet.has(color.toUpperCase()) && !isSelected;
          return (
            <button
              key={color}
              type="button"
              onClick={() => selectPreset(color)}
              title={isUsed ? `${color} (already used)` : color}
              aria-label={`Color ${color}${isUsed ? ' (already used)' : ''}`}
              style={{
                width: dim,
                height: dim,
                borderRadius: '50%',
                background: color,
                // Selected: bright white ring. Used (and not selected):
                // a thinner amber ring as a soft warning. Unused: subtle
                // border for legibility against dark surfaces.
                border: isSelected
                  ? '3px solid #ffffff'
                  : isUsed
                  ? '2px solid #fbbf24'
                  : '1px solid rgba(255,255,255,0.15)',
                boxShadow: isSelected ? '0 0 0 2px rgba(255,255,255,0.4)' : 'none',
                cursor: 'pointer',
                padding: 0,
                outline: 'none',
                position: 'relative',
              }}
            >
              {isUsed ? (
                <span
                  style={{
                    position: 'absolute',
                    top: -2,
                    right: -2,
                    fontSize: '0.55rem',
                    color: '#fbbf24',
                    fontWeight: 700,
                  }}
                >
                  •
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setCustomOpen((c) => !c)}
        style={{
          background: 'none',
          border: 'none',
          color: '#9ab1d6',
          fontSize: '0.8rem',
          textAlign: 'left',
          padding: '0.25rem 0',
          cursor: 'pointer',
        }}
      >
        {customOpen ? '▾' : '▸'} Custom hex…
      </button>

      {customOpen ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="text"
            value={customInput}
            placeholder="#RRGGBB"
            onChange={(e) => setCustomInput(e.target.value)}
            onBlur={commitCustom}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitCustom();
              }
            }}
            style={{ width: '8rem' }}
          />
          {/* Live swatch preview of the typed value (only when valid) so
              admins can sanity-check before committing. */}
          {isValidHex(customInput) ? (
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: dim,
                height: dim,
                borderRadius: '50%',
                background: customInput.toUpperCase(),
                border: '1px solid rgba(255,255,255,0.2)',
              }}
            />
          ) : null}
          <button
            type="button"
            className="secondary-button"
            onClick={commitCustom}
            disabled={!isValidHex(customInput)}
          >
            Use
          </button>
        </div>
      ) : null}
    </div>
  );
}
