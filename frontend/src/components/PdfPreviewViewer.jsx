import { useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Point the worker to the bundled worker file
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href;

/**
 * Renders a PDF (one canvas per page, stacked vertically) with pinch-to-zoom
 * + pan (mobile) and Ctrl+scroll zoom (desktop). Zoom is centered on the
 * pinch midpoint and applies to the whole stack via a transformed wrapper.
 *
 * Accepts either:
 *   - `pdfBase64`: base64-encoded PDF string (existing callers).
 *   - `pdfBytes`:  raw Uint8Array of PDF bytes (preferred — no base64 round-trip).
 *
 * If both are provided, `pdfBytes` wins.
 */
export default function PdfPreviewViewer({ pdfBase64, pdfBytes }) {
  // Wrapper that holds one <canvas> per page. Transform (zoom/pan) is
  // applied to the wrapper so every page scales together and the
  // scrollable container keeps vertical scroll for reading through pages.
  const pagesWrapperRef = useRef(null);
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

  // ── Apply CSS transform to the pages wrapper ──
  const applyTransform = useCallback(() => {
    const wrap = pagesWrapperRef.current;
    if (!wrap) return;
    const s = stateRef.current;
    // Only apply transform when zoomed — at 1x with no pan, remove it
    // entirely so each page canvas renders at native resolution (no GPU
    // layer blur). The wrapper covers the whole stack so every page
    // zooms/pans together.
    if (s.zoom <= 1.001 && Math.abs(s.panX) < 1 && Math.abs(s.panY) < 1) {
      wrap.style.transform = '';
    } else {
      wrap.style.transform = `translate(${s.panX}px, ${s.panY}px) scale(${s.zoom})`;
    }
  }, []);

  // ── Load PDF and render every page onto its own canvas, stacked ──
  useEffect(() => {
    // Resolve the input: prefer pdfBytes (Uint8Array), fall back to base64.
    let uint8 = null;
    if (pdfBytes && pdfBytes.length > 0) {
      uint8 = pdfBytes;
    } else if (pdfBase64) {
      const raw = atob(pdfBase64);
      uint8 = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) uint8[i] = raw.charCodeAt(i);
    }
    if (!uint8) return;

    let cancelled = false;
    // Hold the loading task so we can destroy it if the component unmounts early
    let loadingTask = null;

    (async () => {
      try {
        // pdfjs will consume the buffer — pass a fresh copy so the caller's
        // Uint8Array isn't detached if they reuse it.
        loadingTask = pdfjsLib.getDocument({ data: uint8.slice() });
        const pdf = await loadingTask.promise;
        if (cancelled) return;

        const container = containerRef.current;
        const wrap = pagesWrapperRef.current;
        if (!container || !wrap) return;

        // Clear any prior render (e.g. when a different PDF replaces this one
        // while the component stays mounted).
        wrap.innerHTML = '';

        // Fit every page's WIDTH to the scroll container. Each page is
        // re-measured independently so mixed-size PDFs still render each
        // page at its native aspect ratio.
        const containerW = container.clientWidth - 16;
        const dpr = window.devicePixelRatio || 1;
        const pageGap = 8;  // px — thin gray gap between pages
        let totalCssH = 0;
        let maxCssW = 0;

        for (let p = 1; p <= pdf.numPages; p++) {
          if (cancelled) return;
          const page = await pdf.getPage(p);
          const vp1 = page.getViewport({ scale: 1 });
          const fitScale = containerW / vp1.width;
          const renderVP = page.getViewport({ scale: fitScale * dpr });

          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(renderVP.width);
          canvas.height = Math.floor(renderVP.height);
          const cssW = Math.floor(renderVP.width / dpr);
          const cssH = Math.floor(renderVP.height / dpr);
          canvas.style.display = 'block';
          canvas.style.width = cssW + 'px';
          canvas.style.height = cssH + 'px';
          // Page separator: thin gap between pages so the break is visible.
          if (p > 1) canvas.style.marginTop = pageGap + 'px';
          wrap.appendChild(canvas);

          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport: renderVP }).promise;

          totalCssH += cssH + (p > 1 ? pageGap : 0);
          if (cssW > maxCssW) maxCssW = cssW;
        }

        // Track wrapper dimensions for any future clamp logic (currently
        // unused by pan/zoom handlers, but kept for parity with the old
        // single-canvas implementation).
        stateRef.current.canvasW = maxCssW;
        stateRef.current.canvasH = totalCssH;
      } catch (err) {
        if (!cancelled) console.error('[PdfPreviewViewer] Failed to load PDF:', err);
      }
    })();

    return () => {
      cancelled = true;
      if (loadingTask) {
        try { loadingTask.destroy(); } catch { /* ignore */ }
      }
    };
  }, [pdfBase64, pdfBytes]);

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
        const newZoom = Math.max(0.5, Math.min(5, s.pinchStartZoom * (dist / s.pinchStartDist)));

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

      // Snap back to zoom=1 if close (but only when zoomed IN toward 1;
      // allow zoom-out below 1 for small-screen viewing).
      if (!s.pinching && s.zoom > 1 && s.zoom < 1.05) {
        s.zoom = 1;
        s.panX = 0;
        s.panY = 0;
        applyTransform();
      }
    };

    // Ctrl + scroll wheel zoom (desktop) — zoom toward cursor.
    // Without Ctrl: let the browser scroll the container vertically.
    const onWheel = (e) => {
      if (!e.ctrlKey) return;  // no preventDefault → default scroll behavior
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.5, Math.min(5, s.zoom * factor));

      const rect = container.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const ratio = newZoom / s.zoom;

      s.panX = s.panX * ratio + cx * (1 - ratio);
      s.panY = s.panY * ratio + cy * (1 - ratio);
      s.zoom = newZoom;

      // Snap to 1 only when zooming back IN from above 1.
      if (s.zoom > 1 && s.zoom < 1.05) { s.zoom = 1; s.panX = 0; s.panY = 0; }
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
        overflowX: 'hidden',
        overflowY: 'auto',
        // pan-y so vertical scroll still works on touch devices; pinch-zoom
        // handled manually via non-passive touch listeners.
        touchAction: 'pan-y',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: '8px',
        background: '#4b5563',
        position: 'relative',
      }}
    >
      <div
        ref={pagesWrapperRef}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          // Transform origin at top-center so zoom stays anchored to the
          // visible top of the PDF regardless of which page the user is on.
          transformOrigin: 'center top',
        }}
      />
    </div>
  );
}
