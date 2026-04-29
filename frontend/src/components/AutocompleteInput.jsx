import { useEffect, useMemo, useRef, useState } from 'react';

// Shared typeahead input used by the in-map "Add pin" popup for the LSD /
// client / area fields. Lets users keep typing free-form (all three fields
// stay optional) while surfacing existing values from the current project
// so new pins land with consistent spelling and so workers can spot a
// likely-duplicate LSD before they hit Submit.
//
// `suggestions` accepts either:
//   - a flat string[]   (client, area) — rendered as a single bold line
//   - an array of `{ label, sub }` objects (LSD) — `sub` is shown as
//     dimmer context beside the label, e.g. client + area + status so
//     the user can disambiguate two sites that share a label.
//
// The dropdown only opens while the input is focused AND there's at least
// one suggestion to show, so an empty project (or a query that matches
// nothing) degrades gracefully to a plain input with zero visual noise.
export default function AutocompleteInput({
  value,
  onChange,
  placeholder,
  suggestions = [],
  maxSuggestions = 6,
  onSelect,
  inputStyle,
  autoFocus = false,
}) {
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);
  const query = (value || '').trim().toLowerCase();

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus]);

  const filtered = useMemo(() => {
    if (!suggestions || suggestions.length === 0) return [];
    const predicate = (s) => {
      const label = typeof s === 'string' ? s : s?.label;
      if (!label) return false;
      if (!query) return true;
      const hay = typeof s === 'string'
        ? label.toLowerCase()
        : `${label} ${s.sub || ''}`.toLowerCase();
      return hay.includes(query);
    };
    return suggestions.filter(predicate).slice(0, maxSuggestions);
  }, [suggestions, query, maxSuggestions]);

  const showDropdown = focused && filtered.length > 0;

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        // Delay blur so a mousedown on a suggestion row fires before the
        // dropdown unmounts. 150ms matches FilterBar's suggestion list.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder={placeholder}
        style={inputStyle}
      />
      {showDropdown ? (
        <div className="autocomplete-dropdown" role="listbox">
          {filtered.map((item, idx) => {
            const label = typeof item === 'string' ? item : item.label;
            const sub = typeof item === 'string' ? null : item.sub;
            return (
              <button
                key={`${label}-${idx}`}
                type="button"
                role="option"
                className="autocomplete-item"
                // `onMouseDown` (not onClick) with preventDefault so the
                // input's onBlur-delayed close doesn't race with the
                // selection — this is the standard accessible pattern.
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(label);
                  if (onSelect) onSelect(item);
                  // Keep focus on the input so the user can keep typing
                  // (e.g. append a sub-label) without an extra tap.
                  if (inputRef.current) inputRef.current.focus();
                }}
              >
                <strong className="autocomplete-item-label">{label}</strong>
                {sub ? <span className="autocomplete-item-sub">{sub}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
