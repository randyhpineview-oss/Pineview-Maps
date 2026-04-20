import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import {
  DEFAULT_OFFICE_LINES,
  AUTO_LINE_LABELS,
  WORKER_EDITABLE_LINE_LABELS,
  migrateOfficeLineLabel,
  computeOfficeTotals,
  generateTMTicketPdf,
} from '../lib/tmTicketPdfGenerator';
import SignaturePadModal from './SignaturePadModal';
import PdfPreviewViewer from './PdfPreviewViewer';

const DEFAULT_LABELS_SET = new Set(DEFAULT_OFFICE_LINES.map((l) => l.label));

// Parse herbicide count from a row's herbicides text.
// '' → 0, 'N Herbicides' → N, anything else (single product name) → 1.
function herbicideCount(text) {
  if (!text) return 0;
  const m = String(text).match(/^(\d+)\s+Herbicides$/);
  if (m) return parseInt(m[1], 10);
  return 1;
}

// Derived QTY for the 4 auto-populated office lines.
// - 1/2/3 Herbicide (m²): sum area_ha × 10_000 for non-Roadside rows with that herbicide count.
// - Roadside/Access Rd Liters Applied: sum liters_used for Roadside rows.
function derivedQtyFor(label, rows) {
  const safe = rows || [];
  const main = safe.filter((r) => r.site_type !== 'Roadside');
  const sumAreaM2 = (count) =>
    main.filter((r) => herbicideCount(r.herbicides) === count)
      .reduce((s, r) => s + (Number(r.area_ha) || 0), 0) * 10000;
  switch (label) {
    case '1 Herbicide (m²)': return sumAreaM2(1);
    case '2 Herbicides (m²)': return sumAreaM2(2);
    case '3 Herbicides (m²)': return sumAreaM2(3);
    case 'Roadside/Access Rd Liters Applied':
      return safe.filter((r) => r.site_type === 'Roadside')
        .reduce((s, r) => s + (Number(r.liters_used) || 0), 0);
    default: return null;
  }
}

/**
 * Detail view for a Time & Materials ticket.
 * - Workers: see Sites Treated (read-only), Office Use ONLY with QTY-only editability on a fixed
 *   allowlist of lines; no rates or totals visible.
 * - Office/Admin: full edit including labels, rates, add/remove custom lines, totals, signature.
 */
