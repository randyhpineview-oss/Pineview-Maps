function formatValue(value, fallback = '—') {
  if (Array.isArray(value)) return value.length ? value.join(', ') : fallback;
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function formatPdfLink(url) {
  if (!url) return null;
  if (!url.includes('dropbox.com')) return url;
  return url
    .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
    .replace('&dl=0', '')
    .replace('?dl=0', '?')
    .replace('dl=1', '')
    .replace(/[?&]$/, '');
}

export default function PdfPreviewOverlay({ record, onClose }) {
  const lease = record?.lease_sheet_data || {};
  const directPdfUrl = formatPdfLink(record?.pdf_url || null);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
        backgroundColor: '#111827',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 16px',
          borderBottom: '1px solid #374151',
          gap: '8px',
          flexShrink: 0,
        }}
      >
        <span style={{ color: '#f9fafb', fontWeight: 600, flex: 1 }}>
          Lease Sheet {record?.ticket_number ? `— ${record.ticket_number}` : ''}
        </span>
        {directPdfUrl ? (
          <a
            href={directPdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#60a5fa', fontSize: '0.85rem', textDecoration: 'none', whiteSpace: 'nowrap' }}
          >
            Open PDF ↗
          </a>
        ) : null}
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}
        >
          ×
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        <div
          style={{
            maxWidth: '920px',
            margin: '0 auto',
            background: '#1f2937',
            border: '1px solid #374151',
            borderRadius: '12px',
            padding: '16px',
            color: '#f9fafb',
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
            <div><strong>Date:</strong> {formatValue(lease.date || record?.spray_date)}</div>
            <div><strong>Time:</strong> {formatValue(lease.time)}</div>
            <div><strong>Ticket:</strong> {formatValue(record?.ticket_number || lease.ticket_number)}</div>
            <div><strong>Customer:</strong> {formatValue(lease.customer || record?.site_client)}</div>
            <div><strong>Area:</strong> {formatValue(lease.area || record?.site_area)}</div>
            <div><strong>LSD / Pipeline:</strong> {formatValue(lease.lsdOrPipeline || record?.site_lsd)}</div>
            <div><strong>Distance Sprayed:</strong> {formatValue(lease.totalDistanceSprayed, '—')} m</div>
            <div><strong>Total Liters:</strong> {formatValue(lease.totalLiters)} L</div>
            <div><strong>Area Treated:</strong> {formatValue(lease.areaTreated)} ha</div>
            <div><strong>Applicators:</strong> {formatValue(lease.applicators)}</div>
            <div><strong>Location Types:</strong> {formatValue(lease.locationTypes)}</div>
            <div><strong>Wind:</strong> {formatValue(lease.windDirection)} {lease.windSpeed ? `(${lease.windSpeed} km/h)` : ''}</div>
            <div><strong>Herbicides:</strong> {formatValue(lease.herbicidesUsed)}</div>
          </div>

          {lease.comments ? (
            <div style={{ marginTop: '14px' }}>
              <strong>Comments:</strong>
              <div style={{ marginTop: '6px', color: '#d1d5db' }}>{lease.comments}</div>
            </div>
          ) : null}

          {lease.photos?.length ? (
            <div style={{ marginTop: '14px' }}>
              <strong>Photos:</strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '8px' }}>
                {lease.photos.map((photo, index) => (
                  <img
                    key={`lease-photo-${index}`}
                    src={`data:${photo.type || 'image/jpeg'};base64,${photo.data}`}
                    alt={`Lease photo ${index + 1}`}
                    style={{ width: '140px', height: '140px', objectFit: 'cover', borderRadius: '8px', border: '1px solid #4b5563' }}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
