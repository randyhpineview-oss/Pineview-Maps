import { useState, useEffect } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/$/, '') || '';

export default function PdfPreviewOverlay({ pdfUrl, onClose }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;

    async function fetchPdf() {
      setLoading(true);
      setError(null);
      try {
        const token = localStorage.getItem('supabase-access-token');
        const proxyUrl = `${API_BASE_URL}/api/pdf-proxy?url=${encodeURIComponent(pdfUrl)}`;
        const resp = await fetch(proxyUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
        const blob = await resp.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchPdf();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pdfUrl]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  // Build a direct Dropbox download link for "Open in tab" fallback
  let directUrl = pdfUrl;
  if (directUrl.includes('dropbox.com')) {
    directUrl = directUrl
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      .replace('&dl=0', '').replace('?dl=0', '?').replace('dl=1', '').replace(/[?&]$/, '');
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 50,
      backgroundColor: '#1f2937',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #374151', gap: '8px' }}>
        <span style={{ color: '#f9fafb', fontWeight: 600, flex: 1 }}>PDF Preview</span>
        <a
          href={directUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#60a5fa', fontSize: '0.85rem', textDecoration: 'none', whiteSpace: 'nowrap' }}
        >Open in tab ↗</a>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer', marginLeft: '4px' }}
        >×</button>
      </div>

      {loading && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
          <span>Loading PDF…</span>
        </div>
      )}

      {error && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#f87171', gap: '12px', padding: '20px' }}>
          <span>Failed to load PDF</span>
          <a
            href={directUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#60a5fa', fontSize: '0.9rem' }}
          >Open PDF in browser ↗</a>
        </div>
      )}

      {blobUrl && !loading && (
        <iframe
          src={blobUrl}
          style={{ flex: 1, border: 'none', width: '100%' }}
          title="PDF Preview"
        />
      )}
    </div>
  );
}
