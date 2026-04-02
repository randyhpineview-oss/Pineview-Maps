import { useMemo, useState } from 'react';

import { pinTypeLabel } from '../lib/mapUtils';
import UserManagementPanel from './UserManagementPanel';

function PendingSiteCard({ site, busy, onApprove, onReject, onApproveAndEdit, onSelectSite }) {
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState({
    lsd: site.lsd || '',
    client: site.client || '',
    area: site.area || '',
    gate_code: site.gate_code || '',
    phone_number: site.phone_number || '',
    notes: site.notes || '',
  });

  function update(key, value) {
    setEdits((prev) => ({ ...prev, [key]: value }));
  }

  function buildOverrides() {
    const overrides = {};
    if (edits.lsd !== (site.lsd || '')) overrides.lsd = edits.lsd || null;
    if (edits.client !== (site.client || '')) overrides.client = edits.client || null;
    if (edits.area !== (site.area || '')) overrides.area = edits.area || null;
    if (edits.gate_code !== (site.gate_code || '')) overrides.gate_code = edits.gate_code || null;
    if (edits.phone_number !== (site.phone_number || '')) overrides.phone_number = edits.phone_number || null;
    if (edits.notes !== (site.notes || '')) overrides.notes = edits.notes || null;
    return overrides;
  }

  return (
    <div className="site-row" onClick={() => onSelectSite?.(site)} style={{ cursor: onSelectSite ? 'pointer' : 'default' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
        <div>
          <strong>{site.lsd || 'Unnamed pin'}</strong>
          <div className="small-text">{pinTypeLabel(site.pin_type)} • {site.client || 'No client'} • {site.area || 'No area'}</div>
          <div className="small-text">Status: {site.status === 'inspected' ? 'Inspected' : 'Not inspected'}</div>
        </div>
        <span className="pending-badge">Pending</span>
      </div>
      {site.pending_pin_type ? (
        <div className="small-text" style={{ marginTop: '0.35rem', color: '#fbbf24' }}>
          Type change requested → <strong>{site.pending_pin_type === 'reclaimed' ? 'Reclaimed' : site.pending_pin_type === 'lsd' ? 'LSD' : site.pending_pin_type}</strong>
        </div>
      ) : null}
      {!editing ? (
        <div className="small-text" style={{ marginTop: '0.55rem' }}>
          {site.notes || 'No notes'}
        </div>
      ) : (
        <div className="list-grid" style={{ marginTop: '0.55rem' }}>
          <input value={edits.lsd} onChange={(e) => update('lsd', e.target.value)} placeholder="LSD or site label" />
          <input value={edits.client} onChange={(e) => update('client', e.target.value)} placeholder="Client" />
          <input value={edits.area} onChange={(e) => update('area', e.target.value)} placeholder="Area" />
          <input value={edits.gate_code} onChange={(e) => update('gate_code', e.target.value)} placeholder="Gate code" />
          <input value={edits.phone_number} onChange={(e) => update('phone_number', e.target.value)} placeholder="Phone number" />
          <textarea value={edits.notes} onChange={(e) => update('notes', e.target.value)} placeholder="Notes" rows="2" />
        </div>
      )}
      <div className="button-row" style={{ marginTop: '0.75rem' }}>
        {!editing ? (
          <>
            <button className="primary-button" type="button" disabled={busy} onClick={() => onApprove(site.id, {})}>
              Approve
            </button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => setEditing(true)}>
              Approve & Edit
            </button>
            <button className="danger-button" type="button" disabled={busy} onClick={() => onReject(site.id)}>
              Reject
            </button>
          </>
        ) : (
          <>
            <button className="primary-button" type="button" disabled={busy} onClick={() => { onApproveAndEdit ? onApproveAndEdit(site, buildOverrides()) : onApprove(site.id, buildOverrides()); }}>
              Confirm Approve
            </button>
            <button className="secondary-button" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function CollapsibleSection({ title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((c) => !c)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
          background: 'none', border: 'none', color: '#e5eefb', padding: '0.5rem 0', cursor: 'pointer',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '0.95rem' }}>
          {title}{count != null ? ` (${count})` : ''}
        </h3>
        <span style={{ fontSize: '0.8rem', color: '#9ab1d6' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open ? children : null}
    </div>
  );
}

export default function AdminPanel({
  visible,
  pendingSites,
  deletedSites = [],
  clients,
  areas,
  busy,
  onApprove,
  onReject,
  onApproveAndEdit,
  onBulkReset,
  onImport,
  onRestore,
  onDeletePermanent,
  onSelectSite,
  currentUserEmail,
}) {
  const [file, setFile] = useState(null);
  const [resetClient, setResetClient] = useState('');
  const [resetArea, setResetArea] = useState('');

  const canReset = useMemo(() => Boolean(resetClient || resetArea), [resetClient, resetArea]);

  if (!visible) {
    return null;
  }

  async function handleImport(event) {
    event.preventDefault();
    if (!file) {
      return;
    }
    await onImport(file);
    setFile(null);
  }

  async function handleReset(event) {
    event.preventDefault();
    await onBulkReset({ client: resetClient || null, area: resetArea || null });
  }

  return (
    <div className="panel">
      <h2>Admin tools</h2>
      <div className="list-grid">
        <CollapsibleSection title="Pending approvals" count={pendingSites.length} defaultOpen={pendingSites.length > 0}>
          <div className="list-grid">
            {pendingSites.length === 0 ? (
              <div className="site-row">
                <div className="small-text">No pending pins right now.</div>
              </div>
            ) : (
              pendingSites.map((site) => (
                <PendingSiteCard
                  key={site.id}
                  site={site}
                  busy={busy}
                  onApprove={onApprove}
                  onReject={onReject}
                  onApproveAndEdit={onApproveAndEdit}
                  onSelectSite={onSelectSite}
                />
              ))
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Recent deletes" count={deletedSites.length} defaultOpen={false}>
          <div className="list-grid">
            {deletedSites.length === 0 ? (
              <div className="site-row">
                <div className="small-text">No deleted pins.</div>
              </div>
            ) : (
              deletedSites.map((site) => (
                  <div className="site-row" key={site.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                    <div>
                      <strong>{site.lsd || 'Unnamed pin'}</strong>
                      <div className="small-text">{pinTypeLabel(site.pin_type)} • {site.client || 'No client'} • {site.area || 'No area'}</div>
                    </div>
                    <span className="pending-badge" style={{ background: '#64748b' }}>Deleted</span>
                  </div>
                  <div className="button-row" style={{ marginTop: '0.75rem' }}>
                    <button className="primary-button" type="button" disabled={busy} onClick={() => onRestore(site.id)}>
                      Restore
                    </button>
                    <button className="danger-button" type="button" disabled={busy} onClick={() => onDeletePermanent(site.id)} style={{ marginLeft: '0.5rem' }}>
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Import KML" defaultOpen={false}>
          <form onSubmit={handleImport} className="list-grid">
            <input type="file" accept=".kml" onChange={(event) => setFile(event.target.files?.[0] || null)} />
            <button className="primary-button" type="submit" disabled={!file || busy}>
              Import existing KML
            </button>
          </form>
        </CollapsibleSection>

        <CollapsibleSection title="Bulk reset to green" defaultOpen={false}>
          <form onSubmit={handleReset} className="list-grid">
            <select value={resetClient} onChange={(event) => setResetClient(event.target.value)}>
              <option value="">Select client</option>
              {clients.map((client) => (
                <option key={client} value={client}>
                  {client}
                </option>
              ))}
            </select>
            <select value={resetArea} onChange={(event) => setResetArea(event.target.value)}>
              <option value="">Select area</option>
              {areas.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </select>
            <button className="secondary-button" type="submit" disabled={!canReset || busy}>
              Reset selected sites to Not inspected
            </button>
          </form>
        </CollapsibleSection>

        <CollapsibleSection title="User Management" defaultOpen={false}>
          <UserManagementPanel busy={busy} currentUserEmail={currentUserEmail} />
        </CollapsibleSection>
      </div>
    </div>
  );
}
