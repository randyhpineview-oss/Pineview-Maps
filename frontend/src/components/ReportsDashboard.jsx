import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';

/**
 * Full-page reporting dashboard for admin / office users.
 *
 * IMPORTANT: this component is INERT when not mounted. App.jsx only renders
 * it when `showReportsDashboard` is true, and we don't preload its chunk
 * during idle time (unlike AdminPanel). Workers never see it, so they never
 * cost anything. Even when the dashboard IS open, NO network requests fire
 * until the user clicks "Generate Preview" or "Download CSV". That keeps
 * Supabase egress at zero for the 99% of the time nobody's looking at a
 * report.
 *
 * Layout: date presets → date inputs → filters → column picker with inline
 * format dropdowns → optional row-split / totals toggles → preview table →
 * sticky export bar.
 */

// ── Column catalog — MUST stay in sync with backend/app/reports_routes.py ──
// Each entry: { key, label, format? } where `format` (optional) wires the
// per-column format dropdown next to the checkbox.
const COLUMN_DEFS = [
  { key: 'ticket_number',      label: 'Ticket #' },
  { key: 'source_type',        label: 'Source (Site/Pipeline)' },
  { key: 'lsd_or_pipeline',    label: 'LSD / Pipeline' },
  { key: 'customer',           label: 'Customer' },
  { key: 'area',               label: 'Area' },
  { key: 'spray_date',         label: 'Date',            format: 'date' },
  { key: 'sprayed_by',         label: 'Sprayed By' },
  { key: 'applicators',        label: 'Applicators' },
  { key: 'herbicides',         label: 'Herbicides',      format: 'herbicides' },
  { key: 'noxious_weeds',      label: 'Noxious Weeds',   format: 'weeds' },
  { key: 'location_types',     label: 'Location Types' },
  { key: 'main_site_type',     label: 'Main Site Type' },
  { key: 'total_liters',       label: 'Total Liters' },
  { key: 'total_area',         label: 'Total Area',      format: 'area' },
  { key: 'total_distance_km',  label: 'Total Distance (km)' },
  { key: 'wind_direction',     label: 'Wind Direction' },
  { key: 'wind_speed_kmh',     label: 'Wind Speed (km/h)' },
  { key: 'temperature_c',      label: 'Temperature (°C)' },
  { key: 'roadside_km',        label: 'Roadside Km' },
  { key: 'roadside_liters',    label: 'Roadside Liters' },
  { key: 'roadside_herbicides', label: 'Roadside Herbicides', format: 'herbicides' },
  { key: 'roadside_area_ha',   label: 'Roadside Area (ha)' },
  { key: 'notes',              label: 'Notes' },
];

const DEFAULT_COLUMN_KEYS = new Set([
  'ticket_number', 'lsd_or_pipeline', 'customer', 'area', 'spray_date',
  'sprayed_by', 'herbicides', 'total_liters', 'total_area',
]);

const HERBICIDE_FORMAT_OPTIONS = [
  { value: 'pcp',              label: 'Names + PCP' },
  { value: 'pcp_concentrate',  label: 'Names + PCP + concentrate' },
  { value: 'names',            label: 'Names only' },
  { value: 'tm_count',         label: 'T&M count (1/2/3 Herbicides)' },
];
const AREA_UNIT_OPTIONS = [
  { value: 'ha',   label: 'Hectares (ha)' },
  { value: 'm2',   label: 'Square meters (m²)' },
  { value: 'auto', label: 'Auto (km for Pipeline/Roadside/Access Rd)' },
  { value: 'number', label: 'Number only (no "ha"/"km" suffix)' },
];
const DATE_FORMAT_OPTIONS = [
  { value: 'iso',   label: 'ISO (2025-03-14)' },
  { value: 'local', label: 'Long (Mar 14, 2025)' },
];
const WEEDS_FORMAT_OPTIONS = [
  { value: 'all',           label: 'Selected + custom' },
  { value: 'selected_only', label: 'Selected only' },
];

