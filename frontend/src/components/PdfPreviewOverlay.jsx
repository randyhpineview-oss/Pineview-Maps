import { useEffect, useState } from 'react';
import { api } from '../lib/api';
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
  const [pdfBytes, setPdfBytes] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Fetch the real Dropbox PDF via the backend proxy (avoids browser-side
  // CORS issues and means we don't have to drag base64 photos through the API).
  useEffect(() => {
    if (!record) return;
    if (!record.pdf_url) {
      setError('This record has no uploaded PDF yet.');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    setLoading(true);
    setError(null);
    setPdfBytes(null);

    (async () => {
      try {
        const bytes = await api.fetchPdfBytes(record.pdf_url, controller.signal);
        if (!cancelled) {
          setPdfBytes(bytes);
          setLoading(false);
        }
      } catch (err) {
        if (cancelled || err?.name === 'AbortError') return;
        console.error('[PdfPreviewOverlay] PDF fetch failed:', err);
        setError(err?.message || 'Could not load PDF.');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [record?.id, record?.pdf_url]);

  // Print handler: open PDF in a new window and trigger browser print dialog
  const handlePrint = () => {
    if (!pdfBytes || pdfBytes.length === 0) return;
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const printWindow = window.open(url, '_blank');
    if (printWindow) {
      printWindow.onload = () => {
        printWindow.print();
        // Clean up the blob URL after print dialog closes
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
    } else {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      zIndex: 50, backgroundColor: '#4b5563', display: 'flex', flexDirection: 'column',
    }}>
      {/* ── Toolbar ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 16px', background: 'var(--surface-elev)', borderBottom: '1px solid var(--border-card)',
        gap: '8px', flexShrink: 0,
      }}>
        <span style={{ color: 'var(--text-card)', fontWeight: 600, flex: 1, fontSize: '0.95rem' }}>
          Lease Sheet {ticket ? `— ${ticket}` : ''}
        </span>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {pdfBytes ? (
            <button onClick={handlePrint}
              style={{ background: 'none', border: 'none', color: 'var(--link-card)', fontSize: '0.85rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Print
            </button>
          ) : null}
          {directUrl ? (
            <a href={directUrl} target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--link-card)', fontSize: '0.85rem', textDecoration: 'none', whiteSpace: 'nowrap' }}>
              Open PDF ↗
            </a>
          ) : null}
        </div>
        <button onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--text-card-muted)', fontSize: '1.5rem', cursor: 'pointer' }}>
          ×
        </button>
      </div>

      {/* ── PDF viewer ── */}
      {error ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '20px', textAlign: 'center' }}>
          <div style={{ color: '#f87171' }}>{error}</div>
          {directUrl ? (
            <a href={directUrl} target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--link-card)', fontSize: '0.9rem' }}>
              Open PDF in a new tab ↗
            </a>
          ) : null}
        </div>
      ) : pdfBytes ? (
        <PdfPreviewViewer pdfBytes={pdfBytes} />
      ) : loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-card-muted)' }}>
          Loading PDF…
        </div>
      ) : null}
    </div>
  );
}
