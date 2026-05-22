import { useEffect, useRef, useState } from 'react';

// Google Maps API key — same one used by the Map tab. When unset (e.g.
// local dev without keys) the "Capture from Google Maps" button is
// hidden so the worker doesn't get a broken request.
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

// Resolve the worker's current GPS as { lat, lng }. Uses high-accuracy +
// a 12 s timeout (cellular fixes outside town can be slow). Rejects if
// the worker denies permission or geolocation is unavailable.
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation is not supported on this device.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err?.message || 'Could not get your location.')),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  });
}

// Load a remote image as a same-origin-tainted HTMLImageElement so the
// canvas it backs can still be exported via `toDataURL`. Google Static
// Maps returns CORS headers, so `crossOrigin = 'anonymous'` works.
function loadImageCors(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Could not load map image.'));
    img.src = url;
  });
}

// Convert a CORS-loaded image into a data URL so we can re-use the same
// `setBackgroundDataUrl` path as the file-upload mode.
function imageToDataUrl(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}

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

  // Google Static Maps capture flow state. Defaults pick up a roughly
  // "lease-sized" satellite view (zoom 18, 640×640). Worker can tap +/−
  // to zoom out before re-capturing if the lease is bigger than the
  // default fit.
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureError, setCaptureError] = useState(null);
  const [captureZoom, setCaptureZoom] = useState(18);
  const [captureCoords, setCaptureCoords] = useState(null);  // { lat, lng }
  const [captureType, setCaptureType] = useState('satellite');  // 'satellite' | 'hybrid' | 'roadmap'

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

  // Capture the worker's current GPS location as a Google Static Maps
  // image and drop it into the canvas as the annotation background.
  //
  // The Static Maps endpoint returns a PNG with CORS headers, so we can
  // load it via `crossOrigin = 'anonymous'` and bake it through a hidden
  // <canvas> into a data URL — same pipeline as the file-upload path.
  // Without the data-URL hop the main canvas would be CORS-tainted and
  // `toDataURL` on Save would throw a SecurityError.
  //
  // `coords` (optional) lets the worker re-capture with a different zoom
  // without re-prompting for geolocation each time. First call leaves it
  // null → we ask the browser; subsequent calls reuse the cached point.
  const captureMapFromGoogle = async (coords, zoomOverride) => {
    if (!GOOGLE_MAPS_API_KEY) {
      setCaptureError('Google Maps API key is not configured on this build.');
      return;
    }
    setCaptureError(null);
    setIsCapturing(true);
    try {
      let pt = coords;
      if (!pt) {
        pt = await getCurrentPosition();
        setCaptureCoords(pt);
      }
      const zoom = zoomOverride ?? captureZoom;
      // 640×640 @ 2x = 1280×1280 native pixels — sharp on retina + big
      // enough that strokes don't bleed across small features. The free
      // Static Maps tier supports up to 640×640 base; `scale=2` doubles
      // it for retina without extra request cost.
      const params = new URLSearchParams({
        center: `${pt.lat},${pt.lng}`,
        zoom: String(zoom),
        size: '640x640',
        scale: '2',
        maptype: captureType,
        key: GOOGLE_MAPS_API_KEY,
      });
      const url = `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
      const img = await loadImageCors(url);
      const dataUrl = imageToDataUrl(img);
      setBackgroundDataUrl(dataUrl);
      setStrokes([]);
    } catch (e) {
      setCaptureError(e?.message || 'Map capture failed.');
    } finally {
      setIsCapturing(false);
    }
  };

  // Zoom controls — re-fetch a fresh Static Map at the new zoom level
  // using the previously-resolved coords (no second geolocation prompt).
  const adjustCaptureZoom = (delta) => {
    const next = Math.max(10, Math.min(21, captureZoom + delta));
    setCaptureZoom(next);
    if (captureCoords) {
      // Best-effort — failures surface via captureError.
      captureMapFromGoogle(captureCoords, next);
    }
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

  // Small helper for the tool toolbar's button look — keeps the JSX tidy.
  const toolBtn = (active) => ({
    padding: '6px 10px',
    background: active ? '#3b82f6' : '#111827',
    color: '#f9fafb', border: '1px solid #374151',
    borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem',
    textTransform: 'capitalize', flexShrink: 0,
  });

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', flexDirection: 'column', zIndex: 1200,
    }}>
      {/* ── Header (always-visible title + close X) ──
          A separate row that never wraps and never scrolls horizontally, so
          the worker can ALWAYS find the close button no matter how small
          their screen or how full the tool toolbar gets below. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', background: '#1f2937',
        borderBottom: '1px solid #374151', flexShrink: 0,
      }}>
        <div style={{ color: '#f9fafb', fontWeight: 600, fontSize: '1rem' }}>
          Annotate
        </div>
        <button
          onClick={onCancel}
          aria-label="Close annotation"
          style={{
            background: 'none', border: 'none', color: '#f9fafb',
            fontSize: '1.6rem', lineHeight: 1, cursor: 'pointer',
            padding: '0 8px',
          }}
        >×</button>
      </div>

      {/* ── Tool toolbar ──
          Single-row, horizontally scrollable on narrow screens so the
          drawing canvas + bottom action bar never get pushed off-screen
          by a wrapping toolbar (the original bug). `flexShrink: 0` keeps
          the row at its natural height regardless of viewport. */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        padding: 10, background: '#1f2937',
        borderBottom: '1px solid #374151',
        overflowX: 'auto', flexShrink: 0,
        WebkitOverflowScrolling: 'touch',
      }}>
        {/* Mode picker */}
        {['map', 'blank', 'photo'].map(m => (
          <button key={m} onClick={() => setMode(m)} style={toolBtn(mode === m)}>
            {m === 'map' ? 'Map' : m}
          </button>
        ))}

        <div style={{ width: 1, height: 24, background: '#374151', flexShrink: 0 }} />

        {/* Tool picker */}
        {['draw', 'highlight'].map(t => (
          <button key={t} onClick={() => setTool(t)} style={{
            ...toolBtn(tool === t),
            background: tool === t ? '#22c55e' : '#111827',
          }}>{t}</button>
        ))}

        <div style={{ width: 1, height: 24, background: '#374151', flexShrink: 0 }} />

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
              cursor: 'pointer', padding: 0, flexShrink: 0,
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
            flexShrink: 0,
          }}
        />

        <div style={{ width: 1, height: 24, background: '#374151', flexShrink: 0 }} />

        <label style={{
          color: '#9ca3af', fontSize: '0.8rem',
          display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        }}>
          Width
          <input
            type="range" min="1" max="14" step="1"
            value={strokeWidth}
            onChange={e => setStrokeWidth(Number(e.target.value))}
            style={{ width: 90 }}
          />
          <span style={{ width: 16, textAlign: 'right' }}>{strokeWidth}</span>
        </label>

        <div style={{ width: 1, height: 24, background: '#374151', flexShrink: 0 }} />

        <button onClick={handleUndo} disabled={strokes.length === 0} style={{
          padding: '6px 10px', background: '#374151', color: '#f9fafb',
          border: 'none', borderRadius: 6, fontSize: '0.85rem', flexShrink: 0,
          cursor: strokes.length === 0 ? 'not-allowed' : 'pointer',
          opacity: strokes.length === 0 ? 0.5 : 1,
        }}>Undo</button>
        <button onClick={handleClear} disabled={strokes.length === 0} style={{
          padding: '6px 10px', background: '#374151', color: '#f9fafb',
          border: 'none', borderRadius: 6, fontSize: '0.85rem', flexShrink: 0,
          cursor: strokes.length === 0 ? 'not-allowed' : 'pointer',
          opacity: strokes.length === 0 ? 0.5 : 1,
        }}>Clear</button>
      </div>

      {/* ── Background source picker (map/photo modes, before a background
              is selected) ──
          For "map" mode we now offer two options:
            1. Capture from Google Maps — uses Static Maps API + worker
               GPS. No leaving the app, no manual screenshotting.
            2. Upload screenshot — fallback for when the worker already
               has a saved screenshot or wants to use Google Earth /
               another source.
          Both write into the same `backgroundDataUrl` slot, so the
          downstream draw pipeline is identical. */}
      {mode !== 'blank' && !backgroundDataUrl && (
        <div style={{
          padding: 14, color: '#d1d5db', background: '#0f172a',
          borderBottom: '1px solid #374151', fontSize: '0.9rem',
          flexShrink: 0,
        }}>
          {mode === 'map' && GOOGLE_MAPS_API_KEY && (
            <div style={{ marginBottom: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <button
                onClick={() => captureMapFromGoogle()}
                disabled={isCapturing}
                style={{
                  padding: '10px 14px',
                  background: isCapturing ? '#374151' : '#22c55e',
                  color: 'white', border: 'none', borderRadius: 6,
                  cursor: isCapturing ? 'wait' : 'pointer',
                  fontSize: '0.9rem', fontWeight: 600,
                }}
              >
                {isCapturing ? 'Capturing…' : '📍 Capture from Google Maps'}
              </button>
              <span style={{ color: '#9ca3af', fontSize: '0.8rem' }}>
                Uses your current GPS at zoom {captureZoom} ({captureType}).
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#9ca3af', fontSize: '0.8rem' }}>
                Type:
                <select
                  value={captureType}
                  onChange={e => setCaptureType(e.target.value)}
                  style={{
                    background: '#111827', color: '#f9fafb',
                    border: '1px solid #374151', borderRadius: 4,
                    padding: '4px 6px', fontSize: '0.8rem',
                  }}
                >
                  <option value="satellite">Satellite</option>
                  <option value="hybrid">Hybrid (satellite + labels)</option>
                  <option value="roadmap">Road Map</option>
                  <option value="terrain">Terrain</option>
                </select>
              </label>
            </div>
          )}
          <label style={{
            display: 'inline-block', padding: '10px 14px',
            background: '#3b82f6', color: 'white', borderRadius: 6,
            cursor: 'pointer', fontSize: '0.9rem', fontWeight: 600,
          }}>
            {mode === 'map' ? '📁 Upload Screenshot' : '📁 Upload Photo'}
            <input
              type="file" accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => handleBackgroundFile(e.target.files?.[0])}
            />
          </label>
          <span style={{ marginLeft: 10, color: '#9ca3af' }}>
            {mode === 'map'
              ? 'Or upload a screenshot from Google Earth / another source.'
              : 'Pick any photo to annotate.'}
          </span>
          {captureError && (
            <div style={{
              marginTop: 8, padding: 8, background: '#7f1d1d',
              color: '#fee2e2', borderRadius: 6, fontSize: '0.85rem',
            }}>
              {captureError}
            </div>
          )}
        </div>
      )}

      {/* ── Re-capture / zoom controls (shown after a Google capture) ──
          Lets the worker zoom in/out on the same GPS point without
          re-prompting for permissions, or pick a different background
          source entirely. */}
      {mode === 'map' && backgroundDataUrl && captureCoords && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
          padding: '8px 14px', background: '#0f172a',
          borderBottom: '1px solid #374151', flexShrink: 0, fontSize: '0.82rem',
          color: '#9ca3af',
        }}>
          <span>Zoom: {captureZoom}</span>
          <button onClick={() => adjustCaptureZoom(-1)} disabled={isCapturing || captureZoom <= 10} style={{
            padding: '4px 10px', background: '#374151', color: '#f9fafb',
            border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.85rem',
          }}>−</button>
          <button onClick={() => adjustCaptureZoom(1)} disabled={isCapturing || captureZoom >= 21} style={{
            padding: '4px 10px', background: '#374151', color: '#f9fafb',
            border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.85rem',
          }}>+</button>
          <button onClick={() => { setBackgroundDataUrl(null); setStrokes([]); }} style={{
            padding: '4px 10px', background: '#374151', color: '#f9fafb',
            border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.85rem',
          }}>Re-pick background</button>
        </div>
      )}

      {/* ── Canvas ──
          `minHeight: 0` is the key bit — without it, a tall flex child
          (the canvas image) would push the bottom bar off-screen on
          short viewports. With it, the canvas shrinks instead. */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
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

      {/* ── Bottom action bar ──
          `flexShrink: 0` so the buttons stay anchored to the bottom
          regardless of canvas height — the original "can't find Cancel"
          bug was caused by this row getting squeezed out. */}
      <div style={{
        display: 'flex', gap: 8, padding: 12, flexShrink: 0,
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
