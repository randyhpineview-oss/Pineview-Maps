import { useEffect, useMemo, useRef, useState } from 'react';
import { generateHydroseedDailyPdf, KG_PER_BALE } from '../lib/hydroseedDailyPdfGenerator';
import { api } from '../lib/api';
import { localDateISO } from '../lib/dateUtil';
import {
  saveHydroseedDailyDraft,
  deleteHydroseedDailyDraft,
} from '../lib/offlineStore';
import { useAutoSaveDraft } from '../lib/useAutoSaveDraft';
import PdfPreviewViewer from './PdfPreviewViewer';
import AutocompleteInput from './AutocompleteInput';
import { useDialog } from './DialogProvider';
import MapAnnotationCanvas from './MapAnnotationCanvas';
import { normalizeName } from '../lib/mapUtils';

const MULCH_TYPES = ['Wood', 'Wood + Tack', 'BFM', 'FGM'];

// Suggested equipment labels — match the Quote Builder "Hydroseeding" catalog
// so the office HT pricing stays consistent with quoted rates. Workers can
// still type any free-text label that isn't in this list.
//
// NOTE: "Crew Truck", "Supervisor with Truck", "Lead", and "Labourer" are
// intentionally NOT in this list — those have dedicated count/hours fields
// on the form (the paper-form schedule treats them as fixed rows with
// auto-multiplied totals). Workers can still type those labels as free
// text if they really want a one-off equipment entry, but the dedicated
// fields are the supported path.
const EQUIPMENT_SUGGESTIONS = [
  'T400 Hydroseeder', 'T330 Hydroseeder', '1600 Hydroseeder',
  'Skid Steer', 'UTV / SXS',
];

function newUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeBlankLoad(index) {
  return {
    id: newUuid(),
    load_number: index + 1,
    area_m2: '',
    mulch_bales: '',
    soil_amendment_kg: '',
    seed_kgs: {},
    aqua_gel_kg: '',
    tackifier_kg: '',
    fertilizer_kg: '',
    // Liquid micronutrient additive measured in litres per load. The HT
    // (T&M ticket) PDF rolls these up across all linked dailies into a
    // single 'Micronutrients' line item in the materials/installation
    // section so the office can price per-litre.
    micronutrients_l: '',
    notes: '',
  };
}

function makeBlankSeedType(index) {
  return { name: `Seed ${index + 1}`, description: '' };
}

const inputStyle = {
  width: '100%',
  padding: '10px',
  backgroundColor: '#111827',
  border: '1px solid #374151',
  borderRadius: '6px',
  color: '#f9fafb',
  fontSize: '0.95rem',
  boxSizing: 'border-box',
};

const labelStyle = { display: 'block', fontSize: '0.8rem', color: '#9ca3af', marginBottom: '4px' };

const STRUCTURED_EQ_LABELS = new Set(['crew truck', 'travel (mob/demob)', 'water truck']);

/**
 * Standalone Hydroseed Daily Application Record form.
 *
 * Props are intentionally similar to HerbicideLeaseSheet to ease wiring in
 * App.jsx: `onSubmit({ daily })` fires after a successful POST, `onCancel`
 * closes the modal. `clients` / `areas` / `getAreasForClient` feed
 * autocomplete suggestions for the header. `duplicateFrom`, `draft`, and
 * `editingRecord` are stubs for later phases (Phase 3 = drafts, Phase 6 =
 * duplicate). They're accepted now so the prop surface doesn't change later.
 */
