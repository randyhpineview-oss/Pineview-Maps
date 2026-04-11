import { useEffect, useState } from 'react';
import { generateLeaseSheetPdf } from '../lib/pdfGenerator';
import PdfPreviewViewer from './PdfPreviewViewer';

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

export default function PdfPreviewOverlay({ record, onClose }) {
  const d = record?.lease_sheet_data || {};
  const directUrl = pdfLink(record?.pdf_url || null);
  const ticket = record?.ticket_number || d.ticket_number || '';
  const [pdfBase64, setPdfBase64] = useState(null);
  const [error, setError] = useState(null);

  // Regenerate PDF from stored lease_sheet_data
  useEffect(() => {
    if (!record) return;
    let cancelled = false;

    (async () => {
      try {
        // Build photo data URLs from embedded base64 photos
        const photos = d.photos || [];
        const photoDataUrls = photos.slice(0, 2).map(
          (p) => `data:${p.type || 'image/jpeg'};base64,${p.data}`
        );

        const pdfData = { ...d, ticket_number: ticket };
        const { base64 } = await generateLeaseSheetPdf(pdfData, photoDataUrls);
        if (!cancelled) setPdfBase64(base64);
      } catch (err) {
        console.error('[PdfPreviewOverlay] PDF generation failed:', err);
        if (!cancelled) setError('Could not generate PDF preview.');
      }
    })();

    return () => { cancelled = true; };
  }, [record]);

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      zIndex: 50, backgroundColor: '#4b5563', display: 'flex', flexDirection: 'column',
    }}>
      {/* ── Toolbar ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 16px', background: '#1f2937', borderBottom: '1px solid #374151',
        gap: '8px', flexShrink: 0,
      }}>
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

      {/* ── PDF viewer ── */}
      {error ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f87171' }}>
          {error}
        </div>
      ) : pdfBase64 ? (
        <PdfPreviewViewer pdfBase64={pdfBase64} />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
          Loading PDF...
        </div>
      )}
    </div>
  );
}
