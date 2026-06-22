import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { getHydroseedTicket, upsertHydroseedTicket, removeHydroseedTicket } from '../lib/offlineStore';
import {
  seedOfficeLinesFromTicketRows,
  syncOfficeLineQtysFromRows,
  computeOfficeTotals,
  generateHydroseedTicketPdf,
  OFFICE_UNIT_OPTIONS,
  getOfficeLineProductCategory,
  getOfficeLineKgPerUnit,
  isLegacyAutoSeededLabel,
} from '../lib/hydroseedTicketPdfGenerator';
import { useDialog } from './DialogProvider';
import SignaturePadModal from './SignaturePadModal';
import PdfPreviewViewer from './PdfPreviewViewer';

// Status labels mirror T&M herbicide so the office's mental model is
// the same across both ticket types: Open → Pending → Approved.
// (Backend value is still 'submitted' — the rename is UI-only.)
const STATUS_LABELS = {
  open: 'Open',
  submitted: 'Pending',
  approved: 'Approved',
};
const STATUS_COLORS = {
  open: { bg: '#3b82f6', text: '#fff' },
  submitted: { bg: '#eab308', text: '#1f2937' },
  approved: { bg: '#22c55e', text: '#fff' },
};

// Print a base64-encoded PDF via a hidden iframe. Same approach as
// QuoteBuilder — window.open() + onload.print() is unreliable in iOS
// PWAs and Chromium standalone mode (blob URL frequently fails to fire
// onload, leaving a blank window). The hidden iframe loads the PDF
// inside the current page's origin, which exposes a working print()
// on contentWindow on every browser we've tested.
function printPdfFromBase64(pdfBase64) {
  if (!pdfBase64) return;
  let bytes;
  try {
    const raw = atob(pdfBase64);
    bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  } catch {
    return;
  }
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  iframe.src = url;
  const cleanup = () => {
    try { iframe.remove(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  };
  iframe.onload = () => {
    setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        window.open(url, '_blank');
      }
    }, 200);
    setTimeout(cleanup, 60_000);
  };
  iframe.onerror = cleanup;
  document.body.appendChild(iframe);
}

// Convert a Dropbox share URL into a direct-content URL the browser
// will open inline (PDF viewer) instead of as a download. Same
// transform used by T&M tickets.
function dropboxDirectUrl(rawUrl) {
  if (!rawUrl) return '';
  return rawUrl
    .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
    .replace('&dl=0', '')
    .replace('?dl=0', '?')
    .replace(/[?&]$/, '');
}

const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: 6,
  color: '#f9fafb',
  fontSize: '0.9rem',
  boxSizing: 'border-box',
};
const labelStyle = { display: 'block', fontSize: '0.78rem', color: '#9ca3af', marginBottom: 4 };

