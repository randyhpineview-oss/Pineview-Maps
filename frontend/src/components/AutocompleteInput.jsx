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
  // `open` is the single source of truth for dropdown visibility.
  // Opens on focus and on typing; closes on blur AND — importantly —
  // as soon as the user taps a suggestion. The previous
  // `focused`-only model kept the list visible after a selection,
  // which in the tight Add-pin popup layout left the dropdown sitting
  // on top of the Submit button and made it appear that submissions
  // were blocked (bug report: "thinks the lsd already exists so not
  // letting me add … dropdown is staying there").
  const [open, setOpen] = useState(false);
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

  const showDropdown = open && filtered.length > 0;

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          // Typing always re-opens the dropdown so the user keeps
          // getting live suggestions even if they just selected one
          // and then decided to amend the value.
          setOpen(true);
          onChange(event.target.value);
        }}
        onFocus={() => setOpen(true)}
        // Delay the close slightly so a mousedown-driven suggestion
        // select fires its handler before the list unmounts. 150ms
        // matches FilterBar's suggestion list.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
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
                // `onMouseDown` (not onClick) with preventDefault so
                // the native mousedown→focus-change doesn't swap focus
                // to the <button> (which would immediately fire the
                // input's onBlur before our state update landed).
                onMouseDown={(event) => {
                  event.preventDefault();
                  // Close the dropdown FIRST so it can't sit on top of
                  // the Submit button / sibling fields after the
                  // value is filled in. The .autocomplete-dropdown
                  // has z-index 25 and overlays everything below the
                  // input inside the popup, so a lingering list here
                  // was physically blocking the Submit button.
                  setOpen(false);
                  onChange(label);
                  if (onSelect) onSelect(item);
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
