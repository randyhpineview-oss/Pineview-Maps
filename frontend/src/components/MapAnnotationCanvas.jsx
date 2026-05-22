import { useEffect, useRef, useState } from 'react';

/**
 * Lightweight annotation canvas — 3 background modes, 2 draw modes,
 * 10 preset colors + a custom picker, undo, and "Save" that composites
 * the background image + freehand strokes into a single base64 PNG.
 *
 * Modes:
 *   • map      — worker drops a Google Map screenshot in. Strokes go on top.
 *   • blank    — solid white canvas (drawing notes from scratch).
 *   • photo    — uploaded photo as background.
 *
 * Tools:
 *   • draw     — solid colored stroke (opaque, normal width).
 *   • highlight — translucent stroke (alpha ~0.4) wider, for shading areas.
 *
 * The component is fully self-contained — no external deps beyond React.
 * Built on raw `<canvas>` + pointer events, mirroring SignaturePadModal so
 * we don't pull in react-konva for a single workflow.
 *
 * Props:
 *   - isOpen: bool
 *   - onCancel(): close without saving
 *   - onSave({ data, type, dataUrl }): receives the flattened PNG payload —
 *     same shape the form's photo arrays already use, so the caller can
 *     splice it straight into form.photos.
 *   - mode?: initial mode ('map' | 'blank' | 'photo'). Defaults to 'map'.
 */

const PRESET_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#facc15', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#000000', // black
  '#ffffff', // white
];

const CANVAS_W = 1000;
const CANVAS_H = 700;

