import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { getLeaseSheetDrafts, deleteLeaseSheetDraft } from '../lib/offlineStore';

/**
 * The Forms panel replaces the old Recents panel.
 *
 * Three top-level sub-tabs:
 *   1. Forms            — launcher for form templates
 *   2. In Progress      — 3 sub-sub-tab buttons: Uploading / Open Tickets / Drafts
 *   3. Recently Submitted — list of pending/approved lease sheets (+ T&M tickets)
 */

const SUB_FORMS = 'forms';
const SUB_IN_PROGRESS = 'in_progress';
const SUB_RECENTS = 'recents';

const IP_UPLOADING = 'uploading';
const IP_OPEN = 'open';
const IP_DRAFTS = 'drafts';

const REC_ALL = 'all';
const REC_LEASE = 'lease';
const REC_TM = 'tm';

// Office-only status filter inside the T&M tab of Recently Submitted.
// Workers don't see these buttons (they just see everything that isn't open).
const TM_STATUS_ALL = 'all';
const TM_STATUS_SUBMITTED = 'submitted';
const TM_STATUS_APPROVED = 'approved';

// Format an ISO timestamp as a short, worker-friendly "submitted on" label
// used in the Recently Submitted list. Falls back to an em dash when the
// incoming value is missing or invalid so rows never render "Invalid Date".
//
// NOTE on timezones: the backend stores timestamps as naive UTC
// (datetime.utcnow()). Pydantic serializes them WITHOUT a trailing 'Z',
// so JS's Date() would parse them as LOCAL time — displaying the UTC hour
// as if it were local, which was off by the UTC offset (e.g. 7h in PDT).
// Force UTC parsing by appending 'Z' when no timezone designator is present,
// then toLocaleString() converts back to the user's local time correctly.
function formatSubmittedAt(iso) {
  if (!iso) return '—';
  const s = String(iso);
  // If the string has no timezone suffix (Z or ±HH:MM), treat it as UTC.
  const hasTz = /Z|[+-]\d{2}:?\d{2}$/.test(s);
  const d = new Date(hasTz ? s : `${s}Z`);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ── Row renderers ──
// Lifted to module scope so they can be shared between the per-type tabs
// (Lease / T&M) and the merged "All" tab, without inlining the same JSX
// in three places. Returns a plain element — no hook usage inside.
function renderLeaseRow(record, onViewPdf, onEditRecord) {
  return (
    <div key={`ls-${record.id}`} className="site-row" style={{ padding: '10px', borderRadius: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="small-text" style={{ fontWeight: 700, fontSize: '0.85rem' }}>
            {record.ticket_number || 'No Ticket'}  <span style={{ color: '#22c55e', fontWeight: 500 }}>Lease</span>
          </div>
          <div className="small-text" style={{ marginTop: '2px' }}>
            {record.spray_date} • {record.sprayed_by_name || 'Unknown'}
          </div>
          <div className="small-text" style={{ color: '#9ca3af', marginTop: '2px' }}>
            {record.site_lsd || ''} • {record.site_client || ''} • {record.site_area || ''}
          </div>
          <div className="small-text" style={{ color: '#6b7280', marginTop: '2px', fontSize: '0.75rem' }}>
            Submitted: {formatSubmittedAt(record.created_at)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexShrink: 0, marginLeft: '8px' }}>
          {record.pdf_url && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => onViewPdf?.(record)}
              style={{ padding: '4px 10px', fontSize: '0.75rem' }}
            >
              📄 View
            </button>
          )}
          {/* Edit is only wired for site-sourced lease sheets. Pipeline-sourced
              rows (site_id === null) use a different update endpoint that
              this panel doesn't know how to drive — hide the button to avoid
              hitting /api/site-spray-records with a pipeline record id. */}
          {record.site_id != null && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => onEditRecord?.(record)}
              style={{ padding: '4px 10px', fontSize: '0.75rem' }}
            >
              ✏️ Edit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function renderTmRow(t, onOpenTMTicket) {
  return (
    <div key={`tm-${t.id}`} className="site-row" style={{ padding: '10px', borderRadius: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="small-text" style={{ fontWeight: 700, fontSize: '0.85rem' }}>
            {t.ticket_number}  <span style={{ color: '#8b5cf6', fontWeight: 500 }}>T&M</span>
            {t.status === 'approved' ? <span style={{ color: '#22c55e', marginLeft: '6px' }}>✓</span> : null}
          </div>
          <div className="small-text" style={{ marginTop: '2px' }}>
            {t.spray_date} • {t.created_by_name || 'Unknown'}
          </div>
          <div className="small-text" style={{ color: '#9ca3af', marginTop: '2px' }}>
            {t.client} / {t.area} • {(t.rows?.length || 0)} row(s)
          </div>
          <div className="small-text" style={{ color: '#6b7280', marginTop: '2px', fontSize: '0.75rem' }}>
            Submitted: {formatSubmittedAt(t.submitted_at || t.updated_at || t.created_at)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexShrink: 0, marginLeft: '8px' }}>
          <button
            className="secondary-button"
            type="button"
            onClick={() => onOpenTMTicket?.(t.id)}
            style={{ padding: '4px 10px', fontSize: '0.75rem' }}
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FormsPanel({
  visible,
  cachedRecents = [],
  uploadQueue = [],
  clients = [],          // shared global client list from the map's pins
  areas = [],            // shared global area list from the map's pins
  onViewPdf,
  onEditRecord,
  onStartLeaseSheetFromDraft,
  onStartNewTMTicket,    // called with ({ client, area, spray_date, description_of_work })
  onOpenTMTicket,
  onRequestDraftsRefresh,    // parent can trigger a refresh when form closes
  // Fire-and-forget "hey parent, run a delta sync now". Used when the user
  // opens Recently Submitted so the lease sheet list (sourced from App's
  // `cachedRecents`) catches up in real time instead of waiting for the
  // next 5-minute poll tick. Cheap: hits /api/sync-status first and only
  // fetches deltas for resources that actually changed.
  onRequestSync,
  draftsRefreshToken = 0,    // bump to trigger reload
  // Bumped by App's poll loop when sync-status reports T&M tickets changed.
  // We wire it into the open / submitted ticket effects so the lists refresh
  // automatically without a page reload — egress stays near zero in the
  // steady state because sync-status only ships a MAX(updated_at) timestamp.
  tmRefreshToken = 0,
  roleCanAdmin = false,
  // When true, the user is an admin/office pretending to be a worker.
  // We filter the recently-submitted + open-ticket lists down to records
  // they themselves created, mirroring the backend's worker visibility
  // rule (which matches by created_by_name when user_id is null, or by
  // user_id normally \u2014 we can only see created_by_name on the frontend,
  // so name-matching is used here too).
  viewAsWorker = false,
  currentUserName = '',
}) {
  const [subTab, setSubTab] = useState(SUB_FORMS);
  const [ipTab, setIpTab] = useState(IP_UPLOADING);
  const [recTab, setRecTab] = useState(REC_ALL);
  // Office-only filter inside the T&M tab: all vs submitted vs approved.
  // Default "all" so the tab matches what office used to see before this
  // split; they can narrow to "submitted" to triage pending approvals.
  const [tmStatusFilter, setTmStatusFilter] = useState(TM_STATUS_ALL);

  // Unified T&M tickets cache used by BOTH the Open Tickets (In Progress)
  // list and the Recently Submitted (Recents) list. The first load pulls
  // the full list via /api/time-materials; every subsequent refresh (tab
  // switch or tmRefreshToken bump) goes through /api/time-materials/delta
  // using `tmTicketsSinceRef.current` as the watermark, so we only ship
  // rows that actually changed — soft-deleted IDs come back in the
  // delta's `ids_removed` and get pruned locally.
  const [tmTickets, setTmTickets] = useState([]);
  const tmTicketsSinceRef = useRef(null);
  const tmSyncingRef = useRef(false);
  const [drafts, setDrafts] = useState([]);

  // Derived views over the unified cache.
  const openTickets = useMemo(
    () => tmTickets.filter((t) => t.status === 'open'),
    [tmTickets],
  );
  // Alias kept so the existing `filteredTm`/recents code doesn't need to
  // be renamed. It's just the same underlying list — the filter that
  // strips `status === 'open'` lives inside `filteredTm` itself.
  const tmSubmitted = tmTickets;

  // "New T&M ticket" modal
  const [newTMOpen, setNewTMOpen] = useState(false);
  const [newTMDate, setNewTMDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [newTMClient, setNewTMClient] = useState('');
  const [newTMArea, setNewTMArea] = useState('');
  const [newTMDesc, setNewTMDesc] = useState('');
  const [newTMBusy, setNewTMBusy] = useState(false);

  // Debounced search
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Pagination: show 20 per list, "Load more" reveals +20. Reset when search changes
  // or when the user navigates between tabs to keep the UX predictable.
  const PAGE_SIZE = 20;
  const [leaseCount, setLeaseCount] = useState(PAGE_SIZE);
  const [tmCount, setTmCount] = useState(PAGE_SIZE);
  // The "All" tab gets its own count so paging through a merged list
  // doesn't fight with the per-type counts behind the scenes.
  const [allCount, setAllCount] = useState(PAGE_SIZE);
  const [openCount, setOpenCount] = useState(PAGE_SIZE);
  useEffect(() => { setLeaseCount(PAGE_SIZE); setTmCount(PAGE_SIZE); setAllCount(PAGE_SIZE); }, [search]);
  useEffect(() => { setAllCount(PAGE_SIZE); }, [recTab]);
  useEffect(() => { setOpenCount(PAGE_SIZE); }, [ipTab]);
  // Resetting tmCount when the office toggles its status filter keeps the
  // "Load more" count honest against the filtered list.
  useEffect(() => { setTmCount(PAGE_SIZE); setAllCount(PAGE_SIZE); }, [tmStatusFilter]);

  // Unified T&M sync — replaces the two prior fetch effects. Runs while the
  // FormsPanel is visible AND the user is on a sub-tab that actually needs
  // ticket data (In Progress, or Recently Submitted with recTab !== Lease).
  //
  // First call of a session: full `api.listTMTickets({})` fetch. Seeds
  // the local cache AND the watermark so subsequent ticks go through
  // `api.tmTicketsDelta(since)` instead — that endpoint ships only rows
  // whose `updated_at > since`, plus `ids_removed` for soft-deleted
  // tickets, cutting egress to near-zero when nothing has changed.
  //
  // Triggered by: visible/subTab/recTab (user navigation) and tmRefreshToken
  // (App's poll loop saw `tm_tickets_last_updated` bump in sync-status).
  useEffect(() => {
    if (!visible) return;
    const onInProgress = subTab === SUB_IN_PROGRESS;
    const onRecentsTm = subTab === SUB_RECENTS && recTab !== REC_LEASE;
    if (!onInProgress && !onRecentsTm) return;
    // Guard against overlapping runs when multiple deps change in the same
    // tick (e.g. tab switch + token bump). The in-flight request completes
    // and commits before we fire another.
    if (tmSyncingRef.current) return;

    let cancelled = false;
    tmSyncingRef.current = true;
    (async () => {
      try {
        const since = tmTicketsSinceRef.current;
        if (!since) {
          // Cold start — full list. Seeds both state and the watermark so
          // the NEXT call can take the delta path. We use the current wall
          // clock as the watermark rather than a per-row max(updated_at):
          // simpler, and any race with a row written mid-request is caught
          // by the next delta tick anyway (updated_at > since still holds).
          const list = await api.listTMTickets({});
          if (cancelled) return;
          setTmTickets(list || []);
          tmTicketsSinceRef.current = new Date().toISOString();
        } else {
          // Delta — merges new/updated rows and prunes soft-deleted ones.
          const delta = await api.tmTicketsDelta(since);
          if (cancelled) return;
          const items = Array.isArray(delta?.items) ? delta.items : [];
          const idsRemoved = Array.isArray(delta?.ids_removed) ? delta.ids_removed : [];
          if (items.length > 0 || idsRemoved.length > 0) {
            setTmTickets((prev) => {
              const byId = new Map(prev.map((t) => [t.id, t]));
              for (const it of items) byId.set(it.id, it);
              for (const id of idsRemoved) byId.delete(id);
              return Array.from(byId.values());
            });
          }
          // Advance the watermark. Server sends `server_time` captured
          // BEFORE its query so nothing can slip through on the next tick.
          tmTicketsSinceRef.current = delta?.server_time || tmTicketsSinceRef.current;
        }
      } catch (e) {
        console.warn('[FORMS] TM tickets sync failed:', e.message);
        // Leave the watermark alone so the next tick retries the same range.
      } finally {
        tmSyncingRef.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [visible, subTab, recTab, tmRefreshToken]);

  // When the user opens Recently Submitted, ask the parent to run an
  // immediate delta sync. This catches up `cachedRecents` (lease sheets)
  // and T&M tickets without waiting for the normal 5-minute poll cycle —
  // so a sheet a teammate uploaded a minute ago shows up the instant the
  // tab is opened. Cheap: sync-status is ~100B and only the resources
  // that actually changed get their delta pulled.
  useEffect(() => {
    if (!visible) return;
    if (subTab !== SUB_RECENTS) return;
    try { onRequestSync?.(); } catch { /* non-fatal */ }
  }, [visible, subTab, onRequestSync]);

  // Load drafts when In Progress → Drafts tab is shown (or refresh token bumps)
  useEffect(() => {
    if (!visible) return;
    if (subTab !== SUB_IN_PROGRESS || ipTab !== IP_DRAFTS) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await getLeaseSheetDrafts();
        if (!cancelled) setDrafts(list || []);
      } catch (e) {
        console.warn('[FORMS] getLeaseSheetDrafts failed:', e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, subTab, ipTab, draftsRefreshToken]);

  // Sort helper: newest first by created_at (fall back to id for stable ordering).
  const byNewest = (a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return (b.id || 0) - (a.id || 0);
  };

  // Filtered + sorted lease sheet recents
  const filteredLease = useMemo(() => {
    let base = [...cachedRecents].sort(byNewest);
    // View-as-worker: admin/office are impersonating a worker, so the
    // recents list should only include sheets THEY sprayed \u2014 matches
    // what a real worker sees. Backend still returned everyone's, so we
    // narrow here.
    if (viewAsWorker && currentUserName) {
      base = base.filter((r) => (r.sprayed_by_name || '') === currentUserName);
    }
    if (!search) return base;
    const q = search.toLowerCase();
    return base.filter((r) =>
      (r.ticket_number || '').toLowerCase().includes(q) ||
      (r.site_client || '').toLowerCase().includes(q) ||
      (r.site_area || '').toLowerCase().includes(q) ||
      (r.site_lsd || '').toLowerCase().includes(q) ||
      (r.sprayed_by_name || '').toLowerCase().includes(q)
    );
  }, [cachedRecents, search, viewAsWorker, currentUserName]);

  const filteredTm = useMemo(() => {
    // Recently Submitted should NEVER include status=open tickets — those
    // haven't been handed off to office yet and still belong in the worker's
    // "In Progress → Open Tickets" list.
    let base = tmSubmitted.filter((t) => t.status !== 'open');

    // View-as-worker: narrow to tickets THIS user created, same as the
    // real worker visibility rule in the backend's _visible_query.
    if (viewAsWorker && currentUserName) {
      base = base.filter((t) => (t.created_by_name || '') === currentUserName);
    }

    // Office/admin status filter: all | submitted | approved. Workers just
    // see everything non-open (they don't get the filter buttons at all).
    // In view-as-worker mode roleCanAdmin is false, so this branch skips
    // naturally — admin-impersonating-worker sees the unfiltered feed.
    if (roleCanAdmin) {
      if (tmStatusFilter === TM_STATUS_SUBMITTED) {
        base = base.filter((t) => t.status === 'submitted');
      } else if (tmStatusFilter === TM_STATUS_APPROVED) {
        base = base.filter((t) => t.status === 'approved');
      }
    }

    base = [...base].sort(byNewest);
    if (!search) return base;
    const q = search.toLowerCase();
    return base.filter((t) =>
      (t.ticket_number || '').toLowerCase().includes(q) ||
      (t.client || '').toLowerCase().includes(q) ||
      (t.area || '').toLowerCase().includes(q) ||
      (t.created_by_name || '').toLowerCase().includes(q)
    );
  }, [tmSubmitted, search, tmStatusFilter, roleCanAdmin, viewAsWorker, currentUserName]);

  // Open T&M tickets — the /open endpoint already scopes to the caller's
  // own tickets regardless of role (see list_open_tickets in
  // time_materials_routes.py), so this list is already "mine only". But
  // the main list endpoint used elsewhere is NOT, so we still apply the
  // view-as-worker narrowing here defensively in case the data source
  // ever changes.
  const sortedOpenTickets = useMemo(() => {
    let base = [...openTickets];
    if (viewAsWorker && currentUserName) {
      base = base.filter((t) => (t.created_by_name || '') === currentUserName);
    }
    return base.sort(byNewest);
  }, [openTickets, viewAsWorker, currentUserName]);

  // Merged "All" feed: lease sheets + T&M tickets interleaved by created_at desc.
  // Each row keeps its native shape and gets a `_type` tag so the render
  // pass can pick the right card. Re-uses the same `search` filter logic.
  const filteredAll = useMemo(() => {
    const combined = [
      ...filteredLease.map((r) => ({ ...r, _type: 'lease' })),
      ...filteredTm.map((t) => ({ ...t, _type: 'tm' })),
    ];
    return combined.sort(byNewest);
  }, [filteredLease, filteredTm]);

  // Paginated views
  const visibleLease = useMemo(() => filteredLease.slice(0, leaseCount), [filteredLease, leaseCount]);
  const visibleTm = useMemo(() => filteredTm.slice(0, tmCount), [filteredTm, tmCount]);
  const visibleAll = useMemo(() => filteredAll.slice(0, allCount), [filteredAll, allCount]);
  const visibleOpen = useMemo(() => sortedOpenTickets.slice(0, openCount), [sortedOpenTickets, openCount]);

  if (!visible) return null;

  // Shared sub-tab button styles
  const subBtn = (active) => ({
    flex: 1,
    padding: '10px',
    backgroundColor: active ? '#3b82f6' : '#111827',
    color: active ? 'white' : '#9ca3af',
    border: '1px solid #374151',
    borderRadius: '8px',
    fontSize: '0.85rem',
    fontWeight: 600,
    cursor: 'pointer',
  });

  const innerBtn = (active) => ({
    flex: 1,
    padding: '8px',
    backgroundColor: active ? '#1e40af' : 'transparent',
    color: active ? 'white' : '#9ca3af',
    border: '1px solid #374151',
    borderRadius: '6px',
    fontSize: '0.8rem',
    fontWeight: 500,
    cursor: 'pointer',
  });

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Top sub-tabs */}
      <div style={{ display: 'flex', gap: '6px' }}>
        <button style={subBtn(subTab === SUB_FORMS)} onClick={() => setSubTab(SUB_FORMS)}>Forms</button>
        <button style={subBtn(subTab === SUB_IN_PROGRESS)} onClick={() => setSubTab(SUB_IN_PROGRESS)}>In Progress</button>
        <button style={subBtn(subTab === SUB_RECENTS)} onClick={() => setSubTab(SUB_RECENTS)}>Recently Submitted</button>
      </div>

      {/* ── Forms sub-tab ── */}
      {subTab === SUB_FORMS && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Start a Form</h3>

          <div
            role="button"
            onClick={() => onStartLeaseSheetFromDraft?.(null)}
            style={{
              padding: '14px',
              background: '#111827',
              border: '1px solid #374151',
              borderRadius: '8px',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>🌿 Herbicide Lease Sheet</div>
              <div className="small-text" style={{ color: '#9ca3af', marginTop: '2px' }}>
                Select a site from the Map tab first, then tap "Mark as sprayed".
              </div>
            </div>
            <span style={{ color: '#3b82f6' }}>›</span>
          </div>

          <div
            role="button"
            onClick={() => {
              setNewTMDate(new Date().toISOString().split('T')[0]);
              setNewTMClient('');
              setNewTMArea('');
              setNewTMDesc('');
              setNewTMOpen(true);
            }}
            style={{
              padding: '14px',
              background: '#111827',
              border: '1px solid #374151',
              borderRadius: '8px',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>🧾 Time and Materials Ticket</div>
              <div className="small-text" style={{ color: '#9ca3af', marginTop: '2px' }}>
                Start a new T&M ticket manually (or open one from In Progress).
              </div>
            </div>
            <span style={{ color: '#3b82f6' }}>›</span>
          </div>

          {/* Coming soon placeholders */}
          {['Hydroseeding Ticket', 'JSA', 'Equipment Work Ticket'].map((label) => (
            <div
              key={label}
              style={{
                padding: '14px',
                background: '#0b1220',
                border: '1px dashed #374151',
                borderRadius: '8px',
                opacity: 0.55,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{label}</div>
              <div className="small-text" style={{ color: '#6b7280', marginTop: '2px' }}>
                Coming soon
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── In Progress sub-tab with its own 3 sub-sub-tab buttons ── */}
      {subTab === SUB_IN_PROGRESS && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button style={innerBtn(ipTab === IP_UPLOADING)} onClick={() => setIpTab(IP_UPLOADING)}>
              Uploading{uploadQueue.length > 0 ? ` (${uploadQueue.length})` : ''}
            </button>
            <button style={innerBtn(ipTab === IP_OPEN)} onClick={() => setIpTab(IP_OPEN)}>
              Open Tickets{openTickets.length > 0 ? ` (${openTickets.length})` : ''}
            </button>
            <button style={innerBtn(ipTab === IP_DRAFTS)} onClick={() => setIpTab(IP_DRAFTS)}>
              Drafts{drafts.length > 0 ? ` (${drafts.length})` : ''}
            </button>
          </div>

          {/* Uploading */}
          {ipTab === IP_UPLOADING && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {uploadQueue.length === 0 ? (
                <div className="small-text" style={{ textAlign: 'center', padding: '20px', color: '#9ca3af' }}>
                  Nothing in upload queue.
                </div>
              ) : (
                uploadQueue.map((item) => {
                  // T&M submit entries carry their display fields at the
                  // top level (ticket_number, spray_date). Lease-sheet
                  // entries tuck them inside `payload`. Fall back across
                  // both so the row renders a useful label either way.
                  const ticketNumber = item.ticket_number || item.payload?.ticket_number || 'Pending';
                  const sprayDate = item.spray_date || item.payload?.spray_date || '';
                  const typeLabel =
                    item.targetType === 'tm_ticket' ? 'T&M Ticket'
                    : item.targetType === 'site' ? 'Site'
                    : 'Pipeline';
                  return (
                    <div key={item.id} className="site-row" style={{ padding: '10px', borderRadius: '6px', opacity: 0.85 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div className="small-text" style={{ fontWeight: 600 }}>
                            {ticketNumber} — {sprayDate}
                          </div>
                          <div className="small-text" style={{ color: '#9ca3af' }}>
                            {typeLabel} • {item.status === 'uploading' ? 'Uploading...' : 'Queued'}
                          </div>
                        </div>
                        <span className="pending-badge" style={{ background: '#3b82f6', fontSize: '0.65rem' }}>
                          {item.status === 'uploading' ? '⟳' : '⏳'}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* Open Tickets */}
          {ipTab === IP_OPEN && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {sortedOpenTickets.length === 0 ? (
                <div className="small-text" style={{ textAlign: 'center', padding: '20px', color: '#9ca3af' }}>
                  No open T&M tickets.
                </div>
              ) : (
                visibleOpen.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="site-row"
                    onClick={() => onOpenTMTicket?.(t.id)}
                    style={{
                      textAlign: 'left',
                      padding: '10px',
                      borderRadius: '6px',
                      background: '#111827',
                      border: '1px solid #374151',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div className="small-text" style={{ fontWeight: 700 }}>{t.ticket_number}</div>
                        <div className="small-text" style={{ color: '#9ca3af' }}>
                          {t.client} / {t.area} • {t.spray_date}
                        </div>
                        <div className="small-text" style={{ color: '#9ca3af' }}>
                          {(t.rows?.length || 0)} row(s) • {t.created_by_name || '—'}
                        </div>
                      </div>
                      <span style={{ color: '#3b82f6' }}>›</span>
                    </div>
                  </button>
                ))
              )}
              {sortedOpenTickets.length > openCount && (
                <button
                  type="button"
                  onClick={() => setOpenCount((c) => c + PAGE_SIZE)}
                  style={{ padding: '8px', background: '#1f2937', border: '1px solid #374151', borderRadius: '6px', color: '#60a5fa', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', marginTop: '4px' }}
                >
                  Load more ({sortedOpenTickets.length - openCount} remaining)
                </button>
              )}
            </div>
          )}

          {/* Drafts */}
          {ipTab === IP_DRAFTS && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {drafts.length === 0 ? (
                <div className="small-text" style={{ textAlign: 'center', padding: '20px', color: '#9ca3af' }}>
                  No drafts saved.
                </div>
              ) : (
                drafts.map((d) => (
                  <div
                    key={d.id}
                    className="site-row"
                    style={{ padding: '10px', borderRadius: '6px', background: '#111827', border: '1px solid #374151', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  >
                    <button
                      type="button"
                      onClick={() => onStartLeaseSheetFromDraft?.(d)}
                      style={{ flex: 1, textAlign: 'left', background: 'transparent', border: 'none', color: '#f9fafb', cursor: 'pointer', padding: 0 }}
                    >
                      <div className="small-text" style={{ fontWeight: 600 }}>{d.label || 'Untitled Draft'}</div>
                      <div className="small-text" style={{ color: '#9ca3af', marginTop: '2px' }}>
                        Updated {new Date(d.updatedAt || d.createdAt).toLocaleString()}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      onClick={async () => {
                        if (!confirm('Delete this draft?')) return;
                        await deleteLeaseSheetDraft(d.id);
                        setDrafts((prev) => prev.filter((x) => x.id !== d.id));
                        onRequestDraftsRefresh?.();
                      }}
                      style={{ padding: '4px 10px', fontSize: '0.75rem', marginLeft: '8px' }}
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Recently Submitted sub-tab ── */}
      {subTab === SUB_RECENTS && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search ticket#, client, area, worker..."
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid #374151',
              backgroundColor: '#111827',
              color: '#f9fafb',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '6px' }}>
            <button style={innerBtn(recTab === REC_ALL)} onClick={() => setRecTab(REC_ALL)}>All</button>
            <button style={innerBtn(recTab === REC_LEASE)} onClick={() => setRecTab(REC_LEASE)}>Lease Sheets</button>
            <button style={innerBtn(recTab === REC_TM)} onClick={() => setRecTab(REC_TM)}>T&M Tickets</button>
          </div>

          {/* Render the three tabs. "All" interleaves lease + T&M by created_at;
              "Lease Sheets" / "T&M Tickets" show a single-type list as before. */}
          {recTab === REC_ALL && (
            <div className="list-grid">
              {filteredAll.length === 0 ? (
                <div className="small-text" style={{ textAlign: 'center', padding: '10px', color: '#9ca3af' }}>
                  Nothing here yet.
                </div>
              ) : (
                visibleAll.map((row) =>
                  row._type === 'lease'
                    ? renderLeaseRow(row, onViewPdf, onEditRecord)
                    : renderTmRow(row, onOpenTMTicket)
                )
              )}
              {filteredAll.length > allCount && (
                <button
                  type="button"
                  onClick={() => setAllCount((c) => c + PAGE_SIZE)}
                  style={{ padding: '8px', background: '#1f2937', border: '1px solid #374151', borderRadius: '6px', color: '#60a5fa', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', marginTop: '4px' }}
                >
                  Load more ({filteredAll.length - allCount} remaining)
                </button>
              )}
            </div>
          )}

          {recTab === REC_LEASE && (
            <div className="list-grid">
              {filteredLease.length === 0 ? (
                <div className="small-text" style={{ textAlign: 'center', padding: '10px', color: '#9ca3af' }}>
                  No lease sheets.
                </div>
              ) : (
                visibleLease.map((record) => renderLeaseRow(record, onViewPdf, onEditRecord))
              )}
              {filteredLease.length > leaseCount && (
                <button
                  type="button"
                  onClick={() => setLeaseCount((c) => c + PAGE_SIZE)}
                  style={{ padding: '8px', background: '#1f2937', border: '1px solid #374151', borderRadius: '6px', color: '#60a5fa', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', marginTop: '4px' }}
                >
                  Load more ({filteredLease.length - leaseCount} remaining)
                </button>
              )}
            </div>
          )}

          {recTab === REC_TM && (
            <div className="list-grid">
              {/* Office-only status filter: lets admins/office narrow the list
                  to "awaiting approval" (submitted) or "already approved" so
                  they can triage pricing + approvals at a glance. Workers
                  don't see these buttons \u2014 the list is their own history. */}
              {roleCanAdmin ? (
                <div style={{ display: 'flex', gap: '6px', marginBottom: '2px' }}>
                  <button
                    type="button"
                    style={innerBtn(tmStatusFilter === TM_STATUS_ALL)}
                    onClick={() => setTmStatusFilter(TM_STATUS_ALL)}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    style={innerBtn(tmStatusFilter === TM_STATUS_SUBMITTED)}
                    onClick={() => setTmStatusFilter(TM_STATUS_SUBMITTED)}
                  >
                    Pending
                  </button>
                  <button
                    type="button"
                    style={innerBtn(tmStatusFilter === TM_STATUS_APPROVED)}
                    onClick={() => setTmStatusFilter(TM_STATUS_APPROVED)}
                  >
                    Approved
                  </button>
                </div>
              ) : null}

              {filteredTm.length === 0 ? (
                <div className="small-text" style={{ textAlign: 'center', padding: '10px', color: '#9ca3af' }}>
                  No T&M tickets.
                </div>
              ) : (
                visibleTm.map((t) => renderTmRow(t, onOpenTMTicket))
              )}
              {filteredTm.length > tmCount && (
                <button
                  type="button"
                  onClick={() => setTmCount((c) => c + PAGE_SIZE)}
                  style={{ padding: '8px', background: '#1f2937', border: '1px solid #374151', borderRadius: '6px', color: '#60a5fa', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', marginTop: '4px' }}
                >
                  Load more ({filteredTm.length - tmCount} remaining)
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── New T&M Ticket Modal ── */}
      {newTMOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.65)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !newTMBusy) setNewTMOpen(false); }}
        >
          <div
            style={{
              background: '#111827',
              border: '1px solid #374151',
              borderRadius: '10px',
              width: '100%',
              maxWidth: '420px',
              padding: '18px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '1.05rem' }}>New T&amp;M Ticket</h3>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span className="small-text" style={{ color: '#9ca3af' }}>Date</span>
              <input
                type="date"
                value={newTMDate}
                onChange={(e) => setNewTMDate(e.target.value)}
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  border: '1px solid #374151',
                  background: '#0b1220',
                  color: '#f9fafb',
                }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span className="small-text" style={{ color: '#9ca3af' }}>Client</span>
              <select
                value={newTMClient}
                onChange={(e) => setNewTMClient(e.target.value)}
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  border: '1px solid #374151',
                  background: '#0b1220',
                  color: '#f9fafb',
                }}
              >
                <option value="">-- Select client --</option>
                {clients.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span className="small-text" style={{ color: '#9ca3af' }}>Area</span>
              <select
                value={newTMArea}
                onChange={(e) => setNewTMArea(e.target.value)}
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  border: '1px solid #374151',
                  background: '#0b1220',
                  color: '#f9fafb',
                }}
              >
                <option value="">-- Select area --</option>
                {areas.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span className="small-text" style={{ color: '#9ca3af' }}>Description of Work (optional)</span>
              <textarea
                value={newTMDesc}
                onChange={(e) => setNewTMDesc(e.target.value)}
                rows={3}
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  border: '1px solid #374151',
                  background: '#0b1220',
                  color: '#f9fafb',
                  resize: 'vertical',
                }}
              />
            </label>

            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button
                type="button"
                className="secondary-button"
                disabled={newTMBusy}
                onClick={() => setNewTMOpen(false)}
                style={{ flex: 1 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={newTMBusy || !newTMClient || !newTMArea || !newTMDate}
                onClick={async () => {
                  if (!newTMClient || !newTMArea || !newTMDate) return;
                  setNewTMBusy(true);
                  try {
                    await onStartNewTMTicket?.({
                      client: newTMClient,
                      area: newTMArea,
                      spray_date: newTMDate,
                      description_of_work: newTMDesc || '',
                    });
                    setNewTMOpen(false);
                  } finally {
                    setNewTMBusy(false);
                  }
                }}
                style={{ flex: 1 }}
              >
                {newTMBusy ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