// ── Date preset helpers ──
// All return { start, end } as YYYY-MM-DD strings. Uses local time (not
// UTC) because office runs reports in their own timezone — a "today"
// report at 11:55pm shouldn't roll forward to tomorrow's UTC.
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function today() { return toISODate(new Date()); }
function startOfWeek(d) {
  const out = new Date(d);
  const dow = out.getDay(); // 0 = Sunday
  out.setDate(out.getDate() - dow);
  return out;
}
const DATE_PRESETS = [
  { label: 'Today',       get: () => { const d = today(); return { start: d, end: d }; } },
  { label: 'This Week',   get: () => { const s = startOfWeek(new Date()); return { start: toISODate(s), end: today() }; } },
  { label: 'Last Week',   get: () => {
    const now = new Date();
    const endOfLast = startOfWeek(now); endOfLast.setDate(endOfLast.getDate() - 1);
    const startOfLast = startOfWeek(endOfLast);
    return { start: toISODate(startOfLast), end: toISODate(endOfLast) };
  } },
  { label: 'This Month',  get: () => {
    const n = new Date();
    return { start: toISODate(new Date(n.getFullYear(), n.getMonth(), 1)), end: today() };
  } },
  { label: 'Last Month',  get: () => {
    const n = new Date();
    const start = new Date(n.getFullYear(), n.getMonth() - 1, 1);
    const end = new Date(n.getFullYear(), n.getMonth(), 0); // last day of prev month
    return { start: toISODate(start), end: toISODate(end) };
  } },
  { label: 'This Year',   get: () => {
    const n = new Date();
    return { start: toISODate(new Date(n.getFullYear(), 0, 1)), end: today() };
  } },
  { label: 'Last Year',   get: () => {
    const n = new Date();
    const start = new Date(n.getFullYear() - 1, 0, 1);
    const end = new Date(n.getFullYear() - 1, 11, 31);
    return { start: toISODate(start), end: toISODate(end) };
  } },
];

