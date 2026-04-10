function fmt(value, fallback = '—') {
  if (Array.isArray(value)) return value.length ? value.join(', ') : fallback;
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function pdfLink(url) {
  if (!url) return null;
  if (!url.includes('dropbox.com')) return url;
  return url
    .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
    .replace('&dl=0', '')
    .replace('?dl=0', '?')
    .replace('dl=1', '')
    .replace(/[?&]$/, '');
}

/* ── Shared inline styles mirroring the jsPDF layout ── */
const S = {
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 50, backgroundColor: '#4b5563', display: 'flex', flexDirection: 'column',
  },
  toolbar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 16px', background: '#1f2937', borderBottom: '1px solid #374151',
    gap: '8px', flexShrink: 0,
  },
  page: {
    maxWidth: '640px', width: '100%', margin: '0 auto',
    background: '#ffffff', color: '#1a1a1a', fontFamily: 'Helvetica, Arial, sans-serif',
    fontSize: '9pt', lineHeight: 1.35, padding: '28px 32px', boxSizing: 'border-box',
  },
  cell: (flex = 1) => ({
    border: '0.5px solid #000', padding: '4px 6px', flex,
  }),
  row: { display: 'flex' },
  bold: { fontWeight: 700 },
  label: { fontWeight: 700, fontSize: '8pt' },
  normal: { fontWeight: 400, fontSize: '8pt' },
};

