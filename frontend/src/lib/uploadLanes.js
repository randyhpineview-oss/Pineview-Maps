// Two-lane upload helpers (Path B).
//
// The upload pipeline splits each lease-sheet / hydroseed-daily submit into
// two requests:
//
//   Lane 1 — metadata-only POST to the existing create endpoint. The DB
//   row + linked T&M / HT ticket are created and the response returns in
//   well under a second because no Dropbox calls happen (the create
//   endpoint sees no pdf_base64 / no photos and skips the upload pool).
//
//   Lane 2 — files POST to the new `/files` endpoint. The heavy PDF +
//   photos stream to Dropbox in parallel; the record's pdf_url / photo_urls
//   are patched on completion. Idempotent: Dropbox writes use overwrite
//   mode and the patch overwrites the URL columns wholesale, so retrying
//   after a network blip is safe.
//
// Files (pdf_base64 / tm_pdf_base64 / photos / seed_tag_photos) stay in
// the IndexedDB queue entry across lanes — the queue entry is only
// removed once lane 2 confirms — so a browser tab closing between lanes
// or a lane-2 failure never loses the worker's bytes.

/**
 * Resize + compress a single base64-encoded photo to at most `maxPx` on its
 * longest side at the given JPEG quality. Returns the compressed base64 string
 * (data stripped of the `data:…;base64,` prefix, matching the wire format the
 * rest of the upload pipeline expects).
 *
 * Falls back silently to the original string on any canvas / decode error so
 * a compression failure is never fatal to the upload.
 *
 * Why here rather than at capture time: compressing at capture time would
 * balloon the draft payload in IDB. Doing it at upload time keeps drafts
 * lossless while still cutting Dropbox upload size by 5–10× on typical
 * full-resolution phone camera shots (3–5 MB → 300–600 KB).
 */
async function compressPhotoBase64(
  base64,
  { maxPx = 1600, quality = 0.78 } = {},
) {
  if (!base64) return base64;
  try {
    const dataUrl = `data:image/jpeg;base64,${base64}`;
    const img = await new Promise((resolve, reject) => {
      const i = new window.Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = dataUrl;
    });
    const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const compressed = canvas.toDataURL('image/jpeg', quality);
    const comma = compressed.indexOf(',');
    return comma >= 0 ? compressed.slice(comma + 1) : base64;
  } catch {
    return base64;
  }
}

/**
 * Compress all photo arrays in a lane-2 payload in-place (mutates a shallow
 * copy). Returns a new payload object — the original (in IDB) is untouched.
 * Compression is skipped when the browser has no `document` (SSR / workers).
 */
export async function compressLane2Photos(targetType, payload) {
  if (!payload || typeof document === 'undefined') return payload;

  if (targetType === 'site' || targetType === 'pipeline' || targetType === 'external') {
    const photos = Array.isArray(payload.photos) ? payload.photos : [];
    if (!photos.length) return payload;
    const compressed = await Promise.all(
      photos.map(async (p) => {
        if (!p?.data) return p;
        return { ...p, data: await compressPhotoBase64(p.data) };
      }),
    );
    return { ...payload, photos: compressed };
  }

  if (targetType === 'hydroseed_daily') {
    const ann = Array.isArray(payload.photos) ? payload.photos : [];
    const seed = Array.isArray(payload.seed_tag_photos) ? payload.seed_tag_photos : [];
    if (!ann.length && !seed.length) return payload;
    const [compAnn, compSeed] = await Promise.all([
      Promise.all(ann.map(async (p) => p?.data ? { ...p, data: await compressPhotoBase64(p.data) } : p)),
      Promise.all(seed.map(async (p) => p?.data ? { ...p, data: await compressPhotoBase64(p.data) } : p)),
    ]);
    return { ...payload, photos: compAnn, seed_tag_photos: compSeed };
  }

  return payload;
}

/**
 * Build the slim lane-1 body by stripping every file field from the queue
 * payload. Does NOT mutate the input (the queue entry keeps the full
 * payload in IDB so lane 2 / lane-2 retries can find the bytes).
 */
export function stripFilesForLane1(targetType, payload) {
  if (!payload) return payload;

  if (targetType === 'site' || targetType === 'pipeline' || targetType === 'external') {
    const out = { ...payload };
    delete out.pdf_base64;
    if (out.lease_sheet_data) {
      const lsd = { ...out.lease_sheet_data };
      delete lsd.photos;
      out.lease_sheet_data = lsd;
    }
    if (out.time_materials_link) {
      const tml = { ...out.time_materials_link };
      delete tml.tm_pdf_base64;
      out.time_materials_link = tml;
    }
    return out;
  }

  if (targetType === 'hydroseed_daily') {
    const out = { ...payload };
    delete out.pdf_base64;
    delete out.photos;
    delete out.seed_tag_photos;
    if (out.daily_data) {
      const dd = { ...out.daily_data };
      delete dd.photos;
      delete dd.seed_tag_photos;
      out.daily_data = dd;
    }
    return out;
  }

  // Edit / update target types stay single-lane — caller doesn't strip.
  return payload;
}

/**
 * Build the lane-2 body from the full queue payload. Returns null when
 * there's nothing to upload (no PDF, no photos) so the caller can skip
 * the lane-2 round-trip entirely.
 */
export function buildLane2Payload(targetType, payload) {
  if (!payload) return null;

  if (targetType === 'site' || targetType === 'pipeline' || targetType === 'external') {
    const lsd = payload.lease_sheet_data || {};
    const photos = Array.isArray(lsd.photos) ? lsd.photos : [];
    const tmPdf = payload.time_materials_link?.tm_pdf_base64 || null;
    const pdf = payload.pdf_base64 || null;
    if (!pdf && !tmPdf && photos.length === 0) return null;
    return {
      pdf_base64: pdf,
      tm_pdf_base64: tmPdf,
      photos: photos.length ? photos : null,
    };
  }

  if (targetType === 'hydroseed_daily') {
    const dd = payload.daily_data || {};
    const photos = (Array.isArray(payload.photos) && payload.photos.length)
      ? payload.photos
      : (Array.isArray(dd.photos) ? dd.photos : []);
    const seed = (Array.isArray(payload.seed_tag_photos) && payload.seed_tag_photos.length)
      ? payload.seed_tag_photos
      : (Array.isArray(dd.seed_tag_photos) ? dd.seed_tag_photos : []);
    const pdf = payload.pdf_base64 || null;
    if (!pdf && photos.length === 0 && seed.length === 0) return null;
    return {
      pdf_base64: pdf,
      photos: photos.length ? photos : null,
      seed_tag_photos: seed.length ? seed : null,
    };
  }

  return null;
}

/**
 * Map a create targetType + the record id returned from lane 1 to the
 * lane-2 endpoint path.
 */
export function lane2EndpointFor(targetType, recordId) {
  if (targetType === 'site' || targetType === 'external') {
    return `/api/site-spray-records/${recordId}/files`;
  }
  if (targetType === 'pipeline') {
    return `/api/pipeline-spray-records/${recordId}/files`;
  }
  if (targetType === 'hydroseed_daily') {
    return `/api/hydroseed/dailies/${recordId}/files`;
  }
  return null;
}

/**
 * The targetTypes that use the two-lane pipeline. Edits / status updates
 * stay single-lane (existing PATCH endpoints, no behavior change).
 */
export function isTwoLaneTargetType(targetType) {
  return targetType === 'site'
    || targetType === 'pipeline'
    || targetType === 'external'
    || targetType === 'hydroseed_daily';
}
