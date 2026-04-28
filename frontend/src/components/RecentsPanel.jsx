import { useEffect, useMemo, useState } from 'react';

export default function RecentsPanel({
  visible,
  cachedRecents = [],
  onViewPdf,
  onEditRecord,
  roleCanAdmin = false,
  uploadQueue = [],
}) {
  // Debounced search (client-side filter over pre-loaded data)
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Filter cachedRecents by search term (all filtering is client-side — no API call)
  const records = useMemo(() => {
    if (!search) return cachedRecents;
    const q = search.toLowerCase();
    return cachedRecents.filter((r) =>
      (r.ticket_number || '').toLowerCase().includes(q) ||
      (r.site_client || '').toLowerCase().includes(q) ||
      (r.site_area || '').toLowerCase().includes(q) ||
      (r.site_lsd || '').toLowerCase().includes(q) ||
      (r.sprayed_by_name || '').toLowerCase().includes(q)
    );
  }, [cachedRecents, search]);

  if (!visible) return null;

  return (
    <div className="panel">
      <h2>Recent Submissions</h2>

      <input
        type="text"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        placeholder="Search ticket#, client, area, worker..."
        style={{
          width: '100%',
          padding: '8px 12px',
          borderRadius: '6px',
          border: '1px solid var(--border-card)',
          backgroundColor: 'var(--surface-card)',
          color: 'var(--text-card)',
          marginBottom: '12px',
          boxSizing: 'border-box',
        }}
      />

      {/* Pending uploads */}
      {uploadQueue.length > 0 && (
        <div style={{ marginBottom: '12px' }}>
          <div className="small-text" style={{ fontWeight: 600, marginBottom: '6px', color: '#3b82f6' }}>
            Uploading ({uploadQueue.length})
          </div>
          {uploadQueue.map((item) => (
            <div key={item.id} className="site-row" style={{ padding: '8px', borderRadius: '6px', opacity: 0.7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div className="small-text" style={{ fontWeight: 600 }}>
                    {item.payload?.ticket_number || 'Pending'} — {item.payload?.spray_date || ''}
                  </div>
                  <div className="small-text" style={{ color: 'var(--text-card-muted)' }}>
                    {item.targetType === 'site' ? 'Site' : 'Pipeline'} • {item.status === 'uploading' ? 'Uploading...' : 'Queued'}
                  </div>
                </div>
                <span className="pending-badge" style={{ background: '#3b82f6', fontSize: '0.65rem' }}>
                  {item.status === 'uploading' ? '⟳' : '⏳'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {records.length === 0 ? (
        <div className="small-text" style={{ textAlign: 'center', padding: '20px' }}>No submissions found.</div>
      ) : (
        <div className="list-grid">
          {records.map((record) => (
            <div key={record.id} className="site-row" style={{ padding: '10px', borderRadius: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div className="small-text" style={{ fontWeight: 700, fontSize: '0.85rem' }}>
                    {record.ticket_number || 'No Ticket'}
                  </div>
                  <div className="small-text" style={{ marginTop: '2px' }}>
                    {record.spray_date} • {record.sprayed_by_name || 'Unknown'}
                  </div>
                  <div className="small-text" style={{ color: 'var(--text-card-muted)', marginTop: '2px' }}>
                    {record.site_lsd || ''} • {record.site_client || ''} • {record.site_area || ''}
                  </div>
                  {record.lease_sheet_data?.applicators?.length > 0 && (
                    <div className="small-text" style={{ color: 'var(--text-card-muted)', marginTop: '2px' }}>
                      Applicators: {record.lease_sheet_data.applicators.join(', ')}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0, marginLeft: '8px' }}>
                  {record.pdf_url && (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => onViewPdf?.(record)}
                      style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                    >
                      📄 View
                    </button>
                  )}
                  {roleCanAdmin && (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => onEditRecord?.(record)}
                      style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                    >
                      ✏️ Edit
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
