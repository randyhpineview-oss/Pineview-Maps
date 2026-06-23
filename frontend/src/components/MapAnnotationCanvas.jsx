import { useEffect, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';

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
  // Highlighter opacity (0.05–1.0). Stamped into each highlight stroke so
  // changing the slider later doesn't retroactively alter past strokes —
  // only new strokes pick up the new alpha. Hidden from the toolbar while
  // the pen tool is active.
  const [highlightAlpha, setHighlightAlpha] = useState(0.35);
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
  const [captureType, setCaptureType] = useState('hybrid');  // 'satellite' | 'hybrid' | 'roadmap'

  // Interactive map-picker state. When `isPickingMapLocation` is true the
  // canvas area is replaced by a live <GoogleMap> the worker can pan and
  // zoom freely; "Capture this view" reads the current center + zoom +
  // maptype and pipes them through the same Static Maps flow.
  const [isPickingMapLocation, setIsPickingMapLocation] = useState(initialMode === 'map');
  const [isDrawingBoxMode, setIsDrawingBoxMode] = useState(false);
  const [boxStart, setBoxStart] = useState(null); // {x, y}
  const [boxEnd, setBoxEnd] = useState(null);     // {x, y}
  const isDraggingBoxRef = useRef(false);
  const pickerMapRef = useRef(null);
  const pickerContainerRef = useRef(null);

  // Display zoom for the drawing canvas itself. 1.0 = fit-in-viewport;
  // higher values scale the canvas CSS size up so the worker can scroll
  // around and draw with finer precision. The underlying buffer
  // (CANVAS_W × CANVAS_H) is unchanged so quality is preserved and the
  // exported JPEG is the same regardless of display zoom. Pointer math
  // already accounts for CSS-vs-buffer scale via getBoundingClientRect.
  const [canvasZoom, setCanvasZoom] = useState(1);

  const canvasRef = useRef(null);
  const drawingRef = useRef(null);  // currently in-progress stroke
  const bgImgRef = useRef(null);    // cached HTMLImageElement for the background
  // Offscreen canvas that holds JUST the annotation layer (pen + highlight
  // + eraser punch-outs). Compositing into a separate buffer lets the
  // eraser tool use `destination-out` to wipe annotations without also
  // erasing the background image — `destination-out` on the main canvas
  // would punch a hole through the bg too. Created lazily on first redraw.
  const annotLayerRef = useRef(null);

  // Color picker popover open/closed. Closed state collapses the colors
  // back into a single swatch so the top toolbar stays narrow on mobile.
  const [showColorPicker, setShowColorPicker] = useState(false);

  // Multi-touch pinch-to-zoom state. We track every active pointer by id
  // so we can:
  //   • Cancel an in-progress stroke the moment a SECOND finger lands
  //     (without this, the stroke would jump as the pinch starts).
  //   • Distinguish a 1-finger draw from a 2-finger pinch in pointermove.
  // The pinch implementation uses CSS scrolling on the canvas container —
  // the canvas's CSS width grows with `canvasZoom`, the wrapper has
  // overflow:auto, and we adjust scrollLeft/Top so the pinch midpoint
  // stays anchored to whatever the worker was pinching on. Native browser
  // pinch is disabled by touchAction:'none', which we need anyway to
  // suppress page scroll while the worker draws.
  const containerRef = useRef(null);
  const activePointersRef = useRef(new Map());   // pointerId -> { x, y }
  const pinchStateRef = useRef(null);            // null OR { startDist, startZoom, startMidpoint, startScroll }

  // Idempotent Google Maps API loader — the main MapView already calls
  // useJsApiLoader with the same id, so this either reuses the same
  // script tag (no extra request) or kicks off the load if MapView
  // hasn't mounted yet (e.g. worker tapped Annotate before opening the
  // Map tab). Returns `isLoaded` so we can gate the picker rendering.
  const { isLoaded: isMapsApiLoaded, loadError: mapsApiLoadError } = useJsApiLoader({
    id: 'pineview-google-map',
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
  });

  // Reset everything when (re)opening or switching modes.
  useEffect(() => {
    if (!isOpen) return;
    setStrokes([]);
    drawingRef.current = null;
    // Reset display zoom + clear any leftover pinch state. Without this,
    // a worker who closed the modal mid-pinch would land back on a
    // pre-zoomed view next time they re-opened.
    setCanvasZoom(1);
    activePointersRef.current.clear();
    pinchStateRef.current = null;
    setShowColorPicker(false);
    if (mode === 'blank') {
      setBackgroundDataUrl(null);
      bgImgRef.current = null;
    }
    if (mode === 'map') {
      setIsPickingMapLocation(true);
      setIsDrawingBoxMode(false);
    } else {
      setIsPickingMapLocation(false);
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

    // Annotation layer — pen + highlight + eraser composited in an
    // OFFSCREEN canvas so eraser strokes (destination-out) only chew
    // through annotations, not the background underneath. Then the
    // whole annotation buffer is painted on top of the bg in one shot.
    let layer = annotLayerRef.current;
    if (!layer) {
      layer = document.createElement('canvas');
      layer.width = CANVAS_W;
      layer.height = CANVAS_H;
      annotLayerRef.current = layer;
    }
    const lctx = layer.getContext('2d');
    lctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    for (const s of strokes) drawStroke(lctx, s);
    if (drawingRef.current) drawStroke(lctx, drawingRef.current);

    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  function drawStroke(ctx, stroke) {
    const { points, color: c, width: w, tool: t } = stroke;
    if (!points || points.length === 0) return;
    ctx.save();
    if (t === 'highlight') {
      // Per-stroke alpha (set when the stroke was created) so each
      // highlight keeps the opacity it was drawn at, even if the worker
      // moves the slider afterwards. Defaults to 0.35 for legacy strokes
      // that pre-date the slider.
      ctx.globalAlpha = (typeof stroke.alpha === 'number') ? stroke.alpha : 0.35;
      ctx.lineWidth = w * 4;
      // On the annotation layer we use a plain source-over for highlight
      // so it can later be erased by an eraser stroke. The "multiply"
      // visual effect comes from the layer being painted ONTO the
      // background-bearing main canvas, where the alpha already gives
      // the marker-over-map look without needing a layer-level multiply.
      ctx.globalCompositeOperation = 'source-over';
    } else if (t === 'erase') {
      // Eraser — uses destination-out on the annotation layer to punch
      // a hole through pen + highlight strokes. Because the layer sits
      // ABOVE the background image (and is composited onto the main
      // canvas with source-over), the bg shows through any erased area.
      ctx.globalAlpha = 1;
      ctx.lineWidth = w * 4;  // bigger by default — erasers should feel chunky
      ctx.globalCompositeOperation = 'destination-out';
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

  // ── Pinch-zoom geometry helpers ──
  // Distance between two screen-space points used by the pinch handler.
  const dist2 = (a, b) => {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.hypot(dx, dy);
  };
  // Midpoint of two screen-space points (used as the pinch anchor).
  const mid2 = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  // Begin a pinch gesture: cancel any in-progress stroke, snapshot the
  // starting distance + midpoint + current zoom/scroll so the move
  // handler can derive a stable relative delta.
  const beginPinch = () => {
    const pts = [...activePointersRef.current.values()];
    if (pts.length < 2) return;
    // Stomp any half-drawn stroke; otherwise the worker would see the
    // line snap to one of their fingers as the pinch starts.
    if (drawingRef.current) {
      drawingRef.current = null;
      redraw();
    }
    const container = containerRef.current;
    pinchStateRef.current = {
      startDist: dist2(pts[0], pts[1]) || 1,
      startMid: mid2(pts[0], pts[1]),
      startZoom: canvasZoom,
      startScroll: container
        ? { left: container.scrollLeft, top: container.scrollTop }
        : { left: 0, top: 0 },
    };
  };

  // While pinching, derive the new zoom from the ratio of current to
  // starting finger distance, then adjust container scroll so the midpoint
  // anchored on the canvas stays under the worker's fingers (otherwise the
  // image would drift away from where the gesture started).
  const updatePinch = () => {
    const st = pinchStateRef.current;
    if (!st) return;
    const pts = [...activePointersRef.current.values()];
    if (pts.length < 2) return;
    const d = dist2(pts[0], pts[1]) || 1;
    // Clamp zoom to the same 0.5–4× range we exposed earlier so we don't
    // get a degenerate sub-pixel render at very small scales.
    const nextZoom = Math.max(0.5, Math.min(4, st.startZoom * (d / st.startDist)));
    setCanvasZoom(nextZoom);

    const container = containerRef.current;
    if (!container) return;
    // Keep the pinch midpoint anchored: as the canvas grows (scrollWidth
    // changes after the next render), shift scroll so the same canvas
    // point stays under the same screen point.
    const newMid = mid2(pts[0], pts[1]);
    const ratio = nextZoom / st.startZoom;
    // Where was the gesture-start midpoint in canvas-content coordinates?
    // contentX = (screenX - containerLeft) + scrollLeft
    const rect = container.getBoundingClientRect();
    const startContentX = (st.startMid.x - rect.left) + st.startScroll.left;
    const startContentY = (st.startMid.y - rect.top) + st.startScroll.top;
    // The same content point after scaling lives at content*ratio.
    // We want it to sit at (newMid.x - containerLeft) onscreen.
    const targetScrollLeft = (startContentX * ratio) - (newMid.x - rect.left);
    const targetScrollTop  = (startContentY * ratio) - (newMid.y - rect.top);
    // Defer one frame so the canvas CSS width has been laid out at the
    // new zoom before we set scroll, otherwise the clamp on max-scroll
    // would silently bound us to the OLD width.
    requestAnimationFrame(() => {
      const c = containerRef.current;
      if (!c) return;
      c.scrollLeft = targetScrollLeft;
      c.scrollTop = targetScrollTop;
    });
  };

  const endPinch = () => {
    pinchStateRef.current = null;
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const count = activePointersRef.current.size;
    if (count >= 2) {
      beginPinch();
      return;
    }
    canvasRef.current?.setPointerCapture?.(e.pointerId);
    drawingRef.current = {
      tool,
      color,
      width: strokeWidth,
      // Stamp alpha only on highlight strokes; pen strokes are always
      // fully opaque so we omit the field to keep the saved JSON small.
      ...(tool === 'highlight' ? { alpha: highlightAlpha } : {}),
      points: [eventToCanvasXY(e)],
    };
    redraw();
  };
  const handlePointerMove = (e) => {
    // Keep the active-pointer map fresh so pinch math has current coords.
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinchStateRef.current) {
      e.preventDefault();
      updatePinch();
      return;
    }
    if (!drawingRef.current) return;
    e.preventDefault();
    drawingRef.current.points.push(eventToCanvasXY(e));
    redraw();
  };
  const handlePointerUp = (e) => {
    e.preventDefault();
    activePointersRef.current.delete(e.pointerId);
    if (pinchStateRef.current) {
      // Fewer than 2 fingers left → end the pinch. We deliberately do NOT
      // auto-resume drawing with the remaining finger — the worker has to
      // lift everything and re-tap to start a fresh stroke. That avoids
      // accidental marks when one finger lifts slightly during a pinch.
      if (activePointersRef.current.size < 2) endPinch();
      return;
    }
    if (!drawingRef.current) return;
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
  const captureMapFromGoogle = async (coords, zoomOverride, reqW = 640, reqH = 640) => {
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
      // Scale=2 doubles native pixels for retina. Static Maps max is 640
      // per side on the free tier. reqW/reqH are pre-clamped by the caller.
      const params = new URLSearchParams({
        center: `${pt.lat},${pt.lng}`,
        zoom: String(zoom),
        size: `${reqW}x${reqH}`,
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

  // Capture whatever the worker is currently looking at in the map picker.
  // Reads the live map's center + zoom from the underlying google.maps.Map
  // instance and uses the picker container's actual pixel dimensions to
  // request a Static Maps image with the same aspect ratio — so the
  // screenshot matches what was visible in the picker.
  const captureFromPicker = async () => {
    const map = pickerMapRef.current;
    if (!map) return;
    const center = map.getCenter();
    const zoom = map.getZoom();
    if (!center || zoom == null) return;
    
    let targetPt = { lat: center.lat(), lng: center.lng() };
    let targetZoom = zoom;

    if (isDrawingBoxMode && boxStart && boxEnd && pickerContainerRef.current) {
      const rect = pickerContainerRef.current.getBoundingClientRect();
      const mapW = rect.width;
      const mapH = rect.height;
      
      const x1 = Math.min(boxStart.x, boxEnd.x);
      const x2 = Math.max(boxStart.x, boxEnd.x);
      const y1 = Math.min(boxStart.y, boxEnd.y);
      const y2 = Math.max(boxStart.y, boxEnd.y);
      
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const boxW = x2 - x1;
      
      if (boxW > 0 && mapW > 0 && mapH > 0) {
        // Convert pixel offset from center to lat/lng using map projection
        const scale = Math.pow(2, zoom);
        const proj = map.getProjection();
        if (proj) {
          const centerWorld = proj.fromLatLngToPoint(center);
          const dxWorld = (cx - mapW / 2) / scale;
          const dyWorld = (cy - mapH / 2) / scale;
          const targetWorld = new window.google.maps.Point(
            centerWorld.x + dxWorld,
            centerWorld.y + dyWorld
          );
          const targetLatLng = proj.fromPointToLatLng(targetWorld);
          targetPt = { lat: targetLatLng.lat(), lng: targetLatLng.lng() };
          
          // Google Static Maps free-tier max size is 640x640 (scale=2 makes it 1280x1280).
          // Our aspect ratio is 10:7, so we request 640x448.
          // Calculate the zoom offset so the geographic width of the box fills 640 pixels.
          const zoomOffset = Math.round(Math.log2(640 / boxW));
          targetZoom = Math.min(21, Math.max(10, zoom + zoomOffset));
        }
      }
    }

    setCaptureCoords(targetPt);
    setCaptureZoom(targetZoom);
    setIsPickingMapLocation(false);
    
    await captureMapFromGoogle(targetPt, targetZoom, 640, 448);
  };

  // Recenter the picker on the worker's current GPS. Best-effort — if
  // geolocation is denied we surface the error and let the worker keep
  // panning manually.
  const recenterPickerOnGps = async () => {
    setCaptureError(null);
    try {
      const pt = await getCurrentPosition();
      const map = pickerMapRef.current;
      if (map) {
        map.panTo(pt);
        if ((map.getZoom() ?? 6) < 14) map.setZoom(18);
      }
    } catch (e) {
      setCaptureError(e?.message || 'Could not get your location.');
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

  useEffect(() => {
    if (pickerMapRef.current) {
      pickerMapRef.current.setMapTypeId(captureType);
    }
  }, [captureType]);

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
      // z-index has to clear EVERYTHING in the app: bottom nav tabs
      // (Maps/Sites/Forms/Admin), the install prompt (10000), and any
      // future modals. 100000 is the project-wide "absolute top" tier so
      // the worker can always reach Save / Discard on iOS, where the
      // bottom nav was previously overlapping the action bar.
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', flexDirection: 'column', zIndex: 100000,
    }}>
      {/* ── Header (always-visible title + close X) ──
          A separate row that never wraps and never scrolls horizontally, so
          the worker can ALWAYS find the close button no matter how small
          their screen or how full the tool toolbar gets below. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px', background: '#1f2937',
        borderBottom: '1px solid #374151', flexShrink: 0,
      }}>
        <div style={{ color: '#f9fafb', fontWeight: 600, fontSize: '0.95rem', marginRight: 4 }}>
          Annotate
        </div>
        <div style={{ flex: 1 }} />
        {/* Save + Discard moved to header so the canvas has full height */}
        <button
          onClick={handleSave}
          style={{
            background: '#22c55e', color: 'white',
            border: 'none', borderRadius: 6,
            padding: '6px 14px', cursor: 'pointer',
            fontSize: '0.85rem', fontWeight: 700,
          }}
        >✓ Save</button>
        <button
          onClick={onCancel}
          aria-label="Discard annotation"
          style={{
            background: '#7f1d1d', color: 'white',
            border: 'none', borderRadius: 6,
            padding: '6px 12px', cursor: 'pointer',
            fontSize: '0.85rem', fontWeight: 600,
          }}
        >✕ Discard</button>
      </div>

      {/* ── Compact mobile-first tool bar ──
          Stays on a single row at 360 px wide. Heavy controls (the 10
          color swatches, the verbose mode buttons, the width-slider
          label) collapse into:
            - <select> for Mode (Map / Blank / Photo)
            - Toggle button that flips Draw ↔ Highlight in place
            - Single colored circle that opens a popover of all the preset
              colors + the system color picker
            - Bare range slider for width (no label, no inline number)
            - Icon-only Undo / Clear
          The whole bar still stays visible while drawing — no overlap with
          the canvas — so workers can switch tools mid-annotation. */}
      <div style={{
        display: 'flex', gap: 6, alignItems: 'center',
        padding: '8px 10px', background: '#1f2937',
        borderBottom: '1px solid #374151', flexShrink: 0,
        position: 'relative',  // anchor for the color popover
      }}>
        {/* Mode dropdown — only meaningful before a background is chosen
            (after that, picking a different mode would discard the work).
            We deliberately keep it visible at all times so the worker can
            see which mode they're in, but disabled once they've started. */}
        <select
          value={mode}
          onChange={e => setMode(e.target.value)}
          disabled={!!backgroundDataUrl || strokes.length > 0}
          style={{
            background: '#111827', color: '#f9fafb',
            border: '1px solid #374151', borderRadius: 6,
            padding: '6px 8px', fontSize: '0.85rem', flexShrink: 0,
            opacity: (backgroundDataUrl || strokes.length > 0) ? 0.6 : 1,
          }}
        >
          <option value="map">🗺️ Map</option>
          <option value="blank">📄 Blank</option>
          <option value="photo">📷 Photo</option>
        </select>

        {/* Tool picker — three small icon buttons (pen / highlighter /
            eraser). The selected one gets a coloured background so
            the worker always knows which mode they're in. Kept inline
            (not a dropdown) because tools get swapped often mid-draw
            and a dropdown would add a tap per switch. */}
        <div style={{
          display: 'flex', gap: 2, background: '#111827',
          border: '1px solid #374151', borderRadius: 6, padding: 2,
          flexShrink: 0,
        }}>
          {[
            { id: 'draw', icon: '🖊️', label: 'Pen', bg: '#3b82f6' },
            { id: 'highlight', icon: '🖍️', label: 'Highlighter', bg: '#eab308' },
            { id: 'erase', icon: '🩹', label: 'Eraser', bg: '#ef4444' },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              title={t.label}
              style={{
                padding: '4px 8px',
                background: tool === t.id ? t.bg : 'transparent',
                color: tool === t.id ? 'white' : '#9ca3af',
                border: 'none', borderRadius: 4, cursor: 'pointer',
                fontSize: '0.95rem', minWidth: 32,
              }}
            >{t.icon}</button>
          ))}
        </div>

        {/* Color swatch button — taps open a popover with all 10 presets
            plus the native color picker. Avoids eating the entire toolbar
            with circle swatches on narrow phones. Hidden for the eraser
            since stroke colour has no visible effect on a destination-out
            stroke. */}
        {tool !== 'erase' && (
          <button
            onClick={() => setShowColorPicker(v => !v)}
            title={`Color: ${color} (tap to change)`}
            style={{
              width: 32, height: 32, borderRadius: '50%',
              background: color,
              border: '2px solid #f9fafb',
              cursor: 'pointer', padding: 0, flexShrink: 0,
              boxShadow: showColorPicker ? '0 0 0 2px #3b82f6' : 'none',
            }}
          />
        )}

        {/* Bare width slider — small footprint, no label, no number. */}
        <input
          type="range" min="1" max="14" step="1"
          value={strokeWidth}
          onChange={e => setStrokeWidth(Number(e.target.value))}
          title={`Stroke width: ${strokeWidth}`}
          style={{ flex: 1, minWidth: 60, maxWidth: 160 }}
        />

        {/* Highlight opacity slider — only relevant while the highlighter
            is the active tool. Hidden for the pen so the toolbar stays
            uncluttered when it doesn't apply. Range is 5%–100%; default
            35% matches the pre-slider behaviour. The label uses 'α' so
            it doesn't eat width on narrow phones. */}
        {tool === 'highlight' && (
          <input
            type="range" min="0.05" max="1" step="0.05"
            value={highlightAlpha}
            onChange={e => setHighlightAlpha(Number(e.target.value))}
            title={`Highlighter opacity: ${Math.round(highlightAlpha * 100)}%`}
            style={{ flex: 1, minWidth: 60, maxWidth: 120, accentColor: '#eab308' }}
          />
        )}

        {/* Icon-only Undo / Clear */}
        <button
          onClick={handleUndo}
          disabled={strokes.length === 0}
          title="Undo last stroke"
          style={{
            padding: '6px 8px', background: '#374151', color: '#f9fafb',
            border: 'none', borderRadius: 6, fontSize: '0.95rem', flexShrink: 0,
            cursor: strokes.length === 0 ? 'not-allowed' : 'pointer',
            opacity: strokes.length === 0 ? 0.5 : 1, minWidth: 36,
          }}
        >↶</button>
        <button
          onClick={handleClear}
          disabled={strokes.length === 0}
          title="Clear all strokes"
          style={{
            padding: '6px 8px', background: '#374151', color: '#f9fafb',
            border: 'none', borderRadius: 6, fontSize: '0.85rem', flexShrink: 0,
            cursor: strokes.length === 0 ? 'not-allowed' : 'pointer',
            opacity: strokes.length === 0 ? 0.5 : 1, minWidth: 36,
          }}
        >🗑️</button>

        {/* Color popover — absolute-positioned beneath the toolbar so the
            swatch row no longer eats the full width. Tap outside (or any
            preset) closes it. */}
        {showColorPicker && (
          <div style={{
            position: 'absolute', top: '100%', left: 10, marginTop: 4,
            background: '#1f2937', border: '1px solid #374151', borderRadius: 8,
            padding: 10, zIndex: 5,
            boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
            display: 'grid', gridTemplateColumns: 'repeat(5, 28px)', gap: 8,
            alignItems: 'center',
          }}>
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => { setColor(c); setShowColorPicker(false); }}
                title={c}
                style={{
                  width: 28, height: 28, borderRadius: '50%',
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
                width: 30, height: 30, padding: 0, border: '1px solid #374151',
                background: 'transparent', borderRadius: '50%', cursor: 'pointer',
                gridColumn: 'span 5', justifySelf: 'start',
              }}
            />
          </div>
        )}
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
            <div style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <button
                onClick={() => { setCaptureError(null); setIsPickingMapLocation(true); }}
                style={{
                  padding: '7px 12px',
                  background: '#22c55e', color: 'white',
                  border: 'none', borderRadius: 6, cursor: 'pointer',
                  fontSize: '0.85rem', fontWeight: 600,
                }}
              >
                🗺️ Pick on Google Maps
              </button>
              <button
                onClick={() => captureMapFromGoogle()}
                disabled={isCapturing}
                style={{
                  padding: '7px 12px',
                  background: isCapturing ? '#374151' : '#1f2937',
                  color: '#f9fafb', border: '1px solid #374151', borderRadius: 6,
                  cursor: isCapturing ? 'wait' : 'pointer',
                  fontSize: '0.85rem',
                }}
              >
                {isCapturing ? 'Capturing…' : '📍 Use my location'}
              </button>
              <select
                value={captureType}
                onChange={e => setCaptureType(e.target.value)}
                style={{
                  background: '#111827', color: '#f9fafb',
                  border: '1px solid #374151', borderRadius: 4,
                  padding: '5px 6px', fontSize: '0.8rem',
                }}
              >
                <option value="satellite">Satellite</option>
                <option value="hybrid">Hybrid</option>
                <option value="roadmap">Road Map</option>
                <option value="terrain">Terrain</option>
              </select>
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

      {/* ── Interactive map picker ──
          Replaces the canvas area while the worker is choosing a Google
          Maps location to capture. The map is a live <GoogleMap> with
          full pan/zoom — when the worker taps "Capture this view" we
          read the live map's center + zoom and pipe them through the
          existing Static Maps pipeline so the background JPEG has the
          exact framing the worker just saw. */}
      {isPickingMapLocation && (
        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          background: '#0f172a',
        }}>
          <div style={{
            padding: '5px 10px', background: '#1f2937',
            borderBottom: '1px solid #374151',
            display: 'flex', gap: 6, alignItems: 'center',
            flexShrink: 0, fontSize: '0.78rem', color: '#9ca3af',
          }}>
            <span style={{ color: '#d1d5db', marginRight: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ display: 'flex', background: '#111827', borderRadius: 6, padding: 2, border: '1px solid #374151' }}>
                <button
                  onClick={() => setIsDrawingBoxMode(false)}
                  style={{
                    padding: '4px 10px', background: !isDrawingBoxMode ? '#3b82f6' : 'transparent', color: !isDrawingBoxMode ? 'white' : '#9ca3af',
                    border: 'none', borderRadius: 4, fontSize: '0.75rem', cursor: 'pointer',
                  }}
                >
                  🤚 Pan Map
                </button>
                <button
                  onClick={() => {
                    setIsDrawingBoxMode(true);
                    setBoxStart(null);
                    setBoxEnd(null);
                  }}
                  style={{
                    padding: '4px 10px', background: isDrawingBoxMode ? '#3b82f6' : 'transparent', color: isDrawingBoxMode ? 'white' : '#9ca3af',
                    border: 'none', borderRadius: 4, fontSize: '0.75rem', cursor: 'pointer',
                  }}
                >
                  ⏹️ Draw Box
                </button>
              </div>
              {isDrawingBoxMode ? 'Draw to crop' : 'Pan & zoom'}
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={recenterPickerOnGps} style={{
              padding: '4px 8px', background: '#374151', color: '#f9fafb',
              border: 'none', borderRadius: 5, fontSize: '0.75rem', cursor: 'pointer',
            }}>📍 Me</button>
            <select
              value={captureType}
              onChange={e => setCaptureType(e.target.value)}
              style={{
                background: '#111827', color: '#f9fafb',
                border: '1px solid #374151', borderRadius: 4,
                padding: '3px 5px', fontSize: '0.75rem',
              }}
            >
              <option value="satellite">Satellite</option>
              <option value="hybrid">Hybrid</option>
              <option value="roadmap">Road Map</option>
              <option value="terrain">Terrain</option>
            </select>
          </div>

          <div ref={pickerContainerRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {mapsApiLoadError ? (
              <div style={{
                padding: 20, color: '#fee2e2', background: '#7f1d1d',
                margin: 12, borderRadius: 6,
              }}>
                Couldn&apos;t load Google Maps. Check your network and try again.
              </div>
            ) : !isMapsApiLoaded ? (
              <div style={{
                padding: 20, color: '#9ca3af', textAlign: 'center',
              }}>Loading map…</div>
            ) : (
              <GoogleMap
                mapContainerStyle={{ width: '100%', height: '100%' }}
                center={captureCoords || { lat: 56.2524, lng: -120.8464 }}
                zoom={captureCoords ? captureZoom : 13}
                mapTypeId={captureType}
                options={{
                  mapTypeId: captureType,
                  disableDefaultUI: false,
                  mapTypeControl: false,
                  streetViewControl: false,
                  fullscreenControl: false,
                  gestureHandling: 'greedy',  // one-finger pan on mobile
                }}
                onIdle={() => {
                  const map = pickerMapRef.current;
                  if (map) {
                    const c = map.getCenter();
                    if (c) setCaptureCoords({ lat: c.lat(), lng: c.lng() });
                    setCaptureZoom(map.getZoom());
                  }
                }}
                onLoad={(map) => { 
                  pickerMapRef.current = map; 
                  map.setMapTypeId(captureType);
                }}
              />
            )}

            {isDrawingBoxMode && (
              <div
                style={{ position: 'absolute', inset: 0, zIndex: 10, cursor: 'crosshair', touchAction: 'none' }}
                onPointerDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                  setBoxStart(pt);
                  setBoxEnd(pt);
                  isDraggingBoxRef.current = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!isDraggingBoxRef.current || !boxStart) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const currentX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
                  const currentY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
                  
                  const dx = currentX - boxStart.x;
                  const dy = currentY - boxStart.y;
                  
                  // Enforce aspect ratio 640:448 -> 10:7
                  let newDx = dx;
                  let newDy = dy;
                  
                  if (Math.abs(dx) * 7 > Math.abs(dy) * 10) {
                    newDy = (Math.abs(dx) * 7 / 10) * Math.sign(dy);
                  } else {
                    newDx = (Math.abs(dy) * 10 / 7) * Math.sign(dx);
                  }
                  
                  setBoxEnd({
                    x: boxStart.x + newDx,
                    y: boxStart.y + newDy
                  });
                }}
                onPointerUp={(e) => {
                  isDraggingBoxRef.current = false;
                  if (boxStart) {
                    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
                  }
                }}
                onPointerCancel={(e) => {
                  isDraggingBoxRef.current = false;
                  if (boxStart) {
                    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
                  }
                }}
              >
                {boxStart && boxEnd && (() => {
                  const x1 = Math.min(boxStart.x, boxEnd.x);
                  const x2 = Math.max(boxStart.x, boxEnd.x);
                  const y1 = Math.min(boxStart.y, boxEnd.y);
                  const y2 = Math.max(boxStart.y, boxEnd.y);
                  return (
                    <>
                      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: y1, background: 'rgba(0,0,0,0.5)' }} />
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, top: y2, background: 'rgba(0,0,0,0.5)' }} />
                      <div style={{ position: 'absolute', top: y1, bottom: `calc(100% - ${y2}px)`, left: 0, width: x1, background: 'rgba(0,0,0,0.5)' }} />
                      <div style={{ position: 'absolute', top: y1, bottom: `calc(100% - ${y2}px)`, right: 0, left: x2, background: 'rgba(0,0,0,0.5)' }} />
                      <div style={{
                        position: 'absolute',
                        left: x1, top: y1, width: x2 - x1, height: y2 - y1,
                        border: '2px solid #3b82f6',
                        boxShadow: '0 0 0 1px rgba(255,255,255,0.5)',
                      }} />
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          {captureError && (
            <div style={{
              padding: 8, background: '#7f1d1d', color: '#fee2e2',
              fontSize: '0.85rem', textAlign: 'center', flexShrink: 0,
            }}>{captureError}</div>
          )}

          <div style={{
            display: 'flex', gap: 6, padding: '8px 10px',
            background: '#1f2937', borderTop: '1px solid #374151',
            flexShrink: 0,
          }}>
            <button
              onClick={captureFromPicker}
              disabled={isCapturing || !isMapsApiLoaded}
              style={{
                flex: 1, padding: '9px 12px',
                background: isCapturing ? '#374151' : '#22c55e',
                color: 'white', border: 'none', borderRadius: 7,
                fontWeight: 600, fontSize: '0.9rem',
                cursor: isCapturing ? 'wait' : 'pointer',
              }}
            >
              {isCapturing ? 'Capturing…' : '📸 Capture this view'}
            </button>
            <button
              onClick={() => setIsPickingMapLocation(false)}
              style={{
                padding: '9px 14px', background: '#374151', color: '#f9fafb',
                border: 'none', borderRadius: 7, fontSize: '0.9rem', cursor: 'pointer',
              }}
            >Back</button>
          </div>
        </div>
      )}

      {/* ── Canvas ──
          `minHeight: 0` is the key bit — without it, a tall flex child
          (the canvas image) would push the bottom bar off-screen on
          short viewports. With it, the canvas shrinks instead.
          When `canvasZoom > 1` the canvas's CSS width is scaled up so it
          overflows the wrapper; `overflow: auto` lets the worker scroll
          around to draw on the magnified area. */}
      {!isPickingMapLocation && (
        <div
          ref={containerRef}
          style={{
            flex: 1, minHeight: 0,
            // `flex-start` instead of `center` so the canvas anchors to
            // the top-left when zoomed in — center-justified flex on an
            // overflowing child silently disables scroll on the leading
            // axes, which would trap the worker on the middle of the
            // canvas with no way to reach the corners.
            display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start',
            padding: 12, overflow: 'auto', background: '#0f172a',
            position: 'relative',
          }}
        >
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
              // Display sizing: 95% of viewport when zoom is 1, scaled
              // up linearly from there. `height: auto` preserves aspect
              // ratio so the canvas stays square at any zoom. Pinch
              // handler mutates `canvasZoom` to drive this width.
              width: `${95 * canvasZoom}%`,
              maxWidth: 'none',
              height: 'auto',
              margin: 'auto',  // re-center while zoom == 1
              background: 'white',
              borderRadius: 8,
              touchAction: 'none',  // own all touch gestures (no native pan)
              boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
              cursor: 'crosshair',
            }}
          />

          {/* Tiny on-canvas zoom hint — appears only when the canvas is at
              1× so first-time workers know about pinch-to-zoom. Disappears
              once they've zoomed in (proving they know how it works). */}
          {canvasZoom === 1 && (
            <div style={{
              position: 'absolute', bottom: 16, right: 16,
              background: 'rgba(15, 23, 42, 0.75)', color: '#cbd5e1',
              padding: '4px 10px', borderRadius: 999,
              fontSize: '0.72rem', pointerEvents: 'none',
              border: '1px solid #374151',
            }}>
              👌 Pinch to zoom
            </div>
          )}

          {/* "Reset zoom" button — appears once zoom > 1 so the worker can
              snap back to the fit view without re-pinching. */}
          {canvasZoom !== 1 && (
            <button
              onClick={() => {
                setCanvasZoom(1);
                const c = containerRef.current;
                if (c) { c.scrollLeft = 0; c.scrollTop = 0; }
              }}
              style={{
                position: 'absolute', bottom: 16, right: 16,
                background: 'rgba(15, 23, 42, 0.9)', color: '#f9fafb',
                padding: '6px 12px', borderRadius: 999,
                fontSize: '0.78rem', cursor: 'pointer',
                border: '1px solid #374151',
              }}
            >
              {canvasZoom.toFixed(1)}× · Reset
            </button>
          )}
        </div>
      )}

      {/* Bottom safe-area spacer for iOS gesture bar — no buttons needed
          now that Save/Discard live in the header. */}
      <div style={{ flexShrink: 0, height: 'env(safe-area-inset-bottom, 0px)', background: '#1f2937' }} />
    </div>
  );
}
