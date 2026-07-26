import { useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Point the worker to the bundled worker file
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href;

// Zoom model: pages are rendered at fit-to-width, so zoom=1 is the floor
// (full-width page fit). Users can pinch/Ctrl+scroll above 1 to inspect
// detail; zooming out past fit-width is blocked so multi-page PDFs stay
// one-finger scrollable via the container's native overflow.
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

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
    zoom: 1,       // current zoom multiplier (1 = fit-to-width; also the minimum)
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
  // transformOrigin is '0 0' (top-left), so the transform is simply:
  //   translate(panX, panY) scale(zoom)
  // where panX/panY are in CSS pixels relative to the wrapper's own
  // top-left corner. This makes the pinch math straightforward: no
  // origin offset needs to be subtracted.
  const applyTransform = useCallback(() => {
    const wrap = pagesWrapperRef.current;
    const container = containerRef.current;
    if (!wrap || !container) return;
    const s = stateRef.current;

    // Clamp pan so at least `margin` px of the (scaled) wrapper stays
    // visible inside the container on every edge. This prevents the PDF
    // from being dragged/pinched completely off-screen.
    const margin = 60; // px — minimum strip that must remain on-screen
    const cW = container.clientWidth;
    const cH = container.clientHeight;
    const wW = (s.canvasW || wrap.offsetWidth  || cW) * s.zoom;
    const wH = (s.canvasH || wrap.offsetHeight || cH) * s.zoom;

    // Maximum pan: can slide right/down until left/top edge is `margin` from right/bottom
    const maxX =  cW - margin;
    const maxY =  cH - margin;
    // Minimum pan: can slide left/up until right/bottom edge is `margin` from left/top
    const minX = -(wW - margin);
    const minY = -(wH - margin);

    s.panX = Math.max(minX, Math.min(maxX, s.panX));
    s.panY = Math.max(minY, Math.min(maxY, s.panY));

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
        // Single-finger pan only when zoomed in. At fit-width (zoom=1),
        // leave the gesture to native overflow scroll (touch-action: pan-y).
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
        const newZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, s.pinchStartZoom * (dist / s.pinchStartDist))
        );

        // Zoom toward the pinch midpoint.
        // With transformOrigin='0 0', the math is:
        //   newPan = startPan + (midDelta) + pinchMidInWrapperSpace * (1 - zoomRatio)
        // where pinchMidInWrapperSpace is the midpoint expressed in the
        // wrapper's pre-transform coordinate space:
        //   pinchMidInWrapper = (clientMid - wrapperRect.topLeft - startPan) / startZoom
        // Multiplying back by startZoom and rewriting gives the compact form below.
        const rect = container.getBoundingClientRect();
        // Pinch midpoint relative to wrapper origin (in screen px, before transform)
        const midInContainerX = s.pinchMidX - rect.left;
        const midInContainerY = s.pinchMidY - rect.top;
        const ratio = newZoom / s.pinchStartZoom;

        s.zoom = newZoom;
        if (newZoom <= MIN_ZOOM) {
          // At fit-width: clear pan so native one-finger vertical scroll works.
          s.panX = 0;
          s.panY = 0;
        } else {
          // Keep the pinch midpoint anchored in place, and also follow any
          // translation of the midpoint as both fingers move together.
          s.panX = midInContainerX - ratio * (midInContainerX - s.pinchStartPanX) + (mid.x - s.pinchMidX);
          s.panY = midInContainerY - ratio * (midInContainerY - s.pinchStartPanY) + (mid.y - s.pinchMidY);
        }
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

      // Snap back to fit-width (zoom=1) when close, clearing pan so native
      // one-finger vertical scroll works for multi-page PDFs.
      if (!s.pinching && s.zoom < 1.05) {
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
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s.zoom * factor));

      // Same anchor math as pinch — zoom toward the cursor.
      const rect = container.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const ratio = newZoom / s.zoom;

      if (newZoom <= MIN_ZOOM) {
        s.zoom = 1;
        s.panX = 0;
        s.panY = 0;
      } else {
        s.panX = cursorX - ratio * (cursorX - s.panX);
        s.panY = cursorY - ratio * (cursorY - s.panY);
        s.zoom = newZoom;
        if (s.zoom < 1.05) { s.zoom = 1; s.panX = 0; s.panY = 0; }
      }
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
          // transformOrigin '0 0' makes the pinch/zoom math exact —
          // pan values directly express the wrapper's top-left translation.
          transformOrigin: '0 0',
        }}
      />
    </div>
  );
}
