import { useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Point the worker to the bundled worker file
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href;

/**
 * Renders a base64 PDF onto a canvas with pinch-to-zoom + pan (mobile)
 * and Ctrl+scroll zoom (desktop). Zoom is centered on the pinch midpoint.
 */
export default function PdfPreviewViewer({ pdfBase64 }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  // All mutable transform state lives in a ref to avoid re-renders during gestures
  const stateRef = useRef({
    // CSS transform values
    zoom: 1,       // current zoom multiplier (1 = fit-to-width)
    panX: 0,       // px offset
    panY: 0,
    // Pinch tracking
    pinching: false,
    pinchStartDist: 0,
    pinchStartZoom: 1,
    pinchMidX: 0,
    pinchMidY: 0,
    pinchStartPanX: 0,
    pinchStartPanY: 0,
    // Single-finger pan tracking
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartPanX: 0,
    dragStartPanY: 0,
    // Canvas dimensions at zoom=1 (for clamping)
    canvasW: 0,
    canvasH: 0,
  });

  // ── Apply CSS transform to canvas ──
  const applyTransform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = stateRef.current;
    // Only apply transform when zoomed — at 1x, remove it entirely so the
    // browser renders the canvas at native resolution (no GPU layer blur).
    if (s.zoom <= 1.001 && Math.abs(s.panX) < 1 && Math.abs(s.panY) < 1) {
      canvas.style.transform = '';
    } else {
      canvas.style.transform = `translate(${s.panX}px, ${s.panY}px) scale(${s.zoom})`;
    }
  }, []);

  // ── Load PDF and render once at high-res ──
  useEffect(() => {
    if (!pdfBase64) return;
    let cancelled = false;

    (async () => {
      try {
        const raw = atob(pdfBase64);
        const uint8 = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) uint8[i] = raw.charCodeAt(i);

        const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
        const page = await pdf.getPage(1);
        if (cancelled) return;

        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;

        // Fit PDF width to container
        const vp1 = page.getViewport({ scale: 1 });
        const containerW = container.clientWidth - 16;
        const fitScale = containerW / vp1.width;

        // Render at full DPR resolution natively through PDF.js
        const dpr = window.devicePixelRatio || 1;
        const renderVP = page.getViewport({ scale: fitScale * dpr });

        canvas.width = Math.floor(renderVP.width);
        canvas.height = Math.floor(renderVP.height);
        // CSS display size = render size / dpr
        const cssW = Math.floor(renderVP.width / dpr);
        const cssH = Math.floor(renderVP.height / dpr);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';

        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: renderVP }).promise;

        stateRef.current.canvasW = cssW;
        stateRef.current.canvasH = cssH;
      } catch (err) {
        console.error('[PdfPreviewViewer] Failed to load PDF:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [pdfBase64]);

  // ── Helpers ──
  const getDist = (t) => {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getMid = (t) => ({
    x: (t[0].clientX + t[1].clientX) / 2,
    y: (t[0].clientY + t[1].clientY) / 2,
  });

  // ── Attach non-passive touch + wheel listeners ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const s = stateRef.current;

    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const mid = getMid(e.touches);
        s.pinching = true;
        s.dragging = false;
        s.pinchStartDist = getDist(e.touches);
        s.pinchStartZoom = s.zoom;
        s.pinchMidX = mid.x;
        s.pinchMidY = mid.y;
        s.pinchStartPanX = s.panX;
        s.pinchStartPanY = s.panY;
      } else if (e.touches.length === 1 && s.zoom > 1.01) {
        // Single-finger pan only when zoomed in
        s.dragging = true;
        s.dragStartX = e.touches[0].clientX;
        s.dragStartY = e.touches[0].clientY;
        s.dragStartPanX = s.panX;
        s.dragStartPanY = s.panY;
      }
    };

    const onTouchMove = (e) => {
      if (s.pinching && e.touches.length === 2) {
        e.preventDefault();
        const dist = getDist(e.touches);
        const mid = getMid(e.touches);
        const newZoom = Math.max(1, Math.min(5, s.pinchStartZoom * (dist / s.pinchStartDist)));

        // Zoom toward pinch center: adjust pan so the midpoint stays fixed
        const rect = container.getBoundingClientRect();
        const cx = s.pinchMidX - rect.left - rect.width / 2;
        const cy = s.pinchMidY - rect.top - rect.height / 2;
        const ratio = newZoom / s.pinchStartZoom;

        s.zoom = newZoom;
        s.panX = s.pinchStartPanX + (mid.x - s.pinchMidX) + cx * (1 - ratio);
        s.panY = s.pinchStartPanY + (mid.y - s.pinchMidY) + cy * (1 - ratio);
        applyTransform();
      } else if (s.dragging && e.touches.length === 1) {
        e.preventDefault();
        s.panX = s.dragStartPanX + (e.touches[0].clientX - s.dragStartX);
        s.panY = s.dragStartPanY + (e.touches[0].clientY - s.dragStartY);
        applyTransform();
      }
    };

    const onTouchEnd = (e) => {
      if (e.touches.length < 2) s.pinching = false;
      if (e.touches.length < 1) s.dragging = false;

      // Snap back to zoom=1 if close
      if (!s.pinching && s.zoom < 1.05) {
        s.zoom = 1;
        s.panX = 0;
        s.panY = 0;
        applyTransform();
      }
    };

    // Ctrl + scroll wheel zoom (desktop) — zoom toward cursor
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(1, Math.min(5, s.zoom * factor));

      const rect = container.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const ratio = newZoom / s.zoom;

      s.panX = s.panX * ratio + cx * (1 - ratio);
      s.panY = s.panY * ratio + cy * (1 - ratio);
      s.zoom = newZoom;

      if (s.zoom < 1.05) { s.zoom = 1; s.panX = 0; s.panY = 0; }
      applyTransform();
    };

    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);
    container.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('wheel', onWheel);
    };
  }, [applyTransform]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflow: 'hidden',
        touchAction: 'none',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: '8px',
        background: '#4b5563',
        position: 'relative',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          transformOrigin: 'center top',
        }}
      />
    </div>
  );
}
