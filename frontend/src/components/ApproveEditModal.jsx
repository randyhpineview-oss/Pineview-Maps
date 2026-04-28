import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { generateLeaseSheetPdf } from '../lib/pdfGenerator';
import { generateTMTicketPdf } from '../lib/tmTicketPdfGenerator';

/**
 * Admin "Approve & Edit" review modal.
 *
 * Contract (mirrors update_site_approval on the backend):
 *  - Fetches linked lease sheets up front so the admin sees the full blast
 *    radius before any API call fires.
 *  - Lets the admin edit lsd/client/area/gate_code/phone_number/notes.
 *  - Submit is ATOMIC: one POST /api/sites/{id}/approval with
 *    approval_state='approved', corrected fields, and (when meta
 *    changed) a spray_record_updates array carrying regenerated lease
 *    and T&M PDFs.
 *  - If the backend 409s with reason='shared_tm_ticket_needs_rehome',
 *    we surface a picker per conflicting spray record and resubmit with
 *    tm_link choices baked in.
 *
 * `kind` = 'site' | 'pipeline' — the pipeline variant uses `name` instead
 * of `lsd` but the flow is otherwise identical.
 */
export default function ApproveEditModal({
  kind = 'site',
  target,                // site or pipeline object (must have id + current fields)
  onClose,
  onSubmitted,           // called with the approved resource after success
}) {
  const isPipeline = kind === 'pipeline';
  const labels = isPipeline
    ? { title: 'Pipeline', locationKey: 'name', locationLabel: 'Name' }
    : { title: 'Pin', locationKey: 'lsd', locationLabel: 'LSD' };

  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState([]);  // [{ record, tmTicket }]
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [conflicts, setConflicts] = useState(null); // { shared_ticket_conflicts, open_tm_tickets }
  const [rehomeChoices, setRehomeChoices] = useState({}); // { [spray_record_id]: { ticket_id } | { create: true, description_of_work } }

  const [edits, setEdits] = useState(() => ({
    [labels.locationKey]: target[labels.locationKey] || '',
    client: target.client || '',
    area: target.area || '',
    gate_code: target.gate_code || '',
    phone_number: target.phone_number || '',
    notes: target.notes || '',
  }));

  function setField(k, v) { setEdits((p) => ({ ...p, [k]: v })); }

  const metaChanged = useMemo(() => {
    const currentLoc = target[labels.locationKey] || '';
    const editedLoc = edits[labels.locationKey] || '';
    return (
      editedLoc !== currentLoc
      || (edits.client || '') !== (target.client || '')
      || (edits.area || '') !== (target.area || '')
    );
  }, [edits, target, labels.locationKey]);

  // Load linked spray records (with lease_sheet_data) + their tickets.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        let summaries = [];
        if (isPipeline) {
          // Pipeline spray records come nested on the pipeline row; the
          // full pipeline fetch includes lease_sheet_data already.
          const full = await api.getPipeline?.(target.id).catch(() => null);
          summaries = full?.spray_records || target.spray_records || [];
        } else {
          summaries = await api.listSiteSprayRecords(target.id);
        }
        const detailed = await Promise.all(
          summaries.map(async (s) => {
            let full = s;
            if (!isPipeline && (!s.lease_sheet_data || typeof s.lease_sheet_data !== 'object')) {
              try { full = await api.getSiteSprayRecord(s.id); }
              catch { /* ignore — fall back to summary */ }
            }
            let tmTicket = null;
            if (full?.tm_ticket_id) {
              try { tmTicket = await api.getTMTicket(full.tm_ticket_id); }
              catch { /* ignore */ }
            }
            return { record: full, tmTicket };
          })
        );
        if (!cancelled) setRecords(detailed);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load linked lease sheets.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [target.id, isPipeline]);

  function classifyTicket(tmTicket, recordId) {
    if (!tmTicket || tmTicket.deleted_at) return 'none';
    // Same rule as backend classify_ticket_ownership: shared if ANY row
    // points at a different spray record; otherwise dedicated.
    const rows = tmTicket.rows || [];
    const ownKey = isPipeline ? 'pipeline_spray_record_id' : 'spray_record_id';
    const otherKey = isPipeline ? 'spray_record_id' : 'pipeline_spray_record_id';
    let foreign = 0;
    let own = 0;
    for (const r of rows) {
      if (r[ownKey] === recordId) own++;
      else if (r[ownKey] != null || r[otherKey] != null) foreign++;
    }
    if (foreign > 0) return 'shared';
    return own > 0 ? 'dedicated' : 'dedicated';
  }

  // Build and submit the approval payload. Includes regenerated PDFs
  // when metaChanged. If rehomeChoices is non-empty, bakes them into
  // per-record tm_link entries.
  async function buildAndSubmit() {
    setSubmitting(true);
    setError('');
    try {
      // Updated field map to stamp into lease_sheet_data for regen.
      const correctedData = {
        customer: edits.client || '',
        area: edits.area || '',
        lsdOrPipeline: edits[labels.locationKey] || '',
      };

      const spray_record_updates = [];
      let dedicated_tm_pdf_base64 = null;

      if (metaChanged) {
        for (const { record, tmTicket } of records) {
          const updatedLeaseData = {
            ...(record.lease_sheet_data || {}),
            ...correctedData,
          };

          // Regenerate lease-sheet PDF for this record.
          let lease_pdf_base64 = null;
          try {
            const ticketForPdf = record.ticket_number || updatedLeaseData.ticket_number || '';
            const { base64 } = await generateLeaseSheetPdf({
              ...updatedLeaseData,
              ticket_number: ticketForPdf,
            });
            lease_pdf_base64 = base64;
          } catch (err) {
            console.warn('[APPROVE] Lease PDF regen failed:', err?.message);
          }

          const ownership = classifyTicket(tmTicket, record.id);
          let tm_link = null;
          let tm_pdf_base64 = null;

          if (!record.is_avoided && ownership === 'shared') {
            // Require a re-home choice for each shared conflict.
            const choice = rehomeChoices[record.id];
            if (!choice) {
              // Submit without tm_link → backend will 409 and we'll
              // show the picker. That's the expected path on first
              // submission.
            } else {
              let tmPdfForLink = null;
              try {
                // Best-effort: render a tentative T&M PDF so Dropbox
                // has something current on Day 1 of the re-home.
                const derivedRow = {
                  location: updatedLeaseData.lsdOrPipeline || '',
                  site_type: isPipeline
                    ? 'Pipeline'
                    : (updatedLeaseData.mainSiteType || ''),
                  herbicides: (updatedLeaseData.herbicidesUsed || []).join(', '),
                  liters_used: Number(updatedLeaseData.totalLiters) || 0,
                  area_ha: Number(updatedLeaseData.areaTreated) || 0,
                };
                const tentative = choice.ticket_id
                  ? { /* backend will append; we render blank preview only */ }
                  : {
                      ticket_number: '',
                      spray_date: record.spray_date,
                      client: edits.client || '',
                      area: edits.area || '',
                      description_of_work: choice.description_of_work || '',
                      rows: [derivedRow],
                    };
                if (!choice.ticket_id) {
                  const { base64 } = await generateTMTicketPdf(tentative, { includeOfficeData: false });
                  tmPdfForLink = base64;
                }
              } catch (err) {
                console.warn('[APPROVE] T&M PDF regen (re-home) failed:', err?.message);
              }
              tm_link = {
                ticket_id: choice.ticket_id || null,
                create: !!choice.create,
                description_of_work: choice.description_of_work || null,
                tm_pdf_base64: tmPdfForLink,
              };
            }
          } else if (!record.is_avoided && ownership === 'dedicated' && tmTicket) {
            // Dedicated ticket: regenerate the T&M PDF with the corrected
            // header values. Backend will re-derive rows + upload.
            try {
              const correctedTicket = {
                ...tmTicket,
                client: edits.client || tmTicket.client,
                area: edits.area || tmTicket.area,
                rows: (tmTicket.rows || []).map((r) => ({
                  ...r,
                  location: updatedLeaseData.lsdOrPipeline || r.location,
                })),
              };
              const { base64 } = await generateTMTicketPdf(correctedTicket, { includeOfficeData: false });
              tm_pdf_base64 = base64;
              // Only need to send it once (first dedicated record wins).
              if (!dedicated_tm_pdf_base64) dedicated_tm_pdf_base64 = base64;
            } catch (err) {
              console.warn('[APPROVE] Dedicated T&M PDF regen failed:', err?.message);
            }
          }

          spray_record_updates.push({
            spray_record_id: record.id,
            lease_pdf_base64,
            tm_link,
            tm_pdf_base64,
          });
        }
      }

      const payload = {
        approval_state: 'approved',
        [labels.locationKey]: edits[labels.locationKey] || null,
        client: edits.client || null,
        area: edits.area || null,
        gate_code: edits.gate_code || null,
        phone_number: edits.phone_number || null,
        notes: edits.notes || null,
        spray_record_updates: metaChanged ? spray_record_updates : null,
        dedicated_tm_pdf_base64: metaChanged ? dedicated_tm_pdf_base64 : null,
      };

      const approved = isPipeline
        ? await api.approvePipeline(target.id, payload)
        : await api.approveSite(target.id, payload);
      onSubmitted?.(approved);
      onClose?.();
    } catch (err) {
      // Surface the 409 conflict detail so the admin can pick a re-home ticket.
      const detail = err?.detail || err?.response?.detail;
      if (detail && detail.reason === 'shared_tm_ticket_needs_rehome') {
        setConflicts(detail);
        setError('');
      } else {
        setError(err?.message || 'Approval failed.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function setRehomeChoice(recordId, choice) {
    setRehomeChoices((p) => ({ ...p, [recordId]: choice }));
  }

  const allConflictsResolved = conflicts
    ? (conflicts.shared_ticket_conflicts || []).every((c) => rehomeChoices[c.spray_record_id])
    : true;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: '1rem',
    }}>
      <div style={{
        background: 'var(--surface-elev)', color: 'var(--text-card)', borderRadius: 8,
        padding: '1.25rem', maxWidth: 640, width: '100%',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
      }}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Approve {labels.title} &amp; Edit</h2>
        <p className="small-text" style={{ marginTop: '0.25rem' }}>
          Review and correct the metadata before approval. Changes cascade
          to linked lease sheets and T&amp;M tickets.
        </p>

        {loading ? (
          <div style={{ marginTop: '1rem' }}>Loading linked lease sheets...</div>
        ) : (
          <>
            <div className="list-grid" style={{ marginTop: '0.75rem' }}>
              <label className="small-text">{labels.locationLabel}
                <input value={edits[labels.locationKey]}
                  onChange={(e) => setField(labels.locationKey, e.target.value)}
                  placeholder={labels.locationLabel} />
              </label>
              <label className="small-text">Client
                <input value={edits.client}
                  onChange={(e) => setField('client', e.target.value)}
                  placeholder="Client" />
              </label>
              <label className="small-text">Area
                <input value={edits.area}
                  onChange={(e) => setField('area', e.target.value)}
                  placeholder="Area" />
              </label>
              {!isPipeline ? (
                <>
                  <label className="small-text">Gate code
                    <input value={edits.gate_code}
                      onChange={(e) => setField('gate_code', e.target.value)}
                      placeholder="Gate code" />
                  </label>
                  <label className="small-text">Phone number
                    <input value={edits.phone_number}
                      onChange={(e) => setField('phone_number', e.target.value)}
                      placeholder="Phone number" />
                  </label>
                </>
              ) : null}
              <label className="small-text">Notes
                <textarea value={edits.notes}
                  onChange={(e) => setField('notes', e.target.value)}
                  rows={2} />
              </label>
            </div>

            {records.length > 0 ? (
              <div style={{ marginTop: '1rem' }}>
                <div className="small-text" style={{ fontWeight: 600 }}>
                  Linked lease sheets ({records.length})
                </div>
                {records.map(({ record, tmTicket }) => {
                  const ownership = classifyTicket(tmTicket, record.id);
                  return (
                    <div key={record.id} style={{
                      padding: '0.5rem', marginTop: '0.35rem',
                      background: 'var(--surface-card)', borderRadius: 6,
                      fontSize: '0.8rem',
                    }}>
                      <div><strong>{record.ticket_number || '(no ticket #)'}</strong>
                        {' • '}{String(record.spray_date).slice(0, 10)}
                        {record.is_avoided ? ' • (avoided)' : ''}
                      </div>
                      <div className="small-text">
                        T&amp;M: {tmTicket ? tmTicket.ticket_number : 'not linked'}
                        {' • '}ownership: {ownership}
                      </div>
                    </div>
                  );
                })}
                {metaChanged ? (
                  <div className="small-text" style={{ marginTop: '0.5rem', color: '#fbbf24' }}>
                    Metadata changed — lease-sheet PDFs will be regenerated and T&amp;M rows updated.
                  </div>
                ) : null}
              </div>
            ) : null}

            {conflicts ? (
              <div style={{
                marginTop: '1rem', padding: '0.75rem',
                background: 'var(--surface-card)', borderRadius: 6, border: '1px solid #fbbf24',
              }}>
                <div style={{ fontWeight: 600, color: '#fbbf24' }}>
                  Shared T&amp;M tickets need re-homing
                </div>
                <p className="small-text">
                  These lease sheets share a T&amp;M ticket with other lease
                  sheets on different sites. Pick a destination ticket for
                  each one, or create a new one for the corrected
                  client/area.
                </p>
                {(conflicts.shared_ticket_conflicts || []).map((c) => {
                  const choice = rehomeChoices[c.spray_record_id];
                  const matching = (conflicts.open_tm_tickets || []).filter(
                    (t) => t.spray_date === c.spray_date
                  );
                  return (
                    <div key={c.spray_record_id} style={{
                      marginTop: '0.5rem', padding: '0.5rem',
                      background: 'var(--surface-deep)', borderRadius: 4,
                    }}>
                      <div className="small-text">
                        Lease sheet {c.ticket_number || `#${c.spray_record_id}`}
                        {' • '}currently on {c.current_tm_ticket_number || `ticket ${c.current_tm_ticket_id}`}
                      </div>
                      <div className="button-row" style={{ flexWrap: 'wrap', marginTop: '0.35rem' }}>
                        {matching.map((t) => (
                          <button key={t.id} type="button"
                            className={choice?.ticket_id === t.id ? 'primary-button' : 'secondary-button'}
                            onClick={() => setRehomeChoice(c.spray_record_id, { ticket_id: t.id })}>
                            {t.ticket_number}
                          </button>
                        ))}
                        <button type="button"
                          className={choice?.create ? 'primary-button' : 'secondary-button'}
                          onClick={() => setRehomeChoice(c.spray_record_id, {
                            create: true, description_of_work: '',
                          })}>
                          + Create new ticket
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {error ? (
              <div className="small-text" style={{ marginTop: '0.75rem', color: '#f87171' }}>
                {error}
              </div>
            ) : null}

            <div className="button-row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button className="secondary-button" type="button"
                onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button className="primary-button" type="button"
                onClick={buildAndSubmit}
                disabled={submitting || !allConflictsResolved}>
                {submitting ? 'Approving...' : 'Confirm Approve'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
