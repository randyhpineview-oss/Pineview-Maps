import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Point the worker to the bundled worker file
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href;

/**
 * Renders a base64 PDF onto a canvas with pinch-to-zoom (mobile) and Ctrl+scroll (desktop).
 * Props:
 *   pdfBase64 - base64 string of the PDF (no data URI prefix)
 */
export default function PdfPreviewViewer({ pdfBase64 }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [pdfPage, setPdfPage] = useState(null);
  const [baseScale, setBaseScale] = useState(1);
  const renderTaskRef = useRef(null);

  // Track pinch state
  const pinchRef = useRef({ active: false, startDist: 0, startScale: 1 });
  const scaleRef = useRef(1);

  // Load the PDF page once
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
        if (!cancelled) {
          setPdfPage(page);
          // Calculate base scale so the PDF fills the container width
          const container = containerRef.current;
          if (container) {
            const viewport = page.getViewport({ scale: 1 });
            const fitScale = (container.clientWidth - 16) / viewport.width;
            setBaseScale(fitScale);
            setScale(fitScale);
            scaleRef.current = fitScale;
          }
        }
      } catch (err) {
        console.error('[PdfPreviewViewer] Failed to load PDF:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [pdfBase64]);

  // Render the page whenever scale or pdfPage changes
  useEffect(() => {
    if (!pdfPage || !canvasRef.current) return;

    // Cancel any in-flight render
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const viewport = pdfPage.getViewport({ scale });
    const outputScale = window.devicePixelRatio || 1;

    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';

    ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);

    const task = pdfPage.render({ canvasContext: ctx, viewport });
    renderTaskRef.current = task;
    task.promise.catch((err) => {
      if (err?.name !== 'RenderingCancelledException') {
        console.error('[PdfPreviewViewer] Render error:', err);
      }
    });
  }, [pdfPage, scale]);

  // Ctrl + scroll wheel zoom (desktop)
  const handleWheel = useCallback((e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setScale((prev) => {
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const next = prev * delta;
      return Math.max(baseScale * 0.5, Math.min(baseScale * 5, next));
    });
  }, [baseScale]);

  // Keep scaleRef in sync
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  // Pinch-to-zoom (mobile)
  const getTouchDist = (touches) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Attach non-passive touch + wheel listeners so preventDefault works in PWA
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        pinchRef.current = {
          active: true,
          startDist: getTouchDist(e.touches),
          startScale: scaleRef.current,
        };
      }
    };

    const onTouchMove = (e) => {
      if (!pinchRef.current.active || e.touches.length !== 2) return;
      e.preventDefault();
      const dist = getTouchDist(e.touches);
      const ratio = dist / pinchRef.current.startDist;
      const next = pinchRef.current.startScale * ratio;
      const bs = baseScale || 1;
      const clamped = Math.max(bs * 0.5, Math.min(bs * 5, next));
      setScale(clamped);
    };

    const onTouchEnd = () => {
      pinchRef.current.active = false;
    };

    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);
    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('wheel', handleWheel);
    };
  }, [handleWheel, baseScale]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflow: 'auto',
        WebkitOverflowScrolling: 'touch',
        touchAction: 'none',
        display: 'flex',
        justifyContent: 'center',
        padding: '8px',
        background: '#4b5563',
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block', margin: '0 auto' }} />
    </div>
  );
}