export default function HydroseedDailyRecord({
  isOpen,
  onSubmit,
  onCancel,
  clients = [],
  areas = [],
  getAreasForClient = null,
  // Phase 4+ — pre-fill from an existing record (duplicate flow). Cleared
  // fields: date, photos, seed tags, loads.
  duplicateFrom = null,
  // Phase 3 — resume an in-progress draft from IndexedDB.
  draft = null,
  // Phase 6 — edit an already-submitted record.
  editingRecord = null,
  // System user roster (admin + office + worker). Used to populate the
  // crew picker so the worker doesn't have to retype their teammates'
  // names every shift. Mirrors what `cachedUsers` provides to the rest
  // of the app (check-ins, AdminPanel, etc.). Workers can still add a
  // custom name on top — sub-contractors, day labourers, etc. — so the
  // picker is additive, not restrictive.
  users = [],
}) {
  const { alert } = useDialog();
  const isEditMode = !!editingRecord;
  const initializedRef = useRef(false);
  // Photo dirty flags. Drive the submit payload's `photos` /
  // `seed_tag_photos` fields:
  //   - `true`  → send the full base64 array (current shape).
  //   - `false` → send `null` so the backend preserves the existing
  //              Dropbox URLs without re-uploading the same bytes.
  // Defaults are reset on every open: `true` for create/duplicate flows
  // (so new records actually get their photos), `false` for edit mode
  // (so a worker who tweaks the description without touching photos
  // doesn't burn bandwidth + Dropbox quota re-uploading every photo).
  const [photosDirty, setPhotosDirty] = useState(true);
  const [seedTagPhotosDirty, setSeedTagPhotosDirty] = useState(true);

  const [form, setForm] = useState(() => ({
    date: localDateISO(),
    client: '',
    // Customer-side contact for THIS job — the rep who signed off / can be
    // called if something needs clarification. Separate from `client` (the
    // billing entity) because billing-to and on-site-contact often differ
    // (e.g. client = "BC Hydro", rep = "Bob Smith, Field Supervisor").
    customer_rep: '',
    customer_rep_phone: '',
    area: '',
    site_name: '',
    description_of_work: '',
    // Crew is split into three role buckets because each role gets billed
    // at a different rate. `crew` is kept as a derived flat list (built
    // on submit + draft save) so existing PDF + backend code paths that
    // expect a single `crew[]` continue to work without changes.
    supervisor: '',         // single person, billed as supervisor
    lead: '',               // single person, billed as lead-hand
    workers: [],            // every other crew member, billed as labourer
    crew: [],
    // Per-role payroll hours. Each role bills at a different rate so we
    // capture them as separate scalars. `labour_hours_per_person` is
    // multiplied by `workers.length` server-side to produce the
    // "Total General Labour" hours on the HT PDF.
    supervisor_hours: '',
    lead_hours: '',
    labour_hours_per_person: '',
    // Crew Truck (count × hours per truck). Auto-multiplied on the HT
    // PDF so the office only types the per-truck-hour rate. Hydroseeders
    // intentionally stay in `equipment[]` (one row per machine) so the
    // client sees each unit as its own line item.
    crew_truck_count: '',
    crew_truck_hours: '',
    equipment: [],
    mulch_type: '',
    soil_amendment: '',
    seed_types: [makeBlankSeedType(0)],
    fertilizer: '',
    loads: [],
    // Mob/demob distance — sums across linked dailies on the HT PDF
    // 'Travel (Mob/Demob)' row.
    travel_km: '',
    // Water-truck loads — sums across linked dailies on the HT PDF
    // 'Water Truck' row.
    water_truck_loads: '',
    seed_tag_photos: [],
    photos: [],
    comments: '',
  }));

  const [recordNumber, setRecordNumber] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [pdfBase64, setPdfBase64] = useState(null);
  const [editingLoad, setEditingLoad] = useState(null);   // load object being edited (in sub-modal)
  const [newCrewName, setNewCrewName] = useState('');
  // Phase 3 — device-local draft id. Reused across autosaves so we update
  // the same row instead of piling new ones up.
  const [draftId, setDraftId] = useState(draft?.id || null);
  // Phase 4 — HT picker step (between Preview and Submit, mirroring the
  // lease-sheet → T&M picker). `htChoice` is one of:
  //   • { ticket_id: <int> }   — link to existing open HT
  //   • { create: true }       — create a new HT (description below)
  //   • null                   — worker hasn't decided yet
  const [isPickingHT, setIsPickingHT] = useState(false);
  const [openHTTickets, setOpenHTTickets] = useState([]);
  const [htChoice, setHtChoice] = useState(null);
  const [htDescription, setHtDescription] = useState('');
  const [isLoadingHTTickets, setIsLoadingHTTickets] = useState(false);
  // Phase 5 — annotation canvas modal state.
  const [annotationOpen, setAnnotationOpen] = useState(false);

  // Preview the next HD###### number (read-only — the real allocation
  // happens server-side on submit).
  useEffect(() => {
    if (!isOpen || recordNumber) return;
    let cancelled = false;
    api.getNextHydroseedDaily()
      .then(resp => { if (!cancelled) setRecordNumber(resp.record_number); })
      .catch(() => { /* offline-friendly: leave blank, server assigns on submit */ });
    return () => { cancelled = true; };
  }, [isOpen, recordNumber]);

  // Hydrate from `duplicateFrom` or `editingRecord` or `draft`. The first
  // useEffect with isOpen as a dep so reopening doesn't clobber edits.
  useEffect(() => {
    if (!isOpen) {
      initializedRef.current = false;
      return;
    }
    if (initializedRef.current) return;
    if (draft) {
      initializedRef.current = true;
      // The draft's form already carries photos + seed_tag_photos in the
      // same shape state expects ({ data, type, dataUrl }), so a plain
      // merge is enough. Older drafts (without photo arrays) fall back to
      // the blank defaults from initial state.
      setForm(prev => ({
        ...prev,
        ...(draft.form || {}),
        photos: draft.form?.photos || draft.photos || [],
        seed_tag_photos: draft.form?.seed_tag_photos || draft.seedTagPhotos || [],
      }));
      if (draft.recordNumber) setRecordNumber(draft.recordNumber);
      if (draft.id) setDraftId(draft.id);
      return;
    }
    if (duplicateFrom?.daily_data) {
      initializedRef.current = true;
      const d = duplicateFrom.daily_data;
      setForm({
        // Header + ingredients carry over
        date: localDateISO(),
        client: d.client || duplicateFrom.client || '',
        customer_rep: d.customer_rep || duplicateFrom.customer_rep || '',
        customer_rep_phone: d.customer_rep_phone || duplicateFrom.customer_rep_phone || '',
        area: d.area || duplicateFrom.area || '',
        site_name: d.site_name || duplicateFrom.site_name || '',
        description_of_work: d.description_of_work || duplicateFrom.description_of_work || '',
        // Prefer the structured role fields when present; fall back to
        // legacy flat `crew` (pre-roles records) by dropping everyone
        // into the workers bucket so the duplicate doesn't lose names.
        supervisor: d.supervisor || '',
        lead: d.lead || '',
        workers: d.workers || (d.supervisor || d.lead ? [] : (d.crew || [])),
        crew: d.crew || [],
        // Payroll hours carry over — same crew, often same shift length.
        supervisor_hours: d.supervisor_hours ?? '',
        lead_hours: d.lead_hours ?? '',
        labour_hours_per_person: d.labour_hours_per_person ?? '',
        crew_truck_count: d.crew_truck_count ?? '',
        crew_truck_hours: d.crew_truck_hours ?? '',
        equipment: (d.equipment || []).filter(e => !STRUCTURED_EQ_LABELS.has((e?.label || '').toLowerCase().trim())),
        mulch_type: d.mulch_type || duplicateFrom.mulch_type || '',
        soil_amendment: d.soil_amendment || '',
        seed_types: (d.seed_types && d.seed_types.length > 0) ? d.seed_types : [makeBlankSeedType(0)],
        fertilizer: d.fertilizer || '',
        // Cleared — new day = fresh entries.
        loads: [],
        // Cleared — travel + water truck are typically per-day, not carried.
        travel_km: '',
        water_truck_loads: '',
        seed_tag_photos: [],
        photos: [],
        comments: '',
      });
      return;
    }
    if (isEditMode && editingRecord?.daily_data) {
      initializedRef.current = true;
      const d = editingRecord.daily_data;
      setForm({
        date: d.date || editingRecord.work_date || localDateISO(),
        client: d.client || editingRecord.client || '',
        customer_rep: d.customer_rep || editingRecord.customer_rep || '',
        customer_rep_phone: d.customer_rep_phone || editingRecord.customer_rep_phone || '',
        area: d.area || editingRecord.area || '',
        site_name: d.site_name || editingRecord.site_name || '',
        description_of_work: d.description_of_work || editingRecord.description_of_work || '',
        supervisor: d.supervisor || '',
        lead: d.lead || '',
        workers: d.workers || (d.supervisor || d.lead ? [] : (d.crew || [])),
        crew: d.crew || [],
        supervisor_hours: d.supervisor_hours ?? '',
        lead_hours: d.lead_hours ?? '',
        labour_hours_per_person: d.labour_hours_per_person ?? '',
        crew_truck_count: d.crew_truck_count ?? '',
        crew_truck_hours: d.crew_truck_hours ?? '',
        equipment: (d.equipment || []).filter(e => !STRUCTURED_EQ_LABELS.has((e?.label || '').toLowerCase().trim())),
        mulch_type: d.mulch_type || editingRecord.mulch_type || '',
        soil_amendment: d.soil_amendment || '',
        seed_types: (d.seed_types && d.seed_types.length > 0) ? d.seed_types : [makeBlankSeedType(0)],
        fertilizer: d.fertilizer || '',
        loads: d.loads || [],
        travel_km: d.travel_km ?? '',
        water_truck_loads: d.water_truck_loads ?? '',
        // Start the photo arrays empty; the async restore below fills
        // them from the existing record's Dropbox URLs via the proxy.
        seed_tag_photos: [],
        photos: [],
        comments: d.comments || editingRecord.comments || '',
      });
      setRecordNumber(editingRecord.record_number || '');

      // Restore existing photos by fetching the saved Dropbox URLs back
      // through the backend proxy (avoids the canvas-tainting + CORS
      // headache of loading Dropbox shared links directly into the
      // form's <img> + jsPDF pipeline). Mirrors the lease-sheet edit
      // flow at `HerbicideLeaseSheet.jsx`. Fire-and-forget so the form
      // opens immediately — if the worker submits before this finishes,
      // `photosDirty` stays `false` and the backend keeps the original
      // photo_urls untouched.
      const restoreFromUrls = async (urls, formKey) => {
        if (!Array.isArray(urls) || urls.length === 0) return;
        const restored = await Promise.all(urls.map(async (url) => {
          try {
            const { data, type } = await api.proxyPhoto(url);
            const mime = type || 'image/jpeg';
            return {
              data,
              type: mime,
              dataUrl: `data:${mime};base64,${data}`,
              existingUrl: url,
            };
          } catch {
            // Proxy failed (network blip, Dropbox 404, etc.). Keep the
            // URL as the <img> preview so the worker still SEES the
            // photo — submit will skip this slot since `data` is null.
            return { data: null, type: null, dataUrl: url, existingUrl: url };
          }
        }));
        setForm(prev => ({ ...prev, [formKey]: restored }));
      };
      void restoreFromUrls(editingRecord.photo_urls, 'photos');
      void restoreFromUrls(editingRecord.seed_tag_photo_urls, 'seed_tag_photos');
      return;
    }
    initializedRef.current = true;
  }, [isOpen, duplicateFrom, draft, isEditMode, editingRecord]);

  // Reset the photo dirty flags whenever the form opens. Edit mode
  // starts clean (only sends photos when the worker touches them);
  // create + duplicate + draft flows start dirty so the new record
  // actually persists whatever's in the photo arrays.
  useEffect(() => {
    if (!isOpen) return;
    setPhotosDirty(!isEditMode);
    setSeedTagPhotosDirty(!isEditMode);
  }, [isOpen, isEditMode, editingRecord?.id]);

  // Reset on close so a future open starts clean.
  useEffect(() => {
    if (!isOpen) {
      setIsPreviewing(false);
      setPdfBase64(null);
    }
  }, [isOpen]);

  // ── Derived: area suggestions narrowed by client ─────────────────────────
  const areaOptions = useMemo(() => {
    if (!form.client || typeof getAreasForClient !== 'function') return areas;
    return getAreasForClient(form.client);
  }, [form.client, getAreasForClient, areas]);

  // ── Form mutators ────────────────────────────────────────────────────────
  const setField = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  // Build a payload-ready form with `crew` re-derived from the role
  // buckets. Used everywhere we send `form` downstream (PDF generator,
  // upload-queue payload, draft saver) so the backend always sees the
  // flat crew list it has historically expected, AND the new structured
  // role fields for billing breakdowns.
  const formForOutput = () => {
    const merged = [
      form.supervisor,
      form.lead,
      ...(form.workers || []),
    ].map(n => (n || '').trim()).filter(Boolean);
    // De-dup while preserving order (supervisor → lead → workers).
    const seen = new Set();
    const crew = merged.filter(n => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
    return { ...form, crew };
  };

  // Helper: name already on the crew in ANY role? Prevents double-billing
  // the same person as e.g. both Lead and Worker on the same record.
  const isNameTaken = (name) => {
    const n = (name || '').trim();
    if (!n) return false;
    return n === form.supervisor || n === form.lead || (form.workers || []).includes(n);
  };

  const addWorker = (name) => {
    const v = (name || '').trim();
    if (!v) return;
    if (isNameTaken(v)) return;
    setForm(prev => ({ ...prev, workers: [...(prev.workers || []), v] }));
    setNewCrewName('');
  };
  const removeWorker = (idx) => {
    setForm(prev => ({ ...prev, workers: (prev.workers || []).filter((_, i) => i !== idx) }));
  };

  const addEquipment = () => {
    setForm(prev => ({
      ...prev,
      equipment: [...prev.equipment, { label: '', hours: '' }],
    }));
  };
  const updateEquipment = (idx, patch) => {
    setForm(prev => ({
      ...prev,
      equipment: prev.equipment.map((e, i) => i === idx ? { ...e, ...patch } : e),
    }));
  };
  const removeEquipment = (idx) => {
    setForm(prev => ({ ...prev, equipment: prev.equipment.filter((_, i) => i !== idx) }));
  };

  const addSeedType = () => {
    setForm(prev => ({ ...prev, seed_types: [...prev.seed_types, makeBlankSeedType(prev.seed_types.length)] }));
  };
  const updateSeedType = (idx, patch) => {
    setForm(prev => ({
      ...prev,
      seed_types: prev.seed_types.map((s, i) => i === idx ? { ...s, ...patch } : s),
    }));
  };
  const removeSeedType = (idx) => {
    setForm(prev => {
      const removed = prev.seed_types[idx];
      const seed_types = prev.seed_types.filter((_, i) => i !== idx);
      // Also strip kg entries for the removed seed name from every load so
      // PDF columns don't reference a deleted seed type.
      const removedName = removed?.name;
      const loads = removedName
        ? prev.loads.map(l => {
            if (!l.seed_kgs) return l;
            const { [removedName]: _drop, ...rest } = l.seed_kgs;
            return { ...l, seed_kgs: rest };
          })
        : prev.loads;
      return { ...prev, seed_types, loads };
    });
  };

  // ── Load sub-modal ───────────────────────────────────────────────────────
  const openNewLoad = () => {
    setEditingLoad(makeBlankLoad(form.loads.length));
  };
  const openExistingLoad = (loadId) => {
    const found = form.loads.find(l => l.id === loadId);
    if (found) setEditingLoad({ ...found, seed_kgs: { ...(found.seed_kgs || {}) } });
  };

  // Clone an existing load with the same quantities + ingredients but a
  // fresh id + the next sequential load_number. Skips opening the sub-modal
  // so the worker can tap "Duplicate" repeatedly when running, e.g., five
  // identical loads back-to-back on the same site. They can still tap any
  // load afterwards to tweak it if one load differs.
  const duplicateLoad = (loadId) => {
    setForm(prev => {
      const src = prev.loads.find(l => l.id === loadId);
      if (!src) return prev;
      const clone = {
        ...src,
        id: newUuid(),
        load_number: prev.loads.length + 1,
        // Deep-copy the per-seed-type quantity map so editing the clone
        // doesn't mutate the original.
        seed_kgs: { ...(src.seed_kgs || {}) },
      };
      return { ...prev, loads: [...prev.loads, clone] };
    });
  };
  const saveEditingLoad = () => {
    if (!editingLoad) return;
    setForm(prev => {
      const existing = prev.loads.find(l => l.id === editingLoad.id);
      if (existing) {
        return {
          ...prev,
          loads: prev.loads.map(l => l.id === editingLoad.id ? { ...editingLoad } : l),
        };
      }
      return { ...prev, loads: [...prev.loads, { ...editingLoad }] };
    });
    setEditingLoad(null);
  };
  const deleteEditingLoad = () => {
    if (!editingLoad) return;
    setForm(prev => ({
      ...prev,
      loads: prev.loads
        .filter(l => l.id !== editingLoad.id)
        .map((l, i) => ({ ...l, load_number: i + 1 })),
    }));
    setEditingLoad(null);
  };

  // ── Photos (seed tags + annotations) — Phase 2 uses plain file picker.
  //    Phase 5 swaps the annotations slot for MapAnnotationCanvas. ─────────
  const readPhotoFile = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // Strip the `data:<mime>;base64,` prefix so the backend gets the same
      // shape the lease-sheet flow uses.
      const dataUrl = String(reader.result || '');
      const commaIdx = dataUrl.indexOf(',');
      const data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      const mime = (dataUrl.match(/^data:(.+);base64/) || [])[1] || file.type || 'image/jpeg';
      resolve({ data, type: mime, dataUrl });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  // Mark the corresponding photo array as dirty so the submit payload
  // sends a fresh array (instead of `null`, which would tell the backend
  // to preserve the existing Dropbox URLs without changes).
  const markPhotosDirty = (which) => {
    if (which === 'photos') setPhotosDirty(true);
    else if (which === 'seed_tag_photos') setSeedTagPhotosDirty(true);
  };
  const onPhotoFiles = async (which, files) => {
    const arr = Array.from(files || []).filter(Boolean);
    if (arr.length === 0) return;
    const next = await Promise.all(arr.map(readPhotoFile));
    setForm(prev => ({ ...prev, [which]: [...(prev[which] || []), ...next] }));
    markPhotosDirty(which);
  };
  const removePhoto = (which, idx) => {
    setForm(prev => ({ ...prev, [which]: prev[which].filter((_, i) => i !== idx) }));
    markPhotosDirty(which);
  };

  // ── Validation ───────────────────────────────────────────────────────────
  const requiredMissing = useMemo(() => {
    const missing = [];
    if (!form.date) missing.push('Date');
    if (!form.client) missing.push('Customer');
    if (!form.area) missing.push('Area');
    if (!form.site_name) missing.push('Site');
    if (!form.description_of_work) missing.push('Description of Work');
    // At least one person on the record — any role counts. Per-role
    // billing means we can't require ALL three roles, but we DO need a
    // name somewhere so the timesheet isn't empty.
    if (!form.supervisor && !form.lead && (form.workers || []).length === 0) {
      missing.push('Crew (supervisor, lead, or at least one worker)');
    }
    if (!form.mulch_type) missing.push('Mulch Type');
    if (!(form.seed_types || []).some(s => s.name && s.description)) missing.push('At least one Seed Type');
    if ((form.loads || []).length === 0) missing.push('At least one Load');
    // Seed-tag photos are required to submit. In edit mode an already-
    // submitted record has them on Dropbox (`seed_tag_photo_urls`); the
    // proxy restore above hydrates the form array, but if the worker
    // happens to click submit before that finishes we still want the
    // validator to pass since the existing photos remain on file.
    const hasExistingSeedTagPhotos = (
      (editingRecord?.seed_tag_photo_urls || []).length > 0
    );
    if (
      (form.seed_tag_photos || []).length === 0
      && !hasExistingSeedTagPhotos
    ) {
      missing.push('At least one Seed Tag photo');
    }
    return missing;
  }, [form, editingRecord]);

  // ── Preview ──────────────────────────────────────────────────────────────
  const handlePreview = async () => {
    if (requiredMissing.length > 0) {
      await alert({
        title: 'Missing fields',
        message: `Required fields are missing: ${requiredMissing.join(', ')}`,
        severity: 'warning',
      });
      return;
    }
    try {
      const photoUrls = (form.photos || []).map(p => p.dataUrl).filter(Boolean);
      const seedTagUrls = (form.seed_tag_photos || []).map(p => p.dataUrl).filter(Boolean);
      const { base64 } = await generateHydroseedDailyPdf(
        { ...formForOutput(), record_number: recordNumber },
        photoUrls,
        seedTagUrls,
      );
      setPdfBase64(base64);
      setIsPreviewing(true);
    } catch (err) {
      await alert({
        title: 'Preview failed',
        message: String(err?.message || err),
        severity: 'danger',
      });
    }
  };

  const handleBackToEdit = () => {
    setIsPreviewing(false);
    setPdfBase64(null);
  };

  // ── Draft save (Phase 3 — feeds the autosave hook below) ────────────────
  // Saves the full form snapshot + photos to IndexedDB so the worker can
  // pick the form back up after a tab close, browser crash, or page refresh.
  // Phase 6 will hook this into a visible "💾 Save Draft" button in the
  // FormsPanel drafts row; for now it's autosave-only.
  const handleSaveDraft = async () => {
    try {
      const ensuredDraftId = draftId || (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const label = `${form.client || '—'} / ${form.area || '—'} / ${form.site_name || '—'}`;
      const saved = await saveHydroseedDailyDraft({
        id: ensuredDraftId,
        form: formForOutput(),
        recordNumber: recordNumber || null,
        label,
      });
      setDraftId(saved.id);
    } catch {
      /* swallow — autosave is best-effort */
    }
  };

  // Explicit "Save Draft" button: persist the device-local draft (fast, no
  // network) and return to the map immediately. The draft appears in
  // In Progress → Drafts because onCancel bumps the parent's
  // draftsRefreshToken. Non-blocking — the worker never waits.
  const handleSaveDraftAndClose = async () => {
    try { await handleSaveDraft(); } catch { /* non-fatal */ }
    savedAndClosingRef.current = true;
    onCancel?.();
  };

  // ── Continue → HT picker ─────────────────────────────────────────────────
  // In edit mode we skip the picker entirely — re-linking after the fact
  // happens from the HT detail sheet, not the daily form.
  const handleContinueFromPreview = async () => {
    if (isEditMode) {
      await submitDaily(null);
      return;
    }
    // Instant transition into the picker, fetch in the background.
    setOpenHTTickets([]);
    setHtChoice({ create: true });
    setHtDescription(form.description_of_work || '');
    setIsPickingHT(true);

    const isOffline = typeof window !== 'undefined' && window.navigator?.onLine === false;
    if (isOffline) return;

    setIsLoadingHTTickets(true);
    try {
      const TIMEOUT_MS = 2500;
      const tickets = await Promise.race([
        api.listOpenHydroseedTickets({
          client: normalizeName(form.client) || undefined,
          area: normalizeName(form.area) || undefined,
          work_date: form.date || undefined,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('HT ticket lookup timed out')), TIMEOUT_MS)
        ),
      ]);
      setOpenHTTickets(tickets || []);
      // Auto-pick the only open match — same UX as the T&M picker.
      if (tickets && tickets.length === 1) {
        setHtChoice((curr) => (curr?.create ? { ticket_id: tickets[0].id } : curr));
      } else if (tickets && tickets.length > 1) {
        setHtChoice((curr) => (curr?.create ? null : curr));
      }
    } catch {
      // Timeout / offline — picker stays on "create new" default.
    } finally {
      setIsLoadingHTTickets(false);
    }
  };

  // Latches `true` the instant submit is initiated. The on-close autosave
  // useEffect reads this ref to know whether to skip its forced save —
  // without it we'd race the parent's draft-cleanup and re-create the
  // draft post-submit. Never reset; the component unmounts shortly after.
  const hasSubmittedRef = useRef(false);
  // Set true when the worker taps "Save Draft" (persists locally + returns to
  // the map). Guards the autosave hook + the wasOpenRef close-save so the
  // draft isn't written twice.
  const savedAndClosingRef = useRef(false);

  // ── Submit (called from picker confirm OR directly in edit mode) ─────────
  const submitDaily = async (htLink) => {
    hasSubmittedRef.current = true;
    setIsSubmitting(true);
    try {
      const photoUrls = (form.photos || []).map(p => p.dataUrl).filter(Boolean);
      const seedTagUrls = (form.seed_tag_photos || []).map(p => p.dataUrl).filter(Boolean);
      const submitForm = formForOutput();
      const { base64 } = await generateHydroseedDailyPdf(
        { ...submitForm, record_number: recordNumber },
        photoUrls,
        seedTagUrls,
      );

      const clientSubmissionId = draftId || newUuid();
      const dailyDataSnapshot = {
        ...submitForm,
        record_number: recordNumber,
      };

      const payload = {
        work_date: form.date,
        client: form.client,
        area: form.area,
        site_name: form.site_name,
        description_of_work: form.description_of_work,
        mulch_type: form.mulch_type,
        comments: form.comments,
        daily_data: dailyDataSnapshot,
        pdf_base64: base64,
        // Send the photo arrays only when the worker actually touched
        // them. `null` tells the backend's update path to leave the
        // existing Dropbox URLs alone; an array tells it to wipe + re-
        // upload. Items missing `data` (proxy-restore failed earlier)
        // are filtered out so we don't accidentally serialise nulls.
        photos: photosDirty
          ? (form.photos || [])
              .filter(p => p && p.data)
              .map(p => ({ data: p.data, type: p.type }))
          : null,
        seed_tag_photos: seedTagPhotosDirty
          ? (form.seed_tag_photos || [])
              .filter(p => p && p.data)
              .map(p => ({ data: p.data, type: p.type }))
          : null,
        client_submission_id: clientSubmissionId,
        hydroseed_ticket_link: htLink,
      };

      // Hand off to the parent (App.jsx) which queues the upload in IDB
      // and lets `processUploadQueue` handle the actual PDF + photo +
      // backend POST/PATCH in the background. Same pattern as
      // `handleExternalLeaseSheetSubmit` for lease sheets — keeps the
      // worker out of a long spinner on rural / cellular connections.
      onSubmit?.({
        payload,
        mode: isEditMode ? 'edit' : 'create',
        dailyId: isEditMode ? editingRecord?.id : null,
        draftId,
        recordNumber,
      });
    } catch (err) {
      await alert({
        title: 'Submit failed',
        message: String(err?.message || err),
        severity: 'danger',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmHTLink = async () => {
    if (!htChoice) return;
    const link = htChoice.ticket_id
      ? { ticket_id: htChoice.ticket_id }
      : { create: true, description_of_work: htDescription.trim() || form.description_of_work || '' };
    await submitDaily(link);
  };

  // ── Auto-save draft on tab blur / form close ─────────────────────────────
  // Mirrors HerbicideLeaseSheet. Skipped while submitting, editing an
  // existing record, or inside the load sub-modal (worker is mid-flow).
  const autoSaveEnabled =
    isOpen && !isEditMode && !isSubmitting && !isPreviewing && !editingLoad && !isPickingHT;
  const { saveNow: autoSaveDraftNow } = useAutoSaveDraft({
    enabled: autoSaveEnabled,
    hasContent: () => {
      if (savedAndClosingRef.current) return false;
      const f = form;
      return Boolean(
        (f.photos || []).length > 0 ||
        (f.seed_tag_photos || []).length > 0 ||
        (f.loads || []).length > 0 ||
        (f.crew || []).length > 0 ||
        (f.workers || []).length > 0 ||
        (f.supervisor && String(f.supervisor).trim()) ||
        (f.lead && String(f.lead).trim()) ||
        (f.equipment || []).length > 0 ||
        (f.client && String(f.client).trim()) ||
        (f.area && String(f.area).trim()) ||
        (f.site_name && String(f.site_name).trim()) ||
        (f.description_of_work && String(f.description_of_work).trim()) ||
        (f.mulch_type && String(f.mulch_type).trim()) ||
        (f.comments && String(f.comments).trim()) ||
        // Any payroll-hours / crew-truck / travel / water-truck scalar set
        // is also enough to mark the draft dirty so partial entries autosave.
        (f.supervisor_hours !== '' && f.supervisor_hours != null) ||
        (f.lead_hours !== '' && f.lead_hours != null) ||
        (f.labour_hours_per_person !== '' && f.labour_hours_per_person != null) ||
        (f.crew_truck_count !== '' && f.crew_truck_count != null) ||
        (f.crew_truck_hours !== '' && f.crew_truck_hours != null) ||
        (f.travel_km !== '' && f.travel_km != null) ||
        (f.water_truck_loads !== '' && f.water_truck_loads != null)
      );
    },
    save: handleSaveDraft,
  });

  // Fire one autosave when parent closes the modal (isOpen: true → false).
  // Skipped post-submit (see hasSubmittedRef) so we don't race the parent's
  // draft cleanup and re-create a stale draft after a successful queue.
  const wasOpenRef = useRef(isOpen);
  useEffect(() => {
    if (wasOpenRef.current && !isOpen) {
      if (!isEditMode && !isSubmitting && !hasSubmittedRef.current && !savedAndClosingRef.current) {
        autoSaveDraftNow({ force: true });
      }
    }
    wasOpenRef.current = isOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  // ── Load sub-modal ───────────────────────────────────────────────────────
  // ── Load sub-modal moved to the bottom so the form doesn't unmount ──────

  // ── HT picker (between Preview and Submit) ──────────────────────────────
  if (isPickingHT) {
    const needsDescription = htChoice?.create && !htDescription.trim();
    const needsChoice = !htChoice;
    const isDisabled = isSubmitting || needsDescription || needsChoice;
    const continueLabel = isSubmitting
      ? 'Uploading...'
      : needsChoice
        ? 'Select a ticket above'
        : needsDescription
          ? 'Add description of work'
          : htChoice?.create
            ? 'Submit Daily & Create HT'
            : 'Submit Daily & Link HT';
    return (
      <div style={{
        backgroundColor: '#1f2937', color: '#f9fafb',
        display: 'flex', flexDirection: 'column',
        height: '100%', width: '100%', boxSizing: 'border-box',
      }}>
        {/* ── Sticky header ── */}
        <div style={{ flexShrink: 0, padding: '16px 16px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 600 }}>Link to Hydroseed Ticket</h2>
            <button
              onClick={() => setIsPickingHT(false)}
              style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}
            >×</button>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#9ca3af', margin: '0 0 4px 0' }}>
            Today&apos;s open tickets for <strong>{form.client || '—'}</strong> / <strong>{form.area || '—'}</strong>:
          </p>
        </div>

        {/* ── Scrollable middle ── */}
        <div style={{
          flex: 1, overflowY: 'auto', overflowX: 'hidden',
          padding: '14px 16px 16px',
          WebkitOverflowScrolling: 'touch',
        }}>

        {isLoadingHTTickets && openHTTickets.length === 0 ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: 14, marginBottom: 14,
            background: '#111827', borderRadius: 8, color: '#9ca3af', fontSize: '0.9rem',
          }}>
            <span style={{
              display: 'inline-block', width: 14, height: 14,
              border: '2px solid #374151', borderTopColor: '#3b82f6',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite',
            }} />
            Looking for open Hydroseed tickets…
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : openHTTickets.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            {openHTTickets.map((t) => (
              <label
                key={t.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  background: htChoice?.ticket_id === t.id ? '#1e40af' : '#111827',
                  padding: 12, borderRadius: 8, cursor: 'pointer',
                  border: htChoice?.ticket_id === t.id ? '1px solid #3b82f6' : '1px solid #374151',
                }}
              >
                <input
                  type="radio" name="ht-choice"
                  checked={htChoice?.ticket_id === t.id}
                  onChange={() => setHtChoice({ ticket_id: t.id })}
                  style={{ marginTop: 2 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{t.ticket_number}</div>
                  <div style={{ fontSize: '0.8rem', color: '#9ca3af' }}>
                    {t.work_date} · {t.client || '—'} / {t.area || '—'}
                  </div>
                  {t.description_of_work && (
                    <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginTop: 2 }}>
                      {t.description_of_work}
                    </div>
                  )}
                </div>
              </label>
            ))}
          </div>
        ) : (
          <div style={{
            padding: 12, marginBottom: 14, background: '#111827', borderRadius: 8,
            color: '#9ca3af', fontSize: '0.85rem',
          }}>
            No open Hydroseed tickets found for this client/area/date.
          </div>
        )}

        <label
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            background: htChoice?.create ? '#1e40af' : '#111827',
            padding: 12, borderRadius: 8, cursor: 'pointer',
            border: htChoice?.create ? '1px solid #3b82f6' : '1px solid #374151',
            marginBottom: 12,
          }}
        >
          <input
            type="radio" name="ht-choice"
            checked={!!htChoice?.create}
            onChange={() => setHtChoice({ create: true })}
            style={{ marginTop: 2 }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>+ Create new HT ticket</div>
            <div style={{ fontSize: '0.8rem', color: '#9ca3af' }}>
              New ticket will be auto-numbered. Office adds rates + signs later.
            </div>
          </div>
        </label>

        {htChoice?.create && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: '0.85rem', color: '#9ca3af', marginBottom: 6 }}>
              Description of Work <span style={{ color: '#f87171' }}>*</span>
            </label>
            <textarea
              value={htDescription}
              onChange={e => setHtDescription(e.target.value)}
              rows={2}
              style={{
                width: '100%', padding: 10, background: '#111827',
                border: '1px solid #374151', borderRadius: 6, color: '#f9fafb',
                fontSize: '0.95rem', resize: 'vertical', boxSizing: 'border-box',
              }}
              placeholder="e.g. Hydro seed disturbed areas as required"
            />
          </div>
        )}
        </div>

        {/* ── Sticky bottom action bar ── */}
        <div style={{
          flexShrink: 0, padding: '12px 16px 16px',
          borderTop: '1px solid #374151',
          display: 'flex', gap: 10,
        }}>
          <button
            onClick={handleConfirmHTLink}
            disabled={isDisabled}
            style={{
              flex: 1, padding: 12,
              backgroundColor: isDisabled ? '#374151' : '#22c55e',
              color: 'white', border: 'none', borderRadius: 8,
              fontWeight: 600, fontSize: '1rem',
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              opacity: isDisabled ? 0.6 : 1,
            }}
          >
            {continueLabel}
          </button>
          <button
            onClick={() => setIsPickingHT(false)}
            disabled={isSubmitting}
            style={{
              flex: 1, padding: 12, backgroundColor: '#374151', color: '#f9fafb',
              border: 'none', borderRadius: 8, fontSize: '1rem',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Preview view ─────────────────────────────────────────────────────────
  if (isPreviewing) {
    // Print via hidden iframe (iOS-safe). window.open + onload.print() is
    // unreliable inside iOS Safari + standalone PWA mode — the blob URL
    // frequently fails to fire onload, leaving a blank window. Same
    // pattern used by QuoteBuilder and HydroseedTicketDetailSheet.
    const handlePrint = () => {
      if (!pdfBase64) return;
      let bytes;
      try {
        const raw = atob(pdfBase64);
        bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      } catch {
        return;
      }
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      iframe.src = url;
      const cleanup = () => {
        try { iframe.remove(); } catch { /* ignore */ }
        URL.revokeObjectURL(url);
      };
      iframe.onload = () => {
        setTimeout(() => {
          try {
            iframe.contentWindow?.focus();
            iframe.contentWindow?.print();
          } catch {
            window.open(url, '_blank');
          }
        }, 200);
        setTimeout(cleanup, 60_000);
      };
      iframe.onerror = cleanup;
      document.body.appendChild(iframe);
    };
    // Dropbox link — only meaningful in edit mode where the daily was
    // previously submitted (so a Dropbox PDF exists). Brand-new dailies
    // have no Dropbox URL until after submit. Same URL transform as
    // T&M / Hydroseed tickets: replace www → dl content host, drop dl=0.
    const dropboxHref = (editingRecord?.pdf_url || '')
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      .replace('&dl=0', '')
      .replace('?dl=0', '?')
      .replace(/[?&]$/, '');
    return (
      <div style={{
        backgroundColor: '#4b5563',
        display: 'flex', flexDirection: 'column',
        height: '100%', width: '100%', boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', flexShrink: 0, background: '#1f2937', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, color: '#f9fafb' }}>
            Preview{recordNumber ? ` — ${recordNumber}` : ''}
          </h2>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={handlePrint}
              disabled={!pdfBase64}
              style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: '0.9rem', cursor: pdfBase64 ? 'pointer' : 'not-allowed', padding: 0 }}
            >Print</button>
            {dropboxHref ? (
              <a
                href={dropboxHref}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#60a5fa', fontSize: '0.9rem', textDecoration: 'none' }}
              >
                Open Dropbox PDF ↗
              </a>
            ) : null}
          </div>
        </div>
        <PdfPreviewViewer pdfBase64={pdfBase64} />
        <div style={{ display: 'flex', gap: 10, padding: '12px 16px', flexShrink: 0, background: '#1f2937' }}>
          <button
            onClick={handleContinueFromPreview}
            disabled={isSubmitting}
            style={{
              flex: 1, padding: 12, backgroundColor: '#22c55e', color: 'white',
              border: 'none', borderRadius: 8, fontSize: '1rem', fontWeight: 600,
              cursor: isSubmitting ? 'not-allowed' : 'pointer', opacity: isSubmitting ? 0.7 : 1,
            }}
          >
            {isSubmitting ? 'Uploading...' : isEditMode ? 'Update & Re-Submit' : 'Continue'}
          </button>
          <button
            onClick={handleBackToEdit}
            disabled={isSubmitting}
            style={{
              flex: 1, padding: 12, backgroundColor: '#374151', color: '#f9fafb',
              border: 'none', borderRadius: 8, fontSize: '1rem', cursor: isSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            Back to Edit
          </button>
        </div>
      </div>
    );
  }

  // ── Form view ────────────────────────────────────────────────────────────
  // Layout is a 3-row flex column: fixed header, scrollable middle, sticky
  // action bar. The action bar uses `flexShrink: 0` so it stays anchored
  // at the bottom of the sheet on phones — without this the Preview /
  // Cancel buttons end up below the bottom tabs nav (Map/Sites/Forms/Admin)
  // when 90vh > the available .main-area height, and workers can't submit
  // their record. Same pattern that fixes MapAnnotationCanvas's "can't
  // find Cancel" bug.
  return (
    <div className="hydroseed-daily" style={{
      backgroundColor: '#1f2937', color: '#f9fafb',
      flex: 1,
      maxWidth: 720, margin: '0 auto', width: '100%', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* ── Sticky header ── */}
      <div style={{ flexShrink: 0, padding: '20px 20px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>
            {isEditMode ? 'Edit Hydroseed Daily' : 'Hydroseed Daily Application Record'}
          </h2>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
        </div>
        {recordNumber && (
          <div style={{
            backgroundColor: '#111827', border: '1px solid #3b82f6', borderRadius: 6,
            padding: '8px 12px', marginBottom: 4, textAlign: 'center',
            fontSize: '1rem', fontWeight: 700, color: '#3b82f6',
          }}>
            Record: {recordNumber}
          </div>
        )}
      </div>

      {/* ── Scrollable middle ── */}
      <div style={{
        flex: 1, overflowY: 'auto', overflowX: 'hidden',
        padding: '16px 20px 16px',
        display: 'flex', flexDirection: 'column', gap: 16,
        WebkitOverflowScrolling: 'touch',
      }}>
        {/* ── Header ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={labelStyle}>Date *</label>
            <input type="date" value={form.date} onChange={e => setField('date', e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Site *</label>
            <input
              type="text" value={form.site_name}
              onChange={e => setField('site_name', e.target.value)}
              placeholder="e.g. BC Hydro AFDE Site"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Customer *</label>
            <AutocompleteInput
              value={form.client}
              onChange={(v) => setField('client', v)}
              suggestions={clients}
              placeholder="Customer / contact"
              inputStyle={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Area *</label>
            <AutocompleteInput
              value={form.area}
              onChange={(v) => setField('area', v)}
              suggestions={areaOptions}
              placeholder="Project area"
              inputStyle={inputStyle}
            />
          </div>
          {/* On-site customer representative — the field-side contact who
              signed off on the work and can be called about it. Distinct
              from `client` which is the billing entity. Both fields are
              optional so workers aren't blocked when they don't know it. */}
          <div>
            <label style={labelStyle}>Customer Rep</label>
            <input
              type="text" value={form.customer_rep}
              onChange={e => setField('customer_rep', e.target.value)}
              placeholder="e.g. Bob Smith, Site Foreman"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Rep Contact #</label>
            <input
              type="tel" inputMode="tel" value={form.customer_rep_phone}
              onChange={e => setField('customer_rep_phone', e.target.value)}
              placeholder="(250) 555-0100"
              style={inputStyle}
            />
          </div>
        </div>

        <div>
          <label style={labelStyle}>Description of Work *</label>
          <textarea
            rows={2}
            value={form.description_of_work}
            onChange={e => setField('description_of_work', e.target.value)}
            style={{ ...inputStyle, resize: 'vertical' }}
            placeholder="e.g. Hydro seed areas as required"
          />
        </div>

        {/* ── Crew (split by role) ──
            Each role bills at a different rate, so we capture them as
            separate fields:
              • Supervisor — single person, top rate
              • Lead       — single person, mid rate
              • Workers    — N people, labourer rate
            The downstream PDF + backend still receive a flat `crew[]`
            (derived in formForOutput) so nothing breaks; the structured
            fields are additive. The roster <select> options exclude any
            name already in another role so a worker can't be billed twice
            on the same record. */}
        {(() => {
          const allRosterNames = (users || [])
            .filter(u => u && (u.is_active !== false) && (u.deleted_at == null))
            .map(u => (u.name || u.email || '').trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));

          // Build the roster <select> options for a given role: omit
          // anyone already on the crew in a different role, but keep the
          // CURRENT value for that role so it stays selected in the
          // dropdown.
          const optionsFor = (currentValue) =>
            allRosterNames.filter(n =>
              n === currentValue || (
                n !== form.supervisor &&
                n !== form.lead &&
                !(form.workers || []).includes(n)
              )
            );

          // Reusable single-role picker (supervisor + lead). Combines a
          // <select> of roster names with a free-text input for people
          // who aren't in the user list.
          const SingleRoleRow = ({ roleKey, label, accent }) => {
            const value = form[roleKey] || '';
            const opts = optionsFor(value);
            return (
              <div style={{ marginBottom: 12 }}>
                <label style={{ ...labelStyle, color: accent }}>{label}</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <select
                    value={allRosterNames.includes(value) ? value : ''}
                    onChange={e => setField(roleKey, e.target.value)}
                    style={{ ...inputStyle, flex: 1, minWidth: 140 }}
                  >
                    <option value="">— Select from roster —</option>
                    {opts.map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={allRosterNames.includes(value) ? '' : value}
                    onChange={e => setField(roleKey, e.target.value)}
                    placeholder="…or type a name"
                    style={{ ...inputStyle, flex: 1, minWidth: 140 }}
                  />
                  {value && (
                    <button
                      type="button"
                      onClick={() => setField(roleKey, '')}
                      title={`Clear ${label}`}
                      style={{
                        padding: '0 12px', background: '#374151', color: '#f9fafb',
                        border: 'none', borderRadius: 6, cursor: 'pointer',
                      }}
                    >×</button>
                  )}
                </div>
              </div>
            );
          };

          const workerRosterRemaining = optionsFor(null).filter(
            n => !(form.workers || []).includes(n)
          );

          return (
            <div>
              <label style={labelStyle}>Crew *</label>

              <SingleRoleRow roleKey="supervisor" label="Supervisor" accent="#fbbf24" />
              <SingleRoleRow roleKey="lead" label="Lead" accent="#60a5fa" />

              {/* Workers (multi) */}
              <div>
                <label style={{ ...labelStyle, color: '#34d399' }}>Workers</label>
                {(form.workers || []).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {form.workers.map((name, i) => (
                      <span key={i} style={{
                        background: '#374151', padding: '4px 8px', borderRadius: 4,
                        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem',
                      }}>
                        {name}
                        <button onClick={() => removeWorker(i)} style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', padding: 0 }}>×</button>
                      </span>
                    ))}
                  </div>
                )}

                {workerRosterRemaining.length > 0 && (
                  <div style={{
                    background: '#111827', border: '1px solid #374151', borderRadius: 6,
                    padding: 8, marginBottom: 8,
                  }}>
                    <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: 6 }}>
                      Tap a name to add:
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {workerRosterRemaining.map((name) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => addWorker(name)}
                          style={{
                            background: '#1f2937', color: '#f9fafb',
                            padding: '4px 10px', borderRadius: 4,
                            border: '1px solid #374151', cursor: 'pointer',
                            fontSize: '0.85rem',
                          }}
                        >
                          + {name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text" value={newCrewName}
                    onChange={e => setNewCrewName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addWorker(newCrewName))}
                    placeholder="Add a worker not on the list"
                    style={inputStyle}
                  />
                  <button onClick={() => addWorker(newCrewName)} style={{
                    padding: '0 14px', background: '#3b82f6', color: 'white',
                    border: 'none', borderRadius: 6, cursor: 'pointer',
                  }}>+</button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Payroll Hours ──
            Captured per role because each role bills at a different rate
            on the HT. The 'Total General Labour' row on the HT PDF auto-
            computes as labour_hours_per_person × workers.length so the
            worker only types the per-person shift hours once. */}
        <div style={{
          background: '#111827', border: '1px solid #374151', borderRadius: 6,
          padding: 12, marginTop: 4,
        }}>
          <label style={{ ...labelStyle, marginBottom: 8, color: '#f9fafb', fontSize: '0.9rem' }}>
            Payroll Hours
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ ...labelStyle, color: '#fbbf24' }}>Supervisor hrs</label>
              <input
                type="number" inputMode="decimal" min="0" step="0.25"
                value={form.supervisor_hours}
                onChange={e => setField('supervisor_hours', e.target.value)}
                disabled={!form.supervisor}
                placeholder={form.supervisor ? 'hours' : '— add supervisor —'}
                style={{ ...inputStyle, opacity: form.supervisor ? 1 : 0.5 }}
              />
            </div>
            <div>
              <label style={{ ...labelStyle, color: '#60a5fa' }}>Lead hrs</label>
              <input
                type="number" inputMode="decimal" min="0" step="0.25"
                value={form.lead_hours}
                onChange={e => setField('lead_hours', e.target.value)}
                disabled={!form.lead}
                placeholder={form.lead ? 'hours' : '— add lead —'}
                style={{ ...inputStyle, opacity: form.lead ? 1 : 0.5 }}
              />
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={{ ...labelStyle, color: '#34d399' }}>
              Labourer hrs (per person)
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="number" inputMode="decimal" min="0" step="0.25"
                value={form.labour_hours_per_person}
                onChange={e => setField('labour_hours_per_person', e.target.value)}
                disabled={(form.workers || []).length === 0}
                placeholder={(form.workers || []).length > 0 ? 'hours each' : '— add workers —'}
                style={{
                  ...inputStyle,
                  flex: '0 1 140px',
                  opacity: (form.workers || []).length > 0 ? 1 : 0.5,
                }}
              />
              {(() => {
                const per = Number(form.labour_hours_per_person) || 0;
                const n = (form.workers || []).length;
                if (per > 0 && n > 0) {
                  return (
                    <span style={{
                      fontSize: '0.85rem', color: '#9ca3af',
                      background: '#1f2937', padding: '6px 10px',
                      borderRadius: 4, border: '1px solid #374151',
                    }}>
                      × {n} labourer{n === 1 ? '' : 's'} = <b style={{ color: '#34d399' }}>{(per * n).toFixed(2)} hrs total</b>
                    </span>
                  );
                }
                return null;
              })()}
            </div>
          </div>
        </div>

        {/* ── Crew Trucks ──
            Count × hours per truck. Auto-multiplied on the HT PDF so the
            office types only one rate (per truck-hour). Hydroseeders go
            in the Equipment Used list below as separate rows so the
            client sees each unit (T400, T330, etc.) on its own line. */}
        <div style={{
          background: '#111827', border: '1px solid #374151', borderRadius: 6,
          padding: 12,
        }}>
          <label style={{ ...labelStyle, marginBottom: 8, color: '#f9fafb', fontSize: '0.9rem' }}>
            Crew Trucks (Truck/Trailer)
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={labelStyle}># of Crew Trucks on site</label>
              <input
                type="number" inputMode="numeric" min="0" step="1"
                value={form.crew_truck_count}
                onChange={e => setField('crew_truck_count', e.target.value)}
                placeholder="e.g. 2"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Hours per truck</label>
              <input
                type="number" inputMode="decimal" min="0" step="0.25"
                value={form.crew_truck_hours}
                onChange={e => setField('crew_truck_hours', e.target.value)}
                placeholder="hours each"
                style={inputStyle}
              />
            </div>
          </div>
          {(() => {
            const n = Number(form.crew_truck_count) || 0;
            const h = Number(form.crew_truck_hours) || 0;
            if (n > 0 && h > 0) {
              return (
                <div style={{ marginTop: 8, fontSize: '0.85rem', color: '#9ca3af' }}>
                  = <b style={{ color: '#f9fafb' }}>{(n * h).toFixed(2)} truck-hrs total</b>
                </div>
              );
            }
            return null;
          })()}
        </div>

        {/* ── Equipment Used ──
            Free-form list for everything that isn't crew-truck/labour
            (i.e. Hydroseeders, Skid Steer, UTV, etc.). Hydroseeders are
            entered as separate rows per machine (T400, T330) so the HT
            PDF shows each unit as its own line item. */}
        <div>
          <label style={labelStyle}>Equipment Used</label>
          {form.equipment.map((eq, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 6, marginBottom: 6 }}>
              <AutocompleteInput
                value={eq.label}
                onChange={(v) => updateEquipment(i, { label: v })}
                suggestions={EQUIPMENT_SUGGESTIONS}
                placeholder="Equipment"
                inputStyle={inputStyle}
              />
              <input
                type="number" inputMode="decimal" min="0" step="0.25"
                value={eq.hours}
                onChange={e => updateEquipment(i, { hours: e.target.value })}
                placeholder="hours"
                style={inputStyle}
              />
              <button onClick={() => removeEquipment(i)} style={{
                padding: '0 12px', background: '#7f1d1d', color: 'white',
                border: 'none', borderRadius: 6, cursor: 'pointer',
              }}>×</button>
            </div>
          ))}
          <button onClick={addEquipment} style={{
            padding: '8px 12px', background: '#111827', border: '1px solid #374151',
            color: '#f9fafb', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem',
          }}>+ Equipment</button>
        </div>

        {/* ── Travel + Water Truck ──
            Per-day scalars that aggregate up to the HT PDF as their own
            paper-form rows. Travel is mob/demob distance (multiplied by
            the office-typed per-km rate); Water Truck is a count of
            tank loads. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Travel (Mob/Demob) kms</label>
            <input
              type="number" inputMode="decimal" min="0" step="1"
              value={form.travel_km}
              onChange={e => setField('travel_km', e.target.value)}
              placeholder="kms"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Water Truck Loads</label>
            <input
              type="number" inputMode="numeric" min="0" step="1"
              value={form.water_truck_loads}
              onChange={e => setField('water_truck_loads', e.target.value)}
              placeholder="# of loads"
              style={inputStyle}
            />
          </div>
        </div>

        {/* ── Ingredients ── */}
        <h3 style={{ margin: '8px 0 0', fontSize: '1rem' }}>Materials</h3>
        <div>
          <label style={labelStyle}>Mulch Type *</label>
          <select
            value={form.mulch_type}
            onChange={e => setField('mulch_type', e.target.value)}
            style={inputStyle}
          >
            <option value="">— Select —</option>
            {MULCH_TYPES.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Soil Amendment</label>
          <input
            type="text" value={form.soil_amendment}
            onChange={e => setField('soil_amendment', e.target.value)}
            placeholder="e.g. Lime"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>Fertilizer</label>
          <input
            type="text" value={form.fertilizer}
            onChange={e => setField('fertilizer', e.target.value)}
            placeholder="e.g. 20-10-10"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>Seed Types *</label>
          {form.seed_types.map((s, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '110px 1fr auto', gap: 6, marginBottom: 6 }}>
              <input
                type="text" value={s.name}
                onChange={e => updateSeedType(i, { name: e.target.value })}
                placeholder="Name"
                style={inputStyle}
              />
              <input
                type="text" value={s.description}
                onChange={e => updateSeedType(i, { description: e.target.value })}
                placeholder="Description (e.g. ESC Mixture)"
                style={inputStyle}
              />
              <button onClick={() => removeSeedType(i)} style={{
                padding: '0 12px', background: '#7f1d1d', color: 'white',
                border: 'none', borderRadius: 6, cursor: 'pointer',
              }}>×</button>
            </div>
          ))}
          <button onClick={addSeedType} style={{
            padding: '8px 12px', background: '#111827', border: '1px solid #374151',
            color: '#f9fafb', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem',
          }}>+ Seed Type</button>
        </div>

        {/* ── Loads ──
            Each row is a horizontal flex container: the big left half opens
            the load for editing; the small right-side "Duplicate" button
            stops propagation and clones the load instead. Lets the worker
            quickly run, e.g., five identical 500 kg / 1 bale loads on the
            same site without re-entering everything every time. */}
        <h3 style={{ margin: '8px 0 0', fontSize: '1rem' }}>Loads ({form.loads.length})</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {form.loads.map((l) => {
            const mulchKg = (Number(l.mulch_bales) || 0) * KG_PER_BALE;
            const summary = [
              `Area: ${l.area_m2 || 0} m²`,
              `Mulch: ${mulchKg ? mulchKg.toFixed(0) + ' kg' : '—'}`,
            ].join(' · ');
            return (
              <div
                key={l.id}
                style={{
                  display: 'flex', alignItems: 'stretch', gap: 6,
                }}
              >
                <button
                  onClick={() => openExistingLoad(l.id)}
                  style={{
                    flex: 1, textAlign: 'left', padding: '10px 12px',
                    background: '#111827', border: '1px solid #374151',
                    borderRadius: 6, color: '#f9fafb', cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Load #{l.load_number}</div>
                  <div style={{ fontSize: '0.8rem', color: '#9ca3af' }}>{summary}</div>
                </button>
                <button
                  type="button"
                  onClick={() => duplicateLoad(l.id)}
                  title="Duplicate this load (same quantities)"
                  style={{
                    padding: '0 14px',
                    background: '#1f2937', border: '1px solid #374151',
                    borderRadius: 6, color: '#f9fafb', cursor: 'pointer',
                    fontSize: '0.85rem', whiteSpace: 'nowrap',
                  }}
                >
                  📋 Duplicate
                </button>
              </div>
            );
          })}
          <button onClick={openNewLoad} style={{
            padding: 12, background: '#3b82f6', color: 'white',
            border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600,
          }}>+ Add Load</button>
        </div>

        {/* ── Seed Tag Photos ── */}
        <div>
          <label style={labelStyle}>Seed Tag Photos *</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {form.seed_tag_photos.map((p, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={p.dataUrl} alt={`Seed tag ${i + 1}`} style={{ width: 100, height: 100, objectFit: 'cover', borderRadius: 6 }} />
                <button
                  onClick={() => removePhoto('seed_tag_photos', i)}
                  style={{
                    position: 'absolute', top: 2, right: 2,
                    background: 'rgba(0,0,0,0.6)', color: 'white', border: 'none', borderRadius: '50%',
                    width: 22, height: 22, cursor: 'pointer',
                  }}
                >×</button>
              </div>
            ))}
            <label htmlFor="seed-tag-upload" style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 100, height: 100, background: '#374151', borderRadius: 6,
              cursor: 'pointer', fontSize: '2rem', color: '#6b7280',
            }}>+</label>
            <input
              id="seed-tag-upload" type="file" accept="image/*" multiple
              style={{ display: 'none' }}
              onChange={(e) => onPhotoFiles('seed_tag_photos', e.target.files)}
            />
          </div>
        </div>

        {/* ── Map / Photo Annotations ── */}
        <div>
          <label style={labelStyle}>Map / Photo Annotations</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {form.photos.map((p, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={p.dataUrl} alt={`Annotation ${i + 1}`} style={{ width: 100, height: 100, objectFit: 'cover', borderRadius: 6 }} />
                <button
                  onClick={() => removePhoto('photos', i)}
                  style={{
                    position: 'absolute', top: 2, right: 2,
                    background: 'rgba(0,0,0,0.6)', color: 'white', border: 'none', borderRadius: '50%',
                    width: 22, height: 22, cursor: 'pointer',
                  }}
                >×</button>
              </div>
            ))}
            <label htmlFor="photo-upload" style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 100, height: 100, background: '#374151', borderRadius: 6,
              cursor: 'pointer', fontSize: '2rem', color: '#6b7280',
            }} title="Upload photos">+</label>
            <input
              id="photo-upload" type="file" accept="image/*" multiple
              style={{ display: 'none' }}
              onChange={(e) => onPhotoFiles('photos', e.target.files)}
            />
            <button
              type="button"
              onClick={() => setAnnotationOpen(true)}
              title="Open annotation canvas"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 100, height: 100, background: '#1e3a8a', borderRadius: 6,
                cursor: 'pointer', fontSize: '0.85rem', color: 'white',
                border: 'none', flexDirection: 'column', gap: 4, lineHeight: 1.1,
              }}
            >
              <span style={{ fontSize: '1.6rem' }}>✏️</span>
              <span>Annotate</span>
            </button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 4 }}>
            Tap <strong>Annotate</strong> to draw on a map screenshot, a blank canvas, or a photo. Saved annotations append to the photos above.
          </div>
        </div>

        {/* ── Comments ── */}
        <div>
          <label style={labelStyle}>Comments</label>
          <textarea
            rows={3}
            value={form.comments}
            onChange={e => setField('comments', e.target.value)}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </div>
      </div>

      {/* ── Sticky bottom action bar ──
          `flexShrink: 0` keeps the Preview/Cancel buttons anchored above
          the bottom tabs nav regardless of how much form content is above
          (or how tall the device's keyboard / safe-area is). The
          required-fields warning sits inside the same sticky block so
          workers see what's missing right next to the disabled Preview. */}
      <div style={{
        flexShrink: 0, padding: '12px 20px 16px',
        borderTop: '1px solid #374151',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {requiredMissing.length > 0 && (
          <div style={{
            background: 'rgba(248, 113, 113, 0.08)',
            border: '1px solid rgba(248, 113, 113, 0.4)',
            borderRadius: 6, padding: 10, fontSize: '0.85rem', color: '#fca5a5',
          }}>
            Required: {requiredMissing.join(', ')}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={handlePreview}
            style={{
              flex: 1, padding: 12, backgroundColor: '#22c55e', color: 'white',
              border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '1rem', cursor: 'pointer',
            }}
          >
            {requiredMissing.length > 0 ? `Preview (${requiredMissing.length} missing)` : 'Preview'}
          </button>
          <button
            onClick={onCancel}
            style={{
              flex: 1, padding: 12, backgroundColor: '#374151', color: '#f9fafb',
              border: 'none', borderRadius: 8, fontSize: '1rem', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
        {!isEditMode && (
          <button
            onClick={handleSaveDraftAndClose}
            style={{
              marginTop: 10, width: '100%', padding: 10,
              backgroundColor: 'transparent', color: '#9ca3af',
              border: '1px dashed #374151', borderRadius: 8,
              fontSize: '0.9rem', cursor: 'pointer',
            }}
          >
            {draftId ? '💾 Update Draft' : '💾 Save Draft'}
          </button>
        )}
      </div>

      {/* ── Load sub-modal ─────────────────────────────────────────────────────── */}
      {editingLoad && (() => {
        const bales = Number(editingLoad.mulch_bales) || 0;
        const mulchKg = (bales * KG_PER_BALE).toFixed(1);
        const isExisting = form.loads.some(l => l.id === editingLoad.id);
        return (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1100, padding: 16,
          }}>
            <div style={{
              backgroundColor: '#1f2937', color: '#f9fafb', borderRadius: 12,
              padding: 20, maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <h3 style={{ margin: 0 }}>Load #{editingLoad.load_number}</h3>
                <button onClick={() => setEditingLoad(null)} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Area (m²)</label>
                  <input
                    type="number" inputMode="decimal" min="0"
                    value={editingLoad.area_m2}
                    onChange={e => setEditingLoad({ ...editingLoad, area_m2: e.target.value })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Mulch Bales</label>
                  <input
                    type="number" inputMode="decimal" min="0" step="1"
                    value={editingLoad.mulch_bales}
                    onChange={e => setEditingLoad({ ...editingLoad, mulch_bales: e.target.value })}
                    style={inputStyle}
                  />
                  <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: 2 }}>= {mulchKg} kg</div>
                </div>
                <div>
                  <label style={labelStyle}>Soil Amendment (kg)</label>
                  <input
                    type="number" inputMode="decimal" min="0"
                    value={editingLoad.soil_amendment_kg}
                    onChange={e => setEditingLoad({ ...editingLoad, soil_amendment_kg: e.target.value })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Aqua Gel (kg)</label>
                  <input
                    type="number" inputMode="decimal" min="0"
                    value={editingLoad.aqua_gel_kg}
                    onChange={e => setEditingLoad({ ...editingLoad, aqua_gel_kg: e.target.value })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Tackifier (kg)</label>
                  <input
                    type="number" inputMode="decimal" min="0"
                    value={editingLoad.tackifier_kg}
                    onChange={e => setEditingLoad({ ...editingLoad, tackifier_kg: e.target.value })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Fertilizer (kg)</label>
                  <input
                    type="number" inputMode="decimal" min="0"
                    value={editingLoad.fertilizer_kg}
                    onChange={e => setEditingLoad({ ...editingLoad, fertilizer_kg: e.target.value })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Micro Nutrients (L)</label>
                  <input
                    type="number" inputMode="decimal" min="0" step="any"
                    value={editingLoad.micronutrients_l}
                    onChange={e => setEditingLoad({ ...editingLoad, micronutrients_l: e.target.value })}
                    style={inputStyle}
                  />
                </div>
                {/* Spacer so the 2-column grid stays balanced when the seed
                    grid below renders — keeps Micronutrients on its own row
                    with Fertilizer to its left. */}
                <div />
              </div>

              {(form.seed_types || []).length > 0 && (
                <>
                  <h4 style={{ margin: '14px 0 6px', fontSize: '0.95rem' }}>Seed (kg per type)</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    {form.seed_types.map((st) => {
                      const value = (editingLoad.seed_kgs || {})[st.name] ?? '';
                      return (
                        <div key={st.name}>
                          <label style={labelStyle}>
                            {st.name}{st.description ? ` — ${st.description}` : ''}
                          </label>
                          <input
                            type="number" inputMode="decimal" min="0"
                            value={value}
                            onChange={e => setEditingLoad({
                              ...editingLoad,
                              seed_kgs: { ...(editingLoad.seed_kgs || {}), [st.name]: e.target.value },
                            })}
                            style={inputStyle}
                          />
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              <label style={{ ...labelStyle, marginTop: 14 }}>Notes</label>
              <textarea
                rows={2}
                value={editingLoad.notes}
                onChange={e => setEditingLoad({ ...editingLoad, notes: e.target.value })}
                style={{ ...inputStyle, resize: 'vertical' }}
              />

              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button
                  onClick={saveEditingLoad}
                  style={{
                    flex: 1, padding: 12, backgroundColor: '#22c55e', color: 'white',
                    border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  {isExisting ? 'Save Load' : 'Add Load'}
                </button>
                {isExisting && (
                  <button
                    onClick={() => {
                      // Save any in-progress edits first, then clone — workers
                      // who tweak this load before duplicating expect the
                      // tweaks to be in BOTH the original and the clone.
                      saveEditingLoad();
                      duplicateLoad(editingLoad.id);
                    }}
                    style={{
                      padding: 12, backgroundColor: '#1f2937', color: '#f9fafb',
                      border: '1px solid #374151', borderRadius: 8, cursor: 'pointer',
                    }}
                    title="Save & duplicate this load"
                  >
                    📋 Duplicate
                  </button>
                )}
                {isExisting && (
                  <button
                    onClick={deleteEditingLoad}
                    style={{
                      padding: 12, backgroundColor: '#7f1d1d', color: 'white',
                      border: 'none', borderRadius: 8, cursor: 'pointer',
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      <MapAnnotationCanvas
        isOpen={annotationOpen}
        onCancel={() => setAnnotationOpen(false)}
        onSave={(payload) => {
          // Treat the saved canvas as a regular annotation photo so the
          // existing upload + PDF pipeline picks it up unchanged.
          setForm(prev => ({ ...prev, photos: [...(prev.photos || []), payload] }));
          setPhotosDirty(true);
          setAnnotationOpen(false);
        }}
      />
    </div>
  );
}
