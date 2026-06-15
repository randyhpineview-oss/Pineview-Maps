import { useEffect, useMemo, useRef, useState } from 'react';
import { generateLeaseSheetPdf } from '../lib/pdfGenerator';
import { generateTMTicketPdf } from '../lib/tmTicketPdfGenerator';
import { api } from '../lib/api';
import { saveLeaseSheetDraft, deleteLeaseSheetDraft, getAllTMTickets } from '../lib/offlineStore';
import { useAutoSaveDraft } from '../lib/useAutoSaveDraft';
import { localDateISO } from '../lib/dateUtil';
import PdfPreviewViewer from './PdfPreviewViewer';
import AutocompleteInput from './AutocompleteInput';
import { normalizeName } from '../lib/mapUtils';
import { useDialog } from './DialogProvider';

function get12hTime() {
  const now = new Date();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
}

export default function HerbicideLeaseSheet({
  site,
  pipeline,
  onSubmit,
  onCancel,
  isOpen,
  editingRecord = null,
  cachedLookups = {},
  initialDistanceMeters = null,
  draft = null,                 // optional draft to resume from
  onDraftSaved,                 // callback when "Save Draft" pressed successfully
  requireComments = false,
  commentsLabel = 'Comments',
  limitedRequiredFields = false,
  initialComments = '',
  standalone = false,
  clients = [],
  areas = [],
  lsdSuggestions = [],
  onRedirectToSite = null,
  onRequestMapPick = null,
  onCancelMapPick = null,
  pickedLocation = null,
}) {
  const { alert } = useDialog();
  const isEditMode = !!editingRecord;
  const initializedRef = useRef(false);
  const [herbicides, setHerbicides] = useState([]);
  const [applicators, setApplicators] = useState([]);
  const [noxiousWeeds, setNoxiousWeeds] = useState([]);
  const [locationTypes, setLocationTypes] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [photos, setPhotos] = useState([]);
  const [ticketNumber, setTicketNumber] = useState('');
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfBase64, setPdfBase64] = useState(null);
  // T&M linking step state
  const [isPickingTM, setIsPickingTM] = useState(false);
  const [openTMTickets, setOpenTMTickets] = useState([]);
  const [tmChoice, setTmChoice] = useState(null);  // { ticket_id } | { create: true, description_of_work }
  const [tmDescription, setTmDescription] = useState('');
  // True while the background open-T&M-tickets fetch is in flight after
  // pressing Continue from preview. Drives the small spinner in the
  // picker so the worker knows the tickets list is still populating.
  const [isLoadingTMTickets, setIsLoadingTMTickets] = useState(false);
  const [draftId, setDraftId] = useState(draft?.id || null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  // Set true when the worker taps "Save Draft" (which persists locally and
  // returns to the map). Read by the autosave hook's hasContent guard so the
  // unmount autosave doesn't re-run the full save after we've already saved.
  const savedAndClosingRef = useRef(false);
  // Local-only input for typing custom (Other) weeds. Not persisted.
  const [customWeedInput, setCustomWeedInput] = useState('');
  // Cache last generated PDF so tapping Preview a second time is instant
  // when nothing has changed. Keyed on a JSON snapshot of form + photo
  // identities (we use existingBase64.data length + preview URL as a cheap
  // identity without hashing full image bytes).
  const pdfCacheRef = useRef({ key: null, base64: null });
  // GPS state for standalone mode
  const [gpsLat, setGpsLat] = useState('');
  const [gpsLng, setGpsLng] = useState('');
  const [gpsStatus, setGpsStatus] = useState('');

  // Form state
  const [form, setForm] = useState({
    time: get12hTime(),
    date: localDateISO(),
    customer: '',
    area: '',
    lsdOrPipeline: '',
    applicators: [],
    locationTypes: [],
    temperature: '',
    windSpeed: '',
    windDirection: [],
    sprayType: [],
    sprayMethod: [],
    noxiousWeedsSelected: [],
    customWeeds: [],
    herbicidesUsed: [],
    totalDistanceSprayed: '',
    totalLiters: '',
    areaTreated: '',
    isAccessRoad: false,
    roadsideKm: '',
    roadsideHerbicides: [],
    roadsideLiters: '',
    roadsideAreaTreated: '',
    comments: '',
  });

  // Determine if access road is selected
  const accessRoadTypes = useMemo(() => 
    locationTypes.filter(t => t.is_access_road).map(t => t.name),
  [locationTypes]);

  const hasAccessRoad = useMemo(() => 
    form.locationTypes.some(type => accessRoadTypes.includes(type)),
  [form.locationTypes, accessRoadTypes]);

  // Determine if a pipeline-flagged location type is selected. Drives both
  // the visibility of the "Total Distance (km)" input below AND the
  // `isPipeline` flag we stamp into lease_sheet_data so the backend T&M row
  // derivation knows to emit site_type='Pipeline'.
  //
  // Fallback: also match by case-insensitive name 'Pipeline' so workers get
  // the correct UI immediately even if their cached lookup payload hasn't
  // been refreshed since the is_pipeline column was added.
  const pipelineTypes = useMemo(() =>
    locationTypes
      .filter(t => t.is_pipeline || (t.name || '').toLowerCase() === 'pipeline')
      .map(t => t.name),
  [locationTypes]);

  // The "main" site types are everything that isn't access-road-flagged or
  // pipeline-flagged — Wellsite, Compressor, Battery, etc. Workers pick
  // EXACTLY ONE of these per lease sheet; access-road and pipeline are
  // orthogonal and peel off into their own T&M rows.
  const mainSiteTypeNames = useMemo(() =>
    locationTypes
      .filter(t => !t.is_access_road)
      .map(t => t.name),
  [locationTypes]);

  // The single selected main site type (or '' if none yet). Stamped into
  // lease_sheet_data.mainSiteType so the backend T&M row derivation shows
  // what the worker actually picked (not a default from site.pin_type).
  const mainSiteType = useMemo(() => {
    const selected = form.locationTypes.filter(name => mainSiteTypeNames.includes(name));
    return selected[0] || '';
  }, [form.locationTypes, mainSiteTypeNames]);

  const hasPipeline = useMemo(() =>
    pipelineTypes.includes(mainSiteType),
  [mainSiteType, pipelineTypes]);

  const isRoadsideSite = useMemo(() =>
    mainSiteType === 'Roadside',
  [mainSiteType]);

  // List of required fields that are currently empty. Used both to disable the
  // Preview button and to surface a specific error message when the worker
  // taps it anyway.
  const requiredMissing = useMemo(() => {
    const missing = [];
    const isBlank = (v) => v === '' || v === null || v === undefined;
    if (limitedRequiredFields) {
      if (!form.applicators?.length) missing.push('Applicators');
      if (!String(form.comments || '').trim()) missing.push('Comments');
      return missing;
    }
    if (isBlank(form.time)) missing.push('Time');
    if (isBlank(form.date)) missing.push('Date');
    if (!form.customer || !String(form.customer).trim()) missing.push('Customer');
    if (!form.area || !String(form.area).trim()) missing.push('Area');
    if (!form.lsdOrPipeline || !String(form.lsdOrPipeline).trim()) missing.push('LSD / Pipeline');
    if (!form.applicators?.length) missing.push('Applicators');
    if (!mainSiteType) missing.push('Site Type');
    if (isBlank(form.temperature)) missing.push('Temperature');
    if (isBlank(form.windSpeed)) missing.push('Wind Speed');
    if (!form.windDirection?.length) missing.push('Wind Direction');
    if (!form.sprayType?.length) missing.push('Spray Type');
    if (!form.sprayMethod?.length) missing.push('Spray Method');
    if (!form.noxiousWeedsSelected?.length) missing.push('Noxious Weeds');
    if (
      form.noxiousWeedsSelected?.some(w => String(w).toLowerCase() === 'other') &&
      !form.customWeeds?.length
    ) {
      missing.push('Custom Weed (Other)');
    }
    if (!form.herbicidesUsed?.length) missing.push('Herbicides Used');
    if (isBlank(form.totalLiters)) missing.push('Total Liters');
    if ((hasPipeline || isRoadsideSite) && isBlank(form.totalDistanceSprayed)) {
      missing.push(isRoadsideSite ? 'Roadside km Sprayed' : 'Total Distance (km)');
    }
    if (hasAccessRoad) {
      if (isBlank(form.roadsideKm)) missing.push('Access Road km Sprayed');
      if (!form.roadsideHerbicides?.length) missing.push('Access Road Herbicides Used');
      if (isBlank(form.roadsideLiters)) missing.push('Access Road Liters');
    }
    if (requireComments && !String(form.comments || '').trim()) missing.push('Comments');
    if (photos.length < 2) missing.push('Photos (both slots)');
    return missing;
  }, [form, hasPipeline, isRoadsideSite, hasAccessRoad, mainSiteType, photos, requireComments, limitedRequiredFields]);

  // Auto-populate from site, pipeline, draft, or editing record (run once)
  useEffect(() => {
    // Restore draft (device-local, no API call)
    if (draft && !initializedRef.current) {
      initializedRef.current = true;
      if (draft.form) setForm(draft.form);
      if (Array.isArray(draft.photos) && draft.photos.length > 0) {
        // Normalize photos defensively: a draft may carry any combination
        // of {existingBase64, preview data-URL, top-level data, Dropbox
        // backup url}. We try local bytes first, then fall back to the
        // Dropbox URL via the photo proxy. Last-resort: drop the slot.
        const norm = draft.photos.map((p) => {
          if (!p) return null;
          const b64 = p.existingBase64?.data || p.data || null;
          const mime = p.existingBase64?.type || p.type || 'image/jpeg';
          const localDataUrl = b64
            ? `data:${mime};base64,${b64}`
            : (typeof p.preview === 'string' && p.preview.startsWith('data:') ? p.preview : null);
          return {
            file: null,
            preview: localDataUrl, // may be null — Dropbox fallback below
            existingBase64: b64 ? { data: b64, type: mime } : null,
            url: p.url || null,
          };
        }).filter(Boolean);
        setPhotos(norm.filter((p) => p.preview || p.url));

        // Async Dropbox fallback for any slot missing local bytes. Runs in
        // the background so the form opens immediately; photos pop in once
        // proxied. Failures are silent (slot stays blank, user can re-add).
        const needsFetch = norm
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => !p.preview && p.url);
        if (needsFetch.length > 0) {
          (async () => {
            for (const { p, i } of needsFetch) {
              try {
                const { data, type } = await api.proxyPhoto(p.url);
                const dataUrl = `data:${type};base64,${data}`;
                setPhotos((prev) => {
                  const next = [...prev];
                  if (next[i]) {
                    next[i] = {
                      ...next[i],
                      preview: dataUrl,
                      existingBase64: { data, type },
                    };
                  }
                  return next;
                });
              } catch { /* leave slot empty */ }
            }
          })();
        }
      }
      if (draft.ticketNumber) setTicketNumber(draft.ticketNumber);
      if (draft.id) setDraftId(draft.id);
      return;
    }
    if (isEditMode && editingRecord?.lease_sheet_data) {
      // Only populate form once — skip if already initialized
      if (initializedRef.current) return;
      initializedRef.current = true;
      const d = editingRecord.lease_sheet_data;
      setForm({
        time: d.time || get12hTime(),
        date: d.date || editingRecord.spray_date || localDateISO(),
        customer: d.customer || '',
        area: d.area || '',
        lsdOrPipeline: d.lsdOrPipeline || '',
        applicators: d.applicators || [],
        locationTypes: d.locationTypes || [],
        temperature: d.temperature || '',
        windSpeed: d.windSpeed || '',
        windDirection: d.windDirection || [],
        sprayType: d.sprayType || [],
        sprayMethod: d.sprayMethod || [],
        noxiousWeedsSelected: d.noxiousWeedsSelected || [],
        customWeeds: d.customWeeds || [],
        herbicidesUsed: d.herbicidesUsed || [],
        totalDistanceSprayed: d.totalDistanceSprayed || '',
        totalLiters: d.totalLiters || '',
        areaTreated: d.areaTreated || '',
        isAccessRoad: d.isAccessRoad || false,
        roadsideKm: d.roadsideKm || '',
        roadsideHerbicides: d.roadsideHerbicides || [],
        roadsideLiters: d.roadsideLiters || '',
        roadsideAreaTreated: d.roadsideAreaTreated || '',
        comments: d.comments || '',
      });
      setTicketNumber(editingRecord.ticket_number || d.ticket_number || '');

      // Restore photos from saved base64 data
      if (d.photos && d.photos.length > 0) {
        const restored = d.photos.filter((p) => p && p.data).map((p) => {
          const dataUrl = `data:${p.type || 'image/jpeg'};base64,${p.data}`;
          return {
            file: null,
            preview: dataUrl,
            existingBase64: p,
          };
        });
        if (restored.length > 0) {
          setPhotos(restored);
        } else {
          // Photos exist but have no data (stripped by backend migration), use photo_urls fallback.
          // Show placeholder slots immediately so the spinner is visible right away,
          // then patch each slot as the proxy fetch resolves.
          if (editingRecord.photo_urls && editingRecord.photo_urls.length > 0) {
            const placeholders = editingRecord.photo_urls.map((url) => ({ file: null, preview: null, url }));
            setPhotos(placeholders);
            (async () => {
              for (let i = 0; i < editingRecord.photo_urls.length; i++) {
                const url = editingRecord.photo_urls[i];
                try {
                  const { data, type } = await api.proxyPhoto(url);
                  const dataUrl = `data:${type};base64,${data}`;
                  setPhotos((prev) => {
                    const next = [...prev];
                    if (next[i]) next[i] = { file: null, preview: dataUrl, existingBase64: { data, type } };
                    return next;
                  });
                } catch {
                  setPhotos((prev) => {
                    const next = [...prev];
                    if (next[i]) next[i] = { file: null, preview: url, existingUrl: url };
                    return next;
                  });
                }
              }
            })();
          }
        }
      } else if (editingRecord.photo_urls && editingRecord.photo_urls.length > 0) {
        // No lease_sheet_data photos — fetch from Dropbox.
        // Show placeholder slots immediately so the spinner is visible right away,
        // then patch each slot as the proxy fetch resolves.
        const placeholders = editingRecord.photo_urls.map((url) => ({ file: null, preview: null, url }));
        setPhotos(placeholders);
        (async () => {
          for (let i = 0; i < editingRecord.photo_urls.length; i++) {
            const url = editingRecord.photo_urls[i];
            try {
              const { data, type } = await api.proxyPhoto(url);
              const dataUrl = `data:${type};base64,${data}`;
              setPhotos((prev) => {
                const next = [...prev];
                if (next[i]) next[i] = { file: null, preview: dataUrl, existingBase64: { data, type } };
                return next;
              });
            } catch {
              setPhotos((prev) => {
                const next = [...prev];
                if (next[i]) next[i] = { file: null, preview: url, existingUrl: url };
                return next;
              });
            }
          }
        })();
      }
      return;
    }

    const currentTime = get12hTime();
    const currentDate = localDateISO();
    
    if (site) {
      setForm(prev => ({
        ...prev,
        time: currentTime,
        date: currentDate,
        customer: site.client || '',
        area: site.area || '',
        lsdOrPipeline: site.lsd || '',
        comments: initialComments || prev.comments,
      }));
    } else if (pipeline) {
      setForm(prev => ({
        ...prev,
        time: currentTime,
        date: currentDate,
        customer: pipeline.client || '',
        area: pipeline.area || '',
        lsdOrPipeline: pipeline.name || '',
        comments: initialComments || prev.comments,
        // initialDistanceMeters is sourced from the KML segment picker in
        // meters; the lease sheet / T&M workflow now uses km for pipelines
        // so convert on the way in (3 decimals keeps the fidelity of the
        // original meter value).
        totalDistanceSprayed: initialDistanceMeters != null
          ? (Number(initialDistanceMeters) / 1000).toFixed(3)
          : prev.totalDistanceSprayed,
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditMode, isOpen]);

  // Ticket number is assigned by the backend on submit (not on form open)
  // This avoids wasting ticket numbers when users cancel.
  // In edit mode, we keep the original ticket number from the record.

  // Load lookup tables from pre-loaded IndexedDB cache (passed as prop from App)
  useEffect(() => {
    if (!isOpen) return;
    if (cachedLookups.herbicides?.length) setHerbicides(cachedLookups.herbicides);
    if (cachedLookups.applicators?.length) setApplicators(cachedLookups.applicators);
    if (cachedLookups.weeds?.length) setNoxiousWeeds(cachedLookups.weeds);
    if (cachedLookups.locations?.length) setLocationTypes(cachedLookups.locations);
    setIsLoading(false);
  }, [isOpen, cachedLookups]);

  // Calculate area treated when total liters changes (200L = 1ha)
  useEffect(() => {
    const liters = parseFloat(form.totalLiters);
    if (!isNaN(liters) && liters > 0) {
      const hectares = liters / 200;
      setForm(prev => ({ ...prev, areaTreated: hectares.toFixed(2) }));
    } else {
      setForm(prev => ({ ...prev, areaTreated: '' }));
    }
  }, [form.totalLiters]);

  // Calculate roadside area treated when roadside liters changes
  useEffect(() => {
    const liters = parseFloat(form.roadsideLiters);
    if (!isNaN(liters) && liters > 0) {
      const hectares = liters / 200;
      setForm(prev => ({ ...prev, roadsideAreaTreated: hectares.toFixed(2) }));
    } else {
      setForm(prev => ({ ...prev, roadsideAreaTreated: '' }));
    }
  }, [form.roadsideLiters]);

  // Sync pickedLocation from map pick into GPS fields
  useEffect(() => {
    if (pickedLocation && pickedLocation.latitude != null && pickedLocation.longitude != null) {
      setGpsLat(pickedLocation.latitude.toFixed(6));
      setGpsLng(pickedLocation.longitude.toFixed(6));
      setGpsStatus('Map location applied.');
    }
  }, [pickedLocation]);

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setGpsStatus('Geolocation not available.');
      return;
    }
    setGpsStatus('Getting location...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsLat(pos.coords.latitude.toFixed(6));
        setGpsLng(pos.coords.longitude.toFixed(6));
        setGpsStatus('Current GPS location applied.');
      },
      () => setGpsStatus('Location access failed. Enter manually.'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function clearLocation() {
    setGpsLat('');
    setGpsLng('');
    setGpsStatus('');
  }

  const handleCheckboxGroup = (field, value) => {
    setForm(prev => {
      const current = prev[field] || [];
      const updated = current.includes(value)
        ? current.filter(v => v !== value)
        : [...current, value];
      return { ...prev, [field]: updated };
    });
  };

  const handlePhotoUpload = async (e) => {
    const files = Array.from(e.target.files);
    // Reset the input so picking the same file twice (after a remove)
    // still triggers onChange.
    try { e.target.value = ''; } catch (_) { /* ignore */ }
    // Limit: only take what's needed to reach max 2
    const spotsLeft = 2 - photos.length;
    if (spotsLeft <= 0) return;
    // Read bytes IMMEDIATELY at pick time, while the Android content-URI
    // permission is still fresh. Holding the raw `File` and reading it
    // later (at preview / submit time) was failing on Android with
    // "The requested file could not be read, typically due to permission
    // problems that have occurred after a reference to a file was
    // acquired." — the OS revokes the picker's URI grant between pick
    // and read. Caching the base64 here sidesteps the issue entirely;
    // all downstream paths already prefer `existingBase64` over `file`.
    const slots = files.slice(0, spotsLeft);
    const toAdd = await Promise.all(slots.map((file) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = String(reader.result || '');
        const commaIdx = dataUrl.indexOf(',');
        const data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
        const mime = (dataUrl.match(/^data:(.+);base64/) || [])[1] || file.type || 'image/jpeg';
        resolve({
          existingBase64: { data, type: mime, name: file.name },
          preview: dataUrl,
        });
      };
      reader.onerror = () => {
        // If the read fails right at pick time, surface a clear error
        // instead of silently dropping the slot.
        alert({
          title: 'Photo read failed',
          message: 'Could not read the selected photo. Try taking a new one with the camera button.',
          severity: 'danger',
        });
        resolve(null);
      };
      reader.readAsDataURL(file);
    })));
    const ok = toAdd.filter(Boolean);
    if (ok.length === 0) return;
    setPhotos(prev => [...prev, ...ok]);
  };

  const removePhoto = (index) => {
    setPhotos(prev => {
      const updated = [...prev];
      // Only revoke if it's an object URL (not a data URL or external URL)
      if (updated[index].file) URL.revokeObjectURL(updated[index].preview);
      updated.splice(index, 1);
      return updated;
    });
  };

  const handlePreview = async () => {
    if (requiredMissing.length > 0) {
      await alert({
        title: 'Missing required fields',
        message: 'Please fill all required fields before continuing:\n\n• ' + requiredMissing.join('\n• '),
      });
      return;
    }
    setIsGeneratingPdf(true);
    try {
      // Build a cheap cache key from the form fields + photo identities
      // (file.name+size or existingBase64 data length or preview URL).
      // If nothing has changed since the last generation, reuse the cached
      // PDF bytes instantly without re-running jsPDF.
      const photoKey = photos.map((p) => {
        if (p?.file) return `f:${p.file.name}:${p.file.size}`;
        if (p?.existingBase64?.data) return `b:${p.existingBase64.data.length}`;
        return `u:${p?.preview || ''}`;
      }).join('|');
      const cacheKey = JSON.stringify({ form, ticketNumber, photoKey });
      if (pdfCacheRef.current.key === cacheKey && pdfCacheRef.current.base64) {
        setPdfBase64(pdfCacheRef.current.base64);
        setIsPreviewing(true);
        return;
      }

      // Build photo data URLs for embedding in PDF. FileReader is
      // wrapped with both `onloadend` and `onerror` — without `onerror`
      // a corrupted file silently hangs the await forever, leaving the
      // worker on a frozen "Preview" button until they reload.
      const photoDataUrls = await Promise.all(
        photos.filter(p => p && (p.file || (p.existingBase64?.data) || p.preview)).map(p => {
          if (p.file) {
            return new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
              reader.readAsDataURL(p.file);
            });
          }
          if (p.existingBase64?.data) {
            return Promise.resolve(`data:${p.existingBase64.type || 'image/jpeg'};base64,${p.existingBase64.data}`);
          }
          return Promise.resolve(p.preview);
        })
      );
      const pdfData = {
        ...form,
        ticket_number: ticketNumber,
        herbicidesLookup: herbicides,
        applicatorsLookup: applicators,
      };
      const { base64 } = await generateLeaseSheetPdf(pdfData, photoDataUrls);
      pdfCacheRef.current = { key: cacheKey, base64 };
      setPdfBase64(base64);
      setIsPreviewing(true);
    } catch (err) {
      console.error('[LEASE] Preview failed:', err);
      await alert({
        title: 'Preview failed',
        message: String(err.message || 'Unknown error'),
        severity: 'danger',
      });
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  // Called when user taps "Continue" from Preview.
  // In edit mode: skip linking step (record already linked); go straight to submit.
  // In create mode: navigate to T&M picker INSTANTLY, then fetch existing
  // tickets in the background with a short timeout.
  //
  // History: the previous version awaited `api.listOpenTMTickets(...)` in
  // series before transitioning, which could hang 5-10 seconds when the
  // browser reported `navigator.onLine === true` but couldn't actually
  // reach the server (captive portal, cell drop, Render cold-start).
  // api.js's internal retry-once-after-1s compounded that. The worker
  // would tap Continue and see the button do nothing.
  //
  // New flow:
  //   1. Switch to the picker immediately, defaulted to "create new".
  //   2. Kick off the open-tickets fetch in the background with a 2.5s
  //      race-timeout. The UI stays responsive the whole time.
  //   3. If tickets arrive in time, populate the list. If exactly one
  //      matches AND the worker hasn't already changed the radio,
  //      auto-select it (preserves the previous auto-pick behavior).
  //   4. If the fetch times out or errors, stay on create-new.
  const handleContinueFromPreview = async () => {
    if (isEditMode) {
      await handleConfirmSubmit();
      return;
    }

    // 1. Instant transition — no await before this.
    setOpenTMTickets([]);
    setTmChoice({ create: true });
    setIsPickingTM(true);

    // Offline short-circuit — don't even attempt the fetch.
    const isOffline = typeof window !== 'undefined' && window.navigator?.onLine === false;
    if (isOffline) {
      setIsLoadingTMTickets(true);
      try {
        const cached = await getAllTMTickets();
        const normClient = normalizeName(form.customer);
        const normArea = normalizeName(form.area);
        const matching = (cached || []).filter((t) => {
          return (
            t.status === 'open' &&
            !t.deleted_at &&
            normalizeName(t.client) === normClient &&
            normalizeName(t.area) === normArea &&
            t.spray_date === form.date
          );
        });
        setOpenTMTickets(matching);
        if (matching.length === 1) {
          setTmChoice((current) => (current?.create ? { ticket_id: matching[0].id } : current));
        } else if (matching.length > 1) {
          setTmChoice((current) => (current?.create ? null : current));
        }
      } catch (cacheErr) {
        console.warn('[LEASE] Offline T&M lookup failed:', cacheErr?.message);
      } finally {
        setIsLoadingTMTickets(false);
      }
      return;
    }

    // 2. Background fetch with hard timeout.
    setIsLoadingTMTickets(true);
    try {
      const TIMEOUT_MS = 2500;
      const tickets = await Promise.race([
        api.listOpenTMTickets({
          client: normalizeName(form.customer) || undefined,
          area: normalizeName(form.area) || undefined,
          spray_date: form.date || undefined,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('T&M tickets lookup timed out')), TIMEOUT_MS)
        ),
      ]);
      setOpenTMTickets(tickets || []);
      // 3. Auto-pick single match ONLY if the worker hasn't already
      // interacted with the radio group. Using the functional setState
      // form avoids a stale-closure race if they tap during the fetch.
      if (tickets && tickets.length === 1) {
        setTmChoice((current) => (current?.create ? { ticket_id: tickets[0].id } : current));
      } else if (tickets && tickets.length > 1) {
        // Multiple matches → clear the default create-new so the worker
        // is forced to pick, matching the previous behavior. But only
        // clear if they haven't picked something else during the wait.
        setTmChoice((current) => (current?.create ? null : current));
      }
    } catch (err) {
      console.warn('[LEASE] T&M tickets lookup failed/timed out, checking local cache:', err?.message);
      try {
        const cached = await getAllTMTickets();
        const normClient = normalizeName(form.customer);
        const normArea = normalizeName(form.area);
        const matching = (cached || []).filter((t) => {
          return (
            t.status === 'open' &&
            !t.deleted_at &&
            normalizeName(t.client) === normClient &&
            normalizeName(t.area) === normArea &&
            t.spray_date === form.date
          );
        });
        if (matching.length > 0) {
          setOpenTMTickets(matching);
          if (matching.length === 1) {
            setTmChoice((current) => (current?.create ? { ticket_id: matching[0].id } : current));
          } else if (matching.length > 1) {
            setTmChoice((current) => (current?.create ? null : current));
          }
        }
      } catch (cacheErr) {
        console.warn('[LEASE] Cache lookup fallback failed:', cacheErr?.message);
      }
    } finally {
      setIsLoadingTMTickets(false);
    }
  };

  // Latches `true` the instant submit is initiated. The on-close autosave
  // effect reads this ref to know whether to skip its forced save —
  // without it, after a successful submit the parent flips isOpen→false
  // and the wasOpenRef effect re-creates the draft we just consumed, so
  // the worker sees a stale draft re-appear after submit.
  // Never reset; the component unmounts shortly after.
  const hasSubmittedRef = useRef(false);

  const handleConfirmSubmit = async () => {
    hasSubmittedRef.current = true;
    setIsSubmitting(true);
    try {
      // Network detection. When offline we deliberately SKIP the next-ticket
      // fetch and the PDF regeneration: both need data the worker doesn't
      // have yet (ticket number from herb_lease_seq) and would otherwise
      // bake a blank "No: " into the Dropbox PDF. Instead we queue the
      // sheet without `ticket_number` / `pdf_base64`; processUploadQueue
      // re-generates them at upload time, when we know we have a network.
      const isOnline = typeof window !== 'undefined' && window.navigator?.onLine !== false;

      // For new records, fetch ticket number now so it appears in the PDF
      // (online path only; offline records get their ticket assigned and
      // their PDF rendered at upload time in processUploadQueue).
      let finalTicket = ticketNumber;
      if (!finalTicket && !isEditMode && isOnline) {
        try {
          const resp = await api.getNextTicket();
          finalTicket = resp.ticket_number;
          setTicketNumber(finalTicket);
        } catch (err) {
          // Edge case: navigator.onLine returned true but the request still
          // failed (captive portal, DNS hiccup). Fall through to the offline
          // path below — PDF will be regenerated when the queue retries.
          console.warn('[LEASE] Could not fetch ticket number, will defer to upload-time:', err?.message);
        }
      }

      // Convert photos to base64 once — used by both the PDF render below
      // (when we have a ticket) and the queued payload (always, so the
      // backend has the bytes to upload to Dropbox).
      //
      // For fresh photos (`p.file` set, `existingBase64` not yet built)
      // we MUST run them through FileReader to get a real `data:` URL.
      // Falling through to `p.preview` returned the blob: URL minted by
      // URL.createObjectURL — fine for the in-form `<img>` tag, but
      // jsPDF's `addImage` can't embed `blob:` URIs and the offline
      // queue payload would carry a string that's invalid the moment
      // the worker navigates away (blob URLs expire with their
      // creating document). Mirror handlePreview's logic here.
      const photoDataUrls = await Promise.all(
        photos.filter(p => p && (p.file || (p.existingBase64?.data) || p.preview)).map((p) => {
          if (p.existingBase64?.data) {
            return Promise.resolve(`data:${p.existingBase64.type || 'image/jpeg'};base64,${p.existingBase64.data}`);
          }
          if (p.file) {
            return new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
              reader.readAsDataURL(p.file);
            });
          }
          // Fallback: `preview` is a data: URL (from a draft restore)
          // OR a https: URL (Dropbox proxy result). Both work in
          // `<img>` and jsPDF.
          return Promise.resolve(p.preview);
        })
      );

      // Regenerate PDF with the ticket number so Dropbox copy has it.
      // Skipped offline: we don't have a real ticket number yet, and a
      // blank-ticket PDF would end up in Dropbox. processUploadQueue
      // renders the PDF at retry time using the saved lease_sheet_data.
      let finalPdfBase64 = null;
      if (finalTicket || isEditMode) {
        const out = await generateLeaseSheetPdf(
          {
            ...form,
            ticket_number: finalTicket,
            herbicidesLookup: herbicides,
            applicatorsLookup: applicators,
          },
          photoDataUrls
        );
        finalPdfBase64 = out.base64;
      }

      // Convert photos to base64
      const photoPromises = photos.map(async (p) => {
        if (p.existingBase64) {
          return p.existingBase64;
        }
        if (p.file) {
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              resolve({
                name: p.file.name,
                data: reader.result.split(',')[1],
                type: p.file.type,
              });
            };
            reader.readAsDataURL(p.file);
          });
        }
        return null;
      });
      
      const photoData = (await Promise.all(photoPromises)).filter(Boolean);
      const intendedSiteStatus = site
        ? (limitedRequiredFields ? 'issue_not_inspected' : (requireComments ? 'in_progress' : 'inspected'))
        : undefined;

      // ── Build the T&M link + tentative PDF so the backend can upload to Dropbox ──
      let tm_link = null;
      if (!isEditMode && tmChoice) {
        const pickedExisting = tmChoice.ticket_id
          ? openTMTickets.find((t) => t.id === tmChoice.ticket_id)
          : null;

        // Tentative T&M ticket for PDF rendering (backend will allocate the real number if `create`)
        // When the worker ticked a pipeline-flagged location type the main
        // row mirrors the backend's derive_row_from_spray_record: site_type
        // 'Pipeline' and area_ha holds totalDistanceSprayed directly (km,
        // already entered in km on the lease sheet form).
        // Mirrors backend derive_row_from_spray_record: pipeline sheets
        // force 'Pipeline', otherwise use the worker's actual selection
        // (falling back to the site's pin_type-derived default only as a
        // safety net — validation already requires mainSiteType).
        const tentativeSiteType = hasPipeline
          ? 'Pipeline'
          : (mainSiteType || (site?.pin_type === 'lsd' ? 'Wellsite' : ''));
        const tentativeAreaHa = hasPipeline
          ? (Number(form.totalDistanceSprayed) || 0)
          : (Number(form.areaTreated) || 0);
        const tentativeMainRow = {
          location: form.lsdOrPipeline || '',
          site_type: tentativeSiteType,
          herbicides: (form.herbicidesUsed || []).length === 1
            ? form.herbicidesUsed[0]
            : (form.herbicidesUsed || []).length > 1
              ? `${Math.min(form.herbicidesUsed.length, 3)} Herbicides`
              : '',
          liters_used: Number(form.totalLiters) || 0,
          area_ha: tentativeAreaHa,
          cost_code: '',
        };
        const tentativeTicket = pickedExisting
          ? {
              ...pickedExisting,
              rows: [
                ...(pickedExisting.rows || []),
                tentativeMainRow,
              ],
            }
          : {
              ticket_number: '',  // backend will fill
              spray_date: form.date,
              client: form.customer,
              area: form.area,
              description_of_work: tmDescription || (tmChoice.description_of_work || ''),
              rows: [tentativeMainRow],
            };

        // T&M PDF only renders when we have BOTH a real lease ticket number
        // AND (for the create-new case) we'd otherwise upload a tentative
        // PDF with a blank ticket header. processUploadQueue regenerates
        // the lease-sheet PDF with the real ticket; for the linked T&M PDF
        // we either:
        //   - have a `pickedExisting` ticket → its number is real, render now
        //   - are creating a new T&M → wait until upload time when we know
        //     the lease ticket number; the new T&M ticket number is still
        //     allocated server-side so its header line ("T&M Ticket: ...")
        //     stays blank either way (acceptable degradation; the *body*
        //     of the PDF — rows, dates, totals — renders correctly).
        let tmPdfBase64 = null;
        const canRenderTmNow = !!pickedExisting || !!finalTicket;
        if (canRenderTmNow) {
          try {
            const { base64 } = await generateTMTicketPdf(tentativeTicket, { includeOfficeData: false });
            tmPdfBase64 = base64;
          } catch (err) {
            console.warn('[LEASE] T&M PDF generation failed (continuing):', err?.message);
          }
        }

        tm_link = pickedExisting
          ? { ticket_id: pickedExisting.id, tm_pdf_base64: tmPdfBase64 }
          : {
              create: true,
              description_of_work: tmDescription || (tmChoice.description_of_work || ''),
              tm_pdf_base64: tmPdfBase64,
            };
      }

      // Idempotency key — see backend SiteSprayRecord.client_submission_id.
      // Reusing the draft id when present means a worker can "Save Draft",
      // close the form, reopen + submit later, and have it dedupe correctly
      // if the upload retries. Otherwise mint a fresh UUID at submit time.
      const clientSubmissionId = draftId || (
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      );

      // ── Pre-queue validation — mirror the backend Pydantic schema ──
      // The upload queue treats 400/422 as a permanent failure (a
      // payload that's structurally broken won't get any better with
      // retries). Catching the same conditions here means the worker
      // sees a clear "Spray date is missing" message NOW, while the
      // form is still open and editable, instead of a silent stalled
      // row in the Uploading list later. We deliberately keep this
      // check tight: only the things the backend would actually
      // reject, not a re-implementation of `requiredMissing`.
      const sprayDateStr = String(form.date || '').trim();
      if (!sprayDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(sprayDateStr)) {
        throw new Error(
          'Spray date is missing or in the wrong format. ' +
          'Please pick a date and try again.'
        );
      }
      if (tm_link?.create === true && !String(tm_link.description_of_work || '').trim()) {
        // The picker UI defaults to a blank description; the backend
        // 422s if `create=true` lands without one. This shouldn't happen
        // in practice (the picker enforces it) but we guard so a future
        // form change can't silently regress it into a queue stall.
        throw new Error(
          'Cannot create a new T&M ticket without a description of work. ' +
          'Pick an existing ticket or add a description.'
        );
      }

      const payload = {
        lease_sheet_data: {
          ...form,
          ticket_number: finalTicket || undefined,
          photos: photoData,
          // Persist a boolean parallel to `isAccessRoad` so the backend
          // row-derivation helper doesn't have to re-query location_types
          // to know this sheet was a pipeline spray.
          isPipeline: hasPipeline,
          // The single main site-type name the worker picked (Wellsite /
          // Compressor / Battery / etc). Backend reads this directly for
          // the T&M row's site_type column so the billing row matches the
          // lease-sheet PDF.
          mainSiteType: mainSiteType || null,
          ...(intendedSiteStatus ? { site_status: intendedSiteStatus } : {}),
        },
        pdf_base64: finalPdfBase64,
        ticket_number: finalTicket || undefined,
        spray_date: form.date,
        notes: form.comments,
        is_avoided: false,
        ...(intendedSiteStatus ? { site_status: intendedSiteStatus } : {}),
        time_materials_link: tm_link,
        client_submission_id: clientSubmissionId,
        ...(standalone ? {
          latitude: gpsLat ? parseFloat(gpsLat) : null,
          longitude: gpsLng ? parseFloat(gpsLng) : null,
        } : {}),
      };

      // For edit mode, regenerate the linked T&M PDF as well
      if (isEditMode && editingRecord?.tm_ticket_id) {
        try {
          const tmTicket = await api.getTMTicket(editingRecord.tm_ticket_id);
          const { base64: tmPdfBase64 } = await generateTMTicketPdf(tmTicket, {
            includeOfficeData: false,  // worker-facing regeneration — keep pricing blank
          });
          payload.tm_pdf_base64 = tmPdfBase64;
        } catch (err) {
          console.warn('[LEASE] Could not regenerate T&M PDF:', err?.message);
        }
      }

      await onSubmit(payload);

      // Delete local draft on successful submit, plus best-effort cleanup
      // of the Dropbox photo backup folder so abandoned backups don't pile
      // up. Failure is non-fatal — the lease sheet has already been
      // submitted and queued.
      if (draftId) {
        try { await deleteLeaseSheetDraft(draftId); } catch { /* ignore */ }
        try { api.deleteDraftPhotos(draftId); } catch { /* ignore */ }
      }
    } catch (err) {
      await alert({
        title: 'Upload failed',
        message: String(err.message || 'Unknown error'),
        severity: 'danger',
      });
      setIsSubmitting(false);
    }
  };

  // Save current form state as a device-local draft. Photos are stored in
  // IndexedDB as compact {data, type, url} blobs (one copy of the bytes —
  // we don't double-store a data-URL `preview`, which previously bloated
  // iOS Safari's IDB quota and caused photos to silently drop on resume).
  // We also push each photo to Dropbox (best-effort) as a safety net: if
  // IDB ever loses the local copy, the resume path falls back to fetching
  // the Dropbox URL via the photo proxy.
  // Serialize current photos to compact [{data, type, url?}] blobs — one copy
  // of the bytes. Async because fresh (p.file) photos go through FileReader.
  // Shared by the autosave path and the explicit Save Draft button.
  const serializeDraftPhotos = async () => {
    const photoPromises = photos.filter(p => p && (p.file || p.existingBase64?.data || (typeof p.preview === 'string' && p.preview.startsWith('data:')) || p.url)).map(async (p) => {
      if (p.existingBase64?.data) {
        return {
          data: p.existingBase64.data,
          type: p.existingBase64.type || 'image/jpeg',
          url: p.url || null,
        };
      }
      if (typeof p.preview === 'string' && p.preview.startsWith('data:')) {
        const [meta, b64] = p.preview.split(',');
        const mime = (meta.match(/data:(.*?);base64/) || [])[1] || 'image/jpeg';
        return { data: b64, type: mime, url: p.url || null };
      }
      if (p.file) {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve({
            data: reader.result.split(',')[1],
            type: p.file.type || 'image/jpeg',
            url: p.url || null,
          });
          reader.readAsDataURL(p.file);
        });
      }
      // Last-resort: photo lives only on Dropbox (no local bytes).
      if (p.url) return { data: null, type: 'image/jpeg', url: p.url };
      return null;
    });
    return (await Promise.all(photoPromises)).filter(Boolean);
  };

  const buildDraftPayload = (ensuredDraftId, serializablePhotos, extra = {}) => ({
    id: ensuredDraftId,
    site_id: site?.id || null,
    pipeline_id: pipeline?.id || null,
    site_status: limitedRequiredFields ? 'issue_not_inspected' : (requireComments ? 'in_progress' : 'inspected'),
    form,
    photos: serializablePhotos,
    ticketNumber,
    label: `${form.customer || site?.client || '—'} / ${form.area || site?.area || '—'} / ${form.lsdOrPipeline || site?.lsd || '—'}`,
    ...extra,
  });

  // Best-effort Dropbox photo backup. Detached from React state so it's safe
  // to run AFTER the form has closed — the explicit Save Draft path returns
  // the worker to the map immediately and lets this finish in the background.
  // On completion it clears the transient `_saving` flag so the Drafts list
  // swaps "Saving…" for the normal row.
  const backupDraftPhotos = async (ensuredDraftId, basePayload, serializablePhotos) => {
    try {
      if (window.navigator.onLine) {
        await Promise.all(serializablePhotos.map(async (p, i) => {
          if (p.url || !p.data) return;
          try {
            const { url } = await api.uploadDraftPhoto(ensuredDraftId, i, p.data, p.type);
            if (url) p.url = url;
          } catch { /* non-fatal */ }
        }));
      }
    } catch { /* non-fatal */ }
    // Always clear the saving flag (backup done or skipped) and refresh the
    // Drafts list so the "Saving…" indicator goes away.
    try { await saveLeaseSheetDraft({ ...basePayload, photos: serializablePhotos, _saving: false }); } catch { /* non-fatal */ }
    try { onDraftSaved?.(); } catch { /* non-fatal */ }
  };

  // Autosave path (tab blur / form close): write the local snapshot and run
  // the Dropbox backup. Fire-and-forget from the hook's perspective.
  const handleSaveDraft = async () => {
    setIsSavingDraft(true);
    try {
      const serializablePhotos = await serializeDraftPhotos();
      const ensuredDraftId = draftId || (
        (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const draftPayload = buildDraftPayload(ensuredDraftId, serializablePhotos);
      const saved = await saveLeaseSheetDraft(draftPayload);
      setDraftId(saved.id);
      onDraftSaved?.(saved);
      await backupDraftPhotos(ensuredDraftId, draftPayload, serializablePhotos);
    } catch (err) {
      await alert({
        title: 'Could not save draft',
        message: String(err.message || 'Unknown error'),
        severity: 'danger',
      });
    } finally {
      setIsSavingDraft(false);
    }
  };

  // Explicit "Save Draft" button: persist the local snapshot with a transient
  // "Saving…" flag, return to the map immediately, then finish the Dropbox
  // backup in the background. Non-blocking — the worker never waits on the
  // network, and the Drafts list shows a "Saving…" row until the backup
  // settles.
  const handleSaveDraftAndClose = async () => {
    if (isSavingDraft) return;
    setIsSavingDraft(true);
    try {
      const serializablePhotos = await serializeDraftPhotos();
      const ensuredDraftId = draftId || (
        (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      // Only show "Saving…" if there's still a Dropbox backup to do; an
      // offline save or a photo-less draft is already fully persisted.
      const needsBackup = window.navigator.onLine && serializablePhotos.some((p) => p.data && !p.url);
      const draftPayload = buildDraftPayload(ensuredDraftId, serializablePhotos);
      await saveLeaseSheetDraft({ ...draftPayload, _saving: needsBackup });
      setDraftId(ensuredDraftId);
      onDraftSaved?.();
      // Prevent the unmount autosave from re-running the full save.
      savedAndClosingRef.current = true;
      // Return to the map now; finish the photo backup detached.
      onCancel?.();
      if (needsBackup) void backupDraftPhotos(ensuredDraftId, draftPayload, serializablePhotos);
    } catch (err) {
      setIsSavingDraft(false);
      await alert({
        title: 'Could not save draft',
        message: String(err.message || 'Unknown error'),
        severity: 'danger',
      });
    }
  };

  const handleBackToEdit = () => {
    setIsPreviewing(false);
    setPdfBase64(null);
  };

  // ── Auto-save draft on tab blur / form close ─────────────────────────────
  // The hook saves whenever the tab becomes hidden, the page is being torn
  // down, or this component unmounts. We additionally fire `saveNow` below
  // when the parent flips `isOpen` from true → false (the form returns
  // `null` in that case but doesn't unmount), to cover the most common
  // "user closes the modal" path.
  //
  // Guarded so we never autosave while:
  //   - the form is closed (nothing to save),
  //   - we're already submitting (race with the real POST),
  //   - we're inside the T&M picker (worker is mid-flow, not "abandoning"),
  //   - we're editing an existing record (drafts are for new sheets only).
  const autoSaveEnabled = isOpen && !isEditMode && !isSubmitting && !isPickingTM;
  const { saveNow: autoSaveDraftNow } = useAutoSaveDraft({
    enabled: autoSaveEnabled,
    hasContent: () => {
      if (savedAndClosingRef.current) return false;
      const f = form;
      return Boolean(
        photos.length > 0 ||
        (f.customer && String(f.customer).trim()) ||
        (f.area && String(f.area).trim()) ||
        (f.lsdOrPipeline && String(f.lsdOrPipeline).trim()) ||
        f.applicators?.length ||
        f.locationTypes?.length ||
        f.herbicidesUsed?.length ||
        (f.totalLiters && String(f.totalLiters).trim()) ||
        (f.comments && String(f.comments).trim())
      );
    },
    save: handleSaveDraft,
  });

  // Fire one autosave when parent closes the modal (isOpen: true → false).
  // The component stays mounted (early-return null), so the hook's unmount
  // cleanup wouldn't fire on its own.
  //
  // hasSubmittedRef.current skips this branch after a successful submit so
  // we don't race the parent's `deleteLeaseSheetDraft` and re-create the
  // draft a beat after the queue entry was committed. Without the guard,
  // workers would see a "phantom" draft reappear in their Drafts list
  // every time they submitted a new sheet.
  const wasOpenRef = useRef(isOpen);
  useEffect(() => {
    if (wasOpenRef.current && !isOpen && autoSaveEnabled === false) {
      // Re-evaluate the gate manually since `autoSaveEnabled` is already
      // false by this point (isOpen flipped). We still want to save if
      // not edit-mode / not submitting / and the worker didn't just submit.
      if (!isEditMode && !isSubmitting && !isPickingTM && !hasSubmittedRef.current) {
        autoSaveDraftNow({ force: true });
      }
    }
    wasOpenRef.current = isOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  // ── T&M linking step (between Preview and Submit) ──
  if (isPickingTM) {
    return (
      <div style={{
        backgroundColor: '#1f2937',
        color: '#f9fafb',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
        padding: '20px',
        overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 600 }}>Link to Time & Materials Ticket</h2>
          <button onClick={() => setIsPickingTM(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
        </div>
        <p style={{ fontSize: '0.85rem', color: '#9ca3af', margin: '0 0 14px 0' }}>
          Today's open tickets for <strong>{form.customer || '—'}</strong> / <strong>{form.area || '—'}</strong>:
        </p>

        {isLoadingTMTickets && openTMTickets.length === 0 ? (
          // Small inline loading state while the background fetch is in
          // flight (capped at ~2.5s). Picker is already interactive so
          // the worker can pick "create new" + type a description while
          // this loads — they don't have to wait for it.
          <div style={{
            fontSize: '0.85rem',
            color: '#9ca3af',
            background: '#111827',
            padding: '12px',
            borderRadius: '8px',
            marginBottom: '14px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}>
            <span style={{
              display: 'inline-block',
              width: '14px',
              height: '14px',
              border: '2px solid #374151',
              borderTopColor: '#60a5fa',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }} />
            Looking for open T&M tickets…
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : openTMTickets.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
            {openTMTickets.map((t) => (
              <label
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  background: tmChoice?.ticket_id === t.id ? '#1e40af' : '#111827',
                  padding: '12px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  border: '1px solid #374151',
                }}
              >
                <input
                  type="radio"
                  name="tm-choice"
                  checked={tmChoice?.ticket_id === t.id}
                  onChange={() => setTmChoice({ ticket_id: t.id })}
                  style={{ marginTop: '2px' }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{t.ticket_number}</div>
                  <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginTop: '2px' }}>
                    {(t.rows?.length || 0)} row(s) • {t.created_by_name || '—'}
                  </div>
                  {t.description_of_work ? (
                    <div style={{ fontSize: '0.75rem', color: '#d1d5db', marginTop: '4px' }}>
                      {t.description_of_work}
                    </div>
                  ) : null}
                </div>
              </label>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: '0.85rem', color: '#9ca3af', background: '#111827', padding: '12px', borderRadius: '8px', marginBottom: '14px' }}>
            No open T&M tickets match this client / area / date.
          </div>
        )}

        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            background: tmChoice?.create ? '#1e40af' : '#111827',
            padding: '12px',
            borderRadius: '8px',
            cursor: 'pointer',
            border: '1px solid #374151',
            marginBottom: '14px',
          }}
        >
          <input
            type="radio"
            name="tm-choice"
            checked={!!tmChoice?.create}
            onChange={() => setTmChoice({ create: true })}
            style={{ marginTop: '2px' }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>+ Start new T&M ticket</div>
            <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '2px' }}>
              New ticket for {form.customer || '—'} / {form.area || '—'} / {form.date || '—'}
            </div>
          </div>
        </label>

        {tmChoice?.create ? (
          <div style={{ marginBottom: '14px' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', color: '#9ca3af', marginBottom: '6px' }}>
              Description of Work <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>
            </label>
            <textarea
              value={tmDescription}
              onChange={(e) => setTmDescription(e.target.value)}
              placeholder="e.g. Spray leases and compressors"
              rows={2}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid #374151',
                backgroundColor: '#111827',
                color: '#f9fafb',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
          </div>
        ) : null}

        {tmChoice?.create && openTMTickets.length > 0 ? (
          <div style={{
            fontSize: '0.8rem',
            color: '#fcd34d',
            background: '#78350f',
            padding: '10px',
            borderRadius: '6px',
            marginBottom: '14px',
            border: '1px solid #b45309',
            lineHeight: '1.4',
          }}>
            ⚠ <strong>Note:</strong> There is already at least one open T&M ticket for this client and area today ({openTMTickets.map(t => t.ticket_number).join(', ')}). 
            Normally, you should link your work to the existing ticket. Only start a new one if the client explicitly requested separate tickets for each site.
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: '10px', marginTop: 'auto' }}>
          {(() => {
            const needsDescription = tmChoice?.create && !tmDescription.trim();
            const needsChoice = !tmChoice;
            const isDisabled = isSubmitting || needsDescription || needsChoice;
            const label = isSubmitting
              ? 'Uploading...'
              : needsChoice
                ? 'Select a ticket above'
                : 'Confirm & Submit';
            return (
              <button
                onClick={handleConfirmSubmit}
                disabled={isDisabled}
                style={{
                  flex: 2,
                  padding: '12px',
                  background: isDisabled ? '#374151' : '#22c55e',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '1rem',
                  fontWeight: 600,
                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                }}
              >
                {label}
              </button>
            );
          })()}
          <button
            onClick={() => setIsPickingTM(false)}
            disabled={isSubmitting}
            style={{
              flex: 1,
              padding: '12px',
              background: '#374151',
              color: '#f9fafb',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Preview overlay ──
  if (isPreviewing) {
    // Print handler: convert base64 to Blob, open in new window, trigger print
    const handlePrint = () => {
      if (!pdfBase64) return;
      const raw = atob(pdfBase64);
      const uint8 = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) uint8[i] = raw.charCodeAt(i);
      const blob = new Blob([uint8], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const printWindow = window.open(url, '_blank');
      if (printWindow) {
        printWindow.onload = () => {
          printWindow.print();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
      } else {
        URL.revokeObjectURL(url);
      }
    };

    return (
      <div style={{
        backgroundColor: '#4b5563',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', flexShrink: 0, background: '#1f2937' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, color: '#f9fafb' }}>Preview{ticketNumber ? ` — ${ticketNumber}` : ''}</h2>
          <button onClick={handlePrint} style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: '0.85rem', cursor: 'pointer' }}>Print</button>
        </div>
        <PdfPreviewViewer pdfBase64={pdfBase64} />
        <div style={{ display: 'flex', gap: '10px', padding: '12px 16px', flexShrink: 0, background: '#1f2937' }}>
          <button
            onClick={handleContinueFromPreview}
            disabled={isSubmitting}
            style={{
              flex: 1,
              padding: '12px',
              backgroundColor: '#22c55e',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              opacity: isSubmitting ? 0.7 : 1,
            }}
          >
            {isSubmitting ? 'Uploading...' : isEditMode ? 'Update & Re-Submit' : 'Continue'}
          </button>
          <button
            onClick={handleBackToEdit}
            disabled={isSubmitting}
            style={{
              flex: 1,
              padding: '12px',
              backgroundColor: '#374151',
              color: '#f9fafb',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            Back to Edit
          </button>
        </div>
      </div>
    );
  }

  // ── Form ──
  return (
    <div className="lease-sheet" style={{
      backgroundColor: '#1f2937',
      color: '#f9fafb',
      flex: 1,
      overflowY: 'auto',
      overflowX: 'hidden',
      padding: '20px',
      maxWidth: '600px',
      margin: '0 auto',
      width: '100%',
      boxSizing: 'border-box',
    }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>{isEditMode ? 'Edit Lease Sheet' : 'Herbicide Lease Sheet'}</h2>
          <button onClick={onCancel} style={{
            background: 'none',
            border: 'none',
            color: '#9ca3af',
            fontSize: '1.5rem',
            cursor: 'pointer',
          }}>×</button>
        </div>
        {ticketNumber && (
          <div style={{
            backgroundColor: '#111827',
            border: '1px solid #3b82f6',
            borderRadius: '6px',
            padding: '8px 12px',
            marginBottom: '16px',
            fontSize: '1rem',
            fontWeight: 700,
            color: '#3b82f6',
            textAlign: 'center',
          }}>
            Ticket: {ticketNumber}
          </div>
        )}

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>Loading form...</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Auto-populated fields */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Time {!form.time && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
                <input
                  type="text"
                  value={form.time}
                  readOnly
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #374151',
                    backgroundColor: '#111827',
                    color: '#f9fafb',
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Date {!form.date && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
                <input
                  type="date"
                  value={form.date}
                  onChange={e => setForm(prev => ({ ...prev, date: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #374151',
                    backgroundColor: '#111827',
                    color: '#f9fafb',
                  }}
                />
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Customer {!(form.customer && String(form.customer).trim()) && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
              {standalone ? (
                <AutocompleteInput
                  value={form.customer}
                  onChange={(next) => setForm(prev => ({ ...prev, customer: next }))}
                  placeholder="Customer"
                  suggestions={clients}
                  inputStyle={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #374151', backgroundColor: '#111827', color: '#f9fafb' }}
                />
              ) : (
                <input
                  type="text"
                  value={form.customer}
                  onChange={e => setForm(prev => ({ ...prev, customer: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #374151',
                    backgroundColor: '#111827',
                    color: '#f9fafb',
                  }}
                />
              )}
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Area {!(form.area && String(form.area).trim()) && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
              {standalone ? (
                <AutocompleteInput
                  value={form.area}
                  onChange={(next) => setForm(prev => ({ ...prev, area: next }))}
                  placeholder="Area"
                  suggestions={areas}
                  inputStyle={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #374151', backgroundColor: '#111827', color: '#f9fafb' }}
                />
              ) : (
                <input
                  type="text"
                  value={form.area}
                  onChange={e => setForm(prev => ({ ...prev, area: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #374151',
                    backgroundColor: '#111827',
                    color: '#f9fafb',
                  }}
                />
              )}
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>{standalone ? 'Location (e.g. Km 4, Hwy 43 North)' : 'LSD / Pipeline'} {!(form.lsdOrPipeline && String(form.lsdOrPipeline).trim()) && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
              {standalone ? (
                <AutocompleteInput
                  value={form.lsdOrPipeline}
                  onChange={(next) => setForm(prev => ({ ...prev, lsdOrPipeline: next }))}
                  placeholder="Location description"
                  suggestions={lsdSuggestions}
                  onSelect={(item) => {
                    if (item.site && onRedirectToSite) {
                      onRedirectToSite(item.site);
                      return;
                    }
                    setForm(prev => ({ ...prev, lsdOrPipeline: item.label }));
                    if (item.sub) {
                      const parts = item.sub.split(' · ');
                      setForm(prev => ({
                        ...prev,
                        customer: prev.customer || parts[0] || '',
                        area: prev.area || parts[1] || '',
                      }));
                    }
                  }}
                  inputStyle={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #374151', backgroundColor: '#111827', color: '#f9fafb' }}
                />
              ) : (
                <input
                  type="text"
                  value={form.lsdOrPipeline}
                  onChange={e => setForm(prev => ({ ...prev, lsdOrPipeline: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #374151',
                    backgroundColor: '#111827',
                    color: '#f9fafb',
                  }}
                />
              )}
            </div>

            {/* Optional GPS location (standalone mode only) */}
            {standalone && (
              <div style={{ marginTop: '4px' }}>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>GPS Location (optional)</label>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                  <button className="secondary-button" type="button" onClick={useCurrentLocation} style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                    Use Current Location
                  </button>
                  <button className="secondary-button" type="button" onClick={() => onRequestMapPick?.()} style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                    Pick on Map
                  </button>
                  {(gpsLat || gpsLng) && (
                    <button className="secondary-button" type="button" onClick={clearLocation} style={{ padding: '6px 12px', fontSize: '0.8rem', color: '#f87171' }}>
                      Clear
                    </button>
                  )}
                </div>
                {(gpsLat || gpsLng) && (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input type="text" value={gpsLat} onChange={(e) => setGpsLat(e.target.value)} placeholder="Latitude"
                      style={{ flex: 1, padding: '6px 10px', borderRadius: '6px', border: '1px solid #374151', backgroundColor: '#111827', color: '#f9fafb', fontSize: '0.8rem' }} />
                    <input type="text" value={gpsLng} onChange={(e) => setGpsLng(e.target.value)} placeholder="Longitude"
                      style={{ flex: 1, padding: '6px 10px', borderRadius: '6px', border: '1px solid #374151', backgroundColor: '#111827', color: '#f9fafb', fontSize: '0.8rem' }} />
                  </div>
                )}
                {gpsStatus && <div className="small-text" style={{ marginTop: '4px' }}>{gpsStatus}</div>}
              </div>
            )}

            {/* Applicators */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Applicators {!form.applicators?.length && <span style={{ color: '#f87171' }}>*</span>}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {applicators.map(app => (
                  <label key={app.id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    backgroundColor: form.applicators.includes(app.name) ? '#3b82f6' : '#374151',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                  }}>
                    <input
                      type="checkbox"
                      checked={form.applicators.includes(app.name)}
                      onChange={() => handleCheckboxGroup('applicators', app.name)}
                      style={{ display: 'none' }}
                    />
                    {app.name}
                  </label>
                ))}
              </div>
            </div>

            {/* Site Type (single-select main type, required) + separate
                Access Road / Pipeline toggles that can be layered on top. */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Site Type {!mainSiteType && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {locationTypes
                  .filter(t => !t.is_access_road)
                  .map(type => (
                    <label key={type.id} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '6px 12px',
                      borderRadius: '6px',
                      backgroundColor: mainSiteType === type.name ? '#3b82f6' : '#374151',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                    }}>
                      <input
                        type="radio"
                        name="mainSiteType"
                        checked={mainSiteType === type.name}
                        onChange={() => setForm(prev => {
                          // Replace any currently-selected main type with this
                          // one, while preserving access-road / pipeline picks.
                          const retained = (prev.locationTypes || []).filter(n => !mainSiteTypeNames.includes(n));
                          return { ...prev, locationTypes: [...retained, type.name] };
                        })}
                        style={{ display: 'none' }}
                      />
                      {type.name}
                    </label>
                  ))}
              </div>
            </div>

            {/* Add-ons: Access Road + Pipeline (each its own T&M row) */}
            {locationTypes.some(t => t.is_access_road) ? (
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Add-ons</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {locationTypes
                    .filter(t => t.is_access_road)
                    .map(type => (
                      <label key={type.id} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        backgroundColor: form.locationTypes.includes(type.name) ? '#3b82f6' : '#374151',
                        cursor: 'pointer',
                        fontSize: '0.875rem',
                      }}>
                        <input
                          type="checkbox"
                          checked={form.locationTypes.includes(type.name)}
                          onChange={() => handleCheckboxGroup('locationTypes', type.name)}
                          style={{ display: 'none' }}
                        />
                        {type.name}
                      </label>
                    ))}
                </div>
              </div>
            ) : null}

            {/* Weather */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Temperature (°C) {form.temperature === '' || form.temperature === null || form.temperature === undefined ? <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span> : null}</label>
                <input
                  type="number"
                  value={form.temperature}
                  onChange={e => setForm(prev => ({ ...prev, temperature: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #374151',
                    backgroundColor: '#111827',
                    color: '#f9fafb',
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Wind Speed (km/h) {form.windSpeed === '' || form.windSpeed === null || form.windSpeed === undefined ? <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span> : null}</label>
                <input
                  type="number"
                  value={form.windSpeed}
                  onChange={e => setForm(prev => ({ ...prev, windSpeed: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #374151',
                    backgroundColor: '#111827',
                    color: '#f9fafb',
                  }}
                />
              </div>
            </div>

            {/* Wind Direction */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Wind Direction {!form.windDirection?.length && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {['North', 'South', 'East', 'West', 'None'].map(dir => (
                  <label key={dir} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    backgroundColor: form.windDirection.includes(dir) ? '#3b82f6' : '#374151',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                  }}>
                    <input
                      type="checkbox"
                      checked={form.windDirection.includes(dir)}
                      onChange={() => handleCheckboxGroup('windDirection', dir)}
                      style={{ display: 'none' }}
                    />
                    {dir}
                  </label>
                ))}
              </div>
            </div>

            {/* Spray Type */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Spray Type {!form.sprayType?.length && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {['Blanket', 'Spot', 'Respray'].map(type => (
                  <label key={type} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    backgroundColor: form.sprayType.includes(type) ? '#3b82f6' : '#374151',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                  }}>
                    <input
                      type="checkbox"
                      checked={form.sprayType.includes(type)}
                      onChange={() => handleCheckboxGroup('sprayType', type)}
                      style={{ display: 'none' }}
                    />
                    {type}
                  </label>
                ))}
              </div>
            </div>

            {/* Spray Method */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Spray Method {!form.sprayMethod?.length && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {['Boomless', 'Covered Boom', 'Handwand', 'Backpack'].map(method => (
                  <label key={method} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    backgroundColor: form.sprayMethod.includes(method) ? '#3b82f6' : '#374151',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                  }}>
                    <input
                      type="checkbox"
                      checked={form.sprayMethod.includes(method)}
                      onChange={() => handleCheckboxGroup('sprayMethod', method)}
                      style={{ display: 'none' }}
                    />
                    {method}
                  </label>
                ))}
              </div>
            </div>

            {/* Noxious Weeds */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Noxious Weeds {(!form.noxiousWeedsSelected?.length || (form.noxiousWeedsSelected.some(w => String(w).toLowerCase() === 'other') && !form.customWeeds?.length)) && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {noxiousWeeds.map(weed => (
                  <label key={weed.id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    backgroundColor: form.noxiousWeedsSelected.includes(weed.name) ? '#3b82f6' : '#374151',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                  }}>
                    <input
                      type="checkbox"
                      checked={form.noxiousWeedsSelected.includes(weed.name)}
                      onChange={() => {
                        const isOther = weed.name.toLowerCase() === 'other';
                        const alreadyChecked = form.noxiousWeedsSelected.includes(weed.name);
                        if (isOther && alreadyChecked) {
                          // Un-checking "Other" also clears any typed custom weeds
                          setForm(prev => ({
                            ...prev,
                            noxiousWeedsSelected: prev.noxiousWeedsSelected.filter(v => v !== weed.name),
                            customWeeds: [],
                          }));
                          setCustomWeedInput('');
                        } else {
                          handleCheckboxGroup('noxiousWeedsSelected', weed.name);
                        }
                      }}
                      style={{ display: 'none' }}
                    />
                    {weed.name}
                  </label>
                ))}
              </div>

              {/* Custom weeds input (shown only when "Other" is selected) */}
              {form.noxiousWeedsSelected.some(w => w.toLowerCase() === 'other') && (
                <div style={{ marginTop: '10px', padding: '10px', background: '#111827', border: '1px solid #374151', borderRadius: '6px' }}>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      type="text"
                      value={customWeedInput}
                      onChange={(e) => setCustomWeedInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const trimmed = customWeedInput.trim();
                          if (!trimmed) return;
                          if (form.customWeeds.includes(trimmed)) { setCustomWeedInput(''); return; }
                          setForm(prev => ({ ...prev, customWeeds: [...prev.customWeeds, trimmed] }));
                          setCustomWeedInput('');
                        }
                      }}
                      placeholder="Type a weed name and press Add / Enter"
                      style={{
                        flex: 1,
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid #374151',
                        backgroundColor: '#1f2937',
                        color: '#f9fafb',
                        fontSize: '0.875rem',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const trimmed = customWeedInput.trim();
                        if (!trimmed) return;
                        if (form.customWeeds.includes(trimmed)) { setCustomWeedInput(''); return; }
                        setForm(prev => ({ ...prev, customWeeds: [...prev.customWeeds, trimmed] }));
                        setCustomWeedInput('');
                      }}
                      style={{
                        padding: '6px 14px',
                        borderRadius: '6px',
                        border: 'none',
                        background: '#3b82f6',
                        color: 'white',
                        fontSize: '0.85rem',
                        cursor: 'pointer',
                        fontWeight: 600,
                      }}
                    >
                      Add
                    </button>
                  </div>
                  {form.customWeeds.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                      {form.customWeeds.map((w, idx) => (
                        <span key={`${w}-${idx}`} style={{
                          display: 'inline-flex', alignItems: 'center', gap: '6px',
                          padding: '4px 10px',
                          borderRadius: '999px',
                          background: '#3b82f6',
                          color: 'white',
                          fontSize: '0.8rem',
                        }}>
                          {w}
                          <button
                            type="button"
                            onClick={() => setForm(prev => ({ ...prev, customWeeds: prev.customWeeds.filter((_, i) => i !== idx) }))}
                            aria-label={`Remove ${w}`}
                            style={{ background: 'transparent', color: 'white', border: 'none', cursor: 'pointer', padding: 0, fontSize: '1rem', lineHeight: 1 }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Herbicides Used */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Herbicides Used {!form.herbicidesUsed?.length && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {herbicides.map(herb => (
                  <label key={herb.id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    backgroundColor: form.herbicidesUsed.includes(herb.name) ? '#3b82f6' : '#374151',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                  }}>
                    <input
                      type="checkbox"
                      checked={form.herbicidesUsed.includes(herb.name)}
                      onChange={() => handleCheckboxGroup('herbicidesUsed', herb.name)}
                      style={{ display: 'none' }}
                    />
                    {herb.name}
                  </label>
                ))}
              </div>
            </div>

            {/* Total Liters and (conditionally) Distance Sprayed.
                The Metres input only shows when a pipeline-flagged location
                type is selected; for wellsite/roadside/etc. sprays it would
                just confuse workers into thinking it's required. */}
            <div style={{ display: 'grid', gridTemplateColumns: (hasPipeline || isRoadsideSite) ? '1fr 1fr' : '1fr', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Total Liters {form.totalLiters === '' || form.totalLiters === null || form.totalLiters === undefined ? <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span> : null}</label>
                <input
                  type="number"
                  value={form.totalLiters}
                  onChange={e => setForm(prev => ({ ...prev, totalLiters: e.target.value }))}
                  placeholder="200L = 1ha"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #374151',
                    backgroundColor: '#111827',
                    color: '#f9fafb',
                  }}
                />
              </div>
              {(hasPipeline || isRoadsideSite) && (
                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>{isRoadsideSite ? 'Roadside km Sprayed' : 'Total Distance (km)'} {form.totalDistanceSprayed === '' || form.totalDistanceSprayed === null || form.totalDistanceSprayed === undefined ? <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span> : null}</label>
                  <input
                    type="number"
                    value={form.totalDistanceSprayed}
                    onChange={e => setForm(prev => ({ ...prev, totalDistanceSprayed: e.target.value }))}
                    placeholder="km"
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid #374151',
                      backgroundColor: '#111827',
                      color: '#f9fafb',
                    }}
                  />
                </div>
              )}
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Area Treated (ha) {!form.areaTreated && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
                <input
                  type="text"
                  value={form.areaTreated}
                  readOnly
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #374151',
                    backgroundColor: '#1f2937',
                    color: '#9ca3af',
                  }}
                />
              </div>
            </div>

            {/* Roadside Fields (shown when access road selected) */}
            {hasAccessRoad && (
              <div style={{ 
                padding: '16px', 
                borderRadius: '8px', 
                backgroundColor: '#111827',
                border: '1px solid #374151',
              }}>
                <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', color: '#f9fafb' }}>Access Road Details</h3>
                
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Access Road km Sprayed {form.roadsideKm === '' || form.roadsideKm === null || form.roadsideKm === undefined ? <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span> : null}</label>
                  <input
                    type="number"
                    value={form.roadsideKm}
                    onChange={e => setForm(prev => ({ ...prev, roadsideKm: e.target.value }))}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid #374151',
                      backgroundColor: '#111827',
                      color: '#f9fafb',
                    }}
                  />
                </div>

                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Access Road Herbicides Used {!form.roadsideHerbicides?.length && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {herbicides.map(herb => (
                      <label key={herb.id} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        backgroundColor: form.roadsideHerbicides.includes(herb.name) ? '#3b82f6' : '#374151',
                        cursor: 'pointer',
                        fontSize: '0.875rem',
                      }}>
                        <input
                          type="checkbox"
                          checked={form.roadsideHerbicides.includes(herb.name)}
                          onChange={() => handleCheckboxGroup('roadsideHerbicides', herb.name)}
                          style={{ display: 'none' }}
                        />
                        {herb.name}
                      </label>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Access Road Liters {form.roadsideLiters === '' || form.roadsideLiters === null || form.roadsideLiters === undefined ? <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span> : null}</label>
                    <input
                      type="number"
                      value={form.roadsideLiters}
                      onChange={e => setForm(prev => ({ ...prev, roadsideLiters: e.target.value }))}
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid #374151',
                        backgroundColor: '#111827',
                        color: '#f9fafb',
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Access Road Area (ha) {!form.roadsideAreaTreated && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}</label>
                    <input
                      type="text"
                      value={form.roadsideAreaTreated}
                      readOnly
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid #374151',
                        backgroundColor: '#1f2937',
                        color: '#9ca3af',
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Comments */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>
                {commentsLabel} {(requireComments || limitedRequiredFields) && !String(form.comments || '').trim() ? <span style={{ color: '#f87171' }}>*</span> : null}
              </label>
              <textarea
                value={form.comments}
                onChange={e => setForm(prev => ({ ...prev, comments: e.target.value }))}
                rows={3}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid #374151',
                  backgroundColor: '#111827',
                  color: '#f9fafb',
                  resize: 'vertical',
                }}
              />
            </div>

            {/* Photos — max 2 */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Photos (max 2)</label>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                {/* Slot 1: LSD / Location ID */}
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: '4px' }}>
                    LSD / Location ID {!photos[0] && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}
                  </div>
                  {photos[0] ? (
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      {photos[0].preview ? (
                        <img src={photos[0].preview} alt="LSD Photo" style={{ width: '100px', height: '100px', objectFit: 'cover', borderRadius: '6px' }} />
                      ) : (
                        <div style={{ width: '100px', height: '100px', borderRadius: '6px', backgroundColor: '#374151', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                          <span style={{ display: 'inline-block', width: '20px', height: '20px', border: '2px solid rgba(255,255,255,0.2)', borderTopColor: '#9ca3af', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                          <span style={{ fontSize: '0.6rem', color: '#6b7280' }}>Loading…</span>
                        </div>
                      )}
                      {photos[0].preview && <button onClick={() => removePhoto(0)} style={{ position: 'absolute', top: '-8px', right: '-8px', width: '20px', height: '20px', borderRadius: '50%', backgroundColor: '#ef4444', color: 'white', border: 'none', cursor: 'pointer', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>}
                    </div>
                  ) : (
                    <>
                      {/* No `capture="environment"` — letting the OS pick the
                          source means iOS shows the native action sheet
                          (Photo Library / Take Photo / Choose Files) and
                          Android shows the equivalent chooser, instead of
                          jumping straight into the camera with no way for
                          the worker to pick an existing photo from their
                          gallery. */}
                      <input type="file" accept="image/*" onChange={handlePhotoUpload} style={{ display: 'none' }} id="photo-lsd" />
                      <label htmlFor="photo-lsd" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100px', height: '100px', backgroundColor: '#374151', borderRadius: '6px', cursor: 'pointer', fontSize: '2rem', color: '#6b7280' }}>+</label>
                    </>
                  )}
                </div>
                {/* Slot 2: Site Photo */}
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: '4px' }}>
                    Site Photo {!photos[1] && <span style={{ color: '#f87171', display: limitedRequiredFields ? 'none' : 'inline' }}>*</span>}
                  </div>
                  {photos[1] ? (
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      {photos[1].preview ? (
                        <img src={photos[1].preview} alt="Site Photo" style={{ width: '100px', height: '100px', objectFit: 'cover', borderRadius: '6px' }} />
                      ) : (
                        <div style={{ width: '100px', height: '100px', borderRadius: '6px', backgroundColor: '#374151', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                          <span style={{ display: 'inline-block', width: '20px', height: '20px', border: '2px solid rgba(255,255,255,0.2)', borderTopColor: '#9ca3af', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                          <span style={{ fontSize: '0.6rem', color: '#6b7280' }}>Loading…</span>
                        </div>
                      )}
                      {photos[1].preview && <button onClick={() => removePhoto(1)} style={{ position: 'absolute', top: '-8px', right: '-8px', width: '20px', height: '20px', borderRadius: '50%', backgroundColor: '#ef4444', color: 'white', border: 'none', cursor: 'pointer', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>}
                    </div>
                  ) : (
                    <>
                      {/* See note on photo-lsd input: omitting capture lets
                          the OS show its native picker so the worker can
                          choose between camera and gallery. */}
                      <input type="file" accept="image/*" onChange={handlePhotoUpload} style={{ display: 'none' }} id="photo-site" />
                      <label htmlFor="photo-site" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100px', height: '100px', backgroundColor: '#374151', borderRadius: '6px', cursor: photos.length >= 2 ? 'not-allowed' : 'pointer', fontSize: '2rem', color: '#6b7280' }}>+</label>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Submit buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '20px' }}>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  onClick={handlePreview}
                  disabled={requiredMissing.length > 0 || isGeneratingPdf}
                  title={requiredMissing.length > 0 ? `Missing: ${requiredMissing.join(', ')}` : ''}
                  style={{
                    flex: 1,
                    padding: '12px',
                    backgroundColor: requiredMissing.length > 0 ? '#374151' : '#3b82f6',
                    color: requiredMissing.length > 0 ? '#9ca3af' : 'white',
                    border: 'none',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontWeight: 600,
                    cursor: (requiredMissing.length > 0 || isGeneratingPdf) ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                  }}
                >
                  {isGeneratingPdf ? (
                    <>
                      <span style={{ display: 'inline-block', width: '16px', height: '16px', border: '2px solid rgba(255,255,255,0.4)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                      Generating…
                    </>
                  ) : requiredMissing.length > 0 ? `Preview (${requiredMissing.length} missing)` : 'Preview'}
                </button>
                <button
                  onClick={onCancel}
                  style={{
                    flex: 1,
                    padding: '12px',
                    backgroundColor: '#374151',
                    color: '#f9fafb',
                    border: 'none',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
              {!isEditMode && (
                <button
                  onClick={handleSaveDraftAndClose}
                  disabled={isSavingDraft}
                  style={{
                    padding: '10px',
                    backgroundColor: 'transparent',
                    color: '#9ca3af',
                    border: '1px dashed #374151',
                    borderRadius: '8px',
                    fontSize: '0.9rem',
                    cursor: isSavingDraft ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isSavingDraft ? 'Saving draft...' : draftId ? '💾 Update Draft' : '💾 Save Draft'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
  );
}
