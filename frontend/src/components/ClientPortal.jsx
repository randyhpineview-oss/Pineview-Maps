import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { GoogleMap, Marker, useJsApiLoader } from '@react-google-maps/api';

import { api } from '../lib/api';
import { buildMarkerIcon } from '../lib/mapUtils';
import SiteDetailSheet from './SiteDetailSheet';

const PdfPreviewOverlay = lazy(() => import('./PdfPreviewOverlay'));

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
const mapContainerStyle = { width: '100%', height: '100%' };
const defaultCenter = { lat: 56.2498, lng: -120.8464 }; // Fort St. John, BC

/**
 * Read-only, invite-only portal for external client accounts (Shell, CNRL,
 * etc.). Deliberately its own small, self-contained component rather than
 * a set of `userRole === 'client'` branches threaded through the giant
 * worker/admin App.jsx shell (~7000+ lines of state, polling, and mutating
 * actions that a client-portal account should never be exposed to, even
 * as unreachable dead code).
 *
 * Data scoping is enforced by the backend (see backend/app/auth.py's
 * client allowlist + apply_client_scope) — every `api.*` call here just
 * uses the normal endpoints and the server only ever returns rows within
 * this account's client_name/client_areas. This component's job is UI
 * only: show the same map/pin/spray-history experience a worker gets,
 * minus every action button that changes data.
 */
