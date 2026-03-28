import { useEffect, useState } from 'react';

import { formatDate, getDirectionsUrl, isInfoOnlyPin, pinTypeLabel, statusLabel } from '../lib/mapUtils';

function buildEditState(site) {
  return {
    pin_type: site?.pin_type || 'lsd',
    lsd: site?.lsd || '',
    client: site?.client || '',
    area: site?.area || '',
    latitude: site?.latitude ?? '',
    longitude: site?.longitude ?? '',
    gate_code: site?.gate_code || '',
    phone_number: site?.phone_number || '',
    notes: site?.notes || '',
  };
}

export default function SiteDetailSheet({
  site,
  onStatusChange,
  statusSaving,
  canManagePin = false,
  onSavePin,
  onDeletePin,
  onRequestTypeChange,
  adminBusy = false,
  onRequestMapPick,
  pickedLocation = null,
}) {
  const [note, setNote] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editState, setEditState] = useState(() => buildEditState(site));

  useEffect(() => {
    setNote('');
    setIsEditing(false);
    setEditState(buildEditState(site));
  }, [site?.id, site?.updated_at]);

  useEffect(() => {
    if (pickedLocation && isEditing) {
      setEditState((prev) => ({
        ...prev,
        latitude: pickedLocation.latitude,
        longitude: pickedLocation.longitude,
      }));
    }
  }, [pickedLocation]);

  const canSaveEdit = editState.latitude !== '' && editState.longitude !== '';

  function updateEditField(key, value) {
    setEditState((current) => ({ ...current, [key]: value }));
  }

  async function handleSaveEdit() {
    if (!canSaveEdit || !onSavePin || !site) {
      return;
    }

    const wasSuccessful = await onSavePin(site, {
      pin_type: editState.pin_type,
      lsd: editState.lsd || null,
      client: editState.client || null,
      area: editState.area || null,
      latitude: Number(editState.latitude),
      longitude: Number(editState.longitude),
      gate_code: editState.gate_code || null,
      phone_number: editState.phone_number || null,
      notes: editState.notes || null,
    });

    if (wasSuccessful) {
      setIsEditing(false);
    }
  }

  async function handleDelete() {
    if (!onDeletePin || !site) {
      return;
    }

    if (!window.confirm(`Delete ${site.lsd || 'this pin'}?`)) {
      return;
    }

    await onDeletePin(site);
  }

  if (!site) {
    return (
      <>
        <h2>Site details</h2>
        <p className="small-text">Tap a pin on the map to view its details.</p>
      </>
    );
  }

  return (
    <>
      <div className="button-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2>{site.lsd || 'Unnamed pin'}</h2>
          <p className="small-text">{pinTypeLabel(site.pin_type)} pin</p>
        </div>
        {site.approval_state === 'pending_review' ? <span className="pending-badge">Pending approval</span> : null}
      </div>
      {isEditing ? (
        <>
          <div className="list-grid">
            <select value={editState.pin_type} onChange={(event) => updateEditField('pin_type', event.target.value)}>
              <option value="lsd">LSD</option>
              <option value="water">Water</option>
              <option value="quad_access">Quad access</option>
              <option value="reclaimed">Reclaimed</option>
            </select>
            <input value={editState.lsd} onChange={(event) => updateEditField('lsd', event.target.value)} placeholder="LSD or site label" />
            <input value={editState.client} onChange={(event) => updateEditField('client', event.target.value)} placeholder="Client" />
            <input value={editState.area} onChange={(event) => updateEditField('area', event.target.value)} placeholder="Area" />
            <div className="button-row">
              <input value={editState.latitude} onChange={(event) => updateEditField('latitude', event.target.value)} placeholder="Latitude" />
              <input value={editState.longitude} onChange={(event) => updateEditField('longitude', event.target.value)} placeholder="Longitude" />
            </div>
            {onRequestMapPick ? (
              <button className="secondary-button" type="button" onClick={onRequestMapPick} style={{ width: '100%' }}>
                📍 Pick new location on map
              </button>
            ) : null}
            <input value={editState.gate_code} onChange={(event) => updateEditField('gate_code', event.target.value)} placeholder="Gate code" />
            <input value={editState.phone_number} onChange={(event) => updateEditField('phone_number', event.target.value)} placeholder="Phone number" />
            <textarea value={editState.notes} onChange={(event) => updateEditField('notes', event.target.value)} placeholder="Notes" rows="3" />
          </div>
          <div className="button-row" style={{ marginTop: '1rem' }}>
            <button className="primary-button" type="button" disabled={!canSaveEdit || adminBusy} onClick={handleSaveEdit}>
              {adminBusy ? 'Saving...' : 'Save changes'}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={adminBusy}
              onClick={() => {
                setIsEditing(false);
                setEditState(buildEditState(site));
              }}
            >
              Cancel
            </button>
            <button className="danger-button" type="button" disabled={adminBusy} onClick={handleDelete}>
              Delete pin
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="meta-grid">
            <div className="meta-item">
              <strong>Status</strong>
              {statusLabel(site.status)}
            </div>
            <div className="meta-item">
              <strong>Last inspected</strong>
              {formatDate(site.last_inspected_at)}
            </div>
            <div className="meta-item">
              <strong>Client</strong>
              {site.client || 'Not set'}
            </div>
            <div className="meta-item">
              <strong>Area</strong>
              {site.area || 'Not set'}
            </div>
            <div className="meta-item">
              <strong>Gate code</strong>
              {site.gate_code || 'Not set'}
            </div>
            <div className="meta-item">
              <strong>Phone number</strong>
              {site.phone_number || 'Not set'}
            </div>
            <div className="meta-item" style={{ gridColumn: '1 / -1' }}>
              <strong>Notes</strong>
              {site.notes || 'No notes'}
            </div>
          </div>
          <div className="button-row" style={{ marginTop: '1rem' }}>
            <button
              className="secondary-button"
              type="button"
              onClick={() => window.location.assign(getDirectionsUrl(site))}
            >
              Get Directions
            </button>
            {canManagePin ? (
              <>
                <button className="secondary-button" type="button" onClick={() => setIsEditing(true)}>
                  Edit pin
                </button>
                <button className="danger-button" type="button" disabled={adminBusy} onClick={handleDelete}>
                  Delete pin
                </button>
              </>
            ) : null}
          </div>
          {!isInfoOnlyPin(site.pin_type) ? (
            <>
              <div style={{ marginTop: '1rem' }}>
                <label className="small-text" htmlFor="site-update-note">
                  Update note
                </label>
                <textarea
                  id="site-update-note"
                  rows="3"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Add a short note for this status change"
                />
              </div>
              <div className="button-row" style={{ marginTop: '1rem' }}>
                <button
                  className="status-button green"
                  type="button"
                  disabled={statusSaving}
                  onClick={() => onStatusChange(site, 'inspected', note)}
                >
                  Mark Inspected
                </button>
                <button
                  className="status-button red"
                  type="button"
                  disabled={statusSaving}
                  onClick={() => onStatusChange(site, 'not_inspected', note)}
                >
                  Mark Not inspected
                </button>
              </div>
            </>
          ) : null}
          {(site.pin_type === 'lsd' || site.pin_type === 'reclaimed') && onRequestTypeChange ? (
            <div className="button-row" style={{ marginTop: '0.75rem' }}>
              <button
                className="secondary-button"
                type="button"
                disabled={adminBusy || site.pending_pin_type != null}
                onClick={() =>
                  onRequestTypeChange(
                    site,
                    site.pin_type === 'reclaimed' ? 'lsd' : 'reclaimed'
                  )
                }
              >
                {site.pending_pin_type != null
                  ? 'Type change pending approval'
                  : site.pin_type === 'reclaimed'
                    ? 'Unmark Reclaimed'
                    : 'Mark as Reclaimed'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
