import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import {
  seedOfficeLinesFromTicketRows,
  syncOfficeLineQtysFromRows,
  computeOfficeTotals,
  generateHydroseedTicketPdf,
} from '../lib/hydroseedTicketPdfGenerator';
import { useDialog } from './DialogProvider';
import SignaturePadModal from './SignaturePadModal';
import PdfPreviewViewer from './PdfPreviewViewer';

const STATUS_LABELS = {
  open: 'Open',
  submitted: 'Submitted',
  approved: 'Approved',
};
const STATUS_COLORS = {
  open: { bg: '#3b82f6', text: '#fff' },
  submitted: { bg: '#eab308', text: '#1f2937' },
  approved: { bg: '#22c55e', text: '#fff' },
};

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

  // Local editable state
  const [description, setDescription] = useState('');
  const [client, setClient] = useState('');
  const [area, setArea] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [officeLines, setOfficeLines] = useState([]);
  const [gstPercent, setGstPercent] = useState(5);
  const [gstEnabled, setGstEnabled] = useState(true);

  const applyTicket = (t) => {
    if (!t) return;
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
    setOfficeLines(syncOfficeLineQtysFromRows(saved, t.rows).map(l => ({
      label: l.label || '',
      qty: l.qty ?? '',
      unit: l.unit || '',
      rate: l.rate ?? '',
    })));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const t = await api.getHydroseedTicket(ticketId);
        if (cancelled) return;
        applyTicket(t);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load ticket');
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
  };
  const addLine = () => {
    setOfficeLines(prev => [...prev, { label: '', qty: '', unit: '', rate: '' }]);
  };
  const removeLine = (idx) => {
    setOfficeLines(prev => prev.filter((_, i) => i !== idx));
  };

  // ── Payload assembly ─────────────────────────────────────────────────────
  const buildOfficeDataPayload = () => ({
    lines: officeLines.map(l => ({
      label: l.label || '',
      qty: l.qty === '' || l.qty == null ? null : Number(l.qty),
      unit: l.unit || '',
      rate: l.rate === '' || l.rate == null ? null : Number(l.rate),
    })),
    gst_percent: Number(gstPercent) || 0,
    gst_enabled: !!gstEnabled,
  });

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
      applyTicket(updated);
      onSaved?.(updated);
    } catch (e) {
      await alert({ title: 'Approve failed', message: String(e?.message || e), severity: 'danger' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleUnapprove = async () => {
    if (!canOfficeEdit) return;
    if (!(await confirm({
      title: 'Re-open this ticket?',
      message: 'This will remove the approval signature so it can be edited again.',
    }))) return;
    setIsSaving(true);
    try {
      const updated = await api.updateHydroseedTicket(ticket.id, { status: 'open' });
      applyTicket(updated);
      onSaved?.(updated);
    } catch (e) {
      await alert({ title: 'Could not re-open', message: String(e?.message || e), severity: 'danger' });
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
    setIsSaving(true);
    try {
      await api.deleteHydroseedTicket(ticket.id);
      onClose?.();
    } catch (e) {
      await alert({ title: 'Delete failed', message: String(e?.message || e), severity: 'danger' });
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
      <div style={{ padding: 24, color: '#9ca3af', textAlign: 'center' }}>
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
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: '#1f2937' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem', color: '#f9fafb' }}>
            Preview — {ticket.ticket_number}
          </h2>
          <button
            onClick={() => { setIsPreviewOpen(false); setPreviewBase64(null); }}
            style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}
          >×</button>
        </div>
        <PdfPreviewViewer pdfBase64={previewBase64} />
      </div>
    );
  }

  const statusBadge = STATUS_COLORS[status] || STATUS_COLORS.open;

  return (
    <div style={{
      backgroundColor: '#1f2937', color: '#f9fafb',
      maxHeight: '90vh', overflowY: 'auto', overflowX: 'hidden',
      padding: 20, maxWidth: 880, margin: '0 auto', width: '100%', boxSizing: 'border-box',
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
          <input type="text" value={client} onChange={e => setClient(e.target.value)} disabled={isReadOnly} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Area</label>
          <input type="text" value={area} onChange={e => setArea(e.target.value)} disabled={isReadOnly} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Work Date</label>
          <input type="text" value={String(ticket.work_date || '')} disabled style={{ ...inputStyle, opacity: 0.7 }} />
        </div>
        <div>
          <label style={labelStyle}>PO / Approval #</label>
          <input type="text" value={poNumber} onChange={e => setPoNumber(e.target.value)} disabled={isReadOnly} style={inputStyle} />
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>Description of Work</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
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

      {/* ── Office Use ── */}
      <h3 style={{ margin: '8px 0 6px', fontSize: '1rem' }}>Office Use ONLY</h3>
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
              onChange={e => updateLine(idx, { qty: e.target.value })}
              disabled={isReadOnly}
              style={{ ...inputStyle, textAlign: 'right' }}
            />
            <input
              type="text"
              value={line.unit}
              onChange={e => updateLine(idx, { unit: e.target.value })}
              disabled={isReadOnly}
              style={inputStyle}
            />
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
              onChange={e => setGstEnabled(e.target.checked)}
              disabled={isReadOnly}
            />
            Charge GST
          </label>
          <div>
            <input
              type="number" inputMode="decimal" min="0" step="0.1"
              value={gstPercent}
              onChange={e => setGstPercent(e.target.value)}
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

      {/* ── Actions ── */}
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
        {canOfficeEdit && !isApproved && (
          <button onClick={() => setIsSignatureOpen(true)} disabled={isSaving} style={{
            flex: 1, padding: 12, background: '#22c55e', color: 'white',
            border: 'none', borderRadius: 8, fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer',
          }}>Approve & Sign</button>
        )}
        {canOfficeEdit && isApproved && (
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
