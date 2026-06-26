import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getCachedPdf, putCachedPdf, deleteCachedPdf } from '../lib/offlineStore';
import PdfPreviewViewer from './PdfPreviewViewer';

function base64ToBytes(b64) {
  const raw = atob(b64);
  const u8 = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
  return u8;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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

export default function PdfPreviewOverlay({ record, onClose, canRegenerate = false, cachedLookups = null, onRegenerated = null }) {
  const d = record?.lease_sheet_data || {};
  const directUrl = pdfLink(record?.pdf_url || null);
  const ticket = record?.ticket_number || d.ticket_number || '';
  const [pdfBytes, setPdfBytes] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [regenMsg, setRegenMsg] = useState(null);
  // Bumped after a successful regen to force the fetch effect to re-run
  // against the freshly-uploaded Dropbox file instead of the stale cache.
  const [reloadToken, setReloadToken] = useState(0);

  // Fetch the real Dropbox PDF via the backend proxy (avoids browser-side
  // CORS issues and means we don't have to drag base64 photos through the API).
  useEffect(() => {
    if (!record) return;

    const controller = new AbortController();
    let cancelled = false;

    setLoading(true);
    setError(null);
    setPdfBytes(null);

    (async () => {
      // 1. Cache-first — by ticket number (cached at generation time, so the
      //    preview is instant right after submit even before Dropbox has the
      //    file) then by the Dropbox url (cached after a prior fetch).
      try {
        const cachedB64 =
          (ticket ? await getCachedPdf(`ticket:${ticket}`) : null) ||
          (record.pdf_url ? await getCachedPdf(`url:${record.pdf_url}`) : null);
        if (cachedB64 && !cancelled) {
          setPdfBytes(base64ToBytes(cachedB64));
          setLoading(false);
          return;
        }
      } catch { /* fall through to network */ }

      // 2. No local copy — need the Dropbox url to fetch via the proxy.
      if (!record.pdf_url) {
        if (!cancelled) {
          setError('This record has no uploaded PDF yet.');
          setLoading(false);
        }
        return;
      }

      try {
        const bytes = await api.fetchPdfBytes(record.pdf_url, controller.signal);
        if (!cancelled) {
          setPdfBytes(bytes);
          setLoading(false);
        }
        // Cache the fetched bytes so re-opening this record is instant.
        try { putCachedPdf(`url:${record.pdf_url}`, bytesToBase64(bytes)); } catch { /* non-fatal */ }
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
  }, [record?.id, record?.pdf_url, ticket, reloadToken]);

  // ── Regenerate PDF (admin recovery for previously-corrupted Dropbox files) ──
  // Earlier versions of the jsPDF pipeline called doc.output() twice (once for
  // blob, once for datauristring), and the two serializations could desync,
  // producing PDFs that opened fine in lenient readers but were rejected by
  // pdfjs. The on-disk Dropbox copy is permanently bad for those records.
  // This handler refetches the full record, re-runs the (now single-output)
  // generator, and PATCHes the record so the backend re-uploads a clean PDF
  // to Dropbox, replacing the corrupt one.
  //
  // Photos are NOT re-embedded — their base64 bytes are stripped server-side
  // before persisting (see _strip_photos_from_lease_data). This matches the
  // existing Approve & Edit regen path.
  const handleRegenerate = async () => {
    if (!record?.id || regenerating) return;
    setRegenerating(true);
    setRegenMsg('Regenerating PDF…');
    try {
      const full = await api.getSiteSprayRecord(record.id);
      const leaseData = full?.lease_sheet_data || {};
      const tn = full?.ticket_number || leaseData.ticket_number || ticket || '';

      // Re-hydrate photos. lease_sheet_data.photos[].data is stripped server
      // side (the binaries live in Dropbox), so we try in order:
      //   1. embedded data URLs (legacy records, pre-strip)
      //   2. record.photo_urls fetched through the photo proxy
      // and pass the resulting data URLs to the generator. Mirrors the edit
      // flow in HerbicideLeaseSheet.jsx so the regenerated PDF embeds the
      // same photos the worker originally submitted.
      let photoDataUrls = [];
      const embedded = Array.isArray(leaseData.photos)
        ? leaseData.photos
            .filter((p) => p && p.data)
            .map((p) => `data:${p.type || 'image/jpeg'};base64,${p.data}`)
        : [];
      if (embedded.length > 0) {
        photoDataUrls = embedded;
      } else if (Array.isArray(full?.photo_urls) && full.photo_urls.length > 0) {
        setRegenMsg(`Fetching photos (0/${full.photo_urls.length})…`);
        for (let i = 0; i < full.photo_urls.length; i++) {
          try {
            const { data, type } = await api.proxyPhoto(full.photo_urls[i]);
            photoDataUrls.push(`data:${type || 'image/jpeg'};base64,${data}`);
            setRegenMsg(`Fetching photos (${i + 1}/${full.photo_urls.length})…`);
          } catch (e) {
            console.warn('[PdfPreviewOverlay] photo proxy failed:', e?.message);
          }
        }
        setRegenMsg('Regenerating PDF…');
      }

      const { generateLeaseSheetPdf } = await import('../lib/pdfGenerator');
      const { base64 } = await generateLeaseSheetPdf(
        {
          ...leaseData,
          ticket_number: tn,
          herbicidesLookup: cachedLookups?.herbicides || [],
          applicatorsLookup: cachedLookups?.applicators || [],
        },
        photoDataUrls
      );

      const updated = await api.updateSiteSprayRecord(record.id, {
        pdf_base64: base64,
      });

      // Invalidate caches keyed by ticket and the old (and new) Dropbox URLs
      // so the next preview reads fresh bytes via the proxy.
      try {
        if (tn) await deleteCachedPdf(`ticket:${tn}`);
        if (record.pdf_url) await deleteCachedPdf(`url:${record.pdf_url}`);
        if (updated?.pdf_url && updated.pdf_url !== record.pdf_url) {
          await deleteCachedPdf(`url:${updated.pdf_url}`);
        }
      } catch { /* non-fatal */ }

      setRegenMsg('Done — reloading preview…');
      if (typeof onRegenerated === 'function') {
        try { onRegenerated(updated); } catch { /* parent refresh is best-effort */ }
      }
      setReloadToken((x) => x + 1);
      setTimeout(() => setRegenMsg(null), 2500);
    } catch (err) {
      console.error('[PdfPreviewOverlay] Regenerate failed:', err);
      setRegenMsg(`Regenerate failed: ${err?.message || 'unknown error'}`);
      setTimeout(() => setRegenMsg(null), 4000);
    } finally {
      setRegenerating(false);
    }
  };

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
        padding: '10px 16px', background: '#1f2937', borderBottom: '1px solid #374151',
        gap: '8px', flexShrink: 0,
      }}>
        <span style={{ color: '#f9fafb', fontWeight: 600, flex: 1, fontSize: '0.95rem' }}>
          Lease Sheet {ticket ? `— ${ticket}` : ''}
        </span>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {canRegenerate && record?.id ? (
            <button onClick={handleRegenerate} disabled={regenerating}
              title="Re-render this lease sheet's PDF and re-upload to Dropbox. Use this to repair PDFs that were corrupted by the old double-serialization bug."
              style={{
                background: 'none', border: '1px solid #f59e0b', color: '#fbbf24',
                fontSize: '0.8rem', padding: '4px 10px', borderRadius: 6,
                cursor: regenerating ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                opacity: regenerating ? 0.6 : 1,
              }}>
              {regenerating ? 'Regenerating…' : '↻ Regenerate PDF'}
            </button>
          ) : null}
          {pdfBytes ? (
            <button onClick={handlePrint}
              style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: '0.85rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Print
            </button>
          ) : null}
          {directUrl ? (
            <a href={directUrl} target="_blank" rel="noopener noreferrer"
              style={{ color: '#60a5fa', fontSize: '0.85rem', textDecoration: 'none', whiteSpace: 'nowrap' }}>
              Open PDF ↗
            </a>
          ) : null}
        </div>
        <button onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}>
          ×
        </button>
      </div>

      {/* ── Inline status banner for the regen action ── */}
      {regenMsg ? (
        <div style={{ padding: '8px 16px', background: '#111827', color: '#fbbf24', fontSize: '0.85rem', textAlign: 'center', borderBottom: '1px solid #374151' }}>
          {regenMsg}
        </div>
      ) : null}

      {/* ── PDF viewer ── */}
      {error ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '20px', textAlign: 'center' }}>
          <div style={{ color: '#f87171' }}>{error}</div>
          {canRegenerate && record?.id ? (
            <button onClick={handleRegenerate} disabled={regenerating}
              style={{
                background: '#f59e0b', border: 'none', color: '#111827',
                fontSize: '0.9rem', padding: '8px 16px', borderRadius: 6,
                cursor: regenerating ? 'wait' : 'pointer', fontWeight: 600,
                opacity: regenerating ? 0.6 : 1,
              }}>
              {regenerating ? 'Regenerating…' : '↻ Regenerate PDF & re-upload to Dropbox'}
            </button>
          ) : null}
          {directUrl ? (
            <a href={directUrl} target="_blank" rel="noopener noreferrer"
              style={{ color: '#60a5fa', fontSize: '0.9rem' }}>
              Open PDF in a new tab ↗
            </a>
          ) : null}
        </div>
      ) : pdfBytes ? (
        <PdfPreviewViewer pdfBytes={pdfBytes} />
      ) : loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: '#9ca3af' }}>
          <span aria-hidden="true" style={{ display: 'inline-block', width: 18, height: 18, border: '2px solid #374151', borderTopColor: '#60a5fa', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          Loading PDF…
        </div>
      ) : null}
    </div>
  );
}
