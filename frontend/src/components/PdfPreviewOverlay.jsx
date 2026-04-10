import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/$/, '') || '';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

export default function PdfPreviewOverlay({ pdfUrl, onClose }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Use refs for zoom/pan so touch callbacks always see current values
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const [, forceRender] = useState(0);
  const rerender = () => forceRender(n => n + 1);

  // Gesture refs
  const containerRef = useRef(null);
  const lastTouch = useRef(null);
  const lastPinchDist = useRef(null);
  const lastPinchZoom = useRef(1);
  const lastTapTime = useRef(0);

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

  // Touch handlers — all use refs so no stale closures
  const handleTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDist.current = Math.hypot(dx, dy);
      lastPinchZoom.current = zoomRef.current;
      lastTouch.current = null; // stop pan during pinch
      e.preventDefault();
    } else if (e.touches.length === 1) {
      lastTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, []);

  const handleTouchMove = useCallback((e) => {
    if (e.touches.length === 2 && lastPinchDist.current !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const scale = dist / lastPinchDist.current;
      zoomRef.current = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, lastPinchZoom.current * scale));
      rerender();
      e.preventDefault();
    } else if (e.touches.length === 1 && lastTouch.current && zoomRef.current > 1) {
      const dx = e.touches[0].clientX - lastTouch.current.x;
      const dy = e.touches[0].clientY - lastTouch.current.y;
      panRef.current = { x: panRef.current.x + dx, y: panRef.current.y + dy };
      lastTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      rerender();
      e.preventDefault();
    }
  }, []);

  const handleTouchEnd = useCallback((e) => {
    if (e.touches.length < 2) lastPinchDist.current = null;
    if (e.touches.length === 0) {
      lastTouch.current = null;
      // Double-tap to reset
      const now = Date.now();
      if (now - lastTapTime.current < 300) {
        zoomRef.current = 1;
        panRef.current = { x: 0, y: 0 };
        rerender();
      }
      lastTapTime.current = now;
      // Snap zoom back to 1 if close
      if (zoomRef.current < 1.05) {
        zoomRef.current = 1;
        panRef.current = { x: 0, y: 0 };
        rerender();
      }
    }
  }, []);

  // Mouse wheel zoom (desktop)
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.25 : 0.25;
    zoomRef.current = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomRef.current + delta));
    if (zoomRef.current <= 1) panRef.current = { x: 0, y: 0 };
    rerender();
  }, []);

  // Build a direct Dropbox download link for "Open in tab" fallback
  let directUrl = pdfUrl;
  if (directUrl.includes('dropbox.com')) {
    directUrl = directUrl
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      .replace('&dl=0', '').replace('?dl=0', '?').replace('dl=1', '').replace(/[?&]$/, '');
  }

  const zoom = zoomRef.current;
  const pan = panRef.current;

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
        <span style={{ color: '#f9fafb', fontWeight: 600, flex: 1 }}>Herbicide Lease Sheet</span>
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
            transformOrigin: '0 0',
          }}>
            <iframe
              src={blobUrl}
              style={{ width: '100%', height: '100%', border: 'none', pointerEvents: 'none' }}
              title="Herbicide Lease Sheet"
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