export default function MapAnnotationCanvas({
  isOpen,
  onCancel,
  onSave,
  mode: initialMode = 'map',
}) {
  const [mode, setMode] = useState(initialMode);
  const [tool, setTool] = useState('draw');           // 'draw' | 'highlight'
  const [color, setColor] = useState('#ef4444');
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [backgroundDataUrl, setBackgroundDataUrl] = useState(null);
  // History of completed strokes (each = { tool, color, width, points: [[x,y]..] }).
  // We store strokes — not the raw bitmap — so Undo can pop just the last
  // stroke without re-drawing all pixels manually. Background image is
  // re-painted on every redraw.
  const [strokes, setStrokes] = useState([]);

  const canvasRef = useRef(null);
  const drawingRef = useRef(null);  // currently in-progress stroke
  const bgImgRef = useRef(null);    // cached HTMLImageElement for the background

  // Reset everything when (re)opening or switching modes.
  useEffect(() => {
    if (!isOpen) return;
    setStrokes([]);
    drawingRef.current = null;
    if (mode === 'blank') {
      setBackgroundDataUrl(null);
      bgImgRef.current = null;
    }
  }, [isOpen, mode]);

  // Load background image whenever the data URL changes.
  useEffect(() => {
    if (!backgroundDataUrl) {
      bgImgRef.current = null;
      redraw();
      return;
    }
    const img = new Image();
    img.onload = () => {
      bgImgRef.current = img;
      redraw();
    };
    img.src = backgroundDataUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundDataUrl]);

  // Redraw whenever strokes change (e.g. after Undo).
  useEffect(() => { redraw(); /* eslint-disable-next-line */ }, [strokes]);

  function getCtx() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return canvas.getContext('2d');
  }

  function redraw() {
    const ctx = getCtx();
    if (!ctx) return;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Background image — fit into canvas preserving aspect ratio.
    const img = bgImgRef.current;
    if (img) {
      const ratio = Math.min(CANVAS_W / img.width, CANVAS_H / img.height);
      const dw = img.width * ratio;
      const dh = img.height * ratio;
      const dx = (CANVAS_W - dw) / 2;
      const dy = (CANVAS_H - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);
    }

    for (const s of strokes) drawStroke(ctx, s);
    if (drawingRef.current) drawStroke(ctx, drawingRef.current);

    ctx.restore();
  }

  function drawStroke(ctx, stroke) {
    const { points, color: c, width: w, tool: t } = stroke;
    if (!points || points.length === 0) return;
    ctx.save();
    if (t === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = w * 4;
      ctx.globalCompositeOperation = 'multiply';
    } else {
      ctx.globalAlpha = 1;
      ctx.lineWidth = w;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.strokeStyle = c;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ── Pointer handlers (pointer events cover mouse + touch + stylus) ──────
  const eventToCanvasXY = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    // The canvas is rendered at a smaller CSS size than its drawing buffer
    // — translate via the rendered-to-buffer ratio so strokes hit pixels
    // exactly where the user tapped.
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy];
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    canvasRef.current?.setPointerCapture?.(e.pointerId);
    drawingRef.current = {
      tool,
      color,
      width: strokeWidth,
      points: [eventToCanvasXY(e)],
    };
    redraw();
  };
  const handlePointerMove = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    drawingRef.current.points.push(eventToCanvasXY(e));
    redraw();
  };
  const handlePointerUp = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    try { canvasRef.current?.releasePointerCapture?.(e.pointerId); } catch { /* no-op */ }
    const finished = drawingRef.current;
    drawingRef.current = null;
    setStrokes(prev => [...prev, finished]);
  };

  // ── Background uploads ──────────────────────────────────────────────────
  const handleBackgroundFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setBackgroundDataUrl(reader.result);
      setStrokes([]);
    };
    reader.readAsDataURL(file);
  };

  const handleUndo = () => {
    setStrokes(prev => prev.slice(0, -1));
  };

  const handleClear = () => {
    setStrokes([]);
  };

  const handleSave = () => {
    // Composite already lives in the canvas — just export it. Use JPEG to
    // keep the file size reasonable; map screenshots are photographic so
    // PNG would bloat. Drawn lines render fine at 0.9 quality.
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    const commaIdx = dataUrl.indexOf(',');
    const data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    onSave?.({ data, type: 'image/jpeg', dataUrl });
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', flexDirection: 'column', zIndex: 1200,
    }}>
      {/* ── Top toolbar ── */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
        padding: 10, background: '#1f2937', borderBottom: '1px solid #374151',
      }}>
        <div style={{ color: '#f9fafb', fontWeight: 600, marginRight: 12 }}>Annotate</div>

        {/* Mode picker */}
        {['map', 'blank', 'photo'].map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              padding: '6px 10px',
              background: mode === m ? '#3b82f6' : '#111827',
              color: '#f9fafb', border: '1px solid #374151',
              borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem',
              textTransform: 'capitalize',
            }}
          >{m === 'map' ? 'Map screenshot' : m}</button>
        ))}

        <div style={{ width: 1, height: 24, background: '#374151', margin: '0 6px' }} />

        {/* Tool picker */}
        {['draw', 'highlight'].map(t => (
          <button
            key={t}
            onClick={() => setTool(t)}
            style={{
              padding: '6px 10px',
              background: tool === t ? '#22c55e' : '#111827',
              color: '#f9fafb', border: '1px solid #374151',
              borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem',
              textTransform: 'capitalize',
            }}
          >{t}</button>
        ))}

        <div style={{ width: 1, height: 24, background: '#374151', margin: '0 6px' }} />

        {/* Color presets */}
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            title={c}
            style={{
              width: 26, height: 26, borderRadius: '50%',
              background: c,
              border: color === c ? '3px solid #f9fafb' : '1px solid #374151',
              cursor: 'pointer', padding: 0,
            }}
          />
        ))}
        <input
          type="color"
          value={color}
          onChange={e => setColor(e.target.value)}
          title="Custom color"
          style={{
            width: 28, height: 28, padding: 0, border: '1px solid #374151',
            background: 'transparent', borderRadius: '50%', cursor: 'pointer',
          }}
        />

        <div style={{ width: 1, height: 24, background: '#374151', margin: '0 6px' }} />

        <label style={{ color: '#9ca3af', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          Width
          <input
            type="range" min="1" max="14" step="1"
            value={strokeWidth}
            onChange={e => setStrokeWidth(Number(e.target.value))}
            style={{ width: 90 }}
          />
          <span style={{ width: 16, textAlign: 'right' }}>{strokeWidth}</span>
        </label>

        <div style={{ flex: 1 }} />

        <button onClick={handleUndo} disabled={strokes.length === 0} style={{
          padding: '6px 10px', background: '#374151', color: '#f9fafb',
          border: 'none', borderRadius: 6, fontSize: '0.85rem',
          cursor: strokes.length === 0 ? 'not-allowed' : 'pointer',
          opacity: strokes.length === 0 ? 0.5 : 1,
        }}>Undo</button>
        <button onClick={handleClear} disabled={strokes.length === 0} style={{
          padding: '6px 10px', background: '#374151', color: '#f9fafb',
          border: 'none', borderRadius: 6, fontSize: '0.85rem',
          cursor: strokes.length === 0 ? 'not-allowed' : 'pointer',
          opacity: strokes.length === 0 ? 0.5 : 1,
        }}>Clear</button>
      </div>

      {/* ── Background uploader (map/photo modes) ── */}
      {mode !== 'blank' && !backgroundDataUrl && (
        <div style={{
          padding: 14, color: '#d1d5db', background: '#0f172a',
          borderBottom: '1px solid #374151', fontSize: '0.9rem',
        }}>
          <label style={{
            display: 'inline-block', padding: '10px 14px',
            background: '#3b82f6', color: 'white', borderRadius: 6,
            cursor: 'pointer', fontSize: '0.9rem', fontWeight: 600,
          }}>
            {mode === 'map' ? 'Upload Map Screenshot' : 'Upload Photo'}
            <input
              type="file" accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => handleBackgroundFile(e.target.files?.[0])}
            />
          </label>
          <span style={{ marginLeft: 10, color: '#9ca3af' }}>
            {mode === 'map'
              ? 'Use Google Maps → screenshot the area, then upload it here.'
              : 'Pick any photo to annotate.'}
          </span>
        </div>
      )}

      {/* ── Canvas ── */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 12, overflow: 'auto', background: '#0f172a',
      }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{
            maxWidth: '100%', maxHeight: '100%',
            width: '95%', height: 'auto',
            background: 'white',
            borderRadius: 8,
            touchAction: 'none',  // prevent browser scrolling on touch drags
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            cursor: 'crosshair',
          }}
        />
      </div>

      {/* ── Bottom action bar ── */}
      <div style={{
        display: 'flex', gap: 8, padding: 12,
        background: '#1f2937', borderTop: '1px solid #374151',
      }}>
        <button onClick={handleSave} style={{
          flex: 1, padding: 12, background: '#22c55e', color: 'white',
          border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '1rem',
          cursor: 'pointer',
        }}>Save annotation</button>
        <button onClick={onCancel} style={{
          flex: 1, padding: 12, background: '#374151', color: '#f9fafb',
          border: 'none', borderRadius: 8, fontSize: '1rem', cursor: 'pointer',
        }}>Cancel</button>
      </div>
    </div>
  );
}
