import { useMemo, useRef, useState } from 'react';

import { pinTypeLabel } from '../lib/mapUtils';

export default function FilterBar({
  filters,
  clients,
  areas,
  sites = [],
  onChange,
  onRefresh,
  onSyncCurrentView,
  onSearchSelect,
  syncing,
}) {
  const [focused, setFocused] = useState(false);
  const wrapRef = useRef(null);

  const query = filters.search.trim().toLowerCase();

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
        {areas.map((area) => (
          <option key={area} value={area}>
            {area}
          </option>
        ))}
      </select>
      <select value={filters.pin_type} onChange={(event) => onChange('pin_type', event.target.value)}>
        <option value="">All pin types</option>
        <option value="lsd">LSD</option>
        <option value="water">Water</option>
        <option value="quad_access">Quad access</option>
        <option value="reclaimed">Reclaimed</option>
      </select>
      <select value={filters.status} onChange={(event) => onChange('status', event.target.value)}>
        <option value="">All statuses</option>
        <option value="inspected">Inspected</option>
        <option value="not_inspected">Not inspected</option>
      </select>
      <select value={filters.approval_state} onChange={(event) => onChange('approval_state', event.target.value)}>
        <option value="">All approvals</option>
        <option value="approved">Approved</option>
        <option value="pending_review">Pending</option>
        <option value="rejected">Rejected</option>
      </select>
      <div className="button-row">
        <button className="secondary-button" type="button" onClick={onRefresh} style={{ flex: 1 }}>
          Refresh
        </button>
        <button className="primary-button" type="button" onClick={onSyncCurrentView} disabled={syncing} style={{ flex: 1 }}>
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>
    </>
  );
}