export default function ClientPortal({ clientName, clientAreas, userDisplayName, onSignOut }) {
  const [activeTab, setActiveTab] = useState('map');
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedSiteId, setSelectedSiteId] = useState(null);
  const [sprayRecords, setSprayRecords] = useState([]);
  const [sprayLoading, setSprayLoading] = useState(false);
  const [previewingRecord, setPreviewingRecord] = useState(null);
  const [searchText, setSearchText] = useState('');

  const { isLoaded: mapLoaded, loadError: mapLoadError } = useJsApiLoader({
    id: 'pineview-google-map',
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
  });

  const loadSites = async () => {
    try {
      const data = await api.listSites();
      setSites(Array.isArray(data) ? data : []);
      setError('');
    } catch (err) {
      setError(err.message || 'Could not load sites.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSites();
    // Light periodic refresh — no delta-sync machinery needed for a
    // single read-only account with a small, scoped dataset.
    const interval = setInterval(loadSites, 60_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedSite = useMemo(
    () => sites.find((s) => s.id === selectedSiteId) || null,
    [sites, selectedSiteId]
  );

  useEffect(() => {
    if (!selectedSiteId) {
      setSprayRecords([]);
      return;
    }
    let cancelled = false;
    setSprayLoading(true);
    api.listSiteSprayRecords(selectedSiteId)
      .then((records) => { if (!cancelled) setSprayRecords(Array.isArray(records) ? records : []); })
      .catch(() => { if (!cancelled) setSprayRecords([]); })
      .finally(() => { if (!cancelled) setSprayLoading(false); });
    return () => { cancelled = true; };
  }, [selectedSiteId]);

  const filteredSites = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    if (!needle) return sites;
    return sites.filter((s) =>
      (s.lsd || '').toLowerCase().includes(needle)
      || (s.area || '').toLowerCase().includes(needle)
    );
  }, [sites, searchText]);

  const mapCenter = useMemo(() => {
    if (selectedSite) return { lat: selectedSite.latitude, lng: selectedSite.longitude };
    const first = sites[0];
    return first ? { lat: first.latitude, lng: first.longitude } : defaultCenter;
  }, [sites, selectedSite]);

  const areasLabel = Array.isArray(clientAreas) && clientAreas.length > 0 ? clientAreas.join(', ') : null;

  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', background: '#0b1220', color: '#e5eefb' }}>
      {/* ── Top bar ── */}
      <header
        className="topbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          padding: '0.6rem 1rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span className="topbar-title">Pineview Maps</span>
          <span className="badge" style={{ background: '#1e3a8a', color: '#bfdbfe' }}>
            {clientName || 'Client Portal'}{areasLabel ? ` — ${areasLabel}` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button
            type="button"
            className="badge"
            onClick={() => setActiveTab(activeTab === 'map' ? 'sites' : 'map')}
            style={{ cursor: 'pointer', background: '#1f2937', color: '#93c5fd', border: '1px solid #374151' }}
          >
            {activeTab === 'map' ? '📋 Site list' : '🗺️ Map'}
          </button>
          <span className="badge" style={{ background: 'transparent', color: '#9ca3af' }}>{userDisplayName}</span>
          <button
            type="button"
            onClick={onSignOut}
            className="badge"
            style={{ cursor: 'pointer', background: '#ef4444', color: 'white' }}
          >
            Sign Out
          </button>
        </div>
      </header>

      {error ? (
        <div style={{ padding: '0.5rem 1rem', background: '#7f1d1d', color: '#fecaca', fontSize: '0.85rem' }}>
          {error}
        </div>
      ) : null}

      {/* ── Body ── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Map or Sites list */}
        <div style={{ flex: '1 1 60%', minWidth: 0, position: 'relative' }}>
          {activeTab === 'map' ? (
            !GOOGLE_MAPS_API_KEY ? (
              <div style={{ padding: '2rem', color: '#9ca3af' }}>Map is not configured.</div>
            ) : mapLoadError ? (
              <div style={{ padding: '2rem', color: '#f87171' }}>Could not load the map. Check your connection and reload.</div>
            ) : !mapLoaded ? (
              <div style={{ padding: '2rem', color: '#9ca3af' }}>Loading map…</div>
            ) : (
              <GoogleMap
                mapContainerStyle={mapContainerStyle}
                center={mapCenter}
                zoom={selectedSite ? 14 : 10}
                options={{ mapTypeId: 'satellite', streetViewControl: false, fullscreenControl: false }}
              >
                {sites.map((site) => (
                  <Marker
                    key={site.id}
                    position={{ lat: site.latitude, lng: site.longitude }}
                    icon={buildMarkerIcon(site, site.id === selectedSiteId)}
                    onClick={() => setSelectedSiteId(site.id)}
                  />
                ))}
              </GoogleMap>
            )
          ) : (
            <div style={{ height: '100%', overflowY: 'auto', padding: '0.75rem' }}>
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Search by LSD or area…"
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  marginBottom: '0.75rem',
                  borderRadius: '0.5rem',
                  border: '1px solid #374151',
                  background: '#111827',
                  color: '#e5eefb',
                  boxSizing: 'border-box',
                }}
              />
              {loading ? (
                <p className="small-text">Loading sites…</p>
              ) : filteredSites.length === 0 ? (
                <p className="small-text">No sites found.</p>
              ) : (
                <div className="list-grid">
                  {filteredSites.map((site) => (
                    <div
                      key={site.id}
                      className="site-row"
                      style={{
                        padding: '0.6rem',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        background: site.id === selectedSiteId ? 'rgba(59,130,246,0.15)' : 'transparent',
                      }}
                      onClick={() => { setSelectedSiteId(site.id); setActiveTab('map'); }}
                    >
                      <div style={{ fontWeight: 600 }}>{site.lsd || 'Unnamed pin'}</div>
                      <div className="small-text">{site.area || 'No area set'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Detail panel — side-by-side on desktop, bottom sheet on mobile
            (see `.client-portal-detail` in index.css). */}
        <div className={`client-portal-detail${selectedSite ? ' open' : ''}`}>
          {selectedSite ? (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
              <button
                type="button"
                className="badge"
                onClick={() => setSelectedSiteId(null)}
                style={{ cursor: 'pointer', background: '#1f2937', color: '#93c5fd', border: '1px solid #374151' }}
              >
                ✕ Close
              </button>
            </div>
          ) : null}
          <SiteDetailSheet
            site={selectedSite}
            sprayRecords={sprayLoading ? [] : sprayRecords}
            canManagePin={false}
            canAdmin={false}
            showDirections={false}
            canEditStatus={false}
            canViewPdf={true}
            showSprayHistory={true}
            onViewPdf={(record) => setPreviewingRecord(record)}
          />
        </div>
      </div>

      {previewingRecord ? (
        <Suspense fallback={null}>
          <PdfPreviewOverlay
            record={previewingRecord}
            onClose={() => setPreviewingRecord(null)}
            canRegenerate={false}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