export default function TMTicketDetailSheet({
  ticketId,
  onClose,
  roleCanAdmin = false,
  roleCanOffice = false,
  currentUserEmail = null,
}) {
  const canOfficeEdit = roleCanAdmin || roleCanOffice;
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSignatureOpen, setIsSignatureOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewBase64, setPreviewBase64] = useState(null);

  // Local editable state
  const [description, setDescription] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [officeLines, setOfficeLines] = useState(DEFAULT_OFFICE_LINES.map((l) => ({ ...l })));
  const [gstPercent, setGstPercent] = useState(5);
  const [rowsEdits, setRowsEdits] = useState({});  // rowId → { cost_code, ... }

  // Load ticket
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const t = await api.getTMTicket(ticketId);
        if (cancelled) return;
        setTicket(t);
        setDescription(t.description_of_work || '');
        setPoNumber(t.po_approval_number || '');
        // Seed office lines from saved data, or start from defaults.
        // Migrate any legacy labels (e.g. renamed roadside line) on the fly.
        const seed = t.office_data?.lines || DEFAULT_OFFICE_LINES;
        setOfficeLines(seed.map((l) => ({
          label: migrateOfficeLineLabel(l.label || ''),
          qty: l.qty ?? '',
          rate: l.rate ?? '',
        })));
        setGstPercent(Number(t.office_data?.gst_percent ?? 5));
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load ticket');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ticketId]);

  // Rows including any pending edits — used both in the UI render and as the
  // source of truth for derived auto-populated QTYs.
  const effectiveRows = useMemo(() => {
    return (ticket?.rows || []).map((r) => ({ ...r, ...(rowsEdits[r.id] || {}) }));
  }, [ticket?.rows, rowsEdits]);

  // Resolve the effective QTY for an office line, substituting the derived
  // value for auto-populated labels (workers cannot override these).
  const effectiveQtyOf = (line) => {
    if (AUTO_LINE_LABELS.includes(line.label)) {
      const d = derivedQtyFor(line.label, effectiveRows);
      return Number(d) || 0;
    }
    const q = parseFloat(line.qty);
    return Number.isFinite(q) ? q : 0;
  };

  // Totals always use effective (derived where applicable) QTY.
  const totals = useMemo(() => {
    const lines = officeLines.map((l) => ({ ...l, qty: effectiveQtyOf(l) }));
    return computeOfficeTotals({ lines, gst_percent: gstPercent });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officeLines, gstPercent, effectiveRows]);

  const updateLine = (idx, field, value) => {
    setOfficeLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  };

  const addOfficeLine = () => {
    setOfficeLines((prev) => [...prev, { label: '', qty: '', rate: '' }]);
  };

  const removeOfficeLine = (idx) => {
    setOfficeLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateRowEdit = (rowId, field, value) => {
    setRowsEdits((prev) => ({
      ...prev,
      [rowId]: { ...(prev[rowId] || {}), [field]: value },
    }));
  };

  const buildRowUpdates = () => {
    return Object.entries(rowsEdits).map(([id, fields]) => ({ id: Number(id), ...fields }));
  };

  // Build the office_data payload with derived QTY baked into auto-populated
  // lines, so the persisted value always matches what's shown in the UI.
  const buildOfficeDataPayload = () => ({
    lines: officeLines.map((l) => {
      if (AUTO_LINE_LABELS.includes(l.label)) {
        return { ...l, qty: derivedQtyFor(l.label, effectiveRows) ?? 0 };
      }
      return { ...l };
    }),
    gst_percent: gstPercent,
  });

  // ── Submission readiness ──
  // Only the 7 worker-editable field labels (truck, lead/assistant applicator,
  // UTV, backpack, H2S monitors, travel km) are REQUIRED before a ticket can
  // be submitted or approved. 0 is an acceptable value ("didn't use this item
  // today") — what we reject is empty/null/non-numeric. Auto-populated lines
  // are derived from the spray rows (always filled). Custom office-added
  // lines are optional pricing rows and not required. Matches the backend
  // _validate_ticket_ready_for_submission in time_materials_routes.py.
  const isQtyRequired = (line) => WORKER_EDITABLE_LINE_LABELS.includes(line.label);
  const isQtyFilled = (line) => {
    if (!isQtyRequired(line)) return true;
    if (line.qty === '' || line.qty === null || line.qty === undefined) return false;
    const n = Number(line.qty);
    return Number.isFinite(n);
  };
  const missingQtyLabels = useMemo(() => {
    return officeLines
      .filter((l) => isQtyRequired(l) && !isQtyFilled(l))
      .map((l) => l.label || '(unlabeled)');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officeLines]);
  const hasMissingQty = missingQtyLabels.length > 0;

  // Only tickets in "open" status can be submitted by the owning worker.
  // Office/admin go through the Approve flow instead.
  const canWorkerSubmit =
    !canOfficeEdit && ticket?.status === 'open';
  // Workers on submitted/approved tickets see everything read-only.
  const isWorkerReadOnly =
    !canOfficeEdit && ticket?.status !== 'open';

  // Whether THIS user should see the red asterisks on the 7 worker fields.
  // Workers always see them on their own open tickets. Office/admin also see
  // them whenever any of the 7 is empty, so they can fill in missing values
  // themselves if they happen to be the one completing the ticket in the field.
  const showMissingQtyHint = hasMissingQty && (canWorkerSubmit || canOfficeEdit);

  // Regenerate a PDF using the CURRENT edits (for preview + upload)
  const regenerateCurrentPdf = async (options = {}) => {
    if (!ticket) return null;
    const mergedTicket = {
      ...ticket,
      description_of_work: description,
      po_approval_number: poNumber,
      rows: effectiveRows,
      office_data: buildOfficeDataPayload(),
      ...options,
    };
    const { base64 } = await generateTMTicketPdf(mergedTicket, {
      // Office/admin PDFs show rates + totals; worker PDFs show QTY only (no pricing).
      includeOfficeData: canOfficeEdit,
      signaturePng: options.signaturePng || null,
    });
    return base64;
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const pdfBase64 = await regenerateCurrentPdf();
      const payload = {
        description_of_work: description,
        // Always send office_data — backend enforces allowlist for workers
        // (only QTY on worker-editable labels is accepted).
        office_data: buildOfficeDataPayload(),
      };
      if (canOfficeEdit) {
        payload.po_approval_number = poNumber;
        const rowUps = buildRowUpdates();
        if (rowUps.length > 0) payload.row_updates = rowUps;
      }
      if (pdfBase64) payload.pdf_base64 = pdfBase64;
      const updated = await api.updateTMTicket(ticket.id, payload);
      setTicket(updated);
      setRowsEdits({});
      alert('Saved.');
    } catch (e) {
      alert('Save failed: ' + (e.message || 'Unknown error'));
    } finally {
      setIsSaving(false);
    }
  };

  // Worker-only: submit an open ticket for office approval. Locks the ticket
  // on the worker's side (backend rejects further worker edits once
  // status=submitted). No PDF is uploaded to Dropbox yet \u2014 that happens on
  // the office's final Approve action. The ticket number is already assigned
  // from create time, so the worker keeps their HL/TM reference.
  const handleSubmit = async () => {
    if (hasMissingQty) {
      alert(
        'Fill in a quantity (use 0 if unused) for:\n\n\u2022 ' +
          missingQtyLabels.join('\n\u2022 ')
      );
      return;
    }
    if (!confirm(
      'Submit this ticket for office approval?\n\n'
      + 'You will no longer be able to edit it. Office will add pricing and finalize.'
    )) return;
    setIsSaving(true);
    try {
      const payload = {
        description_of_work: description,
        office_data: buildOfficeDataPayload(),
        status: 'submitted',
      };
      // Intentionally skip pdf_base64 \u2014 the backend doesn't upload to
      // Dropbox on worker submit; that's reserved for office approval.
      const updated = await api.updateTMTicket(ticket.id, payload);
      setTicket(updated);
      setRowsEdits({});
      alert('Ticket submitted for approval.');
    } catch (e) {
      alert('Submit failed: ' + (e.message || 'Unknown error'));
    } finally {
      setIsSaving(false);
    }
  };

  // Shared pre-approval check: same 7-field rule as worker submit. Office/
  // admin approving a ticket where the worker left qty blank gets the same
  // friendly list of what's missing rather than a silent 400 from the API.
  const guardMissingQtyForApproval = () => {
    if (!hasMissingQty) return true;
    alert(
      'Cannot approve — the following worker-filled quantities are still empty '
      + '(use 0 if unused):\n\n• ' + missingQtyLabels.join('\n• ')
    );
    return false;
  };

  const handleApproveWithSignature = async (signatureBase64) => {
    if (!guardMissingQtyForApproval()) {
      setIsSignatureOpen(false);
      return;
    }
    setIsSignatureOpen(false);
    setIsSaving(true);
    try {
      const sigDataUrl = `data:image/png;base64,${signatureBase64}`;
      const pdfBase64 = await regenerateCurrentPdf({ signaturePng: sigDataUrl });
      const payload = {
        description_of_work: description,
        po_approval_number: poNumber,
        office_data: buildOfficeDataPayload(),
        approved_signature: signatureBase64,
        approve: true,
      };
      const rowUps = buildRowUpdates();
      if (rowUps.length > 0) payload.row_updates = rowUps;
      if (pdfBase64) payload.pdf_base64 = pdfBase64;
      const updated = await api.updateTMTicket(ticket.id, payload);
      setTicket(updated);
      setRowsEdits({});
    } catch (e) {
      alert('Approval failed: ' + (e.message || 'Unknown error'));
    } finally {
      setIsSaving(false);
    }
  };

  // Office-only: flip an approved ticket back to "submitted" so corrections
  // can be made. Backend wipes approved_at / approved_by / approved_signature
  // on this transition so the next save regenerates a clean PDF.
  const handleUnapprove = async () => {
    if (!confirm('Unapprove this ticket? The signature and approval info will be cleared so it can be edited and re-approved.')) return;
    setIsSaving(true);
    try {
      const updated = await api.updateTMTicket(ticket.id, { status: 'submitted' });
      setTicket(updated);
      setRowsEdits({});
    } catch (e) {
      alert('Unapprove failed: ' + (e.message || 'Unknown error'));
    } finally {
      setIsSaving(false);
    }
  };

  // Office-only: permanently delete the ticket. Linked spray records are
  // unlinked (not deleted) by the backend, and T&M rows cascade via FK.
  const handleDelete = async () => {
    if (!confirm(`Delete T&M ticket ${ticket.ticket_number}?\n\nThis cannot be undone. Linked spray records are kept but unlinked from this ticket.`)) return;
    if (!confirm('Are you absolutely sure? This is permanent.')) return;
    setIsSaving(true);
    try {
      await api.deleteTMTicket(ticket.id);
      if (onClose) onClose();
    } catch (e) {
      alert('Delete failed: ' + (e.message || 'Unknown error'));
      setIsSaving(false);
    }
  };

  // Approve without drawing a signature — the PDF will have a blank signature
  // line so office can print and hand-sign after the fact.
  const handleApproveWithoutSignature = async () => {
    if (!guardMissingQtyForApproval()) return;
    if (!confirm('Approve this ticket without a signature? The PDF will have a blank signature line.')) return;
    setIsSaving(true);
    try {
      const pdfBase64 = await regenerateCurrentPdf();
      const payload = {
        description_of_work: description,
        po_approval_number: poNumber,
        office_data: buildOfficeDataPayload(),
        approve: true,
      };
      const rowUps = buildRowUpdates();
      if (rowUps.length > 0) payload.row_updates = rowUps;
      if (pdfBase64) payload.pdf_base64 = pdfBase64;
      const updated = await api.updateTMTicket(ticket.id, payload);
      setTicket(updated);
      setRowsEdits({});
    } catch (e) {
      alert('Approval failed: ' + (e.message || 'Unknown error'));
    } finally {
      setIsSaving(false);
    }
  };

  const handlePreviewPdf = async () => {
    try {
      const b64 = await regenerateCurrentPdf();
      setPreviewBase64(b64);
      setIsPreviewOpen(true);
    } catch (e) {
      alert('Preview failed: ' + (e.message || 'Unknown error'));
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '20px', color: '#9ca3af', textAlign: 'center' }}>Loading ticket…</div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: '20px', color: '#f87171', textAlign: 'center' }}>{error}</div>
    );
  }
  if (!ticket) return null;

  // ── PDF preview overlay ──
  if (isPreviewOpen) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: '#4b5563', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 16px', background: '#1f2937', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#f9fafb', fontWeight: 600 }}>T&M Preview — {ticket.ticket_number}</span>
          <button onClick={() => setIsPreviewOpen(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
        </div>
        <PdfPreviewViewer pdfBase64={previewBase64} />
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', color: '#f9fafb', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>T&M Ticket {ticket.ticket_number}</h2>
          <div style={{ fontSize: '0.85rem', color: '#9ca3af', marginTop: '4px' }}>
            {ticket.client} / {ticket.area} / {ticket.spray_date}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginTop: '2px' }}>
            Created by: {ticket.created_by_name || '—'} • Status:{' '}
            <span style={{ color: ticket.status === 'approved' ? '#22c55e' : '#3b82f6' }}>
              {ticket.status}
            </span>
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
      </div>

      {/* Description / PO# */}
      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', fontSize: '0.85rem', color: '#9ca3af', marginBottom: '4px' }}>Description of Work</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: '6px',
            border: '1px solid #374151', backgroundColor: '#111827', color: '#f9fafb', resize: 'vertical',
          }}
        />
      </div>
      {canOfficeEdit ? (
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '0.85rem', color: '#9ca3af', marginBottom: '4px' }}>PO/Approval #</label>
          <input
            value={poNumber}
            onChange={(e) => setPoNumber(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: '6px',
              border: '1px solid #374151', backgroundColor: '#111827', color: '#f9fafb',
            }}
          />
        </div>
      ) : null}

      {/* Sites Treated — read-only for workers (auto-filled from lease sheets).
          Office/admin can edit Cost Code. Area unit swaps to 'km' for Roadside rows. */}
      <h3 style={{ fontSize: '1rem', margin: '14px 0 6px' }}>Sites Treated ({ticket.rows?.length || 0})</h3>
      <div style={{ background: '#111827', borderRadius: '8px', overflow: 'hidden', border: '1px solid #374151' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.9fr 1.2fr 0.8fr 0.8fr 1fr', gap: '4px', padding: '8px', background: '#1f2937', fontSize: '0.75rem', fontWeight: 600, color: '#9ca3af' }}>
          <span>Location</span>
          <span>Type</span>
          <span>Herbicides</span>
          <span>(L) Used</span>
          <span>Area</span>
          <span>Cost Code</span>
        </div>
        {(ticket.rows || []).length === 0 ? (
          <div style={{ padding: '12px', color: '#9ca3af', fontSize: '0.85rem' }}>No rows yet.</div>
        ) : null}
        {(ticket.rows || []).map((r) => {
          const rowEdit = rowsEdits[r.id] || {};
          const isRoadside = r.site_type === 'Roadside';
          const unit = isRoadside ? 'km' : 'ha';
          return (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: '1.4fr 0.9fr 1.2fr 0.8fr 0.8fr 1fr',
              gap: '4px', padding: '8px', borderTop: '1px solid #374151', fontSize: '0.8rem', alignItems: 'center',
            }}>
              <span>{r.location || '—'}</span>
              <span>{r.site_type || '—'}</span>
              <span>{r.herbicides || '—'}</span>
              <span>{r.liters_used != null && r.liters_used !== '' ? Number(r.liters_used).toFixed(2) : '—'}</span>
              <span>{r.area_ha != null && r.area_ha !== '' ? `${Number(r.area_ha).toFixed(2)} ${unit}` : '—'}</span>
              {canOfficeEdit ? (
                <input
                  value={rowEdit.cost_code ?? (r.cost_code ?? '')}
                  onChange={(e) => updateRowEdit(r.id, 'cost_code', e.target.value)}
                  placeholder="—"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: '4px', border: '1px solid #374151', background: '#0b1220', color: '#f9fafb', fontSize: '0.75rem' }}
                />
              ) : (
                <span>{r.cost_code || '—'}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Office Use ONLY
          Workers: see this table, but rate + totals are hidden; QTY is editable
            only on the allowlisted labels; auto-populated lines show their
            derived quantity read-only.
          Office/Admin: full editability including labels, rates, add/remove lines. */}
      <h3 style={{ fontSize: '1rem', margin: '18px 0 6px' }}>Office Use ONLY</h3>
      <div style={{ background: '#111827', borderRadius: '8px', border: '1px solid #374151', overflow: 'hidden' }}>
        {/* Header row */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: canOfficeEdit ? '1.9fr 0.8fr 0.8fr 0.9fr 0.25fr' : '2.5fr 1fr',
          gap: '4px', padding: '8px', background: '#1f2937', fontSize: '0.75rem', fontWeight: 600, color: '#9ca3af',
        }}>
          <span>Line</span>
          <span>
            QTY
            {/* Red asterisk header hint when any of the 7 worker-required
                fields (truck, lead/assistant applicator, UTV, backpack, H2S,
                travel km) still has an empty qty. Visible to both worker
                (Submit is gated) AND office/admin (Approve is gated too). */}
            {showMissingQtyHint ? (
              <span style={{ color: '#f87171', marginLeft: '4px' }} title="Fill in every required quantity (use 0 if unused) before Submit/Approve">*</span>
            ) : null}
          </span>
          {canOfficeEdit ? <span>Rate</span> : null}
          {canOfficeEdit ? <span>Sub Total</span> : null}
          {canOfficeEdit ? <span></span> : null}
        </div>
        {officeLines.map((line, idx) => {
          const isAutoLine = AUTO_LINE_LABELS.includes(line.label);
          const isWorkerEditable = WORKER_EDITABLE_LINE_LABELS.includes(line.label);
          // Custom = anything not in the pre-seeded defaults, including newly-added blank rows.
          const isCustomLine = !DEFAULT_LABELS_SET.has(line.label);
          // Effective QTY: derived for auto-lines, else the typed value.
          const qty = effectiveQtyOf(line);
          const rate = parseFloat(line.rate) || 0;
          const sub = qty * rate;

          // Who can edit QTY here:
          //  - Auto-populated lines: nobody (always derived, read-only).
          //  - Office/admin: always.
          //  - Worker: only if label is in the worker allowlist.
          const qtyEditable = !isAutoLine && (canOfficeEdit || isWorkerEditable);

          // Label editability: office/admin only.
          const labelEditable = canOfficeEdit && !isAutoLine;

          return (
            <div key={idx} style={{
              display: 'grid',
              gridTemplateColumns: canOfficeEdit ? '1.9fr 0.8fr 0.8fr 0.9fr 0.25fr' : '2.5fr 1fr',
              gap: '4px', padding: '6px 8px', borderTop: '1px solid #374151', fontSize: '0.8rem', alignItems: 'center',
            }}>
              {/* Label */}
              {labelEditable ? (
                <input
                  value={line.label}
                  onChange={(e) => updateLine(idx, 'label', e.target.value)}
                  placeholder="Line item"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: '4px', border: '1px solid #374151', background: '#0b1220', color: '#f9fafb', fontSize: '0.75rem' }}
                />
              ) : (
                <span style={{ color: isAutoLine ? '#9ca3af' : '#f9fafb', fontStyle: isAutoLine ? 'italic' : 'normal' }}>
                  {line.label || '—'}
                </span>
              )}

              {/* QTY */}
              {qtyEditable ? (
                <div style={{ position: 'relative' }}>
                  <input
                    type="number" inputMode="decimal" step="0.01"
                    value={line.qty}
                    onChange={(e) => updateLine(idx, 'qty', e.target.value)}
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: '4px',
                      // Red outline on any empty REQUIRED worker field — visible
                      // to both worker and office/admin. Custom office-added
                      // lines are never required so they never go red.
                      border: isQtyRequired(line) && !isQtyFilled(line)
                        ? '1px solid #f87171'
                        : '1px solid #374151',
                      background: '#0b1220', color: '#f9fafb', fontSize: '0.75rem',
                    }}
                  />
                  {isQtyRequired(line) && !isQtyFilled(line) ? (
                    <span
                      aria-hidden="true"
                      title="Required \u2014 enter 0 if unused"
                      style={{
                        position: 'absolute', top: '2px', right: '6px',
                        color: '#f87171', fontWeight: 700, pointerEvents: 'none',
                      }}
                    >
                      *
                    </span>
                  ) : null}
                </div>
              ) : (
                <span style={{ color: isAutoLine ? '#60a5fa' : '#9ca3af' }}>
                  {qty > 0 ? qty.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
                </span>
              )}

              {/* Rate — office/admin only */}
              {canOfficeEdit ? (
                <input
                  type="number" inputMode="decimal" step="0.01"
                  value={line.rate}
                  onChange={(e) => updateLine(idx, 'rate', e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: '4px', border: '1px solid #374151', background: '#0b1220', color: '#f9fafb', fontSize: '0.75rem' }}
                />
              ) : null}

              {/* Sub Total — office/admin only */}
              {canOfficeEdit ? (
                <span style={{ textAlign: 'right', color: sub > 0 ? '#22c55e' : '#6b7280' }}>
                  {sub > 0 ? `$${sub.toFixed(2)}` : '—'}
                </span>
              ) : null}

              {/* Remove button — office/admin only, only on custom (non-default) lines */}
              {canOfficeEdit ? (
                isCustomLine ? (
                  <button
                    type="button"
                    onClick={() => removeOfficeLine(idx)}
                    aria-label="Remove line"
                    title="Remove this custom line"
                    style={{ background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '1rem', padding: 0 }}
                  >
                    ×
                  </button>
                ) : <span />
              ) : null}
            </div>
          );
        })}

        {/* Add Office Line — office/admin only */}
        {canOfficeEdit ? (
          <div style={{ padding: '8px', borderTop: '1px solid #374151', background: '#0b1220' }}>
            <button
              type="button"
              onClick={addOfficeLine}
              style={{
                width: '100%',
                padding: '6px',
                background: '#1f2937',
                border: '1px dashed #374151',
                borderRadius: '6px',
                color: '#60a5fa',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              + Add Office Line
            </button>
          </div>
        ) : null}

        {/* Totals — office/admin only */}
        {canOfficeEdit ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1.9fr 0.8fr 0.8fr 0.9fr 0.25fr', gap: '4px', padding: '6px 8px', borderTop: '1px solid #374151', fontSize: '0.8rem', alignItems: 'center', background: '#0b1220' }}>
              <span></span>
              <span></span>
              <span style={{ fontWeight: 600, color: '#9ca3af' }}>Sub Total</span>
              <span style={{ textAlign: 'right', fontWeight: 600 }}>${totals.subTotal.toFixed(2)}</span>
              <span></span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.9fr 0.8fr 0.8fr 0.9fr 0.25fr', gap: '4px', padding: '6px 8px', borderTop: '1px solid #374151', fontSize: '0.8rem', alignItems: 'center', background: '#0b1220' }}>
              <span></span>
              <span></span>
              <span style={{ fontWeight: 600, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: '6px' }}>
                GST
                <input
                  type="number" inputMode="decimal" step="0.1"
                  value={gstPercent}
                  onChange={(e) => setGstPercent(Number(e.target.value) || 0)}
                  style={{ width: '48px', padding: '2px 4px', borderRadius: '4px', border: '1px solid #374151', background: '#111827', color: '#f9fafb', fontSize: '0.75rem' }}
                />%
              </span>
              <span style={{ textAlign: 'right', fontWeight: 600 }}>${totals.gst.toFixed(2)}</span>
              <span></span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.9fr 0.8fr 0.8fr 0.9fr 0.25fr', gap: '4px', padding: '8px', borderTop: '1px solid #374151', fontSize: '0.9rem', alignItems: 'center', background: '#0f172a', fontWeight: 700 }}>
              <span></span>
              <span></span>
              <span>Total</span>
              <span style={{ textAlign: 'right', color: '#22c55e' }}>${totals.total.toFixed(2)}</span>
              <span></span>
            </div>
          </>
        ) : null}
      </div>

      {/* Approval info */}
      {ticket.status === 'approved' ? (
        <div style={{ marginTop: '14px', background: '#065f46', padding: '10px 12px', borderRadius: '6px', fontSize: '0.85rem' }}>
          ✓ Approved by {ticket.approved_by_name || '—'} on{' '}
          {ticket.approved_at ? new Date(ticket.approved_at).toLocaleString() : '—'}
        </div>
      ) : null}

      {/* Actions */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '18px' }}>
        <button
          onClick={handlePreviewPdf}
          style={{ flex: 1, padding: '12px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', minWidth: '120px' }}
        >
          📄 Preview PDF
        </button>
        {/* Save: hide for workers once the ticket leaves "open" — submitted
            and approved tickets are locked on the worker side. Office/admin
            can always save edits regardless of status. */}
        {(canOfficeEdit || canWorkerSubmit) ? (
          <button
            onClick={handleSave}
            disabled={isSaving}
            style={{ flex: 1, padding: '12px', background: isSaving ? '#374151' : '#22c55e', color: 'white', border: 'none', borderRadius: '8px', fontSize: '0.9rem', fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer', minWidth: '120px' }}
          >
            {isSaving ? 'Saving…' : '💾 Save'}
          </button>
        ) : null}
        {/* Worker Submit for Approval: only on their own open tickets. Disabled
            (but visible) until every required qty is filled, so the worker
            knows what's blocking them. Click on disabled state still shows
            the missing-field alert via handleSubmit's guard. */}
        {canWorkerSubmit ? (
          <button
            onClick={handleSubmit}
            disabled={isSaving || hasMissingQty}
            title={hasMissingQty ? `Fill in: ${missingQtyLabels.join(', ')}` : 'Submit for office approval'}
            style={{
              flex: 1, padding: '12px',
              background: (isSaving || hasMissingQty) ? '#374151' : '#0ea5e9',
              color: 'white', border: 'none', borderRadius: '8px',
              fontSize: '0.9rem', fontWeight: 600,
              cursor: (isSaving || hasMissingQty) ? 'not-allowed' : 'pointer',
              minWidth: '120px',
            }}
          >
            {isSaving ? 'Submitting…' : '📤 Submit for Approval'}
          </button>
        ) : null}
        {canOfficeEdit && ticket.status !== 'approved' ? (
          <button
            onClick={handleApproveWithoutSignature}
            disabled={isSaving}
            style={{ flex: 1, padding: '12px', background: isSaving ? '#374151' : '#f59e0b', color: 'white', border: 'none', borderRadius: '8px', fontSize: '0.9rem', fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer', minWidth: '120px' }}
          >
            ✓ Approve (no signature)
          </button>
        ) : null}
        {canOfficeEdit && ticket.status !== 'approved' ? (
          <button
            onClick={() => setIsSignatureOpen(true)}
            style={{ flex: 1, padding: '12px', background: '#8b5cf6', color: 'white', border: 'none', borderRadius: '8px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', minWidth: '120px' }}
          >
            ✍️ Sign & Approve
          </button>
        ) : null}
        {canOfficeEdit && ticket.status === 'approved' ? (
          <button
            onClick={handleUnapprove}
            disabled={isSaving}
            style={{ flex: 1, padding: '12px', background: isSaving ? '#374151' : '#f59e0b', color: 'white', border: 'none', borderRadius: '8px', fontSize: '0.9rem', fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer', minWidth: '120px' }}
          >
            ↩️ Unapprove
          </button>
        ) : null}
        {canOfficeEdit ? (
          <button
            onClick={handleDelete}
            disabled={isSaving}
            style={{ flex: 1, padding: '12px', background: isSaving ? '#374151' : '#dc2626', color: 'white', border: 'none', borderRadius: '8px', fontSize: '0.9rem', fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer', minWidth: '120px' }}
          >
            🗑️ Delete Ticket
          </button>
        ) : null}
      </div>

      {ticket.pdf_url ? (
        <a
          href={ticket.pdf_url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('&dl=0', '').replace('?dl=0', '?').replace(/[?&]$/, '')}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'inline-block', marginTop: '12px', color: '#60a5fa', fontSize: '0.85rem' }}
        >
          Open Dropbox PDF ↗
        </a>
      ) : null}

      {/* Signature Pad Modal */}
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
