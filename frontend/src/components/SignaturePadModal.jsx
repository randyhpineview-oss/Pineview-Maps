import { useEffect, useRef, useState } from 'react';

/**
 * Full-screen signature draw pad modal using native <canvas> + pointer events.
 * onSave receives the signature as a base64 PNG data URL (prefixed with `data:image/png;base64,`),
 * minus the `data:image/png;base64,` prefix — i.e., raw base64 suitable for storage and PDF embedding.
 *
 * Props:
 *   - isOpen, onClose, onSave: usual modal controls. onSave(base64, dataUrl).
 *   - existingSignature: base64 or data URL to pre-draw on open (e.g. previously-saved
 *     approved_signature from this ticket). Wins over the device-local saved signature.
 *   - storageKey: optional localStorage key for the "Save as default signature" feature.
 *     When present and `existingSignature` is falsy, the saved signature is loaded on
 *     open; checking "Save as my default signature" before Save persists the drawing.
 */
export default function SignaturePadModal({
  isOpen,
  onClose,
  onSave,
  existingSignature = null,
  storageKey = null,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [hasSavedDefault, setHasSavedDefault] = useState(false);

  // Read whether we have a saved-default signature whenever the modal opens.
  useEffect(() => {
    if (!isOpen || !storageKey) { setHasSavedDefault(false); return; }
    try {
      setHasSavedDefault(!!localStorage.getItem(storageKey));
    } catch {
      setHasSavedDefault(false);
    }
  }, [isOpen, storageKey]);

  // Resize the canvas to fit its container while preserving the drawing
  useEffect(() => {
    if (!isOpen) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111';
      // White background
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      // Restore existing signature if provided; otherwise fall back to the
      // device-local saved signature (if any).
      let source = existingSignature;
      if (!source && storageKey) {
        try {
          source = localStorage.getItem(storageKey);
        } catch {
          source = null;
        }
      }
      if (source) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, width, height);
        img.src = source.startsWith('data:')
          ? source
          : `data:image/png;base64,${source}`;
        setHasDrawn(true);
      }
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [isOpen, existingSignature, storageKey]);

  if (!isOpen) return null;

  const getPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX ?? e.touches?.[0]?.clientX;
    const cy = e.clientY ?? e.touches?.[0]?.clientY;
    return { x: cx - rect.left, y: cy - rect.top };
  };

  const handleStart = (e) => {
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    setIsDrawing(true);
    setHasDrawn(true);
  };

  const handleMove = (e) => {
    if (!isDrawing) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const handleEnd = (e) => {
    e.preventDefault();
    setIsDrawing(false);
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    setHasDrawn(false);
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    if (saveAsDefault && storageKey) {
      try {
        localStorage.setItem(storageKey, base64);
      } catch (e) {
        console.warn('[SignaturePad] Could not save signature to localStorage:', e?.message);
      }
    }
    onSave?.(base64, dataUrl);
  };

  const handleClearSaved = () => {
    if (!storageKey) return;
    try {
      localStorage.removeItem(storageKey);
    } catch { /* ignore */ }
    setHasSavedDefault(false);
    setSaveAsDefault(false);
    handleClear();
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      zIndex: 100,
      background: 'rgba(0,0,0,0.85)',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', color: '#f9fafb', fontWeight: 600, fontSize: '1rem', background: '#1f2937', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Sign & Approve</span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}
        >
          ×
        </button>
      </div>

      {/* Canvas area */}
      <div
        ref={containerRef}
        style={{ flex: 1, margin: '16px', background: '#fff', borderRadius: '8px', touchAction: 'none', overflow: 'hidden' }}
      >
        <canvas
          ref={canvasRef}
          onMouseDown={handleStart}
          onMouseMove={handleMove}
          onMouseUp={handleEnd}
          onMouseLeave={handleEnd}
          onTouchStart={handleStart}
          onTouchMove={handleMove}
          onTouchEnd={handleEnd}
          style={{ cursor: 'crosshair', display: 'block' }}
        />
      </div>

      {/* Save-as-default checkbox + clear-saved link */}
      {storageKey ? (
        <div style={{
          padding: '8px 16px',
          background: '#1f2937',
          color: '#9ca3af',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '0.85rem',
          flexWrap: 'wrap',
          gap: '8px',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={saveAsDefault}
              onChange={(e) => setSaveAsDefault(e.target.checked)}
            />
            Save as my default signature
          </label>
          {hasSavedDefault ? (
            <button
              type="button"
              onClick={handleClearSaved}
              style={{ background: 'transparent', color: '#f87171', border: 'none', cursor: 'pointer', fontSize: '0.8rem', padding: 0, textDecoration: 'underline' }}
            >
              Clear saved signature
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Footer buttons */}
      <div style={{ padding: '12px 16px', display: 'flex', gap: '10px', background: '#1f2937' }}>
        <button
          onClick={handleClear}
          style={{ flex: 1, padding: '12px', background: '#374151', color: '#f9fafb', border: 'none', borderRadius: '8px', fontSize: '1rem', cursor: 'pointer' }}
        >
          Clear
        </button>
        <button
          onClick={handleSave}
          disabled={!hasDrawn}
          style={{
            flex: 2,
            padding: '12px',
            background: hasDrawn ? '#22c55e' : '#374151',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '1rem',
            fontWeight: 600,
            cursor: hasDrawn ? 'pointer' : 'not-allowed',
          }}
        >
          Save & Approve
        </button>
      </div>
    </div>
  );
}
