import { useMemo, useState } from 'react';

import { pinTypeLabel, statusLabel } from '../lib/mapUtils';
import UserManagementPanel from './UserManagementPanel';
import InviteClientPanel from './InviteClientPanel';
import LookupManager from './LookupManager';
import DeviceAdmin from './DeviceAdmin';
import { useDialog } from './DialogProvider';

function PendingSiteCard({ site, busy, onApprove, onReject, onApproveAndEdit, onSelectSite }) {
  // Approve & Edit now opens the full review modal (ApproveEditModal)
  // via onApproveAndEdit; nothing is submitted until the admin confirms
  // in the modal, which also handles T&M re-homing and PDF regeneration.
  const isTypeChangeRequest = Boolean(site.pending_pin_type);
  // Prefer the denormalized scalar names because Supabase Realtime ships
  // the raw `sites` row to subscribers without nested user joins. Fall
  // back to the nested user object for any code path that pre-dates the
  // denorm (and to email if the name happens to be missing).
  const typeChangeRequester = site.pending_change_requested_by_name
    || site.pending_change_requested_by_user?.name
    || site.pending_change_requested_by_user?.email
    || 'Unknown';
  const newPinRequester = site.created_by_name
    || site.created_by_user?.name
    || site.created_by_user?.email
    || 'Unknown';
  return (
    <div className="site-row" onClick={() => onSelectSite?.(site)} style={{ cursor: onSelectSite ? 'pointer' : 'default' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
        <div>
          <strong>{site.lsd || 'Unnamed pin'}</strong>
          <div className="small-text">{pinTypeLabel(site.pin_type)} • {site.client || 'No client'} • {site.area || 'No area'}</div>
          <div className="small-text">Status: {statusLabel(site.status)}</div>
          {!isTypeChangeRequest ? (
            <div className="small-text">Requested by: <strong>{newPinRequester}</strong></div>
          ) : null}
        </div>
        <span className="pending-badge">Pending</span>
      </div>
      {isTypeChangeRequest ? (
        <div className="small-text" style={{ marginTop: '0.35rem', color: '#fbbf24' }}>
          Type change requested by <strong>{typeChangeRequester}</strong> → <strong>{site.pending_pin_type === 'reclaimed' ? 'Reclaimed' : site.pending_pin_type === 'lsd' ? 'LSD' : site.pending_pin_type}</strong>
        </div>
      ) : null}
      <div className="small-text" style={{ marginTop: '0.55rem' }}>
        {site.notes || 'No notes'}
      </div>
      <div className="button-row" style={{ marginTop: '0.75rem' }} onClick={(e) => e.stopPropagation()}>
        <button className="primary-button" type="button" disabled={busy} onClick={() => onApprove(site.id, {})}>
          Approve
        </button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => onApproveAndEdit?.(site)}>
          Approve &amp; Edit
        </button>
        <button className="danger-button" type="button" disabled={busy} onClick={() => onReject(site.id)}>
          Reject
        </button>
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
  // Crew-lead variant: shows ONLY pin-related sections — pending pin /
  // pipeline approvals, the matching Recent Deletes rows (sites, pipelines,
  // lease sheets), and the Tools row (which auto-collapses to just the
  // Check-ins Dashboard button when the office-only handlers are omitted).
  // Hides User Management, Truck Tracking, Lookup Tables, KML imports,
  // Bulk Reset, and the T&M / hydroseed / quote Recent Deletes loops.
  canOnlyManagePins = false,
  pendingSites,
  deletedSites = [],
  clients,
  areas,
  getAreasForClient,
  busy,
  onApprove,
  onReject,
  onApproveAndEdit,
  onBulkApprovePending,
  onBulkRejectPending,
  onBulkReset,
  onImport,
  onRestore,
  onDeletePermanent,
  onSelectSite,
  currentUserEmail,
  devices = [],
  onRefreshDevices,
  // Pipeline props
  pendingPipelines = [],
  onApprovePipeline,
  onRejectPipeline,
  onApprovePipelineAndEdit,
  onImportPipelineKml,
  onBulkResetPipelines,
  onSelectPipeline,
  deletedPipelines = [],
  onRestorePipeline,
  onDeletePipelinePermanent,
  // Deleted lease sheets and T&M tickets
  deletedLeaseSheets = [],
  onRestoreLeaseSheet,
  onDeleteLeaseSheetPermanent,
  deletedTMTickets = [],
  onRestoreTMTicket,
  onDeleteTMTicketPermanent,
  // Soft-deleted hydroseed records — admin-only Recent Deletes section.
  deletedHydroseedDailies = [],
  onRestoreHydroseedDaily,
  onDeleteHydroseedDailyPermanent,
  deletedHydroseedTickets = [],
  onRestoreHydroseedTicket,
  onDeleteHydroseedTicketPermanent,
  onBulkDeleteAllPermanent,
  // Pre-loaded cached data from IndexedDB
  cachedLookups = { herbicides: [], applicators: [], weeds: [], locations: [] },
  onLookupsChanged,
  cachedUsers = [],
  onUsersChanged,
  // Opens the full-page Reports overlay. Admin/office only — button is
  // only rendered when a handler is supplied.
  onOpenReports,
  // Opens the full-page Quote Builder overlay. Same admin/office gating
  // as Reports — only rendered when a handler is supplied.
  onOpenQuotes,
  // Opens the full-page Calendar overlay (tasks/events/bids/contacts).
  // Same admin/office gating as Reports/Quotes — only rendered when a
  // handler is supplied. CalendarOverlay.jsx is lazy-loaded on tap.
  onOpenCalendar,
  // Opens the Check-ins Dashboard (Overview / Active / History /
  // Settings tabs). Admin/office only — workers use the avatar-menu
  // "🛟 Check-ins" item for their own personal page.
  onOpenCheckins,
  // Opens the Operations TV dashboard as a dismissible overlay.
  // Admin/office only — only rendered when a handler is supplied.
  onOpenTvDashboard,
  // Soft-deleted quotes (same Recent Deletes pattern as lease sheets / TM).
  deletedQuotes = [],
  onRestoreQuote,
  onDeleteQuotePermanent,
  onLocateDevice,
}) {
  const { confirm } = useDialog();
  const [file, setFile] = useState(null);
  const [pipelineFile, setPipelineFile] = useState(null);
  const [resetClient, setResetClient] = useState('');
  const [resetArea, setResetArea] = useState('');
  const [pipelineResetClient, setPipelineResetClient] = useState('');
  const [pipelineResetArea, setPipelineResetArea] = useState('');
  const [resetIncludeGrey, setResetIncludeGrey] = useState(false);
  const [pipelineResetIncludeGrey, setPipelineResetIncludeGrey] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importingPipeline, setImportingPipeline] = useState(false);

  const canReset = useMemo(() => Boolean(resetClient || resetArea), [resetClient, resetArea]);
  const pendingApprovalCount = pendingSites.length + pendingPipelines.length;

  if (!visible) {
    return null;
  }

  async function handleImport(event) {
    event.preventDefault();
    if (!file) {
      return;
    }
    setImporting(true);
    try {
      await onImport(file);
      setFile(null);
    } finally {
      setImporting(false);
    }
  }

  async function handleReset(event) {
    event.preventDefault();
    await onBulkReset({ client: resetClient || null, area: resetArea || null, include_grey: resetIncludeGrey });
  }

  async function handleBulkApprovePending() {
    if (pendingApprovalCount === 0) return;
    const label = pendingApprovalCount === 1 ? 'pending approval' : 'pending approvals';
    if (!(await confirm({
      title: 'Approve all pending',
      message: `Approve all ${pendingApprovalCount} ${label}?`,
      okLabel: 'Approve all',
    }))) return;
    await onBulkApprovePending?.();
  }

  async function handleBulkRejectPending() {
    if (pendingApprovalCount === 0) return;
    const label = pendingApprovalCount === 1 ? 'pending approval' : 'pending approvals';
    if (!(await confirm({
      title: 'Reject all pending',
      message: `Reject all ${pendingApprovalCount} ${label}? This cannot be undone for new field-added items.`,
      severity: 'danger',
      okLabel: 'Reject all',
    }))) return;
    await onBulkRejectPending?.();
  }

  // Crew leads only see pin-related Recent Deletes (sites, pipelines,
  // lease sheets). Strip the office-only buckets here so the loops below
  // and the bulk-delete counter both behave correctly even if App.jsx
  // accidentally still passes the arrays.
  if (canOnlyManagePins) {
    deletedTMTickets = [];
    deletedHydroseedDailies = [];
    deletedHydroseedTickets = [];
    deletedQuotes = [];
  }

  // Total count across all Recent-Deletes item types. Drives both
  // the "Delete All Permanently" button's visibility and the numbers
  // shown in the confirmation dialog + helper text.
  const deletedCount =
    deletedSites.length +
    deletedPipelines.length +
    deletedLeaseSheets.length +
    deletedTMTickets.length +
    deletedHydroseedDailies.length +
    deletedHydroseedTickets.length +
    deletedQuotes.length;

  async function handleBulkDeleteAllPermanent() {
    if (deletedCount === 0) return;
    const label = deletedCount === 1 ? 'item' : 'items';
    if (!(await confirm({
      title: 'Delete forever',
      message: `Permanently delete all ${deletedCount} ${label} in Recent Deletes? This cannot be undone.`,
      severity: 'danger',
      okLabel: 'Delete forever',
    }))) return;
    await onBulkDeleteAllPermanent?.();
  }

  return (
    <div className="panel">
      <h2>Admin tools</h2>
      <div className="list-grid">
        <CollapsibleSection title="Pending Approvals" count={pendingApprovalCount} defaultOpen={pendingApprovalCount > 0}>
          <div className="list-grid">
            {pendingApprovalCount === 0 ? (
              <div className="site-row">
                <div className="small-text">No pending approvals right now.</div>
              </div>
            ) : (
              <>
                <div className="site-row">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div>
                      <strong>Bulk actions</strong>
                      <div className="small-text">{pendingApprovalCount} pending item{pendingApprovalCount === 1 ? '' : 's'} ready for review.</div>
                    </div>
                    <div className="button-row">
                      <button className="primary-button" type="button" disabled={busy} onClick={handleBulkApprovePending}>
                        Approve All
                      </button>
                      <button className="danger-button" type="button" disabled={busy} onClick={handleBulkRejectPending}>
                        Reject All
                      </button>
                    </div>
                  </div>
                </div>
                {pendingSites.map((site) => (
                  <PendingSiteCard
                    key={`site-${site.id}`}
                    site={site}
                    busy={busy}
                    onApprove={onApprove}
                    onReject={onReject}
                    onApproveAndEdit={onApproveAndEdit}
                    onSelectSite={onSelectSite}
                  />
                ))}
                {pendingPipelines.map((pipeline) => (
                  <div className="site-row" key={`pipeline-${pipeline.id}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div>
                        <strong>{pipeline.name || 'Unnamed pipeline'}</strong>
                        <div className="small-text">
                          Pipeline • {pipeline.client || 'No client'} • {pipeline.area || 'No area'} • {pipeline.total_length_km?.toFixed(2) || '?'} km
                        </div>
                      </div>
                      <span className="pending-badge">Pending</span>
                    </div>
                    <div className="button-row" style={{ marginTop: '0.75rem' }}>
                      <button className="primary-button" type="button" disabled={busy}
                        onClick={() => onApprovePipeline?.(pipeline.id, { approval_state: 'approved' })}>
                        Approve
                      </button>
                      <button className="secondary-button" type="button" disabled={busy}
                        onClick={() => onApprovePipelineAndEdit?.(pipeline)}>
                        Approve &amp; Edit
                      </button>
                      <button className="danger-button" type="button" disabled={busy}
                        onClick={() => onRejectPipeline?.(pipeline.id)}>
                        Reject
                      </button>
                      {onSelectPipeline && (
                        <button className="secondary-button" type="button"
                          onClick={() => onSelectPipeline(pipeline)}>
                          View
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Recent Deletes" count={deletedCount} defaultOpen={false}>
          <div className="list-grid">
            {deletedCount === 0 ? (
              <div className="site-row">
                <div className="small-text">No deleted items.</div>
              </div>
            ) : (
              <>
                {/* Bulk-actions card mirroring the Pending section's
                    "Approve All / Reject All" row so admins can empty
                    the recycle bin in one action when the list has
                    accumulated obvious-to-purge items. Hidden for
                    crew leads — irreversible bulk delete stays an
                    office/admin tool. */}
                {!canOnlyManagePins ? (
                  <div className="site-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <div>
                        <strong>Bulk actions</strong>
                        <div className="small-text">{deletedCount} deleted item{deletedCount === 1 ? '' : 's'} can be permanently removed.</div>
                      </div>
                      <div className="button-row">
                        <button className="danger-button" type="button" disabled={busy} onClick={handleBulkDeleteAllPermanent}>
                          Delete All Permanently
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
                {deletedSites.map((site) => (
                  <div className="site-row" key={`site-${site.id}`}>
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
                        Delete Forever
                      </button>
                    </div>
                  </div>
                ))}
                {deletedPipelines.map((pipeline) => (
                  <div className="site-row" key={`pipeline-${pipeline.id}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div>
                        <strong>{pipeline.name || 'Unnamed pipeline'}</strong>
                        <div className="small-text">
                          Pipeline • {pipeline.client || 'No client'} • {pipeline.area || 'No area'} • {pipeline.total_length_km?.toFixed(2) || '?'} km
                        </div>
                      </div>
                      <span className="pending-badge" style={{ background: '#64748b' }}>Deleted</span>
                    </div>
                    <div className="button-row" style={{ marginTop: '0.75rem' }}>
                      <button className="primary-button" type="button" disabled={busy} onClick={() => onRestorePipeline?.(pipeline.id)}>
                        Restore
                      </button>
                      <button className="danger-button" type="button" disabled={busy} onClick={async () => {
                        if (await confirm({
                          title: 'Delete forever',
                          message: `Permanently delete "${pipeline.name || 'Unnamed pipeline'}"? This cannot be undone.`,
                          severity: 'danger',
                          okLabel: 'Delete forever',
                        })) {
                          onDeletePipelinePermanent?.(pipeline.id);
                        }
                      }} style={{ marginLeft: '0.5rem' }}>
                        Delete Forever
                      </button>
                    </div>
                  </div>
                ))}
                {deletedLeaseSheets.map((record) => (
                  <div className="site-row" key={`lease-${record.id}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div>
                        <strong>{record.ticket_number || 'No Ticket'}</strong>
                        <div className="small-text">
                          Lease Sheet • {record.spray_date} • {record.sprayed_by_name || 'Unknown'}
                        </div>
                        <div className="small-text" style={{ color: '#9ca3af' }}>
                          {record.site_lsd || record.site_client || record.site_area || ''}
                        </div>
                      </div>
                      <span className="pending-badge" style={{ background: '#64748b' }}>Deleted</span>
                    </div>
                    <div className="button-row" style={{ marginTop: '0.75rem' }}>
                      <button className="primary-button" type="button" disabled={busy} onClick={() => onRestoreLeaseSheet?.(record)}>
                        Restore
                      </button>
                      <button className="danger-button" type="button" disabled={busy} onClick={async () => {
                        if (await confirm({
                          title: 'Delete forever',
                          message: `Permanently delete lease sheet "${record.ticket_number || ''}"? This cannot be undone.`,
                          severity: 'danger',
                          okLabel: 'Delete forever',
                        })) {
                          onDeleteLeaseSheetPermanent?.(record);
                        }
                      }} style={{ marginLeft: '0.5rem' }}>
                        Delete Forever
                      </button>
                    </div>
                  </div>
                ))}
                {deletedTMTickets.map((ticket) => (
                  <div className="site-row" key={`tm-${ticket.id}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div>
                        <strong>{ticket.ticket_number || 'No Ticket'}</strong>
                        <div className="small-text">
                          T&M Ticket • {ticket.spray_date} • {ticket.client || 'No client'} / {ticket.area || 'No area'}
                        </div>
                        <div className="small-text" style={{ color: '#9ca3af' }}>
                          {ticket.description_of_work || 'No description'}
                        </div>
                      </div>
                      <span className="pending-badge" style={{ background: '#64748b' }}>Deleted</span>
                    </div>
                    <div className="button-row" style={{ marginTop: '0.75rem' }}>
                      <button className="primary-button" type="button" disabled={busy} onClick={() => onRestoreTMTicket?.(ticket.id)}>
                        Restore
                      </button>
                      <button className="danger-button" type="button" disabled={busy} onClick={async () => {
                        if (await confirm({
                          title: 'Delete forever',
                          message: `Permanently delete T&M ticket "${ticket.ticket_number || ''}"? This cannot be undone.`,
                          severity: 'danger',
                          okLabel: 'Delete forever',
                        })) {
                          onDeleteTMTicketPermanent?.(ticket.id);
                        }
                      }} style={{ marginLeft: '0.5rem' }}>
                        Delete Forever
                      </button>
                    </div>
                  </div>
                ))}
                {deletedHydroseedDailies.map((daily) => (
                  <div className="site-row" key={`hyd-daily-${daily.id}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div>
                        <strong>💧 {daily.record_number || 'No Record'}</strong>
                        <div className="small-text">
                          Hydroseed Daily • {daily.work_date} • {daily.client || 'No client'} / {daily.area || 'No area'}
                        </div>
                        <div className="small-text" style={{ color: '#9ca3af' }}>
                          {daily.site_name || daily.description_of_work || ''}
                        </div>
                      </div>
                      <span className="pending-badge" style={{ background: '#64748b' }}>Deleted</span>
                    </div>
                    <div className="button-row" style={{ marginTop: '0.75rem' }}>
                      <button className="primary-button" type="button" disabled={busy} onClick={() => onRestoreHydroseedDaily?.(daily.id)}>
                        Restore
                      </button>
                      <button className="danger-button" type="button" disabled={busy} onClick={async () => {
                        if (await confirm({
                          title: 'Delete forever',
                          message: `Permanently delete hydroseed daily "${daily.record_number || ''}"? This cannot be undone.`,
                          severity: 'danger',
                          okLabel: 'Delete forever',
                        })) {
                          onDeleteHydroseedDailyPermanent?.(daily.id);
                        }
                      }} style={{ marginLeft: '0.5rem' }}>
                        Delete Forever
                      </button>
                    </div>
                  </div>
                ))}
                {deletedHydroseedTickets.map((ticket) => (
                  <div className="site-row" key={`hyd-ticket-${ticket.id}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div>
                        <strong>💧 {ticket.ticket_number || 'No Ticket'}</strong>
                        <div className="small-text">
                          Hydroseed Ticket • {ticket.work_date} • {ticket.client || 'No client'} / {ticket.area || 'No area'}
                        </div>
                        <div className="small-text" style={{ color: '#9ca3af' }}>
                          {ticket.description_of_work || ''}
                        </div>
                      </div>
                      <span className="pending-badge" style={{ background: '#64748b' }}>Deleted</span>
                    </div>
                    <div className="button-row" style={{ marginTop: '0.75rem' }}>
                      <button className="primary-button" type="button" disabled={busy} onClick={() => onRestoreHydroseedTicket?.(ticket.id)}>
                        Restore
                      </button>
                      <button className="danger-button" type="button" disabled={busy} onClick={async () => {
                        if (await confirm({
                          title: 'Delete forever',
                          message: `Permanently delete hydroseed ticket "${ticket.ticket_number || ''}"? This cannot be undone.`,
                          severity: 'danger',
                          okLabel: 'Delete forever',
                        })) {
                          onDeleteHydroseedTicketPermanent?.(ticket.id);
                        }
                      }} style={{ marginLeft: '0.5rem' }}>
                        Delete Forever
                      </button>
                    </div>
                  </div>
                ))}
                {deletedQuotes.map((quote) => (
                  <div className="site-row" key={`quote-${quote.id}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div>
                        <strong>{quote.quote_number || 'No Quote'}</strong>
                        <div className="small-text">
                          Quote • {quote.quote_date} • {quote.client || 'No client'}{quote.area ? ` / ${quote.area}` : ''}
                        </div>
                        <div className="small-text" style={{ color: '#9ca3af' }}>
                          Grand total: ${Number(quote.grand_total ?? 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                      </div>
                      <span className="pending-badge" style={{ background: '#64748b' }}>Deleted</span>
                    </div>
                    <div className="button-row" style={{ marginTop: '0.75rem' }}>
                      <button className="primary-button" type="button" disabled={busy} onClick={() => onRestoreQuote?.(quote.id)}>
                        Restore
                      </button>
                      <button className="danger-button" type="button" disabled={busy} onClick={async () => {
                        if (await confirm({
                          title: 'Delete forever',
                          message: `Permanently delete quote "${quote.quote_number || ''}"? This cannot be undone.`,
                          severity: 'danger',
                          okLabel: 'Delete forever',
                        })) {
                          onDeleteQuotePermanent?.(quote.id);
                        }
                      }} style={{ marginLeft: '0.5rem' }}>
                        Delete Forever
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </CollapsibleSection>

        {/* Visible to admin/office AND crew_lead ("field lead") — unlike
            the rest of User Management below, inviting a client is
            explicitly something a field lead should be able to do. The
            list of existing client accounts (with revoke/reset) still
            lives in the admin/office-only User Management section. */}
        <CollapsibleSection title="Invite a Client" defaultOpen={false}>
          <InviteClientPanel clients={clients} getAreasForClient={getAreasForClient} />
        </CollapsibleSection>

        {/* The five sections below (KML import, Bulk Reset, User
            Management, Truck Tracking, Lookup Tables) are office/admin
            tooling. Crew leads only see pin-management + Recent Deletes
            (sites/pipelines/lease sheets) + the Tools row's Check-ins
            Dashboard entry. */}
        {!canOnlyManagePins ? (<>
        <CollapsibleSection title="Import KML" defaultOpen={false}>
          <div className="list-grid">
            <div className="small-text" style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Sites KML</div>
            <form onSubmit={handleImport} className="list-grid">
              <input type="file" accept=".kml" onChange={(event) => setFile(event.target.files?.[0] || null)} disabled={importing} />
              <button className="primary-button" type="submit" disabled={!file || busy || importing}>
                {importing ? 'Importing...' : 'Import Sites KML'}
              </button>
              {importing && (
                <div className="small-text" style={{ textAlign: 'center', marginTop: '0.5rem', color: '#6b7280' }}>
                  Uploading and processing KML file...
                </div>
              )}
            </form>
            <div style={{ borderTop: '1px solid rgba(143,182,255,0.1)', margin: '0.5rem 0' }} />
            <div className="small-text" style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Pipeline KML/KMZ</div>
            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!pipelineFile || !onImportPipelineKml) return;
              setImportingPipeline(true);
              try {
                await onImportPipelineKml(pipelineFile);
                setPipelineFile(null);
              } finally {
                setImportingPipeline(false);
              }
            }} className="list-grid">
              <input type="file" accept=".kml,.kmz" onChange={(event) => setPipelineFile(event.target.files?.[0] || null)} disabled={importingPipeline} />
              <button className="primary-button" type="submit" disabled={!pipelineFile || busy || importingPipeline}>
                {importingPipeline ? 'Importing...' : 'Import Pipeline KML/KMZ'}
              </button>
              {importingPipeline && (
                <div className="small-text" style={{ textAlign: 'center', marginTop: '0.5rem', color: '#6b7280' }}>
                  Uploading and processing pipeline file...
                </div>
              )}
            </form>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Bulk Reset" defaultOpen={false}>
          <div className="list-grid">
            <div className="small-text" style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Reset Sites</div>
            <form onSubmit={handleReset} className="list-grid">
              <select value={resetClient} onChange={(event) => setResetClient(event.target.value)}>
                <option value="">Select client</option>
                {clients.map((client) => (
                  <option key={client} value={client}>{client}</option>
                ))}
              </select>
              <select value={resetArea} onChange={(event) => setResetArea(event.target.value)}>
                <option value="">Select area</option>
                {areas.map((area) => (
                  <option key={area} value={area}>{area}</option>
                ))}
              </select>
              <label className="small-text" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <input
                  type="checkbox"
                  checked={resetIncludeGrey}
                  onChange={(event) => setResetIncludeGrey(event.target.checked)}
                />
                Also reset grey (issue) pins
              </label>
              <button className="secondary-button" type="submit" disabled={!canReset || busy}>
                Reset Sites to Not Inspected
              </button>
            </form>
            <div style={{ borderTop: '1px solid rgba(143,182,255,0.1)', margin: '0.5rem 0' }} />
            <div className="small-text" style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Reset Pipelines</div>
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!pipelineResetClient && !pipelineResetArea) return;
              onBulkResetPipelines?.({ client: pipelineResetClient || null, area: pipelineResetArea || null, include_grey: pipelineResetIncludeGrey });
            }} className="list-grid">
              <select value={pipelineResetClient} onChange={(event) => setPipelineResetClient(event.target.value)}>
                <option value="">Select client</option>
                {clients.map((client) => (
                  <option key={client} value={client}>{client}</option>
                ))}
              </select>
              <select value={pipelineResetArea} onChange={(event) => setPipelineResetArea(event.target.value)}>
                <option value="">Select area</option>
                {areas.map((area) => (
                  <option key={area} value={area}>{area}</option>
                ))}
              </select>
              <label className="small-text" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <input
                  type="checkbox"
                  checked={pipelineResetIncludeGrey}
                  onChange={(event) => setPipelineResetIncludeGrey(event.target.checked)}
                />
                Also reset grey (issue) pipelines
              </label>
              <button className="secondary-button" type="submit" disabled={(!pipelineResetClient && !pipelineResetArea) || busy}>
                Reset Pipelines to Not Sprayed
              </button>
            </form>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="User Management" defaultOpen={false}>
          <UserManagementPanel
            busy={busy}
            currentUserEmail={currentUserEmail}
            cachedUsers={cachedUsers}
            onUsersChanged={onUsersChanged}
            clients={clients}
            getAreasForClient={getAreasForClient}
          />
        </CollapsibleSection>

        {/* Truck Tracking sits next to User Management because device admin
            (register iPad, assign driver, rotate token) is conceptually a
            people/fleet operation rather than a data-import or pin-management
            one. DeviceAdmin renders using the passed real-time devices list. */}
        <CollapsibleSection title="Truck Tracking (iPads)" defaultOpen={false}>
          <DeviceAdmin busy={busy} devices={devices} onRefreshDevices={onRefreshDevices} onLocateDevice={onLocateDevice} />
        </CollapsibleSection>

        <CollapsibleSection title="Lookup Tables" defaultOpen={false}>
          <LookupManager cachedLookups={cachedLookups} onLookupsChanged={onLookupsChanged} />
        </CollapsibleSection>
        </>) : null}

        {/* Tools row — Reports / Quotes / Calendar collapsed into a single
            compact site-row to save vertical space. All three are admin/
            office-only and lazy-load their target overlay on tap. The
            tooltips on each button preserve the long-form descriptions
            that previously lived in dedicated cards. */}
        {(onOpenReports || onOpenQuotes || onOpenCalendar || onOpenCheckins || onOpenTvDashboard) ? (
          <div className="site-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <strong style={{ marginRight: '0.25rem' }}>Tools</strong>
            {onOpenReports ? (
              <button
                className="secondary-button"
                type="button"
                onClick={onOpenReports}
                title="Generate custom CSV reports — daily, weekly, or annual."
              >
                📊 Reports
              </button>
            ) : null}
            {onOpenQuotes ? (
              <button
                className="secondary-button"
                type="button"
                onClick={onOpenQuotes}
                title="Build quotes from the 2026 rate catalog — Hydroseeding, Herbicide, Drone."
              >
                📝 Quotes
              </button>
            ) : null}
            {onOpenCheckins ? (
              <button
                className="secondary-button"
                type="button"
                onClick={onOpenCheckins}
                title="Live worker check-in dashboard — Overview, Active, History, and Settings (recipient list)."
              >
                🛟 Check-ins Dashboard
              </button>
            ) : null}
            {onOpenTvDashboard ? (
              <button
                className="secondary-button"
                type="button"
                onClick={onOpenTvDashboard}
                title="Operations TV — full-screen office overview: live check-ins, site inspection progress, and today's throughput. Closeable."
              >
                📺 Operations TV
              </button>
            ) : null}
            {onOpenCalendar ? (
              <button
                className="secondary-button"
                type="button"
                onClick={onOpenCalendar}
                title="Daily tasks, contacts, upcoming events, and bid postings."
              >
                📅 Calendar
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