// ── Styles (kept inline so we don't pollute index.css for a rarely-open page) ──
const S = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 90, background: '#0b1220',
    display: 'flex', flexDirection: 'column', color: '#e5eefb',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 16px', background: '#111c33',
    borderBottom: '1px solid rgba(143,182,255,0.12)',
  },
  body: { flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' },
  card: {
    background: 'rgba(14,23,43,0.9)',
    border: '1px solid rgba(143,182,255,0.12)',
    borderRadius: '12px', padding: '14px',
  },
  sectionTitle: { margin: 0, marginBottom: '10px', fontSize: '0.95rem', fontWeight: 700 },
  presetBtn: {
    background: 'rgba(30,41,59,1)', color: '#d7e4fa',
    border: '1px solid rgba(143,182,255,0.18)',
    borderRadius: '999px', padding: '6px 12px',
    fontSize: '0.78rem', cursor: 'pointer',
  },
  presetBtnActive: { background: 'linear-gradient(135deg,#3b82f6,#2563eb)', color: '#fff', borderColor: 'transparent' },
  input: {
    width: '100%', borderRadius: '8px',
    border: '1px solid rgba(143,182,255,0.16)', background: 'rgba(9,17,31,0.75)',
    color: '#e5eefb', padding: '8px 10px', fontSize: '0.85rem',
  },
  label: { display: 'block', fontSize: '0.75rem', color: '#9ab1d6', marginBottom: '4px' },
  colRow: {
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '6px 8px', borderRadius: '6px',
  },
  smallSelect: {
    borderRadius: '6px', border: '1px solid rgba(143,182,255,0.16)',
    background: 'rgba(9,17,31,0.75)', color: '#e5eefb',
    padding: '4px 8px', fontSize: '0.75rem',
  },
  banner: {
    background: '#78350f', color: '#fcd34d', padding: '10px 14px',
    borderRadius: '8px', fontSize: '0.85rem',
  },
  errorBanner: { background: '#7f1d1d', color: '#fca5a5' },
  tableWrap: {
    border: '1px solid rgba(143,182,255,0.12)', borderRadius: '8px',
    overflow: 'auto', maxHeight: '50vh',
  },
  th: {
    position: 'sticky', top: 0, background: '#0b1220', color: '#9ab1d6',
    padding: '8px 10px', fontSize: '0.75rem', textAlign: 'left',
    whiteSpace: 'nowrap', borderBottom: '1px solid rgba(143,182,255,0.12)',
  },
  td: {
    padding: '6px 10px', fontSize: '0.78rem',
    borderBottom: '1px solid rgba(143,182,255,0.06)',
    whiteSpace: 'nowrap', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  footer: {
    position: 'sticky', bottom: 0, zIndex: 1,
    background: '#111c33', borderTop: '1px solid rgba(143,182,255,0.12)',
    padding: '10px 16px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '12px', flexWrap: 'wrap',
  },
  primary: {
    background: 'linear-gradient(135deg,#3b82f6,#2563eb)', color: '#fff',
    border: 'none', padding: '10px 18px', borderRadius: '10px',
    fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem',
  },
  secondary: {
    background: 'rgba(30,41,59,1)', color: '#d7e4fa',
    border: '1px solid rgba(143,182,255,0.18)',
    padding: '10px 18px', borderRadius: '10px', fontWeight: 500,
    cursor: 'pointer', fontSize: '0.9rem',
  },
};

export default function ReportsDashboard({
  onClose,
  // Cached lookup arrays from App.jsx so we don't re-fetch herbicides /
  // applicators just to fill a dropdown. These are already in memory for
  // any admin/office user who has the HerbicideLeaseSheet cache warm.
  cachedLookups = { herbicides: [], applicators: [] },
}) {
  // ── Date range (defaults to "This Year") ──
  const initial = useMemo(() => {
    const preset = DATE_PRESETS.find((p) => p.label === 'This Year');
    return preset ? preset.get() : { start: today(), end: today() };
  }, []);
  const [startDate, setStartDate] = useState(initial.start);
  const [endDate, setEndDate] = useState(initial.end);
  const [activePreset, setActivePreset] = useState('This Year');

  // ── Filters ──
  const [customer, setCustomer] = useState('');
  const [area, setArea] = useState('');
  const [applicator, setApplicator] = useState('');
  const [herbicide, setHerbicide] = useState('');
  const [includeAvoided, setIncludeAvoided] = useState(false);

  // ── Per-column selection + format prefs ──
  const [columnKeys, setColumnKeys] = useState(() => new Set(DEFAULT_COLUMN_KEYS));
  const [herbicidesFormat, setHerbicidesFormat] = useState('pcp');
  const [areaUnits, setAreaUnits] = useState('ha');
  const [dateFormat, setDateFormat] = useState('iso');
  const [weedsFormat, setWeedsFormat] = useState('all');

  // ── Row / totals modes ──
  const [splitRoadside, setSplitRoadside] = useState(false);
  const [includeTotals, setIncludeTotals] = useState(false);

  // ── Filter-dropdown options (fetched once when dashboard opens) ──
  const [filterOptions, setFilterOptions] = useState({ customers: [], areas: [] });
  const [filterOptionsError, setFilterOptionsError] = useState('');

  // ── Preview / download state ──
  const [preview, setPreview] = useState(null); // { rows, headers, columns, total_matched, truncated, preview_limit }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [downloadedInfo, setDownloadedInfo] = useState(null); // { filename, size }
  const downloadAbortRef = useRef(null);

  // Tracks whether we've rendered since the user last changed inputs —
  // drives the "Refresh preview" hint after a filter change.
  const [previewStale, setPreviewStale] = useState(false);

  // ── Fetch filter-dropdown options on mount (single admin-only call) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opts = await api.getReportFilterOptions();
        if (cancelled) return;
        setFilterOptions({
          customers: opts.customers || [],
          areas: opts.areas || [],
        });
      } catch (e) {
        if (cancelled) return;
        setFilterOptionsError(e.message || 'Failed to load filter options');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Preloaded applicator / herbicide lists from parent's cache.
  const applicatorOptions = useMemo(
    () => (cachedLookups.applicators || []).map((a) => a.name).filter(Boolean).sort(),
    [cachedLookups.applicators],
  );
  const herbicideOptions = useMemo(
    () => (cachedLookups.herbicides || []).map((h) => h.name).filter(Boolean).sort(),
    [cachedLookups.herbicides],
  );

  // ── Offline handling ──
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // ── Handlers ──
  const applyPreset = (presetLabel) => {
    const preset = DATE_PRESETS.find((p) => p.label === presetLabel);
    if (!preset) return;
    const { start, end } = preset.get();
    setStartDate(start);
    setEndDate(end);
    setActivePreset(presetLabel);
    setPreviewStale(true);
  };
  const onCustomDateChange = (setter) => (e) => {
    setter(e.target.value);
    setActivePreset('Custom');
    setPreviewStale(true);
  };

  const toggleColumn = (key) => {
    setColumnKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setPreviewStale(true);
  };
  const selectAllColumns = () => {
    setColumnKeys(new Set(COLUMN_DEFS.map((c) => c.key)));
    setPreviewStale(true);
  };
  const resetColumns = () => {
    setColumnKeys(new Set(DEFAULT_COLUMN_KEYS));
    setPreviewStale(true);
  };

  // Maintain stable column order for preview/export (catalog order) with
  // only the user-checked keys passing through.
  const orderedSelected = useMemo(
    () => COLUMN_DEFS.map((c) => c.key).filter((k) => columnKeys.has(k)),
    [columnKeys],
  );

  const buildParams = useCallback(() => ({
    startDate,
    endDate,
    customer: customer || undefined,
    area: area || undefined,
    applicator: applicator || undefined,
    herbicide: herbicide || undefined,
    includeAvoided,
    splitRoadside,
    includeTotals,
    columns: orderedSelected,
    herbicidesFormat,
    areaUnits,
    dateFormat,
    weedsFormat,
  }), [
    startDate, endDate, customer, area, applicator, herbicide,
    includeAvoided, splitRoadside, includeTotals, orderedSelected,
    herbicidesFormat, areaUnits, dateFormat, weedsFormat,
  ]);

  const validateRange = () => {
    if (!startDate || !endDate) {
      setError('Start date and end date are required.');
      return false;
    }
    if (startDate > endDate) {
      setError('Start date must be before end date.');
      return false;
    }
    if (orderedSelected.length === 0) {
      setError('Select at least one column to include.');
      return false;
    }
    setError('');
    return true;
  };

  const handleGeneratePreview = async () => {
    if (!online) return;
    if (!validateRange()) return;
    setBusy(true);
    setError('');
    setDownloadError('');
    setDownloadedInfo(null);
    try {
      const data = await api.getReportPreview(buildParams());
      setPreview(data);
      setPreviewStale(false);
    } catch (e) {
      setError(e.message || 'Failed to generate preview');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    if (!online) return;
    if (!validateRange()) return;
    setDownloading(true);
    setDownloadError('');
    setDownloadedInfo(null);
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    try {
      const info = await api.downloadReportCsv(buildParams(), { signal: controller.signal });
      setDownloadedInfo(info);
    } catch (e) {
      if (e.name !== 'AbortError') {
        setDownloadError(e.message || 'Download failed');
      }
    } finally {
      setDownloading(false);
      downloadAbortRef.current = null;
    }
  };

  const handleCancelDownload = () => {
    if (downloadAbortRef.current) downloadAbortRef.current.abort();
  };

  // Abort in-flight download if the dashboard is closed mid-stream.
  useEffect(() => () => {
    if (downloadAbortRef.current) downloadAbortRef.current.abort();
  }, []);

  // ── Render helpers ──
  const renderColumnRow = (def) => {
    const checked = columnKeys.has(def.key);
    return (
      <div key={def.key} style={{
        ...S.colRow,
        background: checked ? 'rgba(59,130,246,0.08)' : 'transparent',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, cursor: 'pointer', margin: 0 }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={() => toggleColumn(def.key)}
            style={{ width: '16px', height: '16px', cursor: 'pointer' }}
          />
          <span style={{ fontSize: '0.85rem' }}>{def.label}</span>
        </label>
        {def.format === 'herbicides' && checked && (
          <select
            value={herbicidesFormat}
            onChange={(e) => { setHerbicidesFormat(e.target.value); setPreviewStale(true); }}
            style={S.smallSelect}
            aria-label={`${def.label} format`}
          >
            {HERBICIDE_FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}
        {def.format === 'area' && checked && (
          <select
            value={areaUnits}
            onChange={(e) => { setAreaUnits(e.target.value); setPreviewStale(true); }}
            style={S.smallSelect}
            aria-label="Area units"
          >
            {AREA_UNIT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}
        {def.format === 'date' && checked && (
          <select
            value={dateFormat}
            onChange={(e) => { setDateFormat(e.target.value); setPreviewStale(true); }}
            style={S.smallSelect}
            aria-label="Date format"
          >
            {DATE_FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}
        {def.format === 'weeds' && checked && (
          <select
            value={weedsFormat}
            onChange={(e) => { setWeedsFormat(e.target.value); setPreviewStale(true); }}
            style={S.smallSelect}
            aria-label="Weeds format"
          >
            {WEEDS_FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}
      </div>
    );
  };

  return (
    <div style={S.overlay} role="dialog" aria-label="Reports dashboard">
      {/* Header */}
      <div style={S.header}>
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>📊 Reports</h2>
        <button type="button" onClick={onClose} style={S.secondary} aria-label="Close reports">
          ✕ Close
        </button>
      </div>

      {/* Body */}
      <div style={S.body}>
        {!online && (
          <div style={S.banner}>
            ⚠ You're offline — reports need an internet connection to generate or download.
          </div>
        )}

        {/* Date presets + inputs */}
        <section style={S.card}>
          <h3 style={S.sectionTitle}>Date Range</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
            {DATE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p.label)}
                style={{
                  ...S.presetBtn,
                  ...(activePreset === p.label ? S.presetBtnActive : null),
                }}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setActivePreset('Custom')}
              style={{
                ...S.presetBtn,
                ...(activePreset === 'Custom' ? S.presetBtnActive : null),
              }}
            >
              Custom
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', maxWidth: '500px' }}>
            <div>
              <label style={S.label}>Start Date</label>
              <input type="date" style={S.input} value={startDate} onChange={onCustomDateChange(setStartDate)} />
            </div>
            <div>
              <label style={S.label}>End Date</label>
              <input type="date" style={S.input} value={endDate} onChange={onCustomDateChange(setEndDate)} />
            </div>
          </div>
        </section>

        {/* Filters */}
        <section style={S.card}>
          <h3 style={S.sectionTitle}>Filters (optional)</h3>
          {filterOptionsError ? (
            <div style={{ ...S.banner, ...S.errorBanner, marginBottom: '10px' }}>
              {filterOptionsError}
            </div>
          ) : null}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '12px',
          }}>
            <div>
              <label style={S.label}>Customer</label>
              <select style={S.input} value={customer} onChange={(e) => { setCustomer(e.target.value); setPreviewStale(true); }}>
                <option value="">All customers</option>
                {filterOptions.customers.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Area</label>
              <select style={S.input} value={area} onChange={(e) => { setArea(e.target.value); setPreviewStale(true); }}>
                <option value="">All areas</option>
                {filterOptions.areas.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Applicator</label>
              <select style={S.input} value={applicator} onChange={(e) => { setApplicator(e.target.value); setPreviewStale(true); }}>
                <option value="">All applicators</option>
                {applicatorOptions.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Herbicide</label>
              <select style={S.input} value={herbicide} onChange={(e) => { setHerbicide(e.target.value); setPreviewStale(true); }}>
                <option value="">All herbicides</option>
                {herbicideOptions.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeAvoided}
              onChange={(e) => { setIncludeAvoided(e.target.checked); setPreviewStale(true); }}
              style={{ width: '16px', height: '16px', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '0.85rem' }}>Include avoided records (no actual spray happened)</span>
          </label>
        </section>

        {/* Column picker */}
        <section style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
            <h3 style={{ ...S.sectionTitle, marginBottom: 0 }}>Columns</h3>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button type="button" onClick={selectAllColumns} style={{ ...S.secondary, padding: '4px 10px', fontSize: '0.75rem' }}>Select all</button>
              <button type="button" onClick={resetColumns} style={{ ...S.secondary, padding: '4px 10px', fontSize: '0.75rem' }}>Reset defaults</button>
            </div>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '4px',
          }}>
            {COLUMN_DEFS.map(renderColumnRow)}
          </div>
        </section>

        {/* Row-split / totals toggles */}
        <section style={S.card}>
          <h3 style={S.sectionTitle}>Row &amp; Totals Options</h3>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer', marginBottom: '10px' }}>
            <input
              type="checkbox"
              checked={splitRoadside}
              onChange={(e) => { setSplitRoadside(e.target.checked); setPreviewStale(true); }}
              style={{ width: '16px', height: '16px', cursor: 'pointer', marginTop: '2px' }}
            />
            <div>
              <div style={{ fontSize: '0.85rem' }}>Split access-road work into a separate row <span style={{ color: '#9ab1d6' }}>(T&amp;M style)</span></div>
              <div style={{ fontSize: '0.72rem', color: '#9ab1d6', marginTop: '2px' }}>
                When a lease sheet includes access-road spraying, emit one row for the main site and a second "Access Road" row — matches the T&amp;M ticket's Sites Treated table exactly.
              </div>
            </div>
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeTotals}
              onChange={(e) => { setIncludeTotals(e.target.checked); setPreviewStale(true); }}
              disabled={!splitRoadside}
              style={{ width: '16px', height: '16px', cursor: splitRoadside ? 'pointer' : 'not-allowed', marginTop: '2px' }}
            />
            <div style={{ opacity: splitRoadside ? 1 : 0.5 }}>
              <div style={{ fontSize: '0.85rem' }}>Include year-end totals footer</div>
              <div style={{ fontSize: '0.72rem', color: '#9ab1d6', marginTop: '2px' }}>
                Appends total m² for 1/2/3-Herbicide work and total liters for Pipeline/Roadside — the 4 auto-populated office lines on the T&amp;M ticket. Requires the row-split option above.
              </div>
            </div>
          </label>
        </section>

        {/* Status / error / preview */}
        {error ? (
          <div style={{ ...S.banner, ...S.errorBanner }}>{error}</div>
        ) : null}
        {downloadError ? (
          <div style={{ ...S.banner, ...S.errorBanner }}>Download failed: {downloadError}</div>
        ) : null}
        {downloadedInfo ? (
          <div style={{ ...S.banner, background: '#14532d', color: '#86efac' }}>
            ✓ Downloaded <strong>{downloadedInfo.filename}</strong> ({(downloadedInfo.size / 1024).toFixed(0)} KB)
          </div>
        ) : null}

        <section style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
            <h3 style={{ ...S.sectionTitle, marginBottom: 0 }}>Preview</h3>
            {previewStale && preview ? (
              <span style={{ fontSize: '0.75rem', color: '#fbbf24' }}>Filters changed — refresh preview to see current results.</span>
            ) : null}
          </div>

          {!preview ? (
            <div style={{ fontSize: '0.85rem', color: '#9ab1d6', padding: '12px 0' }}>
              Set your date range and click <strong>Generate Preview</strong> below to see the first 500 matching rows. The CSV download returns every matching row — no limit.
            </div>
          ) : preview.rows.length === 0 ? (
            <div style={{ fontSize: '0.85rem', color: '#9ab1d6', padding: '12px 0' }}>
              No records match your filters in this date range.
            </div>
          ) : (
            <>
              <div style={{ fontSize: '0.8rem', color: '#9ab1d6', marginBottom: '8px' }}>
                Showing first <strong style={{ color: '#e5eefb' }}>{preview.rows.length}</strong> of <strong style={{ color: '#e5eefb' }}>{preview.total_matched}</strong> matching record{preview.total_matched === 1 ? '' : 's'}.
                {preview.truncated ? ' (CSV download will include all of them.)' : ''}
              </div>
              <div style={S.tableWrap}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                  <thead>
                    <tr>
                      {preview.headers.map((h) => <th key={h} style={S.th}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 100).map((r, i) => (
                      <tr key={i}>
                        {preview.columns.map((k) => (
                          <td key={k} style={S.td} title={r[k]}>{r[k]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.rows.length > 100 ? (
                <div style={{ fontSize: '0.75rem', color: '#9ab1d6', marginTop: '6px' }}>
                  Preview table shows first 100 of {preview.rows.length} preview rows for readability. The CSV will include every matching row.
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      {/* Sticky footer */}
      <div style={S.footer}>
        <div style={{ fontSize: '0.8rem', color: '#9ab1d6' }}>
          {preview ? (
            <>
              <strong style={{ color: '#e5eefb' }}>{preview.total_matched}</strong> matching record{preview.total_matched === 1 ? '' : 's'}
              {splitRoadside ? ' — access-road work splits into additional rows in the CSV' : ''}
            </>
          ) : (
            'Generate a preview to see record counts.'
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={handleGeneratePreview}
            disabled={busy || !online}
            style={{
              ...S.secondary,
              opacity: (busy || !online) ? 0.6 : 1,
              cursor: (busy || !online) ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Generating…' : preview ? 'Refresh Preview' : 'Generate Preview'}
          </button>
          {downloading && (
            <span style={{ fontSize: '0.82rem', color: '#60a5fa', alignSelf: 'center', marginRight: '6px' }}>
              ⌛ Generating CSV...
            </span>
          )}
          {downloading ? (
            <button type="button" onClick={handleCancelDownload} style={{ ...S.secondary, color: '#fca5a5', borderColor: '#7f1d1d' }}>
              Cancel download
            </button>
          ) : (
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading || !online}
              style={{
                ...S.primary,
                opacity: (downloading || !online) ? 0.6 : 1,
                cursor: (downloading || !online) ? 'not-allowed' : 'pointer',
              }}
            >
              ⬇ Download CSV
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
