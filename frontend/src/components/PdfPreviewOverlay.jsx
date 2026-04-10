import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/$/, '') || '';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

export default function PdfPreviewOverlay({ pdfUrl, onClose }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  // Refs for gesture tracking
  const containerRef = useRef(null);
  const isPanning = useRef(false);
  const lastTouch = useRef(null);
  const lastPinchDist = useRef(null);
  const lastPinchZoom = useRef(1);

  // Fetch PDF via backend proxy
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

  // Double-tap to reset zoom
  const lastTapTime = useRef(0);
  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapTime.current < 300) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
    lastTapTime.current = now;
  }, []);

  // Touch handlers for pinch-to-zoom and pan
  const handleTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      // Pinch start
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDist.current = Math.hypot(dx, dy);
      lastPinchZoom.current = zoom;
      e.preventDefault();
    } else if (e.touches.length === 1 && zoom > 1) {
      // Pan start (only when zoomed in)
      isPanning.current = true;
      lastTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, [zoom]);

  const handleTouchMove = useCallback((e) => {
    if (e.touches.length === 2 && lastPinchDist.current !== null) {
      // Pinch zoom
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const scale = dist / lastPinchDist.current;
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, lastPinchZoom.current * scale));
      setZoom(newZoom);
      e.preventDefault();
    } else if (e.touches.length === 1 && isPanning.current && lastTouch.current) {
      // Pan
      const dx = e.touches[0].clientX - lastTouch.current.x;
      const dy = e.touches[0].clientY - lastTouch.current.y;
      setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      lastTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      e.preventDefault();
    }
  }, []);

  const handleTouchEnd = useCallback((e) => {
    if (e.touches.length < 2) {
      lastPinchDist.current = null;
    }
    if (e.touches.length === 0) {
      isPanning.current = false;
      lastTouch.current = null;
      handleDoubleTap();
    }
  }, [handleDoubleTap]);

  // Mouse wheel zoom (desktop)
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom(z => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta)));
  }, []);

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
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #374151', gap: '8px', flexShrink: 0 }}>
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

      {/* Content area */}
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
        <div
          ref={containerRef}
          style={{
            flex: 1,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <div style={{
            width: '100%',
            height: '100%',
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center top',
          }}>
            <iframe
              src={blobUrl}
              style={{ width: '100%', height: '100%', border: 'none', pointerEvents: 'none' }}
              title="PDF Preview"
            />
          </div>
          {/* Transparent touch layer on top of iframe to capture pinch/pan gestures */}
          <div
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onWheel={handleWheel}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 2,
              touchAction: 'none',
            }}
          />
        </div>
      )}
    </div>
  );
}
