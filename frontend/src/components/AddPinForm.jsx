import { useEffect, useMemo, useState } from 'react';

const initialForm = {
  pin_type: 'lsd',
  status: 'not_inspected',
  lsd: '',
  client: '',
  area: '',
  latitude: '',
  longitude: '',
  gate_code: '',
  phone_number: '',
  notes: '',
};

export default function AddPinForm({
  onSubmit,
  submitting,
  title = 'Add pending pin',
  description = 'Add missing LSD, water, or quad access pins. All new pins require approval.',
  submitLabel = 'Submit pending pin',
  successMessage = 'Pending pin submitted.',
  selectedMapLocation = null,
  isPickingMapLocation = false,
  onRequestMapPick,
  onCancelMapPick,
}) {
  const [formState, setFormState] = useState(initialForm);
  const [locationState, setLocationState] = useState('');

  const canSubmit = useMemo(
    () => formState.latitude !== '' && formState.longitude !== '',
    [formState.latitude, formState.longitude]
  );

  function updateField(key, value) {
    setFormState((current) => ({ ...current, [key]: value }));
  }

  useEffect(() => {
    if (!selectedMapLocation) {
      return;
    }

    setFormState((current) => ({
      ...current,
      latitude: selectedMapLocation.latitude.toFixed(6),
      longitude: selectedMapLocation.longitude.toFixed(6),
    }));
    setLocationState('Map location applied.');
  }, [selectedMapLocation?.latitude, selectedMapLocation?.longitude]);

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setLocationState('Geolocation is not available on this device.');
      return;
    }

    if (isPickingMapLocation) {
      onCancelMapPick?.();
    }

    setLocationState('Getting your location...');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        updateField('latitude', position.coords.latitude.toFixed(6));
        updateField('longitude', position.coords.longitude.toFixed(6));
        setLocationState('Current GPS location applied.');
      },
      () => {
        setLocationState('Location access failed. Enter coordinates manually.');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function toggleMapPick() {
    if (isPickingMapLocation) {
      onCancelMapPick?.();
      setLocationState('Map location picking canceled.');
      return;
    }

    onRequestMapPick?.();
    setLocationState('Tap the map to choose a location.');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit) {
      setLocationState('Latitude and longitude are required.');
      return;
    }

    const wasSuccessful = await onSubmit({
      ...formState,
      latitude: Number(formState.latitude),
      longitude: Number(formState.longitude),
      lsd: formState.lsd || null,
      client: formState.client || null,
      area: formState.area || null,
      gate_code: formState.gate_code || null,
      phone_number: formState.phone_number || null,
      notes: formState.notes || null,
    });

    if (wasSuccessful) {
      setFormState(initialForm);
      setLocationState(successMessage);
    }
  }

  return (
    <div className="panel">
      <h2>{title}</h2>
      <p className="small-text">{description}</p>
      <form onSubmit={handleSubmit} className="list-grid">
        <select value={formState.pin_type} onChange={(event) => updateField('pin_type', event.target.value)}>
          <option value="lsd">LSD</option>
          <option value="water">Water</option>
          <option value="quad_access">Quad access</option>
          <option value="reclaimed">Reclaimed</option>
        </select>
        <select value={formState.status} onChange={(event) => updateField('status', event.target.value)}>
          <option value="not_inspected">Not inspected</option>
          <option value="inspected">Inspected</option>
        </select>
        <input
          value={formState.lsd}
          onChange={(event) => updateField('lsd', event.target.value)}
          placeholder="LSD or site label"
        />
        <input value={formState.client} onChange={(event) => updateField('client', event.target.value)} placeholder="Client" />
        <input value={formState.area} onChange={(event) => updateField('area', event.target.value)} placeholder="Area" />
        <div className="button-row">
          <input
            value={formState.latitude}
            onChange={(event) => updateField('latitude', event.target.value)}
            placeholder="Latitude"
          />
          <input
            value={formState.longitude}
            onChange={(event) => updateField('longitude', event.target.value)}
            placeholder="Longitude"
          />
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={useCurrentLocation}>
            Use current GPS
          </button>
          <button className="secondary-button" type="button" onClick={toggleMapPick}>
            {isPickingMapLocation ? 'Cancel map pick' : 'Pick on map'}
          </button>
        </div>
        <input
          value={formState.gate_code}
          onChange={(event) => updateField('gate_code', event.target.value)}
          placeholder="Gate code"
        />
        <input
          value={formState.phone_number}
          onChange={(event) => updateField('phone_number', event.target.value)}
          placeholder="Phone number"
        />
        <textarea
          value={formState.notes}
          onChange={(event) => updateField('notes', event.target.value)}
          placeholder="Notes"
          rows="3"
        />
        <div className="button-row">
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? 'Submitting...' : submitLabel}
          </button>
        </div>
        {locationState ? <div className="small-text">{locationState}</div> : null}
      </form>
    </div>
  );
}
