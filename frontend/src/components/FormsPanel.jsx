import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { getLeaseSheetDrafts, deleteLeaseSheetDraft } from '../lib/offlineStore';

/**
 * The Forms panel replaces the old Recents panel.
 *
 * Three top-level sub-tabs:
 *   1. Forms            — launcher for form templates
 *   2. In Progress      — 3 sub-sub-tab buttons: Uploading / Open Tickets / Drafts
 *   3. Recently Submitted — list of submitted lease sheets (+ T&M tickets)
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
  draftsRefreshToken = 0,    // bump to trigger reload
  roleCanAdmin = false,
}) {
  const [subTab, setSubTab] = useState(SUB_FORMS);
  const [ipTab, setIpTab] = useState(IP_UPLOADING);
  const [recTab, setRecTab] = useState(REC_ALL);

  const [openTickets, setOpenTickets] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [tmSubmitted, setTmSubmitted] = useState([]);

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
  const [openCount, setOpenCount] = useState(PAGE_SIZE);
  useEffect(() => { setLeaseCount(PAGE_SIZE); setTmCount(PAGE_SIZE); }, [search]);
  useEffect(() => { setOpenCount(PAGE_SIZE); }, [ipTab]);

  // Load open T&M tickets when In Progress → Open Tickets tab is shown
  useEffect(() => {
    if (!visible) return;
    if (subTab !== SUB_IN_PROGRESS || ipTab !== IP_OPEN) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listTMTickets({ status: 'open' });
        if (!cancelled) setOpenTickets(list || []);
      } catch (e) {
        console.warn('[FORMS] listTMTickets open failed:', e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, subTab, ipTab]);

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

  // Load submitted T&M tickets when Recently Submitted → (All | T&M) tab is shown
  useEffect(() => {
    if (!visible) return;
    if (subTab !== SUB_RECENTS) return;
    if (recTab === REC_LEASE) return;  // don't need TM list for lease-only view
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listTMTickets({});
        if (!cancelled) setTmSubmitted(list || []);
      } catch (e) {
        console.warn('[FORMS] listTMTickets failed:', e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, subTab, recTab]);

  // Sort helper: newest first by created_at (fall back to id for stable ordering).
  const byNewest = (a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return (b.id || 0) - (a.id || 0);
  };

  // Filtered + sorted lease sheet recents
  const filteredLease = useMemo(() => {
    const base = [...cachedRecents].sort(byNewest);
    if (!search) return base;
    const q = search.toLowerCase();
    return base.filter((r) =>
      (r.ticket_number || '').toLowerCase().includes(q) ||
      (r.site_client || '').toLowerCase().includes(q) ||
      (r.site_area || '').toLowerCase().includes(q) ||
      (r.site_lsd || '').toLowerCase().includes(q) ||
      (r.sprayed_by_name || '').toLowerCase().includes(q)
    );
  }, [cachedRecents, search]);

  const filteredTm = useMemo(() => {
    const base = [...tmSubmitted].sort(byNewest);
    if (!search) return base;
    const q = search.toLowerCase();
    return base.filter((t) =>
      (t.ticket_number || '').toLowerCase().includes(q) ||
      (t.client || '').toLowerCase().includes(q) ||
      (t.area || '').toLowerCase().includes(q) ||
      (t.created_by_name || '').toLowerCase().includes(q)
    );
  }, [tmSubmitted, search]);

  const sortedOpenTickets = useMemo(() => [...openTickets].sort(byNewest), [openTickets]);

  // Paginated views
  const visibleLease = useMemo(() => filteredLease.slice(0, leaseCount), [filteredLease, leaseCount]);
  const visibleTm = useMemo(() => filteredTm.slice(0, tmCount), [filteredTm, tmCount]);
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
                uploadQueue.map((item) => (
                  <div key={item.id} className="site-row" style={{ padding: '10px', borderRadius: '6px', opacity: 0.85 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div className="small-text" style={{ fontWeight: 600 }}>
                          {item.payload?.ticket_number || 'Pending'} — {item.payload?.spray_date || ''}
                        </div>
                        <div className="small-text" style={{ color: '#9ca3af' }}>
                          {item.targetType === 'site' ? 'Site' : 'Pipeline'} • {item.status === 'uploading' ? 'Uploading...' : 'Queued'}
                        </div>
                      </div>
                      <span className="pending-badge" style={{ background: '#3b82f6', fontSize: '0.65rem' }}>
                        {item.status === 'uploading' ? '⟳' : '⏳'}
                      </span>
                    </div>
                  </div>
                ))
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

          {/* Lease sheet rows */}
          {(recTab === REC_ALL || recTab === REC_LEASE) && (
            <div className="list-grid">
              {filteredLease.length === 0 ? (
                <div className="small-text" style={{ textAlign: 'center', padding: '10px', color: '#9ca3af' }}>
                  No lease sheets.
                </div>
              ) : (
                visibleLease.map((record) => (
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
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onEditRecord?.(record)}
                          style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                        >
                          ✏️ Edit
                        </button>
                      </div>
                    </div>
                  </div>
                ))
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

          {/* T&M rows */}
          {(recTab === REC_ALL || recTab === REC_TM) && (
            <div className="list-grid">
              {filteredTm.length === 0 ? (
                <div className="small-text" style={{ textAlign: 'center', padding: '10px', color: '#9ca3af' }}>
                  No T&M tickets.
                </div>
              ) : (
                visibleTm.map((t) => (
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
                ))
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
