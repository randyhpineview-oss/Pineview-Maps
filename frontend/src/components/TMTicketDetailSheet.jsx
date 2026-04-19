import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { DEFAULT_OFFICE_LINES, computeOfficeTotals, generateTMTicketPdf } from '../lib/tmTicketPdfGenerator';
import SignaturePadModal from './SignaturePadModal';
import PdfPreviewViewer from './PdfPreviewViewer';

/**
 * Detail view for a Time & Materials ticket.
 * - Workers: read-only, no office_data, no signature fields.
 * - Office/Admin: editable Office Use ONLY lines, auto-computed totals, signature pad for approval.
 */
export default function TMTicketDetailSheet({
  ticketId,
  onClose,
  roleCanAdmin = false,
  roleCanOffice = false,
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
        const seed = t.office_data?.lines || DEFAULT_OFFICE_LINES;
        setOfficeLines(seed.map((l) => ({
          label: l.label || '',
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

  const totals = useMemo(
    () => computeOfficeTotals({ lines: officeLines, gst_percent: gstPercent }),
    [officeLines, gstPercent]
  );

  const updateLine = (idx, field, value) => {
    setOfficeLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
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

  // Regenerate a PDF using the CURRENT edits (for preview + upload)
  const regenerateCurrentPdf = async (options = {}) => {
    if (!ticket) return null;
    const mergedRows = (ticket.rows || []).map((r) => ({
      ...r,
      ...(rowsEdits[r.id] || {}),
    }));
    const mergedTicket = {
      ...ticket,
      description_of_work: description,
      po_approval_number: poNumber,
      rows: mergedRows,
      office_data: { lines: officeLines, gst_percent: gstPercent },
      ...options,
    };
    const { base64 } = await generateTMTicketPdf(mergedTicket, {
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
      };
      if (canOfficeEdit) {
        payload.po_approval_number = poNumber;
        payload.office_data = { lines: officeLines, gst_percent: gstPercent };
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

  const handleApproveWithSignature = async (signatureBase64) => {
    setIsSignatureOpen(false);
    setIsSaving(true);
    try {
      const sigDataUrl = `data:image/png;base64,${signatureBase64}`;
      const pdfBase64 = await regenerateCurrentPdf({ signaturePng: sigDataUrl });
      const payload = {
        description_of_work: description,
        po_approval_number: poNumber,
        office_data: { lines: officeLines, gst_percent: gstPercent },
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

      {/* Sites Treated */}
      <h3 style={{ fontSize: '1rem', margin: '14px 0 6px' }}>Sites Treated ({ticket.rows?.length || 0})</h3>
      <div style={{ background: '#111827', borderRadius: '8px', overflow: 'hidden', border: '1px solid #374151' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.9fr 1.2fr 0.8fr 0.8fr 1fr', gap: '4px', padding: '8px', background: '#1f2937', fontSize: '0.75rem', fontWeight: 600, color: '#9ca3af' }}>
          <span>Location</span>
          <span>Type</span>
          <span>Herbicides</span>
          <span>(L) Used</span>
          <span>Area (ha)</span>
          <span>Cost Code</span>
        </div>
        {(ticket.rows || []).length === 0 ? (
          <div style={{ padding: '12px', color: '#9ca3af', fontSize: '0.85rem' }}>No rows yet.</div>
        ) : null}
        {(ticket.rows || []).map((r) => {
          const rowEdit = rowsEdits[r.id] || {};
          return (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: '1.4fr 0.9fr 1.2fr 0.8fr 0.8fr 1fr',
              gap: '4px', padding: '8px', borderTop: '1px solid #374151', fontSize: '0.8rem', alignItems: 'center',
            }}>
              <span>{r.location || '—'}</span>
              <span>{r.site_type || '—'}</span>
              <span>{r.herbicides || '—'}</span>
              <span>{r.liters_used != null ? Number(r.liters_used).toFixed(2) : '—'}</span>
              <span>{r.area_ha != null ? Number(r.area_ha).toFixed(2) : '—'}</span>
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

      {/* Office Use ONLY — only for office/admin */}
      {canOfficeEdit ? (
        <>
          <h3 style={{ fontSize: '1rem', margin: '18px 0 6px' }}>Office Use ONLY</h3>
          <div style={{ background: '#111827', borderRadius: '8px', border: '1px solid #374151', overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 0.8fr 0.8fr 0.9fr', gap: '4px', padding: '8px', background: '#1f2937', fontSize: '0.75rem', fontWeight: 600, color: '#9ca3af' }}>
              <span>Line</span>
              <span>QTY</span>
              <span>Rate</span>
              <span>Sub Total</span>
            </div>
            {officeLines.map((line, idx) => {
              const qty = parseFloat(line.qty) || 0;
              const rate = parseFloat(line.rate) || 0;
              const sub = qty * rate;
              return (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '2fr 0.8fr 0.8fr 0.9fr', gap: '4px', padding: '6px 8px', borderTop: '1px solid #374151', fontSize: '0.8rem', alignItems: 'center' }}>
                  <span>{line.label}</span>
                  <input
                    type="number" inputMode="decimal" step="0.01"
                    value={line.qty}
                    onChange={(e) => updateLine(idx, 'qty', e.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: '4px', border: '1px solid #374151', background: '#0b1220', color: '#f9fafb', fontSize: '0.75rem' }}
                  />
                  <input
                    type="number" inputMode="decimal" step="0.01"
                    value={line.rate}
                    onChange={(e) => updateLine(idx, 'rate', e.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: '4px', border: '1px solid #374151', background: '#0b1220', color: '#f9fafb', fontSize: '0.75rem' }}
                  />
                  <span style={{ textAlign: 'right', color: sub > 0 ? '#22c55e' : '#6b7280' }}>
                    {sub > 0 ? `$${sub.toFixed(2)}` : '—'}
                  </span>
                </div>
              );
            })}
            {/* Totals */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 0.8fr 0.8fr 0.9fr', gap: '4px', padding: '6px 8px', borderTop: '1px solid #374151', fontSize: '0.8rem', alignItems: 'center', background: '#0b1220' }}>
              <span></span>
              <span></span>
              <span style={{ fontWeight: 600, color: '#9ca3af' }}>Sub Total</span>
              <span style={{ textAlign: 'right', fontWeight: 600 }}>${totals.subTotal.toFixed(2)}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 0.8fr 0.8fr 0.9fr', gap: '4px', padding: '6px 8px', borderTop: '1px solid #374151', fontSize: '0.8rem', alignItems: 'center', background: '#0b1220' }}>
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
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 0.8fr 0.8fr 0.9fr', gap: '4px', padding: '8px', borderTop: '1px solid #374151', fontSize: '0.9rem', alignItems: 'center', background: '#0f172a', fontWeight: 700 }}>
              <span></span>
              <span></span>
              <span>Total</span>
              <span style={{ textAlign: 'right', color: '#22c55e' }}>${totals.total.toFixed(2)}</span>
            </div>
          </div>
        </>
      ) : null}

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
        <button
          onClick={handleSave}
          disabled={isSaving}
          style={{ flex: 1, padding: '12px', background: isSaving ? '#374151' : '#22c55e', color: 'white', border: 'none', borderRadius: '8px', fontSize: '0.9rem', fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer', minWidth: '120px' }}
        >
          {isSaving ? 'Saving…' : '💾 Save'}
        </button>
        {canOfficeEdit && ticket.status !== 'approved' ? (
          <button
            onClick={() => setIsSignatureOpen(true)}
            style={{ flex: 1, padding: '12px', background: '#8b5cf6', color: 'white', border: 'none', borderRadius: '8px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', minWidth: '120px' }}
          >
            ✍️ Sign & Approve
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
      />
    </div>
  );
}
