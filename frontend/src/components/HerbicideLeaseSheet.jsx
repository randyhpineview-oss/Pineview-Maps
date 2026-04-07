import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

export default function HerbicideLeaseSheet({
  site,
  pipeline,
  onSubmit,
  onCancel,
  isOpen,
}) {
  const [herbicides, setHerbicides] = useState([]);
  const [applicators, setApplicators] = useState([]);
  const [noxiousWeeds, setNoxiousWeeds] = useState([]);
  const [locationTypes, setLocationTypes] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [photos, setPhotos] = useState([]);

  // Form state
  const [form, setForm] = useState({
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
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

  // Auto-populate from site or pipeline
  useEffect(() => {
    // Always update time when lease sheet opens
    const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
      }));
    }
  }, [site, pipeline]);

  // Load lookup tables
  useEffect(() => {
    async function loadLookups() {
      try {
        const [herbs, apps, weeds, types] = await Promise.all([
          api.listHerbicides(),
          api.listApplicators(),
          api.listNoxiousWeeds(),
          api.listLocationTypes(),
        ]);
        setHerbicides(herbs);
        setApplicators(apps);
        setNoxiousWeeds(weeds);
        setLocationTypes(types);
      } catch (error) {
        console.error('Failed to load lookup tables:', error);
      } finally {
        setIsLoading(false);
      }
    }
    if (isOpen) {
      loadLookups();
    }
  }, [isOpen]);

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
    const newPhotos = files.map(file => ({
      file,
      preview: URL.createObjectURL(file),
    }));
    setPhotos(prev => [...prev, ...newPhotos]);
  };

  const removePhoto = (index) => {
    setPhotos(prev => {
      const updated = [...prev];
      URL.revokeObjectURL(updated[index].preview);
      updated.splice(index, 1);
      return updated;
    });
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const payload = {
        lease_sheet_data: form,
        photos: photos.map(p => p.file),
        spray_date: form.date,
        notes: form.comments,
        is_avoided: false,
      };
      await onSubmit(payload);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>Herbicide Lease Sheet</h2>
          <button onClick={onCancel} style={{
            background: 'none',
            border: 'none',
            color: '#9ca3af',
            fontSize: '1.5rem',
            cursor: 'pointer',
          }}>×</button>
        </div>

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>Loading form...</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Auto-populated fields */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '4px' }}>Time</label>
                <input
                  type="time"
                  value={form.time}
                  onChange={e => setForm(prev => ({ ...prev, time: e.target.value }))}
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
              <div>
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

            {/* Photos */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#9ca3af', marginBottom: '8px' }}>Location Photos</label>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handlePhotoUpload}
                style={{ display: 'none' }}
                id="photo-upload"
              />
              <label
                htmlFor="photo-upload"
                style={{
                  display: 'inline-block',
                  padding: '8px 16px',
                  backgroundColor: '#374151',
                  color: '#f9fafb',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                }}
              >
                Add Photos
              </label>
              
              {photos.length > 0 && (
                <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
                  {photos.map((photo, idx) => (
                    <div key={idx} style={{ position: 'relative' }}>
                      <img
                        src={photo.preview}
                        alt={`Photo ${idx + 1}`}
                        style={{
                          width: '80px',
                          height: '80px',
                          objectFit: 'cover',
                          borderRadius: '6px',
                        }}
                      />
                      <button
                        onClick={() => removePhoto(idx)}
                        style={{
                          position: 'absolute',
                          top: '-8px',
                          right: '-8px',
                          width: '20px',
                          height: '20px',
                          borderRadius: '50%',
                          backgroundColor: '#ef4444',
                          color: 'white',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: '12px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Submit buttons */}
            <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
              <button
                onClick={handleSubmit}
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
                {isSubmitting ? 'Submitting...' : 'Submit & Mark Inspected'}
              </button>
              <button
                onClick={onCancel}
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
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
  );
}
