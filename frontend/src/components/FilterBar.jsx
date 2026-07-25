import { useMemo, useRef, useState } from 'react';

import { nameKey, pinTypeLabel } from '../lib/mapUtils';

const LAYER_OPTIONS = [
  { key: 'lsd', label: 'LSD' },
  { key: 'water', label: 'Water' },
  { key: 'quad_access', label: 'Quad Access' },
  { key: 'reclaimed', label: 'Reclaimed' },
  { key: 'pipelines', label: 'Pipelines' },
  { key: 'trucks', label: 'Trucks' },
  { key: 'crew', label: 'Crew (live)' },
];

export default function FilterBar({
  filters,
  clients,
  areas,
  sites = [],
  pipelines = [],
  onChange,
  onSearchSelect,
  onClearAll,
  layers = { lsd: true, water: true, quad_access: true, reclaimed: true, pipelines: true, trucks: true, crew: true },
  onLayerToggle,
  showTrucksOption = true,
  showCrewOption = true,
  // Client portal hides Water / Quad Access (internal pins). Defaults
  // stay true so worker/admin/office/crew_lead/tv callers are unchanged.
  showWaterOption = true,
  showQuadAccessOption = true,
}) {
  const [focused, setFocused] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const wrapRef = useRef(null);

  const layerOptions = useMemo(() => {
    const hidden = new Set();
    if (!showTrucksOption) hidden.add('trucks');
    if (!showCrewOption) hidden.add('crew');
    if (!showWaterOption) hidden.add('water');
    if (!showQuadAccessOption) hidden.add('quad_access');
    if (hidden.size === 0) return LAYER_OPTIONS;
    return LAYER_OPTIONS.filter((opt) => !hidden.has(opt.key));
  }, [showTrucksOption, showCrewOption, showWaterOption, showQuadAccessOption]);

  const query = filters.search.trim().toLowerCase();

  // True when at least one filter is set. Used to enable / disable the
  // "Clear all filters" button so users get a visual cue that there's
  // nothing to clear in the default state.
  const hasActiveFilters = Boolean(
    (filters.search && filters.search.trim()) ||
    filters.client ||
    filters.area ||
    filters.status ||
    filters.approval_state
  );

  // Filter areas based on selected client: when a client is chosen,
  // only show areas that have sites/pipelines for that client.
  // Membership is keyed on `nameKey` (case-insensitive, whitespace-
  // collapsed) so a legacy site row with raw value "FOOTHILLS" still
  // matches the canonical "Foothills" entry that App.jsx ships in the
  // `areas` list. Without this keying the filtered list would silently
  // drop any area whose underlying rows hadn't been re-saved since
  // the canonicalization rolled out.
  //
  // Pipelines must be included — a company can have area coverage on
  // pipelines only. If nothing matches (client-name drift, pins still
  // loading), keep the provided `areas` list rather than emptying the
  // dropdown to a bare "All areas" option.
  const filteredAreas = useMemo(() => {
    if (!filters.client) return areas; // All clients → show all areas
    const clientKey = nameKey(filters.client);
    const areaKeysForClient = new Set();
    for (const s of sites) {
      if (nameKey(s.client) !== clientKey) continue;
      const key = nameKey(s.area);
      if (key) areaKeysForClient.add(key);
    }
    for (const p of pipelines) {
      if (nameKey(p.client) !== clientKey) continue;
      const key = nameKey(p.area);
      if (key) areaKeysForClient.add(key);
    }
    if (areaKeysForClient.size === 0) return areas;
    return areas.filter((area) => areaKeysForClient.has(nameKey(area)));
  }, [areas, filters.client, sites, pipelines]);

  const suggestions = useMemo(() => {
    if (!query || query.length < 1) return [];
    return sites
      .filter((s) => {
        const hay = [s.lsd, s.client, s.area].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(query);
      })
      .slice(0, 8);
  }, [query, sites]);

  const showSuggestions = focused && query.length > 0 && suggestions.length > 0;

  return (
    <>
      <div style={{ position: 'relative' }} ref={wrapRef}>
        <input
          value={filters.search}
          onChange={(event) => onChange('search', event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder="Search LSD, client, area…"
        />
        {showSuggestions ? (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: '#0f172a',
            border: '1px solid rgba(143,182,255,0.2)',
            borderRadius: '0 0 10px 10px',
            maxHeight: '200px',
            overflowY: 'auto',
            zIndex: 20,
          }}>
            {suggestions.map((site) => (
              <button
                key={site.id || site.cacheId}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (onSearchSelect) onSearchSelect(site);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid rgba(143,182,255,0.08)',
                  color: '#e5eefb',
                  padding: '8px 10px',
                  cursor: 'pointer',
                  fontSize: '0.82rem',
                }}
              >
                <strong>{site.lsd || 'Unnamed'}</strong>
                <span style={{ color: '#9ab1d6', marginLeft: 6 }}>
                  {site.client || pinTypeLabel(site.pin_type)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <select value={filters.client} onChange={(event) => onChange('client', event.target.value)}>
        <option value="">All clients</option>
        {clients.map((client) => (
          <option key={client} value={client}>
            {client}
          </option>
        ))}
      </select>
      <select value={filters.area} onChange={(event) => onChange('area', event.target.value)}>
        <option value="">All areas</option>
        {filteredAreas.map((area) => (
          <option key={area} value={area}>
            {area}
          </option>
        ))}
      </select>
      <div style={{
        borderRadius: '10px',
        border: '1px solid rgba(143,182,255,0.16)',
        background: 'rgba(9,17,31,0.85)',
        overflow: 'hidden',
      }}>
        <button
          type="button"
          onClick={() => setLayersOpen((c) => !c)}
          style={{
            width: '100%',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'transparent',
            border: 'none',
            padding: '0.5rem 0.65rem',
            cursor: 'pointer',
            color: '#f5f8ff',
            fontSize: '0.82rem',
          }}
        >
          <span>Layers</span>
          <span style={{ fontSize: '0.65rem', color: '#9ab1d6', transition: 'transform 0.2s', transform: layersOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
        </button>
        {layersOpen ? (
          <div style={{ padding: '0 0.35rem 0.5rem', display: 'grid', gap: '2px' }}>
            {layerOptions.map(({ key, label }) => {
              const isOn = layers[key] ?? true;
              return (
                <div
                  key={key}
                  className="layer-item"
                  onClick={() => onLayerToggle?.(key)}
                >
                  <div className={`layer-item-check ${isOn ? 'checked' : ''}`}>
                    {isOn ? (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
                      </svg>
                    ) : null}
                  </div>
                  {label}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      <select value={filters.status} onChange={(event) => onChange('status', event.target.value)}>
        <option value="">All statuses</option>
        <option value="inspected">Inspected</option>
        <option value="in_progress">In progress</option>
        <option value="not_inspected">Not inspected</option>
        <option value="issue">Issue with Site</option>
        <option value="issue_not_inspected">Issue (Not Inspected)</option>
      </select>
      <select value={filters.approval_state} onChange={(event) => onChange('approval_state', event.target.value)}>
        <option value="">All approvals</option>
        <option value="approved">Approved</option>
        <option value="pending_review">Pending</option>
        <option value="rejected">Rejected</option>
      </select>
      <button
        type="button"
        onClick={() => onClearAll?.()}
        disabled={!hasActiveFilters}
        style={{
          width: '100%',
          marginTop: '0.15rem',
          borderRadius: '10px',
          border: '1px solid rgba(143,182,255,0.16)',
          background: hasActiveFilters ? 'rgba(220,38,38,0.18)' : 'rgba(9,17,31,0.85)',
          color: hasActiveFilters ? '#fecaca' : '#5f7396',
          padding: '0.5rem 0.65rem',
          fontSize: '0.82rem',
          cursor: hasActiveFilters ? 'pointer' : 'not-allowed',
          transition: 'background 0.15s, color 0.15s',
        }}
      >
        Clear all filters
      </button>
    </>
  );
}
