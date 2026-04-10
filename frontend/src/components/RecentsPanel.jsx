import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function RecentsPanel({
  visible,
  onViewPdf,
  onEditRecord,
  roleCanAdmin = false,
  uploadQueue = [],
}) {
  const [records, setRecords] = useState([]);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Load cached recents instantly, then refresh from server
  useEffect(() => {
    if (!visible) return;
    try {
      const cached = localStorage.getItem('recents_cache');
      if (cached) {
        const c = JSON.parse(cached);
        if (c.records && !search) setRecords(c.records);
      }
    } catch { /* ignore */ }
  }, [visible]);

  const loadRecords = useCallback(async () => {
    if (!visible) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.listRecentSubmissions(search || undefined);
      setRecords(data);
      // Cache the unfiltered list
      if (!search) {
        localStorage.setItem('recents_cache', JSON.stringify({
          records: data,
          cachedAt: new Date().toISOString(),
        }));
      }
    } catch (err) {
      setError(err.message || 'Failed to load submissions');
    } finally {
      setIsLoading(false);
    }
  }, [visible, search]);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  // Debounced search
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

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
          border: '1px solid #374151',
          backgroundColor: '#111827',
          color: '#f9fafb',
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
                  <div className="small-text" style={{ color: '#9ca3af' }}>
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

      {isLoading && records.length === 0 ? (
        <div className="small-text" style={{ textAlign: 'center', padding: '20px' }}>Loading...</div>
      ) : error ? (
        <div className="small-text" style={{ textAlign: 'center', padding: '20px', color: '#fca5a5' }}>{error}</div>
      ) : records.length === 0 ? (
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
                  <div className="small-text" style={{ color: '#9ca3af', marginTop: '2px' }}>
                    {record.site_lsd || ''} • {record.site_client || ''} • {record.site_area || ''}
                  </div>
                  {record.lease_sheet_data?.applicators?.length > 0 && (
                    <div className="small-text" style={{ color: '#9ca3af', marginTop: '2px' }}>
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

      <button
        className="secondary-button"
        type="button"
        onClick={loadRecords}
        disabled={isLoading}
        style={{ width: '100%', marginTop: '12px' }}
      >
        {isLoading ? 'Loading...' : 'Refresh'}
      </button>
    </div>
  );
}
