import { useEffect, useMemo, useRef, useState } from 'react';
import { generateLeaseSheetPdf } from '../lib/pdfGenerator';
import { generateTMTicketPdf } from '../lib/tmTicketPdfGenerator';
import { api } from '../lib/api';
import { saveLeaseSheetDraft, deleteLeaseSheetDraft } from '../lib/offlineStore';
import PdfPreviewViewer from './PdfPreviewViewer';

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
}) {
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
  const [pdfBase64, setPdfBase64] = useState(null);
  // T&M linking step state
  const [isPickingTM, setIsPickingTM] = useState(false);
  const [openTMTickets, setOpenTMTickets] = useState([]);
  const [tmChoice, setTmChoice] = useState(null);  // { ticket_id } | { create: true, description_of_work }
  const [tmDescription, setTmDescription] = useState('');
  const [draftId, setDraftId] = useState(draft?.id || null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  // Local-only input for typing custom (Other) weeds. Not persisted.
  const [customWeedInput, setCustomWeedInput] = useState('');

  // Form state
  const [form, setForm] = useState({
    time: get12hTime(),
    date: new Date().toISOString().split('T')[0],
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

  // Auto-populate from site, pipeline, draft, or editing record (run once)
  useEffect(() => {
    // Restore draft (device-local, no API call)
    if (draft && !initializedRef.current) {
      initializedRef.current = true;
      if (draft.form) setForm(draft.form);
      if (draft.photos) setPhotos(draft.photos);
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
        date: d.date || editingRecord.spray_date || new Date().toISOString().split('T')[0],
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
        const restored = d.photos.map((p) => {
          const dataUrl = `data:${p.type || 'image/jpeg'};base64,${p.data}`;
          return {
            file: null,
            preview: dataUrl,
            existingBase64: p,
          };
        });
        setPhotos(restored);
      } else if (editingRecord.photo_urls && editingRecord.photo_urls.length > 0) {
        // Fallback: fetch Dropbox photos and convert to base64 to avoid CORS issues
        (async () => {
          const restored = await Promise.all(
            editingRecord.photo_urls.map(async (url) => {
              const rawUrl = url.replace('dl=0', 'raw=1');
              try {
                const resp = await fetch(rawUrl);
                const blob = await resp.blob();
                const dataUrl = await new Promise((resolve) => {
                  const reader = new FileReader();
                  reader.onloadend = () => resolve(reader.result);
                  reader.readAsDataURL(blob);
                });
                return {
                  file: null,
                  preview: dataUrl,
                  existingBase64: {
                    data: dataUrl.split(',')[1],
                    type: blob.type || 'image/jpeg',
                  },
                };
              } catch {
                // If fetch fails, use URL as preview (photos won't embed in PDF)
                return { file: null, preview: rawUrl, existingUrl: url };
              }
            })
          );
          setPhotos(restored);
        })();
      }
      return;
    }

    const currentTime = get12hTime();
    const currentDate = new Date().toISOString().split('T')[0];
    
    if (site) {
      setForm(prev => ({
        ...prev,
        time: currentTime,
        date: currentDate,
        customer: site.client || '',
        area: site.area || '',
        lsdOrPipeline: site.lsd || '',
      }));
    } else if (pipeline) {
      setForm(prev => ({
        ...prev,
        time: currentTime,
        date: currentDate,
        customer: pipeline.client || '',
        area: pipeline.area || '',
        lsdOrPipeline: pipeline.name || '',
        totalDistanceSprayed: initialDistanceMeters != null ? String(initialDistanceMeters) : prev.totalDistanceSprayed,
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

  const handleCheckboxGroup = (field, value) => {
    setForm(prev => {
      const current = prev[field] || [];
      const updated = current.includes(value)
        ? current.filter(v => v !== value)
        : [...current, value];
      return { ...prev, [field]: updated };
    });
  };

  const handlePhotoUpload = (e) => {
    const files = Array.from(e.target.files);
    // Limit: only take what's needed to reach max 2
    const spotsLeft = 2 - photos.length;
    if (spotsLeft <= 0) return;
    const toAdd = files.slice(0, spotsLeft).map(file => ({
      file,
      preview: URL.createObjectURL(file),
    }));
    setPhotos(prev => [...prev, ...toAdd]);
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
    try {
      // Build photo data URLs for embedding in PDF
      const photoDataUrls = await Promise.all(
        photos.map(p => {
          if (p.file) {
            return new Promise(resolve => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.readAsDataURL(p.file);
            });
          }
          if (p.existingBase64) {
            return `data:${p.existingBase64.type || 'image/jpeg'};base64,${p.existingBase64.data}`;
          }
          return p.preview;
        })
      );
      const pdfData = {
        ...form,
        ticket_number: ticketNumber,
      };
      const { base64 } = await generateLeaseSheetPdf(pdfData, photoDataUrls);
      setPdfBase64(base64);
      setIsPreviewing(true);
    } catch (err) {
      console.error('[LEASE] Preview failed:', err);
      alert('Failed to generate preview: ' + (err.message || 'Unknown error'));
    }
  };

  // Called when user taps "Continue" from Preview.
  // In edit mode: skip linking step (record already linked); go straight to submit.
  // In create mode: fetch open T&M tickets matching client/area/date, show picker.
  const handleContinueFromPreview = async () => {
    if (isEditMode) {
      await handleConfirmSubmit();
      return;
    }
    try {
      const tickets = await api.listOpenTMTickets({
        client: form.customer || undefined,
        area: form.area || undefined,
        spray_date: form.date || undefined,
      });
      setOpenTMTickets(tickets || []);
      // Default pick: if exactly one matches auto-pick it; if multiple require user to choose;
      // if none, default to "create new".
      if (tickets && tickets.length === 1) {
        setTmChoice({ ticket_id: tickets[0].id });
      } else if (tickets && tickets.length > 1) {
        setTmChoice(null);  // force user to pick
      } else {
        setTmChoice({ create: true });
      }
      setIsPickingTM(true);
    } catch (err) {
      console.warn('[LEASE] Could not fetch open T&M tickets (continuing without link):', err?.message);
      setOpenTMTickets([]);
      setTmChoice({ create: true });
      setIsPickingTM(true);
    }
  };

  const handleConfirmSubmit = async () => {
    setIsSubmitting(true);
    try {
      // For new records, fetch ticket number now so it appears in the PDF
      let finalTicket = ticketNumber;
      if (!finalTicket && !isEditMode) {
        try {
          const resp = await api.getNextTicket();
          finalTicket = resp.ticket_number;
          setTicketNumber(finalTicket);
        } catch (err) {
          console.warn('[LEASE] Could not fetch ticket number:', err?.message);
        }
      }

      // Regenerate PDF with the ticket number so Dropbox copy has it
      const photoDataUrls = await Promise.all(
        photos.map(async (p) => {
          if (p.existingBase64) {
            return `data:${p.existingBase64.type || 'image/jpeg'};base64,${p.existingBase64.data}`;
          }
          return p.preview;
        })
      );
      const { base64: finalPdfBase64 } = await generateLeaseSheetPdf(
        { ...form, ticket_number: finalTicket },
        photoDataUrls
      );

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

      // ── Build the T&M link + tentative PDF so the backend can upload to Dropbox ──
      let tm_link = null;
      if (!isEditMode && tmChoice) {
        const pickedExisting = tmChoice.ticket_id
          ? openTMTickets.find((t) => t.id === tmChoice.ticket_id)
          : null;

        // Tentative T&M ticket for PDF rendering (backend will allocate the real number if `create`)
        const tentativeTicket = pickedExisting
          ? {
              ...pickedExisting,
              rows: [
                ...(pickedExisting.rows || []),
                {
                  location: form.lsdOrPipeline || '',
                  site_type: (site?.pin_type === 'lsd' ? 'Wellsite' : ''),
                  herbicides: (form.herbicidesUsed || []).length === 1
                    ? form.herbicidesUsed[0]
                    : (form.herbicidesUsed || []).length > 1
                      ? `${form.herbicidesUsed.length} Herbicides`
                      : '',
                  liters_used: Number(form.totalLiters) || 0,
                  area_ha: Number(form.areaTreated) || 0,
                  cost_code: '',
                },
              ],
            }
          : {
              ticket_number: '',  // backend will fill
              spray_date: form.date,
              client: form.customer,
              area: form.area,
              description_of_work: tmDescription || (tmChoice.description_of_work || ''),
              rows: [
                {
                  location: form.lsdOrPipeline || '',
                  site_type: (site?.pin_type === 'lsd' ? 'Wellsite' : ''),
                  herbicides: (form.herbicidesUsed || []).length === 1
                    ? form.herbicidesUsed[0]
                    : (form.herbicidesUsed || []).length > 1
                      ? `${form.herbicidesUsed.length} Herbicides`
                      : '',
                  liters_used: Number(form.totalLiters) || 0,
                  area_ha: Number(form.areaTreated) || 0,
                  cost_code: '',
                },
              ],
            };

        let tmPdfBase64 = null;
        try {
          const { base64 } = await generateTMTicketPdf(tentativeTicket, { includeOfficeData: false });
          tmPdfBase64 = base64;
        } catch (err) {
          console.warn('[LEASE] T&M PDF generation failed (continuing):', err?.message);
        }

        tm_link = pickedExisting
          ? { ticket_id: pickedExisting.id, tm_pdf_base64: tmPdfBase64 }
          : {
              create: true,
              description_of_work: tmDescription || (tmChoice.description_of_work || ''),
              tm_pdf_base64: tmPdfBase64,
            };
      }

      const payload = {
        lease_sheet_data: {
          ...form,
          ticket_number: finalTicket || undefined,
          photos: photoData,
        },
        pdf_base64: finalPdfBase64,
        ticket_number: finalTicket || undefined,
        spray_date: form.date,
        notes: form.comments,
        is_avoided: false,
        time_materials_link: tm_link,
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

      // Delete local draft on successful submit
      if (draftId) {
        try { await deleteLeaseSheetDraft(draftId); } catch { /* ignore */ }
      }
    } catch (err) {
      alert('Upload failed: ' + (err.message || 'Unknown error'));
      setIsSubmitting(false);
    }
  };

  // Save current form state as a device-local draft
  const handleSaveDraft = async () => {
    setIsSavingDraft(true);
    try {
      // Convert any file-based photos to base64 so they survive a reload
      const photoPromises = photos.map(async (p) => {
        if (p.existingBase64) return p;
        if (p.preview?.startsWith('data:')) return p;
        if (p.file) {
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve({
              file: null,
              preview: reader.result,
              existingBase64: {
                data: reader.result.split(',')[1],
                type: p.file.type || 'image/jpeg',
              },
            });
            reader.readAsDataURL(p.file);
          });
        }
        return p;
      });
      const serializablePhotos = await Promise.all(photoPromises);

      const saved = await saveLeaseSheetDraft({
        id: draftId || undefined,
        site_id: site?.id || null,
        pipeline_id: pipeline?.id || null,
        form,
        photos: serializablePhotos,
        ticketNumber,
        label: `${form.customer || site?.client || '—'} / ${form.area || site?.area || '—'} / ${form.lsdOrPipeline || site?.lsd || '—'}`,
      });
      setDraftId(saved.id);
      onDraftSaved?.(saved);
    } catch (err) {
      alert('Could not save draft: ' + (err.message || 'Unknown error'));
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleBackToEdit = () => {
    setIsPreviewing(false);
    setPdfBase64(null);
  };

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

        {openTMTickets.length > 0 ? (
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
              Description of Work <span style={{ color: '#f87171' }}>*</span>
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
      borderRadius: '16px 16px 0 0',
      maxHeight: '90vh',
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
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Time</label>
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
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Date</label>
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
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Customer</label>
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
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Area</label>
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
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>LSD / Pipeline</label>
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
            </div>

            {/* Applicators */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Applicators</label>
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

            {/* Location Types */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Location Type</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {locationTypes.map(type => (
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

            {/* Weather */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Temperature (°C)</label>
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
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Wind Speed (km/h)</label>
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
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Wind Direction</label>
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
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Spray Type</label>
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
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Spray Method</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {['Boomless', 'Covered Boom', 'Handwand'].map(method => (
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
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Noxious Weeds</label>
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
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Herbicides Used</label>
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
                    {herb.name} {herb.pcp_number && `(${herb.pcp_number})`}
                  </label>
                ))}
              </div>
            </div>

            {/* Total Liters and Distance Sprayed */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Total Liters</label>
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
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Total Metres (m)</label>
                <input
                  type="number"
                  value={form.totalDistanceSprayed}
                  onChange={e => setForm(prev => ({ ...prev, totalDistanceSprayed: e.target.value }))}
                  placeholder="Distance"
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
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Area Treated (ha)</label>
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
                <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', color: '#f9fafb' }}>Roadside Details</h3>
                
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Roadside km Sprayed</label>
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
                  <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Roadside Herbicides Used</label>
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
                    <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Roadside Liters</label>
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
                    <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Roadside Area (ha)</label>
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
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Comments</label>
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
                  <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: '4px' }}>LSD / Location ID</div>
                  {photos[0] ? (
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <img src={photos[0].preview} alt="LSD Photo" style={{ width: '100px', height: '100px', objectFit: 'cover', borderRadius: '6px' }} />
                      <button onClick={() => removePhoto(0)} style={{ position: 'absolute', top: '-8px', right: '-8px', width: '20px', height: '20px', borderRadius: '50%', backgroundColor: '#ef4444', color: 'white', border: 'none', cursor: 'pointer', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                    </div>
                  ) : (
                    <>
                      <input type="file" accept="image/*" capture="environment" onChange={handlePhotoUpload} style={{ display: 'none' }} id="photo-lsd" />
                      <label htmlFor="photo-lsd" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100px', height: '100px', backgroundColor: '#374151', borderRadius: '6px', cursor: 'pointer', fontSize: '2rem', color: '#6b7280' }}>+</label>
                    </>
                  )}
                </div>
                {/* Slot 2: Site Photo */}
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: '4px' }}>Site Photo</div>
                  {photos[1] ? (
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <img src={photos[1].preview} alt="Site Photo" style={{ width: '100px', height: '100px', objectFit: 'cover', borderRadius: '6px' }} />
                      <button onClick={() => removePhoto(1)} style={{ position: 'absolute', top: '-8px', right: '-8px', width: '20px', height: '20px', borderRadius: '50%', backgroundColor: '#ef4444', color: 'white', border: 'none', cursor: 'pointer', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                    </div>
                  ) : (
                    <>
                      <input type="file" accept="image/*" capture="environment" onChange={handlePhotoUpload} style={{ display: 'none' }} id="photo-site" />
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
                  style={{
                    flex: 1,
                    padding: '12px',
                    backgroundColor: '#3b82f6',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Preview
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
                  onClick={handleSaveDraft}
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