export default function PdfPreviewOverlay({ record, onClose }) {
  const d = record?.lease_sheet_data || {};
  const directUrl = pdfLink(record?.pdf_url || null);
  const ticket = record?.ticket_number || d.ticket_number || '';
  const customer = d.customer || record?.site_client || '';
  const area = d.area || record?.site_area || '';
  const lsd = d.lsdOrPipeline || record?.site_lsd || '';
  const windText = `${fmt(d.windDirection, '')} ${d.windSpeed ? d.windSpeed + ' km/h' : ''}`.trim() || '—';
  const showRoadside = d.isAccessRoad || (d.locationTypes || []).some(t => ['Access Road', 'Roadside'].includes(t));

  return (
    <div style={S.overlay}>
      {/* ── Toolbar ── */}
      <div style={S.toolbar}>
        <span style={{ color: '#f9fafb', fontWeight: 600, flex: 1, fontSize: '0.95rem' }}>
          Lease Sheet {ticket ? `— ${ticket}` : ''}
        </span>
        {directUrl ? (
          <a href={directUrl} target="_blank" rel="noopener noreferrer"
            style={{ color: '#60a5fa', fontSize: '0.85rem', textDecoration: 'none', whiteSpace: 'nowrap' }}>
            Open PDF ↗
          </a>
        ) : null}
        <button onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}>
          ×
        </button>
      </div>

      {/* ── Scrollable page ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 8px' }}>
        <div style={S.page}>

          {/* ── Header: Logo + Title + Ticket ── */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px', gap: '16px' }}>
            <img src="/logo.png" alt="" style={{ width: '72px', height: '72px', objectFit: 'contain' }}
              onError={(e) => { e.target.style.display = 'none'; }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '14pt', fontWeight: 700, color: '#325032' }}>Herbicide Lease Sheet</div>
              <div style={{ fontSize: '7pt', color: '#666', marginTop: '2px' }}>
                7077 252 Road, Pineview, BC, Canada, V1J 8E3
              </div>
              <div style={{ fontSize: '7pt', color: '#666' }}>
                Tel: 250.261.9544 | office@pineviewmanagement.com
              </div>
            </div>
            <div style={{ fontSize: '11pt', fontWeight: 700, textAlign: 'right', whiteSpace: 'nowrap' }}>
              No: {ticket || ''}
            </div>
          </div>

          {/* ── Customer / Area / LSD ── */}
          <div style={{ marginBottom: '2px' }}>
            <span style={S.bold}>Customer/Area/LSD: </span>
            {customer} / {area} / {lsd}
          </div>

          {/* ── Date + Time ── */}
          <div style={{ marginBottom: '2px' }}>
            <span style={S.bold}>Date: </span>{fmt(d.date || record?.spray_date)}
            <span style={{ ...S.bold, marginLeft: '32px' }}>Time: </span>{fmt(d.time)}
          </div>

          {/* ── Applicators ── */}
          <div style={{ marginBottom: '6px' }}>
            <span style={S.bold}>Applicators: </span>{fmt(d.applicators)}
          </div>

          {/* ── Wind Direction/Speed | Location Type ── */}
          <div style={S.row}>
            <div style={S.cell()}>
              <div style={S.label}>Wind Direction/Speed:</div>
              <div style={S.normal}>{windText}</div>
            </div>
            <div style={S.cell()}>
              <div style={S.label}>Location Type:</div>
              <div style={S.normal}>{fmt(d.locationTypes)}</div>
            </div>
          </div>

          {/* ── Temperature ── */}
          <div style={S.row}>
            <div style={S.cell()}>
              <span style={S.label}>Temp: </span>
              <span style={S.normal}>{d.temperature ? `${d.temperature}°C` : '—'}</span>
            </div>
            <div style={S.cell()}></div>
          </div>

          {/* ── Noxious Weeds ── */}
          <div style={S.row}>
            <div style={S.cell()}>
              <div style={S.label}>Noxious Weeds:</div>
              <div style={S.normal}>{fmt(d.noxiousWeedsSelected)}</div>
            </div>
            <div style={S.cell()}></div>
          </div>

          {/* ── Products Applied ── */}
          <div style={S.row}>
            <div style={{ ...S.cell(), flex: 2 }}>
              <div style={S.label}>Products Applied:</div>
              <div style={S.normal}>{fmt(d.herbicidesUsed)}</div>
            </div>
          </div>

          {/* ── Area Treated / Total Product ── */}
          <div style={{ ...S.row, ...S.cell() }}>
            <span style={S.label}>Area Treated: </span>
            <span style={{ ...S.normal, marginRight: '24px' }}>{fmt(d.areaTreated, '___')} ha</span>
            <span style={S.label}>Total Product: </span>
            <span style={S.normal}>{fmt(d.totalLiters, '___')} L</span>
          </div>

          {/* ── Total Distance Sprayed (if present) ── */}
          {d.totalDistanceSprayed ? (
            <div style={{ ...S.row, ...S.cell() }}>
              <span style={S.label}>Total Distance Sprayed: </span>
              <span style={S.normal}>{d.totalDistanceSprayed} m</span>
            </div>
          ) : null}

          {/* ── Spray Type / Spray Method ── */}
          <div style={S.row}>
            <div style={S.cell()}>
              <div style={S.label}>Spray Type:</div>
              <div style={S.normal}>{fmt(d.sprayType)}</div>
            </div>
            <div style={S.cell()}>
              <div style={S.label}>Spray Method:</div>
              <div style={S.normal}>{fmt(d.sprayMethod)}</div>
            </div>
          </div>

          {/* ── Roadside Details (if applicable) ── */}
          {showRoadside ? (
            <div style={{ ...S.row, ...S.cell() }}>
              <div>
                <div style={S.label}>Roadside Details:</div>
                <div style={S.normal}>
                  Distance: {fmt(d.roadsideKm, '___')} km &nbsp; Herbicides: {fmt(d.roadsideHerbicides)}
                </div>
                <div style={S.normal}>
                  Liters: {fmt(d.roadsideLiters, '___')} L &nbsp; Area: {fmt(d.roadsideAreaTreated, '___')} ha
                </div>
              </div>
            </div>
          ) : null}

          {/* ── Comments ── */}
          <div style={{ ...S.row, ...S.cell(), minHeight: '40px' }}>
            <div>
              <div style={S.label}>Comments:</div>
              <div style={S.normal}>{d.comments || ''}</div>
            </div>
          </div>

          {/* ── Photos ── */}
          {d.photos?.length ? (
            <div style={{ marginTop: '8px' }}>
              <div style={S.label}>Photos:</div>
              <div style={{ display: 'flex', gap: '12px', marginTop: '6px', flexWrap: 'wrap' }}>
                {d.photos.slice(0, 2).map((photo, i) => (
                  <div key={`photo-${i}`} style={{ textAlign: 'center' }}>
                    <img
                      src={`data:${photo.type || 'image/jpeg'};base64,${photo.data}`}
                      alt={`Photo ${i + 1}`}
                      style={{ maxWidth: '240px', maxHeight: '240px', objectFit: 'contain', border: '0.5px solid #999' }}
                    />
                    <div style={{ fontSize: '7pt', color: '#666', marginTop: '2px' }}>
                      {i === 0 ? 'LSD / Location ID' : 'Site Photo'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

        </div>
      </div>
    </div>
  );
}
