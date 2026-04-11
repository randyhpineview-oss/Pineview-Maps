import { useEffect, useMemo, useState } from 'react';
import { generateLeaseSheetPdf } from '../lib/pdfGenerator';
import { api } from '../lib/api';
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
}) {
  const isEditMode = !!editingRecord;
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

  // Auto-populate from site, pipeline, or editing record
  useEffect(() => {
    if (isEditMode && editingRecord?.lease_sheet_data) {
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
        // Fallback: use Dropbox photo URLs as previews
        const restored = editingRecord.photo_urls.map((url) => ({
          file: null,
          preview: url.replace('dl=0', 'raw=1'),
          existingUrl: url,
        }));
        setPhotos(restored);
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
  }, [site, pipeline, isEditMode, editingRecord, initialDistanceMeters]);

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
        // Pre-existing photo (edit mode) — already a data URL or Dropbox URL
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
      };
      await onSubmit(payload);
    } catch (err) {
      alert('Upload failed: ' + (err.message || 'Unknown error'));
      setIsSubmitting(false);
    }
  };

  const handleBackToEdit = () => {
    setIsPreviewing(false);
    setPdfBase64(null);
  };

  if (!isOpen) return null;

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
            onClick={handleConfirmSubmit}
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
            {isSubmitting ? 'Uploading...' : isEditMode ? 'Update & Re-Submit' : 'Confirm & Submit'}
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
                      onChange={() => handleCheckboxGroup('noxiousWeedsSelected', weed.name)}
                      style={{ display: 'none' }}
                    />
                    {weed.name}
                  </label>
                ))}
              </div>
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

            {/* Total Liters and Area Treated */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Total Distance Sprayed (m)</label>
                <input
                  type="number"
                  value={form.totalDistanceSprayed}
                  onChange={e => setForm(prev => ({ ...prev, totalDistanceSprayed: e.target.value }))}
                  placeholder="Segment distance"
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
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Total Liters Applied</label>
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
            <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
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
          </div>
        )}
      </div>
  );
}
