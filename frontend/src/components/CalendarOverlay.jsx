/**
 * Calendar overlay — admin/office full-page modal mounted on demand from
 * AdminPanel. Renders a polished FullCalendar grid showing tasks, events,
 * and bids merged into one event source, with a contacts side-drawer and
 * a "Created by" filter that applies to tasks + events (per the plan).
 *
 * Architecture notes:
 *   - Lazy-loaded from App.jsx so the FullCalendar bundle (~150 KB gzipped)
 *     never lands in worker sessions.
 *   - Opens its own Supabase Realtime channel on mount, tears down on
 *     close. Coalesced 250 ms debounce on the refetch so a flurry of
 *     INSERTs from another device doesn't thrash the network.
 *   - Roll-forward is called once per day per browser (gated by a
 *     localStorage stamp). The endpoint itself is idempotent, so multiple
 *     admins all opening the calendar same morning is safe.
 *   - All writes use the api wrapper which adds the Bearer token; the
 *     backend enforces admin/office via the require_roles dependency.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';

import { api } from '../lib/api';
import { supabase } from '../lib/supabaseClient';
import { useDialog } from './DialogProvider';

// ── Styles (inline so they live with the component) ────────────────────────

const S = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 90, background: '#0b1220',
    display: 'flex', flexDirection: 'column', color: '#e5eefb',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: '0.75rem',
    padding: '10px 14px', background: '#111c33',
    borderBottom: '1px solid rgba(143,182,255,0.12)',
    flexWrap: 'wrap',
  },
  title: { margin: 0, fontSize: '1.05rem', fontWeight: 600, flex: '0 0 auto' },
  spacer: { flex: 1 },
  navBtn: {
    background: '#1e293b', color: '#e5eefb', border: '1px solid rgba(143,182,255,0.18)',
    borderRadius: 8, padding: '6px 12px', fontSize: '0.82rem', cursor: 'pointer',
  },
  navBtnActive: {
    background: '#2563eb', borderColor: '#2563eb', color: '#fff',
  },
  primary: {
    background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8,
    padding: '6px 12px', fontSize: '0.82rem', cursor: 'pointer', fontWeight: 600,
  },
  danger: {
    background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8,
    padding: '6px 12px', fontSize: '0.82rem', cursor: 'pointer', fontWeight: 600,
  },
  ghost: {
    background: 'transparent', color: '#e5eefb',
    border: '1px solid rgba(143,182,255,0.2)', borderRadius: 8,
    padding: '6px 12px', fontSize: '0.82rem', cursor: 'pointer',
  },
  select: {
    background: '#1e293b', color: '#e5eefb',
    border: '1px solid rgba(143,182,255,0.18)', borderRadius: 8,
    padding: '6px 10px', fontSize: '0.82rem',
  },
  input: {
    width: '100%', background: '#1e293b', color: '#e5eefb',
    border: '1px solid rgba(143,182,255,0.18)', borderRadius: 8,
    padding: '8px 10px', fontSize: '0.9rem', boxSizing: 'border-box',
  },
  body: {
    flex: 1, minHeight: 0, padding: '12px 14px', overflow: 'auto',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  bidsBar: {
    background: '#1a1330', border: '1px solid rgba(168,85,247,0.35)',
    borderRadius: 10, padding: '8px 12px',
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  bidChip: {
    background: '#2e1065', color: '#e9d5ff', borderRadius: 6,
    padding: '4px 8px', fontSize: '0.78rem', cursor: 'pointer',
    border: '1px solid rgba(168,85,247,0.4)',
    display: 'inline-flex', gap: 6, alignItems: 'center',
  },
  modalBackdrop: {
    position: 'fixed', inset: 0, zIndex: 95, background: 'rgba(0,0,0,0.65)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  },
  modal: {
    background: '#0f172a', border: '1px solid rgba(143,182,255,0.18)',
    borderRadius: 12, padding: 16, width: '100%', maxWidth: 480,
    maxHeight: '90vh', overflow: 'auto', color: '#e5eefb',
    display: 'flex', flexDirection: 'column', gap: 12,
    boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
  },
  drawer: {
    position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(420px, 100%)',
    background: '#0f172a', borderLeft: '1px solid rgba(143,182,255,0.18)',
    zIndex: 96, padding: 14, overflow: 'auto', color: '#e5eefb',
    display: 'flex', flexDirection: 'column', gap: 10,
    boxShadow: '-10px 0 30px rgba(0,0,0,0.4)',
  },
  fieldLabel: { fontSize: '0.78rem', color: '#9ab1d6', marginBottom: 4, display: 'block' },
  badge: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, borderRadius: 11,
    background: 'rgba(255,255,255,0.18)', color: '#fff',
    fontSize: '0.7rem', fontWeight: 700, marginLeft: 6,
  },
  meta: {
    fontSize: '0.75rem', color: '#9ab1d6', paddingTop: 8,
    borderTop: '1px solid rgba(143,182,255,0.12)',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

const PRIORITY_OPTIONS = [
  { value: 'important', label: 'Important (red)', color: '#dc2626' },
  { value: 'attention', label: 'Needs attention (yellow)', color: '#f59e0b' },
  { value: 'normal', label: 'Day-to-day (green)', color: '#16a34a' },
];

const priorityColor = (p) =>
  PRIORITY_OPTIONS.find((o) => o.value === p)?.color || '#16a34a';

const EVENT_COLOR = '#3b82f6';
const BID_COLOR = '#a855f7';
const COMPLETED_COLOR = '#475569';

function initialsOf(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(input) {
  if (!input) return '';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(input) {
  if (!input) return '';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// FullCalendar uses an exclusive `end`, so multi-day events need end+1 day.
function addOneDay(isoDate) {
  if (!isoDate) return undefined;
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Merge tasks + events + bids (with closing_date) into FullCalendar's
// event-source shape. Bids without closing_date are rendered separately in
// the "no date" bar above the grid — they're excluded here on purpose.
function bundleToEvents(bundle) {
  const out = [];
  for (const t of bundle.tasks || []) {
    const color = t.is_completed ? COMPLETED_COLOR : priorityColor(t.priority);
    out.push({
      id: `task-${t.id}`,
      title: t.task_text,
      start: t.task_date,
      allDay: true,
      backgroundColor: color,
      borderColor: color,
      textColor: '#fff',
      // `editable: true` enables drag-drop for re-dating. Bids set it to
      // false below so their closing_date stays source-controlled.
      editable: !t.is_completed,
      extendedProps: { kind: 'task', raw: t },
    });
  }
  for (const e of bundle.events || []) {
    out.push({
      id: `event-${e.id}`,
      title: e.title,
      start: e.event_date,
      // FullCalendar treats `end` as exclusive for all-day events.
      end: e.end_date ? addOneDay(e.end_date) : undefined,
      allDay: true,
      backgroundColor: EVENT_COLOR,
      borderColor: EVENT_COLOR,
      textColor: '#fff',
      editable: true,
      extendedProps: { kind: 'event', raw: e },
    });
  }
  for (const b of bundle.bids || []) {
    if (!b.closing_date) continue; // shown in the no-date bar instead
    out.push({
      id: `bid-${b.id}`,
      title: b.bid_title,
      start: b.closing_date,
      allDay: true,
      backgroundColor: BID_COLOR,
      borderColor: BID_COLOR,
      textColor: '#fff',
      editable: false,
      extendedProps: { kind: 'bid', raw: b },
    });
  }
  return out;
}

const LS_LAST_ROLL = 'pv_calendar_last_roll';
const LS_LAST_VIEW = 'pv_calendar_last_view';

// ── Sub-components ─────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={S.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

function ModalShell({ title, onClose, children, footer }) {
  return (
    <div style={S.modalBackdrop} onMouseDown={onClose}>
      <div style={S.modal} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: '1rem', flex: 1 }}>{title}</h3>
          <button type="button" onClick={onClose} style={S.ghost} aria-label="Close">✕</button>
        </div>
        {children}
        {footer ? <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>{footer}</div> : null}
      </div>
    </div>
  );
}

function AddPickerModal({ onPick, onClose, defaultDate }) {
  return (
    <ModalShell title={`Add to calendar${defaultDate ? ` — ${formatDate(defaultDate)}` : ''}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button type="button" style={S.primary} onClick={() => onPick('task')}>
          ✓ Task
        </button>
        <button type="button" style={{ ...S.primary, background: EVENT_COLOR }} onClick={() => onPick('event')}>
          📅 Event
        </button>
        <button type="button" style={{ ...S.primary, background: BID_COLOR }} onClick={() => onPick('bid')}>
          📋 Bid (manual)
        </button>
      </div>
    </ModalShell>
  );
}

function TaskFormModal({ initial, users, onSubmit, onClose, onDelete, busy }) {
  const [taskDate, setTaskDate] = useState(initial?.task_date || todayISO());
  const [taskText, setTaskText] = useState(initial?.task_text || '');
  const [priority, setPriority] = useState(initial?.priority || 'normal');
  const [assignedUserId, setAssignedUserId] = useState(initial?.assigned_user_id ?? '');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!taskText.trim()) return;
    await onSubmit({
      task_date: taskDate,
      task_text: taskText.trim(),
      priority,
      assigned_user_id: assignedUserId === '' ? null : Number(assignedUserId),
    });
  }

  return (
    <ModalShell
      title={initial ? 'Edit task' : 'New task'}
      onClose={onClose}
      footer={(
        <>
          {initial && onDelete ? (
            <button type="button" style={S.danger} onClick={onDelete} disabled={busy}>Delete</button>
          ) : null}
          <button type="button" style={S.ghost} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" style={S.primary} onClick={handleSubmit} disabled={busy || !taskText.trim()}>
            {busy ? 'Saving…' : (initial ? 'Save' : 'Add task')}
          </button>
        </>
      )}
    >
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Date">
          <input type="date" value={taskDate} onChange={(e) => setTaskDate(e.target.value)} style={S.input} required />
        </Field>
        <Field label="Task">
          <textarea
            value={taskText}
            onChange={(e) => setTaskText(e.target.value)}
            placeholder="What needs doing?"
            style={{ ...S.input, minHeight: 70, resize: 'vertical' }}
            required
          />
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ ...S.input, padding: '8px 10px' }}>
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Assigned to">
          <select value={assignedUserId} onChange={(e) => setAssignedUserId(e.target.value)} style={{ ...S.input, padding: '8px 10px' }}>
            <option value="">— Unassigned —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        </Field>
      </form>
    </ModalShell>
  );
}

function EventFormModal({ initial, onSubmit, onClose, onDelete, busy }) {
  const [eventDate, setEventDate] = useState(initial?.event_date || todayISO());
  const [endDate, setEndDate] = useState(initial?.end_date || '');
  const [title, setTitle] = useState(initial?.title || '');
  const [location, setLocation] = useState(initial?.location || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [url, setUrl] = useState(initial?.url || '');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) return;
    await onSubmit({
      event_date: eventDate,
      end_date: endDate || null,
      title: title.trim(),
      location: location.trim() || null,
      notes: notes.trim() || null,
      url: url.trim() || null,
    });
  }

  return (
    <ModalShell
      title={initial ? 'Edit event' : 'New event'}
      onClose={onClose}
      footer={(
        <>
          {initial && onDelete ? (
            <button type="button" style={S.danger} onClick={onDelete} disabled={busy}>Delete</button>
          ) : null}
          <button type="button" style={S.ghost} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" style={{ ...S.primary, background: EVENT_COLOR }} onClick={handleSubmit} disabled={busy || !title.trim()}>
            {busy ? 'Saving…' : (initial ? 'Save' : 'Add event')}
          </button>
        </>
      )}
    >
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Western Canada Spray Conference" style={S.input} required />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Start date">
            <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} style={S.input} required />
          </Field>
          <Field label="End date (optional)">
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={eventDate} style={S.input} />
          </Field>
        </div>
        <Field label="Location"><input value={location} onChange={(e) => setLocation(e.target.value)} style={S.input} /></Field>
        <Field label="URL"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" style={S.input} /></Field>
        <Field label="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...S.input, minHeight: 60, resize: 'vertical' }} />
        </Field>
      </form>
    </ModalShell>
  );
}

function BidFormModal({ initial, onSubmit, onClose, onDelete, busy }) {
  const [bidTitle, setBidTitle] = useState(initial?.bid_title || '');
  const [closingDate, setClosingDate] = useState(initial?.closing_date || '');
  const [summary, setSummary] = useState(initial?.summary || '');
  const [sourceUrl, setSourceUrl] = useState(initial?.source_url || '');
  const [keywords, setKeywords] = useState(
    (initial?.matched_keywords || []).join(', ')
  );

  async function handleSubmit(e) {
    e.preventDefault();
    if (!bidTitle.trim()) return;
    const kws = keywords.split(',').map((s) => s.trim()).filter(Boolean);
    await onSubmit({
      bid_title: bidTitle.trim(),
      closing_date: closingDate || null,
      summary: summary.trim() || null,
      source_url: sourceUrl.trim() || null,
      matched_keywords: kws.length ? kws : null,
    });
  }

  return (
    <ModalShell
      title={initial ? 'Edit bid' : 'New bid'}
      onClose={onClose}
      footer={(
        <>
          {initial && onDelete ? (
            <button type="button" style={S.danger} onClick={onDelete} disabled={busy}>Delete</button>
          ) : null}
          <button type="button" style={S.ghost} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" style={{ ...S.primary, background: BID_COLOR }} onClick={handleSubmit} disabled={busy || !bidTitle.trim()}>
            {busy ? 'Saving…' : (initial ? 'Save' : 'Add bid')}
          </button>
        </>
      )}
    >
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Title">
          <input value={bidTitle} onChange={(e) => setBidTitle(e.target.value)} style={S.input} required />
        </Field>
        <Field label="Closing date (leave blank if unknown)">
          <input type="date" value={closingDate} onChange={(e) => setClosingDate(e.target.value)} style={S.input} />
        </Field>
        <Field label="Source URL">
          <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://bcbid.gov.bc.ca/…" style={S.input} />
        </Field>
        <Field label="Keywords (comma-separated)">
          <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="hydroseeding, drone" style={S.input} />
        </Field>
        <Field label="Summary">
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} style={{ ...S.input, minHeight: 60, resize: 'vertical' }} />
        </Field>
      </form>
    </ModalShell>
  );
}

function ItemDetailModal({ item, onEdit, onDelete, onToggleComplete, onDismissBid, onClose, busy }) {
  const { kind, raw } = item;
  const meta = (
    <div style={S.meta}>
      <div>Added by <strong>{raw.created_by_name || 'Unknown'}</strong> on {formatDateTime(raw.created_at)}</div>
      {raw.updated_by_name && raw.updated_by_user_id !== raw.created_by_user_id ? (
        <div>Last edited by <strong>{raw.updated_by_name}</strong> on {formatDateTime(raw.updated_at)}</div>
      ) : null}
    </div>
  );
  if (kind === 'task') {
    return (
      <ModalShell
        title="Task"
        onClose={onClose}
        footer={(
          <>
            <button type="button" style={S.danger} onClick={onDelete} disabled={busy}>Delete</button>
            <button type="button" style={S.ghost} onClick={onEdit} disabled={busy}>Edit</button>
            <button
              type="button"
              style={{ ...S.primary, background: raw.is_completed ? '#64748b' : '#16a34a' }}
              onClick={onToggleComplete}
              disabled={busy}
            >
              {raw.is_completed ? 'Mark incomplete' : 'Mark complete'}
            </button>
          </>
        )}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 12, height: 12, borderRadius: 6, display: 'inline-block',
            background: priorityColor(raw.priority),
          }} />
          <strong style={{ textDecoration: raw.is_completed ? 'line-through' : 'none' }}>
            {raw.task_text}
          </strong>
        </div>
        <div style={{ fontSize: '0.85rem', color: '#c9d6ee' }}>
          Date: {formatDate(raw.task_date)}
          {raw.original_task_date && raw.original_task_date !== raw.task_date ? (
            <span title={`Originally for ${formatDate(raw.original_task_date)}`}> · ↻ rolled from {formatDate(raw.original_task_date)}</span>
          ) : null}
        </div>
        <div style={{ fontSize: '0.85rem', color: '#c9d6ee' }}>
          Assigned to: <strong>{raw.assigned_user_name || 'Unassigned'}</strong>
        </div>
        {raw.is_completed ? (
          <div style={{ fontSize: '0.85rem', color: '#86efac' }}>
            Completed by <strong>{raw.completed_by_name || 'Unknown'}</strong> on {formatDateTime(raw.completed_at)}
          </div>
        ) : null}
        {meta}
      </ModalShell>
    );
  }
  if (kind === 'event') {
    return (
      <ModalShell
        title="Event"
        onClose={onClose}
        footer={(
          <>
            <button type="button" style={S.danger} onClick={onDelete} disabled={busy}>Delete</button>
            <button type="button" style={{ ...S.primary, background: EVENT_COLOR }} onClick={onEdit} disabled={busy}>Edit</button>
          </>
        )}
      >
        <strong style={{ fontSize: '1.05rem' }}>{raw.title}</strong>
        <div style={{ fontSize: '0.85rem', color: '#c9d6ee' }}>
          {raw.end_date ? `${formatDate(raw.event_date)} – ${formatDate(raw.end_date)}` : formatDate(raw.event_date)}
        </div>
        {raw.location ? <div style={{ fontSize: '0.85rem' }}>📍 {raw.location}</div> : null}
        {raw.url ? (
          <a href={raw.url} target="_blank" rel="noreferrer" style={{ fontSize: '0.85rem', color: '#60a5fa' }}>
            {raw.url}
          </a>
        ) : null}
        {raw.notes ? <div style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>{raw.notes}</div> : null}
        {meta}
      </ModalShell>
    );
  }
  // Bid
  return (
    <ModalShell
      title="Bid"
      onClose={onClose}
      footer={(
        <>
          <button type="button" style={S.danger} onClick={onDelete} disabled={busy}>Delete</button>
          <button type="button" style={S.ghost} onClick={onDismissBid} disabled={busy}>
            {raw.is_dismissed ? 'Un-dismiss' : 'Dismiss'}
          </button>
          <button type="button" style={{ ...S.primary, background: BID_COLOR }} onClick={onEdit} disabled={busy}>Edit</button>
        </>
      )}
    >
      <strong style={{ fontSize: '1.05rem' }}>{raw.bid_title}</strong>
      <div style={{ fontSize: '0.85rem', color: '#c9d6ee' }}>
        {raw.closing_date ? `Closes ${formatDate(raw.closing_date)}` : 'No close date'} · source: {raw.source}
      </div>
      {raw.matched_keywords && raw.matched_keywords.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {raw.matched_keywords.map((k) => (
            <span key={k} style={{
              background: '#2e1065', color: '#e9d5ff', borderRadius: 4,
              padding: '2px 6px', fontSize: '0.72rem',
            }}>{k}</span>
          ))}
        </div>
      ) : null}
      {raw.source_url ? (
        <a href={raw.source_url} target="_blank" rel="noreferrer" style={{ fontSize: '0.85rem', color: '#60a5fa' }}>
          {raw.source_url}
        </a>
      ) : null}
      {raw.summary ? <div style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>{raw.summary}</div> : null}
      {meta}
    </ModalShell>
  );
}

function ContactsDrawer({ contacts, clients, onAdd, onUpdate, onDelete, onClose, busy }) {
  const { confirm } = useDialog();
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({
    company_name: '', contact_name: '', phone: '', email: '', role: '', client: '', notes: '',
  });
  const [adding, setAdding] = useState(false);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = contacts.filter((c) => {
      if (!q) return true;
      return [c.company_name, c.contact_name, c.phone, c.email, c.role, c.client]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q));
    });
    const byClient = {};
    for (const c of filtered) {
      const key = c.client || '— No client —';
      if (!byClient[key]) byClient[key] = [];
      byClient[key].push(c);
    }
    return Object.entries(byClient).sort(([a], [b]) => a.localeCompare(b));
  }, [contacts, search]);

  function startEdit(c) {
    setEditingId(c.id);
    setAdding(false);
    setForm({
      company_name: c.company_name || '',
      contact_name: c.contact_name || '',
      phone: c.phone || '',
      email: c.email || '',
      role: c.role || '',
      client: c.client || '',
      notes: c.notes || '',
    });
  }

  function startAdd() {
    setEditingId(null);
    setAdding(true);
    setForm({ company_name: '', contact_name: '', phone: '', email: '', role: '', client: '', notes: '' });
  }

  async function handleSave() {
    if (!form.company_name.trim()) return;
    const payload = {
      company_name: form.company_name.trim(),
      contact_name: form.contact_name.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      role: form.role.trim() || null,
      client: form.client.trim() || null,
      notes: form.notes.trim() || null,
    };
    if (editingId != null) {
      await onUpdate(editingId, payload);
      setEditingId(null);
    } else {
      await onAdd(payload);
      setAdding(false);
    }
  }

  async function handleDelete(id) {
    if (!(await confirm({ message: 'Remove this contact?', severity: 'danger', okLabel: 'Remove' }))) return;
    await onDelete(id);
  }

  const editorOpen = adding || editingId != null;

  return (
    <div style={S.drawer} onMouseDown={(e) => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: '1rem', flex: 1 }}>Contacts</h3>
        <button type="button" style={S.ghost} onClick={onClose}>✕</button>
      </div>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search company, contact, phone…"
        style={S.input}
      />
      {!editorOpen ? (
        <button type="button" style={S.primary} onClick={startAdd}>+ Add contact</button>
      ) : (
        <div style={{ background: '#111c33', padding: 10, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Field label="Company">
            <input value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} style={S.input} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Contact name">
              <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} style={S.input} />
            </Field>
            <Field label="Role">
              <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={S.input} />
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Phone">
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={S.input} />
            </Field>
            <Field label="Email">
              <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={S.input} />
            </Field>
          </div>
          <Field label="Client (groups contacts)">
            <input
              value={form.client}
              onChange={(e) => setForm({ ...form, client: e.target.value })}
              list="pv-calendar-client-list"
              style={S.input}
              placeholder="e.g. CNRL"
            />
            <datalist id="pv-calendar-client-list">
              {(clients || []).map((c) => <option key={c} value={c} />)}
            </datalist>
          </Field>
          <Field label="Notes">
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...S.input, minHeight: 50, resize: 'vertical' }} />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" style={S.ghost} onClick={() => { setAdding(false); setEditingId(null); }} disabled={busy}>Cancel</button>
            <button type="button" style={S.primary} onClick={handleSave} disabled={busy || !form.company_name.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
      {grouped.length === 0 ? (
        <div style={{ color: '#9ab1d6', fontSize: '0.85rem', textAlign: 'center', padding: 20 }}>
          {contacts.length === 0 ? 'No contacts yet.' : 'No contacts match the search.'}
        </div>
      ) : (
        grouped.map(([client, list]) => (
          <div key={client} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: '0.75rem', color: '#9ab1d6', fontWeight: 600, marginTop: 4 }}>{client}</div>
            {list.map((c) => (
              <div key={c.id} style={{
                background: '#111c33', borderRadius: 8, padding: 8,
                display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{c.company_name}</div>
                  {c.contact_name || c.role ? (
                    <div style={{ fontSize: '0.78rem', color: '#c9d6ee' }}>
                      {c.contact_name}{c.role ? ` · ${c.role}` : ''}
                    </div>
                  ) : null}
                  {c.phone ? <div style={{ fontSize: '0.78rem', color: '#9ab1d6' }}>☏ {c.phone}</div> : null}
                  {c.email ? <div style={{ fontSize: '0.78rem', color: '#9ab1d6' }}>✉ {c.email}</div> : null}
                  {c.notes ? <div style={{ fontSize: '0.75rem', color: '#9ab1d6', marginTop: 2 }}>{c.notes}</div> : null}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <button type="button" style={{ ...S.ghost, padding: '4px 8px', fontSize: '0.72rem' }} onClick={() => startEdit(c)}>Edit</button>
                  <button type="button" style={{ ...S.ghost, padding: '4px 8px', fontSize: '0.72rem', color: '#f87171' }} onClick={() => handleDelete(c.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function CalendarOverlay({ onClose, clients = [], currentUser }) {
  const { alert: dialogAlert } = useDialog();
  const calendarRef = useRef(null);
  const refetchTimerRef = useRef(null);

  // Bundle state — single source of truth, refetched whenever the visible
  // range or the createdBy filter changes (or Realtime pings us).
  const [bundle, setBundle] = useState({ tasks: [], events: [], bids: [], contacts: [], users: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // View / range
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const [initialView] = useState(() => {
    try {
      const stored = localStorage.getItem(LS_LAST_VIEW);
      if (stored) return stored;
    } catch { /* ignore */ }
    return isMobile ? 'listMonth' : 'dayGridMonth';
  });
  const [visibleRange, setVisibleRange] = useState(() => {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    start.setDate(start.getDate() - 7);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    end.setDate(end.getDate() + 31);
    return {
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
    };
  });

  // Filter
  const [createdByFilter, setCreatedByFilter] = useState('');

  // Modals
  const [addPicker, setAddPicker] = useState(null); // { defaultDate } | null
  const [editing, setEditing] = useState(null);     // { kind, raw, mode: 'create' | 'edit' } | null
  const [detail, setDetail] = useState(null);       // { kind, raw } | null
  const [contactsOpen, setContactsOpen] = useState(false);

  // ── Load bundle ──────────────────────────────────────────────────────────
  const loadBundle = useCallback(async () => {
    setError(null);
    try {
      const data = await api.getCalendarBundle({
        from: visibleRange.from,
        to: visibleRange.to,
        createdBy: createdByFilter || undefined,
      });
      setBundle({
        tasks: data.tasks || [],
        events: data.events || [],
        bids: data.bids || [],
        contacts: data.contacts || [],
        users: data.users || [],
      });
    } catch (e) {
      setError(e.message || 'Failed to load calendar');
    } finally {
      setLoading(false);
    }
  }, [visibleRange.from, visibleRange.to, createdByFilter]);

  useEffect(() => { loadBundle(); }, [loadBundle]);

  // Debounced refetch for Realtime — collapse a burst of inserts into one
  // round-trip 250ms after the last event.
  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      loadBundle();
    }, 250);
  }, [loadBundle]);

  // ── Roll forward on first open today ─────────────────────────────────────
  useEffect(() => {
    const today = todayISO();
    let last = null;
    try { last = localStorage.getItem(LS_LAST_ROLL); } catch { /* ignore */ }
    if (last === today) return;
    (async () => {
      try {
        const res = await api.rollForwardCalendarTasks();
        try { localStorage.setItem(LS_LAST_ROLL, today); } catch { /* ignore */ }
        if (res && res.rolled > 0) {
          // Force a refetch since rolled tasks now have new task_date.
          loadBundle();
        }
      } catch (e) {
        // Silent: roll-forward is best-effort, and the next session will
        // retry. Don't spam an alert dialog for a background sync.
        console.warn('[Calendar] roll-forward failed', e);
      }
    })();
  }, [loadBundle]);

  // ── Realtime channel ────────────────────────────────────────────────────
  useEffect(() => {
    if (!supabase) return undefined;
    const channel = supabase
      .channel('pineview-calendar')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_tasks' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_events' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_bids' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_contacts' }, scheduleRefetch)
      .subscribe();
    return () => {
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
      try { supabase.removeChannel(channel); } catch { /* ignore */ }
    };
  }, [scheduleRefetch]);

  // ── Escape key closes overlay ───────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        // Cascade: close inner modal/drawer first, then the overlay.
        if (editing) { setEditing(null); return; }
        if (detail) { setDetail(null); return; }
        if (addPicker) { setAddPicker(null); return; }
        if (contactsOpen) { setContactsOpen(false); return; }
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, detail, addPicker, contactsOpen, onClose]);

  // ── FullCalendar derived events ─────────────────────────────────────────
  const calendarEvents = useMemo(() => bundleToEvents(bundle), [bundle]);
  const noDateBids = useMemo(
    () => (bundle.bids || []).filter((b) => !b.closing_date),
    [bundle.bids],
  );

  // ── Action handlers ─────────────────────────────────────────────────────

  async function handleCreateTask(payload) {
    setBusy(true);
    try {
      await api.createCalendarTask(payload);
      setEditing(null);
      await loadBundle();
    } catch (e) {
      await dialogAlert({ title: 'Add failed', message: String(e.message || e), severity: 'danger' });
    } finally { setBusy(false); }
  }

  async function handleUpdateTask(taskId, payload) {
    setBusy(true);
    try {
      await api.updateCalendarTask(taskId, payload);
      setEditing(null);
      setDetail(null);
      await loadBundle();
    } catch (e) {
      await dialogAlert({ title: 'Save failed', message: String(e.message || e), severity: 'danger' });
    } finally { setBusy(false); }
  }

  async function handleDeleteTask(taskId) {
    setBusy(true);
    try {
      await api.deleteCalendarTask(taskId);
      setEditing(null);
      setDetail(null);
      await loadBundle();
    } catch (e) {
      await dialogAlert({ title: 'Delete failed', message: String(e.message || e), severity: 'danger' });
    } finally { setBusy(false); }
  }

  async function handleCreateEvent(payload) {
    setBusy(true);
    try {
      await api.createCalendarEvent(payload);
      setEditing(null);
      await loadBundle();
    } catch (e) {
      await dialogAlert({ title: 'Add failed', message: String(e.message || e), severity: 'danger' });
    } finally { setBusy(false); }
  }

  async function handleUpdateEvent(eventId, payload) {
    setBusy(true);
    try {
      await api.updateCalendarEvent(eventId, payload);
      setEditing(null);
      setDetail(null);
      await loadBundle();
    } catch (e) {
      await dialogAlert({ title: 'Save failed', message: String(e.message || e), severity: 'danger' });
    } finally { setBusy(false); }
  }

  async function handleDeleteEvent(eventId) {
    setBusy(true);
    try {
      await api.deleteCalendarEvent(eventId);
      setEditing(null);
      setDetail(null);
      await loadBundle();
    } catch (e) {
      await dialogAlert({ title: 'Delete failed', message: String(e.message || e), severity: 'danger' });
    } finally { setBusy(false); }
  }

  async function handleCreateBid(payload) {
    setBusy(true);
    try {
      await api.createCalendarBid(payload);
      setEditing(null);
      await loadBundle();
    } catch (e) {
      await dialogAlert({ title: 'Add failed', message: String(e.message || e), severity: 'danger' });
    } finally { setBusy(false); }
  }

  async function handleUpdateBid(bidId, payload) {
    setBusy(true);
    try {
      await api.updateCalendarBid(bidId, payload);
      setEditing(null);
      setDetail(null);
      await loadBundle();
    } catch (e) {
      await dialogAlert({ title: 'Save failed', message: String(e.message || e), severity: 'danger' });
    } finally { setBusy(false); }
  }

  async function handleDeleteBid(bidId) {
    setBusy(true);
    try {
      await api.deleteCalendarBid(bidId);
      setEditing(null);
      setDetail(null);
      await loadBundle();
    } catch (e) {
      await dialogAlert({ title: 'Delete failed', message: String(e.message || e), severity: 'danger' });
    } finally { setBusy(false); }
  }

  async function handleDismissBid(bid) {
    setBusy(true);
    try {
      await api.updateCalendarBid(bid.id, { is_dismissed: !bid.is_dismissed });
      setDetail(null);
      await loadBundle();
    } catch (e) {
      await dialogAlert({ title: 'Update failed', message: String(e.message || e), severity: 'danger' });
    } finally { setBusy(false); }
  }

  // Contacts
  async function handleAddContact(payload) {
    setBusy(true);
    try { await api.createCalendarContact(payload); await loadBundle(); }
    catch (e) { await dialogAlert({ title: 'Add failed', message: String(e.message || e), severity: 'danger' }); }
    finally { setBusy(false); }
  }
  async function handleUpdateContact(id, payload) {
    setBusy(true);
    try { await api.updateCalendarContact(id, payload); await loadBundle(); }
    catch (e) { await dialogAlert({ title: 'Save failed', message: String(e.message || e), severity: 'danger' }); }
    finally { setBusy(false); }
  }
  async function handleDeleteContact(id) {
    setBusy(true);
    try { await api.deleteCalendarContact(id); await loadBundle(); }
    catch (e) { await dialogAlert({ title: 'Delete failed', message: String(e.message || e), severity: 'danger' }); }
    finally { setBusy(false); }
  }

  // ── FullCalendar callbacks ──────────────────────────────────────────────

  function handleDatesSet(arg) {
    // FullCalendar tells us when the visible window changes (view switch,
    // prev/next, or jumpToDate). Capture it for the next bundle fetch.
    const from = arg.startStr.slice(0, 10);
    const to = arg.endStr.slice(0, 10);
    if (from !== visibleRange.from || to !== visibleRange.to) {
      setVisibleRange({ from, to });
    }
    try { localStorage.setItem(LS_LAST_VIEW, arg.view.type); } catch { /* ignore */ }
  }

  function handleDateClick(arg) {
    // Empty-day click → "what would you like to add?" picker prefilled to
    // the clicked date. Sub-modals consume defaultDate via initial.task_date.
    setAddPicker({ defaultDate: arg.dateStr });
  }

  function handleEventClick(clickInfo) {
    const ext = clickInfo.event.extendedProps;
    if (!ext) return;
    setDetail({ kind: ext.kind, raw: ext.raw });
  }

  async function handleEventDrop(dropInfo) {
    const ext = dropInfo.event.extendedProps;
    if (!ext) return;
    const newDate = dropInfo.event.startStr.slice(0, 10);
    try {
      if (ext.kind === 'task') {
        await api.updateCalendarTask(ext.raw.id, { task_date: newDate });
      } else if (ext.kind === 'event') {
        // Preserve duration when dragging a multi-day event by also
        // shifting end_date. FullCalendar applies the same delta to start
        // and end, so we recompute from the dropped event.
        const newEnd = dropInfo.event.end
          ? new Date(dropInfo.event.end.getTime() - 86400000).toISOString().slice(0, 10)
          : null;
        const patch = { event_date: newDate };
        if (ext.raw.end_date) patch.end_date = newEnd;
        await api.updateCalendarEvent(ext.raw.id, patch);
      } else {
        dropInfo.revert();
        return;
      }
      await loadBundle();
    } catch (e) {
      dropInfo.revert();
      await dialogAlert({ title: 'Move failed', message: String(e.message || e), severity: 'danger' });
    }
  }

  // Custom event chip content: title + creator initials badge (tasks/events).
  function renderEventContent(arg) {
    const ext = arg.event.extendedProps;
    const isTask = ext?.kind === 'task';
    const isEvent = ext?.kind === 'event';
    const isCompleted = isTask && ext.raw.is_completed;
    const wasRolled = isTask && ext.raw.original_task_date && ext.raw.original_task_date !== ext.raw.task_date;
    const creatorName = ext?.raw?.created_by_name;
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, width: '100%',
        textDecoration: isCompleted ? 'line-through' : 'none',
        opacity: isCompleted ? 0.7 : 1,
        fontSize: '0.78rem', lineHeight: 1.2,
      }}>
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {wasRolled ? '↻ ' : ''}{arg.event.title}
        </span>
        {(isTask || isEvent) && creatorName ? (
          <span
            style={S.badge}
            title={`Added by ${creatorName}`}
          >
            {initialsOf(creatorName)}
          </span>
        ) : null}
      </div>
    );
  }

  // ── Add-picker dispatch ─────────────────────────────────────────────────

  function openAddPicker() {
    setAddPicker({ defaultDate: null });
  }

  function handleAddPick(kind) {
    const defaultDate = addPicker?.defaultDate || todayISO();
    setAddPicker(null);
    if (kind === 'task') {
      setEditing({ kind: 'task', mode: 'create', raw: { task_date: defaultDate, priority: 'normal' } });
    } else if (kind === 'event') {
      setEditing({ kind: 'event', mode: 'create', raw: { event_date: defaultDate } });
    } else if (kind === 'bid') {
      setEditing({ kind: 'bid', mode: 'create', raw: { closing_date: defaultDate } });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="calendar-overlay" style={S.overlay}>
      {/* Header */}
      <div style={S.header}>
        <h2 style={S.title}>📅 Calendar</h2>
        <select
          value={createdByFilter}
          onChange={(e) => setCreatedByFilter(e.target.value)}
          style={S.select}
          title="Filter tasks & events by creator"
        >
          <option value="">Created by: All</option>
          {bundle.users.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
        <button type="button" style={S.ghost} onClick={() => setContactsOpen(true)}>
          📇 Contacts{bundle.contacts.length ? ` (${bundle.contacts.length})` : ''}
        </button>
        <button type="button" style={S.primary} onClick={openAddPicker}>+ Add</button>
        <div style={S.spacer} />
        {loading ? <span style={{ fontSize: '0.78rem', color: '#9ab1d6' }}>Loading…</span> : null}
        {error ? <span style={{ fontSize: '0.78rem', color: '#f87171' }}>{error}</span> : null}
        <button type="button" style={S.ghost} onClick={onClose} aria-label="Close calendar">✕ Close</button>
      </div>

      {/* Body */}
      <div style={S.body}>
        {/* Bids without a close date — bucket above the grid so they aren't lost */}
        {noDateBids.length > 0 ? (
          <div style={S.bidsBar}>
            <div style={{ fontSize: '0.78rem', color: '#c4b5fd', fontWeight: 600 }}>
              Open bids without a close date
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {noDateBids.map((b) => (
                <span
                  key={b.id}
                  style={S.bidChip}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetail({ kind: 'bid', raw: b })}
                  onKeyDown={(e) => { if (e.key === 'Enter') setDetail({ kind: 'bid', raw: b }); }}
                >
                  {b.bid_title}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div style={{ flex: 1, minHeight: 0, background: '#0f172a', borderRadius: 10, padding: 8 }}>
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
            initialView={initialView}
            headerToolbar={{
              left: 'prev,next today',
              center: 'title',
              right: isMobile
                ? 'listMonth,dayGridMonth'
                : 'dayGridMonth,timeGridWeek,timeGridDay,listMonth',
            }}
            events={calendarEvents}
            eventContent={renderEventContent}
            datesSet={handleDatesSet}
            dateClick={handleDateClick}
            eventClick={handleEventClick}
            eventDrop={handleEventDrop}
            editable
            height="100%"
            fixedWeekCount={false}
            dayMaxEvents={4}
            firstDay={1}
            // FullCalendar's all-day banner appears on time-grid views; for
            // an admin/office tasks-and-events surface we always treat
            // items as all-day. Disable time-pickers in the form modals.
            allDaySlot
          />
        </div>
      </div>

      {/* Add-type picker */}
      {addPicker ? (
        <AddPickerModal
          defaultDate={addPicker.defaultDate}
          onPick={handleAddPick}
          onClose={() => setAddPicker(null)}
        />
      ) : null}

      {/* Detail (click an existing event) */}
      {detail ? (
        <ItemDetailModal
          item={detail}
          busy={busy}
          onClose={() => setDetail(null)}
          onEdit={() => {
            const d = detail;
            setDetail(null);
            setEditing({ kind: d.kind, mode: 'edit', raw: d.raw });
          }}
          onDelete={async () => {
            if (detail.kind === 'task') await handleDeleteTask(detail.raw.id);
            else if (detail.kind === 'event') await handleDeleteEvent(detail.raw.id);
            else if (detail.kind === 'bid') await handleDeleteBid(detail.raw.id);
          }}
          onToggleComplete={async () => {
            if (detail.kind !== 'task') return;
            await handleUpdateTask(detail.raw.id, { is_completed: !detail.raw.is_completed });
          }}
          onDismissBid={async () => {
            if (detail.kind !== 'bid') return;
            await handleDismissBid(detail.raw);
          }}
        />
      ) : null}

      {/* Create / edit forms */}
      {editing?.kind === 'task' ? (
        <TaskFormModal
          initial={editing.mode === 'edit' ? editing.raw : { task_date: editing.raw.task_date, priority: 'normal' }}
          users={bundle.users}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(payload) => editing.mode === 'edit'
            ? handleUpdateTask(editing.raw.id, payload)
            : handleCreateTask(payload)}
          onDelete={editing.mode === 'edit' ? () => handleDeleteTask(editing.raw.id) : undefined}
        />
      ) : null}
      {editing?.kind === 'event' ? (
        <EventFormModal
          initial={editing.mode === 'edit' ? editing.raw : { event_date: editing.raw.event_date }}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(payload) => editing.mode === 'edit'
            ? handleUpdateEvent(editing.raw.id, payload)
            : handleCreateEvent(payload)}
          onDelete={editing.mode === 'edit' ? () => handleDeleteEvent(editing.raw.id) : undefined}
        />
      ) : null}
      {editing?.kind === 'bid' ? (
        <BidFormModal
          initial={editing.mode === 'edit' ? editing.raw : { closing_date: editing.raw.closing_date }}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(payload) => editing.mode === 'edit'
            ? handleUpdateBid(editing.raw.id, payload)
            : handleCreateBid(payload)}
          onDelete={editing.mode === 'edit' ? () => handleDeleteBid(editing.raw.id) : undefined}
        />
      ) : null}

      {/* Contacts side drawer */}
      {contactsOpen ? (
        <div style={S.modalBackdrop} onMouseDown={() => setContactsOpen(false)}>
          <ContactsDrawer
            contacts={bundle.contacts}
            clients={clients}
            busy={busy}
            onAdd={handleAddContact}
            onUpdate={handleUpdateContact}
            onDelete={handleDeleteContact}
            onClose={() => setContactsOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