function formatMoney(n) {
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

/**
 * Office-side detail / approve sheet for a HydroseedTicket (HT######).
 *
 * Differs from `TMTicketDetailSheet` in two big ways:
 *   1. Rolled-up rows are READ-ONLY. They come from
 *      `_aggregate_rows_from_daily()` on the server and refresh whenever a
 *      linked daily is created or edited. Office can't add manual rows here.
 *   2. `office_data.lines` are auto-seeded from those rows the first time
 *      the sheet opens. Office types Rate; QTY is editable too in case a
 *      manual adjustment is needed, but each save also re-syncs auto-rolled
 *      qtys for any line whose label still matches an aggregated row.
 *
 * Props:
 *   - ticketId: int
 *   - onClose(): closes the sheet
 *   - onSaved(updatedTicket): optional callback to refresh the parent list
 *   - roleCanAdmin / roleCanOffice: gate edit + approve actions
 *   - currentUserEmail: drives the "Save as my default signature" key
 */
export default function HydroseedTicketDetailSheet({
  ticketId,
  onClose,
  onSaved,
  roleCanAdmin = false,
  roleCanOffice = false,
  currentUserEmail = null,
}) {
  const { alert, confirm } = useDialog();
  const canOfficeEdit = roleCanAdmin || roleCanOffice;

  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSignatureOpen, setIsSignatureOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewBase64, setPreviewBase64] = useState(null);
  // Dirty flag — set whenever office data is edited locally but not yet
  // persisted. Used to hide the Dropbox PDF link (which reflects the last
  // saved version) so the user doesn't accidentally print a stale copy.
  const [isDirty, setIsDirty] = useState(false);

  // Local editable state
  const [description, setDescription] = useState('');
  const [client, setClient] = useState('');
  const [area, setArea] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [officeLines, setOfficeLines] = useState([]);
  // Labels the office intentionally removed from the office lines list.
  // Persisted on office_data.removed_labels so the sync function won't
  // re-add them from the aggregated daily rows after a save round-trip.
  const [removedLabels, setRemovedLabels] = useState([]);
  const [gstPercent, setGstPercent] = useState(5);
  const [gstEnabled, setGstEnabled] = useState(true);
  // Paper-form office-typed fields. `comments` is the free-text bottom
  // box on the printed ticket; `otherProducts` are the two optional
  // 'Other Product' rows in the materials/installation table (label +
  // qty + unit + rate, same shape as a regular office line).
  const [comments, setComments] = useState('');
  const [otherProducts, setOtherProducts] = useState([
    { label: '', qty: '', unit: '', rate: '' },
    { label: '', qty: '', unit: '', rate: '' },
  ]);

  const applyTicket = (t) => {
    if (!t) return;
    setIsDirty(false);  // fresh data from server — no unsaved changes
    setTicket(t);
    setDescription(t.description_of_work || '');
    setClient(t.client || '');
    setArea(t.area || '');
    setPoNumber(t.po_approval_number || '');
    setGstPercent(Number(t.office_data?.gst_percent ?? 5));
    setGstEnabled(t.office_data?.gst_enabled !== false);

    // Seed office lines: start with whatever's saved, then sync qtys from
    // the latest aggregated rows so newly-linked dailies show up.
    const saved = t.office_data?.lines && t.office_data.lines.length > 0
      ? t.office_data.lines
      : seedOfficeLinesFromTicketRows(t.rows);
    const serverRemoved = Array.isArray(t.office_data?.removed_labels)
      ? t.office_data.removed_labels
      : [];

    // removed_labels is persisted on office_data by the backend, so
    // serverRemoved is the authoritative source. Previously a "robust
    // diffing" block here added any aggregated row label not in saved to
    // computedRemoved — but that wrongly suppressed new rows from dailies
    // linked while the ticket was approved (the office never saw them,
    // let alone deleted them). Rely on serverRemoved only.
    const removedList = Array.from(new Set(serverRemoved));
    setRemovedLabels(removedList);
    setOfficeLines(syncOfficeLineQtysFromRows(saved, t.rows, new Set(serverRemoved)).map(l => ({
      label: l.label || '',
      qty: l.qty ?? '',
      unit: l.unit || '',
      rate: l.rate ?? '',
      isQtyOverridden: !!l.isQtyOverridden,
    })));

    setComments(t.office_data?.comments || '');
    // Hydrate the two Other Product slots; pad with blanks so the UI
    // always shows exactly two rows even when only one is saved.
    const savedOther = Array.isArray(t.office_data?.other_products)
      ? t.office_data.other_products
      : [];
    setOtherProducts([
      {
        label: savedOther[0]?.label || '',
        qty: savedOther[0]?.qty ?? '',
        unit: savedOther[0]?.unit || '',
        rate: savedOther[0]?.rate ?? '',
      },
      {
        label: savedOther[1]?.label || '',
        qty: savedOther[1]?.qty ?? '',
        unit: savedOther[1]?.unit || '',
        rate: savedOther[1]?.rate ?? '',
      },
    ]);
  };

  // Cache-first load — mirrors TMTicketDetailSheet.
  // 1. Read IDB first: if cached, render immediately and clear the spinner.
  // 2. In parallel, fetch the latest from the network: on success, replace
  //    state and warm the cache. On network error, only surface "failed"
  //    if we also don't have a cached copy.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      let haveCached = false;
      try {
        const cached = await getHydroseedTicket(ticketId);
        if (cached) {
          haveCached = true;
          applyTicket(cached);
          if (!cancelled) setLoading(false);
        }
      } catch { /* IDB error is non-fatal */ }

      try {
        const t = await api.getHydroseedTicket(ticketId);
        if (cancelled) return;
        applyTicket(t);
        try { await upsertHydroseedTicket(t); } catch { /* non-fatal */ }
      } catch (e) {
        if (e.status === 404 || e.status === 400) {
          try { await removeHydroseedTicket(ticketId); } catch { /* ignore */ }
          if (!cancelled) {
            await alert({
              title: 'Ticket not found',
              message: 'This ticket no longer exists on the server and has been removed from your offline cache.',
            });
            if (onClose) onClose();
          }
          return;
        }
        if (!cancelled && !haveCached) {
          setError(e.message || 'Failed to load ticket');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ticketId]);

  const totals = useMemo(
    () => computeOfficeTotals({
      lines: officeLines,
      gst_percent: gstPercent,
      gst_enabled: gstEnabled,
    }),
    [officeLines, gstPercent, gstEnabled],
  );

  const status = ticket?.status || 'open';
  const isApproved = status === 'approved';
  const isReadOnly = isApproved || !canOfficeEdit;

  // ── Office line editors ──────────────────────────────────────────────────
  const updateLine = (idx, patch) => {
    setOfficeLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
    if (patch.label != null && patch.label !== '') {
      const newLabel = String(patch.label).toLowerCase().trim();
      setRemovedLabels(prev => prev.filter(r => String(r).toLowerCase().trim() !== newLabel));
    }
    setIsDirty(true);
  };
  const addLine = () => {
    setOfficeLines(prev => [...prev, { label: '', qty: '', unit: '', rate: '', isQtyOverridden: true }]);
    setIsDirty(true);
  };
  const removeLine = (idx) => {
    setOfficeLines(prev => {
      const removed = prev[idx];
      // Track the removed label so syncOfficeLineQtysFromRows won't
      // re-add it from the aggregated daily rows on the next load.
      if (removed?.label) {
        setRemovedLabels(rl => {
          const lc = removed.label.toLowerCase().trim();
          return rl.some(r => r.toLowerCase().trim() === lc) ? rl : [...rl, removed.label];
        });
      }
      return prev.filter((_, i) => i !== idx);
    });
    setIsDirty(true);
  };

  // ── Payload assembly ─────────────────────────────────────────────────────
  const buildOfficeDataPayload = () => ({
    lines: officeLines.map(l => ({
      label: l.label || '',
      qty: l.qty === '' || l.qty == null ? null : Number(l.qty),
      unit: l.unit || '',
      rate: l.rate === '' || l.rate == null ? null : Number(l.rate),
      isQtyOverridden: !!l.isQtyOverridden,
    })),
    gst_percent: Number(gstPercent) || 0,
    gst_enabled: !!gstEnabled,
    // Labels the office intentionally removed. Persisted so they don't
    // reappear when syncOfficeLineQtysFromRows runs after the next load.
    removed_labels: removedLabels,
    // Paper-form fields. `comments` is plain text; `other_products` is
    // always serialized as a 2-element array (with blanks for unused
    // slots) so the PDF generator can index by position.
    comments: comments || '',
    other_products: otherProducts.map(op => ({
      label: op.label || '',
      qty: op.qty === '' || op.qty == null ? null : Number(op.qty),
      unit: op.unit || '',
      rate: op.rate === '' || op.rate == null ? null : Number(op.rate),
    })),
  });

  // Helper for the two Other Product rows.
  const updateOtherProduct = (idx, patch) => {
    setOtherProducts(prev => prev.map((op, i) => i === idx ? { ...op, ...patch } : op));
    setIsDirty(true);
  };

  // Re-generate the current PDF (used for both Preview and Approve).
  const regeneratePdf = async (options = {}) => {
    const mergedTicket = {
      ...ticket,
      description_of_work: description,
      client,
      area,
      po_approval_number: poNumber,
      office_data: buildOfficeDataPayload(),
    };
    const linkedRecordNumbers = (ticket?.daily_records || [])
      .map(d => d.record_number)
      .filter(Boolean);
    const { base64 } = await generateHydroseedTicketPdf(mergedTicket, {
      includeOfficeData: canOfficeEdit,
      signaturePng: options.signaturePng || null,
      linkedRecordNumbers,
    });
    return base64;
  };

  // ── Actions ──────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!canOfficeEdit) return;
    setIsSaving(true);
    try {
      const pdf = await regeneratePdf();
      const payload = {
        description_of_work: description,
        client,
        area,
        po_approval_number: poNumber,
        office_data: buildOfficeDataPayload(),
        pdf_base64: pdf,
      };
      const updated = await api.updateHydroseedTicket(ticket.id, payload);
      try { await upsertHydroseedTicket(updated); } catch { /* non-fatal cache refresh */ }
      applyTicket(updated);
      onSaved?.(updated);
    } catch (e) {
      await alert({ title: 'Save failed', message: String(e?.message || e), severity: 'danger' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleApproveWithSignature = async (signatureBase64) => {
    if (!canOfficeEdit) return;
    setIsSignatureOpen(false);
    setIsSaving(true);
    try {
      const sigDataUrl = `data:image/png;base64,${signatureBase64}`;
      const pdf = await regeneratePdf({ signaturePng: sigDataUrl });
      const payload = {
        description_of_work: description,
        client,
        area,
        po_approval_number: poNumber,
        office_data: buildOfficeDataPayload(),
        approved_signature: signatureBase64,
        approve: true,
        pdf_base64: pdf,
      };
      const updated = await api.updateHydroseedTicket(ticket.id, payload);
      try { await upsertHydroseedTicket(updated); } catch { /* non-fatal cache refresh */ }
      applyTicket(updated);
      onSaved?.(updated);
    } catch (e) {
      await alert({ title: 'Approve failed', message: String(e?.message || e), severity: 'danger' });
    } finally {
      setIsSaving(false);
    }
  };

  // Approve without drawing a signature — the PDF will have a blank
  // signature line so office can print and hand-sign after the fact.
  const handleApproveWithoutSignature = async () => {
    if (!canOfficeEdit) return;
    if (!(await confirm({
      title: 'Approve without signature',
      message: 'Approve this ticket without a signature? The PDF will have a blank signature line.',
      okLabel: 'Approve',
    }))) return;
    setIsSaving(true);
    try {
      const pdf = await regeneratePdf();
      const payload = {
        description_of_work: description,
        client,
        area,
        po_approval_number: poNumber,
        office_data: buildOfficeDataPayload(),
        approve: true,
        pdf_base64: pdf,
      };
      const updated = await api.updateHydroseedTicket(ticket.id, payload);
      try { await upsertHydroseedTicket(updated); } catch { /* non-fatal cache refresh */ }
      applyTicket(updated);
      onSaved?.(updated);
    } catch (e) {
      await alert({ title: 'Approval failed', message: String(e?.message || e), severity: 'danger' });
    } finally {
      setIsSaving(false);
    }
  };

  // Re-open transitions:
  //   Approved → Pending  (mirrors T&M handleUnapprove, so office can
  //                        tweak rates and re-approve in one extra click)
  //   Pending  → Open     (only fired by the office button; lets office
  //                        kick a ticket back to the worker if the rolled-up
  //                        rows are wrong)
  const handleUnapprove = async () => {
    if (!canOfficeEdit) return;
    const goingTo = isApproved ? 'submitted' : 'open';
    const message = isApproved
      ? 'This will clear the approval signature so the ticket can be edited and re-approved.'
      : 'This will move the ticket back to Open so the worker can revise it before resubmitting for approval.';
    if (!(await confirm({
      title: 'Re-open this ticket?',
      message,
    }))) return;
    setIsSaving(true);
    try {
      const updated = await api.updateHydroseedTicket(ticket.id, { status: goingTo });
      applyTicket(updated);
      onSaved?.(updated);
    } catch (e) {
      await alert({ title: 'Could not re-open', message: String(e?.message || e), severity: 'danger' });
    } finally {
      setIsSaving(false);
    }
  };

  // Worker (or office on the worker's behalf) flips Open → Pending. We
  // intentionally don't bundle a Save of office_data here — the worker
  // shouldn't be allowed to alter rates and the backend rejects that
  // field on worker writes anyway. We DO regenerate + send a fresh
  // pdf_base64 though: the backend's upload guard skips uploads while
  // the ticket is Open, so the very first Dropbox upload only happens
  // on the Open → Pending transition. Without a PDF in this payload
  // the ticket would stay Pending with pdf_url=NULL until the office
  // subsequently hit Save, which left the Dropbox link missing for
  // however long that took. Worker-generated PDFs carry
  // includeOfficeData=false (no rates) — the office will overwrite on
  // their next Save once they've typed pricing.
  const handleSubmitForApproval = async () => {
    if (!(await confirm({
      title: 'Submit for approval?',
      message: 'This moves the ticket to Pending so the office can finalize pricing and sign.',
    }))) return;
    setIsSaving(true);
    try {
      const pdf = await regeneratePdf();
      const updated = await api.updateHydroseedTicket(ticket.id, {
        status: 'submitted',
        pdf_base64: pdf,
      });
      applyTicket(updated);
      onSaved?.(updated);
    } catch (e) {
      await alert({ title: 'Submit failed', message: String(e?.message || e), severity: 'danger' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!roleCanAdmin) return;
    if (!(await confirm({
      title: 'Delete this ticket?',
      message: 'Linked dailies will be detached. This can be undone from the deleted tickets list.',
      severity: 'danger',
    }))) return;
    try {
      await api.deleteHydroseedTicket(ticket.id);
      try { await removeHydroseedTicket(ticket.id); } catch { /* ignore */ }
      onClose?.();
    } catch (e) {
      if (e.status === 404 || e.status === 400) {
        try { await removeHydroseedTicket(ticket.id); } catch { /* ignore */ }
        onClose?.();
      } else {
        await alert({ title: 'Delete failed', message: String(e?.message || e), severity: 'danger' });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handlePreview = async () => {
    try {
      const pdf = await regeneratePdf();
      setPreviewBase64(pdf);
      setIsPreviewOpen(true);
    } catch (e) {
      await alert({ title: 'Preview failed', message: String(e?.message || e), severity: 'danger' });
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ padding: 24, color: '#9ca3af', textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
        <span aria-hidden="true" style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid #374151', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        Loading ticket…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 24, color: '#f87171', textAlign: 'center' }}>
        {error}
        <div style={{ marginTop: 12 }}>
          <button onClick={onClose} style={{
            padding: '10px 18px', background: '#374151', color: '#f9fafb',
            border: 'none', borderRadius: 6, cursor: 'pointer',
          }}>Close</button>
        </div>
      </div>
    );
  }
  if (!ticket) return null;

  if (isPreviewOpen) {
    // Dropbox link — office/admin only. The stored PDF carries office
    // rates + signature once the ticket is past Open, which workers
    // must not see. Their preview is regenerated client-side without
    // that data.
    const dropboxHref = canOfficeEdit && ticket.pdf_url ? dropboxDirectUrl(ticket.pdf_url) : '';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: '#1f2937', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem', color: '#f9fafb' }}>
            Preview — {ticket.ticket_number}
          </h2>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => printPdfFromBase64(previewBase64)}
              disabled={!previewBase64}
              style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: '0.9rem', cursor: previewBase64 ? 'pointer' : 'not-allowed', padding: 0 }}
            >Print</button>
            {dropboxHref && !isDirty ? (
              <a
                href={dropboxHref}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#60a5fa', fontSize: '0.9rem', textDecoration: 'none' }}
              >
                Open Dropbox PDF ↗
              </a>
            ) : null}
            <button
              onClick={() => { setIsPreviewOpen(false); setPreviewBase64(null); }}
              style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer', padding: 0 }}
            >×</button>
          </div>
        </div>
        <PdfPreviewViewer pdfBase64={previewBase64} />
      </div>
    );
  }

  const statusBadge = STATUS_COLORS[status] || STATUS_COLORS.open;

  return (
    <div style={{
      backgroundColor: '#1f2937', color: '#f9fafb',
      flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
      // Pad the scrollable area's bottom so on iPhone Safari (where the
      // dynamic toolbar / home indicator overlap the bottom of a fixed
      // 100vh container) the action buttons (Approve / Save / Re-open)
      // stay scrollable into view above the unsafe area. Matches the
      // sticky-action-bar effect the Daily form gets via its internal
      // flex layout.
      padding: '20px 20px calc(env(safe-area-inset-bottom, 0px) + 32px)',
      maxWidth: 880, margin: '0 auto', width: '100%', boxSizing: 'border-box',
      borderRadius: '16px 16px 0 0',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 600 }}>
            Hydroseed Ticket — {ticket.ticket_number}
          </h2>
          <span style={{
            background: statusBadge.bg, color: statusBadge.text,
            padding: '2px 10px', borderRadius: 12, fontSize: '0.75rem', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: 0.4,
          }}>
            {STATUS_LABELS[status] || status}
          </span>
        </div>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: '#9ca3af',
          fontSize: '1.5rem', cursor: 'pointer',
        }}>×</button>
      </div>

      {/* ── Header fields ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <label style={labelStyle}>Customer</label>
          <input type="text" value={client} onChange={e => { setClient(e.target.value); setIsDirty(true); }} disabled={isReadOnly} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Area</label>
          <input type="text" value={area} onChange={e => { setArea(e.target.value); setIsDirty(true); }} disabled={isReadOnly} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Work Date</label>
          <input type="text" value={String(ticket.work_date || '')} disabled style={{ ...inputStyle, opacity: 0.7 }} />
        </div>
        <div>
          <label style={labelStyle}>PO / Approval #</label>
          <input type="text" value={poNumber} onChange={e => { setPoNumber(e.target.value); setIsDirty(true); }} disabled={isReadOnly} style={inputStyle} />
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>Description of Work</label>
        <textarea
          value={description}
          onChange={e => { setDescription(e.target.value); setIsDirty(true); }}
          disabled={isReadOnly}
          rows={2}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </div>

      {/* ── Linked dailies summary ── */}
      <div style={{ background: '#111827', borderRadius: 6, padding: 10, marginBottom: 14, fontSize: '0.85rem' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          Linked Dailies ({(ticket.daily_records || []).length})
        </div>
        {(ticket.daily_records || []).length > 0 ? (
          <div style={{ color: '#cbd5e1', fontSize: '0.8rem', marginBottom: 4 }}>
            {(ticket.daily_records || []).map(d => d.record_number).join(', ')}
          </div>
        ) : null}
        <div style={{ color: '#9ca3af' }}>
          QTY totals below auto-aggregate from each linked HD###### record. Workers
          can add more dailies to this ticket until it&apos;s approved.
        </div>
      </div>

      {/* ── Read-only rolled-up rows ── */}
      <h3 style={{ margin: '8px 0 6px', fontSize: '1rem' }}>Materials & Equipment Used</h3>
      <div style={{ background: '#111827', borderRadius: 6, overflow: 'hidden', marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 80px', padding: '8px 10px', background: '#0f172a', fontWeight: 600, fontSize: '0.8rem' }}>
          <div>Item</div>
          <div style={{ textAlign: 'right' }}>Quantity</div>
          <div>Unit</div>
        </div>
        {(ticket.rows || []).length === 0 ? (
          <div style={{ padding: 12, fontSize: '0.85rem', color: '#9ca3af' }}>
            No rows yet. Link a daily to populate this.
          </div>
        ) : (
          (ticket.rows || []).map((r) => (
            <div
              key={r.id}
              style={{
                display: 'grid', gridTemplateColumns: '1fr 100px 80px',
                padding: '8px 10px', fontSize: '0.85rem',
                borderTop: '1px solid #1f2937',
              }}
            >
              <div>{r.label}</div>
              <div style={{ textAlign: 'right' }}>
                {Number(r.qty).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
              <div>{r.unit}</div>
            </div>
          ))
        )}
      </div>

      {/* ── Paper-form fields (office-typed) ──
          Two Other Product slots + the bottom Comments box. These mirror
          the optional rows on the printed ticket; they're persisted on
          `office_data` so the PDF can render them in the combined
          materials/installation table and below it. Workers see the
          non-rate parts on their PDF preview but never the rates. */}
      <h3 style={{ margin: '8px 0 6px', fontSize: '1rem' }}>Paper-form fields</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 70px 90px 30px', gap: 6, fontSize: '0.78rem', color: '#9ca3af', marginBottom: 4, padding: '0 4px' }}>
        <div>Other Product</div>
        <div style={{ textAlign: 'right' }}>QTY</div>
        <div>Unit</div>
        <div style={{ textAlign: 'right' }}>Rate</div>
        <div />
      </div>
      {otherProducts.map((op, idx) => (
        <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 70px 90px 30px', gap: 6, marginBottom: 4 }}>
          <input
            type="text"
            value={op.label}
            onChange={e => updateOtherProduct(idx, { label: e.target.value })}
            disabled={isReadOnly}
            placeholder={`Other Product ${idx + 1}`}
            style={inputStyle}
          />
          <input
            type="number" inputMode="decimal" min="0" step="any"
            value={op.qty}
            onChange={e => updateOtherProduct(idx, { qty: e.target.value })}
            disabled={isReadOnly}
            style={{ ...inputStyle, textAlign: 'right' }}
          />
          <input
            type="text"
            value={op.unit}
            onChange={e => updateOtherProduct(idx, { unit: e.target.value })}
            disabled={isReadOnly}
            placeholder="kg / hr"
            style={inputStyle}
          />
          <input
            type="number" inputMode="decimal" min="0" step="any"
            value={op.rate}
            onChange={e => updateOtherProduct(idx, { rate: e.target.value })}
            disabled={isReadOnly}
            style={{ ...inputStyle, textAlign: 'right' }}
          />
          <div />
        </div>
      ))}
      <div style={{ marginTop: 10 }}>
        <label style={{ display: 'block', fontSize: '0.8rem', color: '#9ca3af', marginBottom: 4 }}>
          Comments
        </label>
        <textarea
          rows={3}
          value={comments}
          onChange={e => { setComments(e.target.value); setIsDirty(true); }}
          disabled={isReadOnly}
          placeholder="Notes that print at the bottom of the ticket…"
          style={{ ...inputStyle, resize: 'vertical', width: '100%' }}
        />
      </div>

      {/* ── Office Use ── */}
      <h3 style={{ margin: '14px 0 6px', fontSize: '1rem' }}>Office Use ONLY</h3>
      {!canOfficeEdit && (
        <div style={{
          background: '#7f1d1d33', color: '#fca5a5',
          padding: 8, borderRadius: 4, fontSize: '0.8rem', marginBottom: 8,
        }}>
          Only office / admin users can edit rates.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 70px 90px 90px 30px', gap: 6, fontSize: '0.78rem', color: '#9ca3af', marginBottom: 4, padding: '0 4px' }}>
        <div>Label</div>
        <div style={{ textAlign: 'right' }}>QTY</div>
        <div>Unit</div>
        <div style={{ textAlign: 'right' }}>Rate</div>
        <div style={{ textAlign: 'right' }}>Sub Total</div>
        <div />
      </div>
      {officeLines.map((line, idx) => {
        const qty = parseFloat(line.qty) || 0;
        const rate = parseFloat(line.rate) || 0;
        const sub = qty * rate;
        // Hide legacy auto-seeded rolled-up lines ('Mulch (bales)' /
        // 'Seed') from the editable UI when they're empty — the per-
        // product unit dropdown + per-seed-type lines have replaced
        // them. Lines that already carry a rate stay visible so the
        // office can manually migrate the rate onto the consolidated
        // line before deleting (otherwise we'd silently orphan an
        // already-entered rate).
        if (isLegacyAutoSeededLabel(line.label) && !(rate > 0)) {
          return null;
        }
        // Decide whether this line gets the unit dropdown (mulch /
        // seed: <name> / fertilizer) or the legacy free-text unit input.
        const productCategory = getOfficeLineProductCategory(line.label);
        const unitOptions = productCategory ? OFFICE_UNIT_OPTIONS[productCategory] : null;
        // Switching units re-derives qty via the kg total so the
        // displayed amount always represents the same physical
        // quantity — e.g. 1000 kg ↔ 44.05 bales — regardless of how
        // many times the office flips the dropdown.
        const handleUnitChange = (newUnit) => {
          const fromFactor = getOfficeLineKgPerUnit(productCategory, line.unit) || 1;
          const toFactor = getOfficeLineKgPerUnit(productCategory, newUnit) || 1;
          const currentQtyNum = parseFloat(line.qty);
          if (!Number.isFinite(currentQtyNum)) {
            updateLine(idx, { unit: newUnit });
            return;
          }
          const kgEquivalent = currentQtyNum * fromFactor;
          const newQty = Math.round((kgEquivalent / toFactor) * 100) / 100;
          updateLine(idx, { unit: newUnit, qty: newQty });
        };
        return (
          <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 70px 90px 90px 30px', gap: 6, marginBottom: 4 }}>
            <input
              type="text"
              value={line.label}
              onChange={e => updateLine(idx, { label: e.target.value })}
              disabled={isReadOnly}
              style={inputStyle}
            />
            <input
              type="number" inputMode="decimal" min="0" step="any"
              value={line.qty}
              onChange={e => updateLine(idx, { qty: e.target.value, isQtyOverridden: true })}
              disabled={isReadOnly}
              style={{ ...inputStyle, textAlign: 'right' }}
            />
            {unitOptions ? (
              <select
                value={unitOptions.some(o => o.value === line.unit) ? line.unit : (unitOptions[0]?.value || 'kg')}
                onChange={e => handleUnitChange(e.target.value)}
                disabled={isReadOnly}
                style={inputStyle}
                title={`Toggle billing unit for ${line.label} — qty re-derives automatically`}
              >
                {unitOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.value}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={line.unit}
                onChange={e => updateLine(idx, { unit: e.target.value })}
                disabled={isReadOnly}
                style={inputStyle}
              />
            )}
            <input
              type="number" inputMode="decimal" min="0" step="any"
              value={line.rate}
              onChange={e => updateLine(idx, { rate: e.target.value })}
              disabled={isReadOnly}
              style={{ ...inputStyle, textAlign: 'right' }}
            />
            <div style={{ ...inputStyle, textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
              {sub > 0 ? `$ ${formatMoney(sub)}` : ''}
            </div>
            {!isReadOnly ? (
              <button
                onClick={() => removeLine(idx)}
                title="Remove line"
                style={{
                  background: 'none', border: 'none', color: '#fca5a5',
                  cursor: 'pointer', fontSize: '1.1rem',
                }}
              >×</button>
            ) : <div />}
          </div>
        );
      })}
      {!isReadOnly && (
        <button onClick={addLine} style={{
          marginTop: 6, padding: '6px 12px',
          background: '#111827', border: '1px dashed #374151',
          color: '#f9fafb', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem',
        }}>+ Add line</button>
      )}

      {/* ── GST + totals ── */}
      <div style={{ marginTop: 14, padding: 12, background: '#111827', borderRadius: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}>
            <input
              type="checkbox"
              checked={gstEnabled}
              onChange={e => { setGstEnabled(e.target.checked); setIsDirty(true); }}
              disabled={isReadOnly}
            />
            Charge GST
          </label>
          <div>
            <input
              type="number" inputMode="decimal" min="0" step="0.1"
              value={gstPercent}
              onChange={e => { setGstPercent(e.target.value); setIsDirty(true); }}
              disabled={isReadOnly || !gstEnabled}
              style={{ ...inputStyle, width: 70, textAlign: 'right', display: 'inline-block' }}
            />
            <span style={{ marginLeft: 4 }}>%</span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 4, fontSize: '0.9rem' }}>
          <div>Sub Total</div>
          <div style={{ textAlign: 'right' }}>$ {formatMoney(totals.subTotal)}</div>
          {gstEnabled && (
            <>
              <div>GST ({totals.gstPercent}%)</div>
              <div style={{ textAlign: 'right' }}>$ {formatMoney(totals.gst)}</div>
            </>
          )}
          <div style={{ fontWeight: 700 }}>Total</div>
          <div style={{ textAlign: 'right', fontWeight: 700 }}>$ {formatMoney(totals.total)}</div>
        </div>
      </div>

      {/* Approval info — mirrors T&M herbicide green banner */}
      {ticket.status === 'approved' ? (
        <div style={{ marginTop: 14, background: '#065f46', padding: '10px 12px', borderRadius: 6, fontSize: '0.85rem' }}>
          ✓ Approved by {ticket.approved_by_name || '—'} on{' '}
          {ticket.approved_at ? new Date(ticket.approved_at).toLocaleString() : '—'}
        </div>
      ) : null}

      {/* ── Actions ──
          Workflow mirrors T&M herbicide:
            Open    → 'Submit for Approval'  (worker or office) → Pending
            Pending → 'Approve & Sign'       (office)            → Approved
            Pending → 'Re-open'              (office)            → Open
            Approved→ 'Re-open'              (office)            → Pending
          Save is available on Open and Pending for office (the office
          types rates after the worker has submitted). */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
        <button onClick={handlePreview} disabled={isSaving} style={{
          flex: 1, padding: 12, background: '#374151', color: '#f9fafb',
          border: 'none', borderRadius: 8, fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer',
        }}>Preview PDF</button>
        {canOfficeEdit && !isApproved && (
          <button onClick={handleSave} disabled={isSaving} style={{
            flex: 1, padding: 12, background: '#3b82f6', color: 'white',
            border: 'none', borderRadius: 8, fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer',
          }}>{isSaving ? 'Saving…' : 'Save'}</button>
        )}
        {status === 'open' && (
          <button onClick={handleSubmitForApproval} disabled={isSaving} style={{
            flex: 1, padding: 12, background: '#8b5cf6', color: 'white',
            border: 'none', borderRadius: 8, fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer',
            minWidth: 160,
          }}>Submit for Approval</button>
        )}
        {canOfficeEdit && status === 'submitted' && (
          <button onClick={() => setIsSignatureOpen(true)} disabled={isSaving} style={{
            flex: 1, padding: 12, background: '#22c55e', color: 'white',
            border: 'none', borderRadius: 8, fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer',
          }}>Approve & Sign</button>
        )}
        {canOfficeEdit && status === 'submitted' && (
          <button onClick={handleApproveWithoutSignature} disabled={isSaving} style={{
            flex: 1, padding: 12, background: '#16a34a', color: 'white',
            border: 'none', borderRadius: 8, fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer',
          }}>Approve (No Signature)</button>
        )}
        {canOfficeEdit && (status === 'submitted' || isApproved) && (
          <button onClick={handleUnapprove} disabled={isSaving} style={{
            flex: 1, padding: 12, background: '#eab308', color: '#1f2937',
            border: 'none', borderRadius: 8, fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer',
          }}>Re-open</button>
        )}
        {roleCanAdmin && (
          <button onClick={handleDelete} disabled={isSaving} style={{
            padding: 12, background: '#7f1d1d', color: 'white',
            border: 'none', borderRadius: 8, fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer',
          }}>Delete</button>
        )}
      </div>

      {/* Dropbox link — office/admin only, mirrors the T&M pattern. The
          stored PDF includes rates + signature, which workers must not
          see; their Preview button regenerates a clean copy on the fly.
          When there are unsaved changes we hide the link and show a
          warning instead — the stored PDF is stale and would show the
          old lines/dollars if printed directly from Dropbox. */}
      {canOfficeEdit && ticket.pdf_url && !isDirty ? (
        <a
          href={dropboxDirectUrl(ticket.pdf_url)}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'inline-block', marginTop: 12, color: '#60a5fa', fontSize: '0.85rem' }}
        >
          Open Dropbox PDF ↗
        </a>
      ) : canOfficeEdit && ticket.pdf_url && isDirty ? (
        <div style={{
          marginTop: 12, fontSize: '0.8rem', color: '#fbbf24',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          ⚠ Unsaved changes — use <strong>Preview PDF → Print</strong> to print the latest version.
          Save first to update the Dropbox copy.
        </div>
      ) : null}

      <SignaturePadModal
        isOpen={isSignatureOpen}
        onClose={() => setIsSignatureOpen(false)}
        onSave={handleApproveWithSignature}
        existingSignature={ticket.approved_signature || null}
        storageKey={currentUserEmail ? `pv.sig.${currentUserEmail.toLowerCase()}` : null}
      />
    </div>
  );
}
