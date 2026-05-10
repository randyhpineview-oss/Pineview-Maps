import { useEffect, useMemo, useState } from 'react';

import AutocompleteInput from './AutocompleteInput';
import { useDialog } from './DialogProvider';

function buildEditState(pipeline) {
  return {
    name: pipeline?.name || '',
    client: pipeline?.client || '',
    area: pipeline?.area || '',
  };
}

export default function PipelineDetailSheet({
  pipeline,
  canManage = false,
  onSavePipeline,
  onDeletePipeline,
  onMarkInspection,
  // Pipeline-only entry for the "⚠ Issue with Pipeline" flow. Receives
  // (pipeline, reason). App.jsx routes this into segment-selection mode
  // ('issue') so the user picks a stretch on the map; the spray-confirm
  // popup that follows offers Yes-Fill-Sheet / Skip / Cancel applied to
  // that segment. The legacy inline Yes/Skip prompt that used to live
  // on this sheet is gone — the choice is now in the popup, after the
  // worker has actually selected the segment.
  onMarkIssueNotInspected,
  adminBusy = false,
  sprayRecords = [],
  onDeleteSprayRecord,
  highlightedSprayRecordId = null,
  onHighlightSprayRecord,
  onViewRecord,
  // Autofill data for the Client / Area edit fields. Optional — if a
  // parent doesn't pass them, the inputs degrade to plain text boxes
  // (AutocompleteInput's dropdown stays hidden when there are no
  // matching suggestions). Pipeline name stays plain because names
  // are unique to each pipeline.
  clientSuggestions = [],
  getAreasForClient,
}) {
  const { prompt } = useDialog();
  const [isEditing, setIsEditing] = useState(false);
  const [editState, setEditState] = useState(() => buildEditState(pipeline));

  useEffect(() => {
    setIsEditing(false);
    setEditState(buildEditState(pipeline));
  }, [pipeline?.id]);

  const totalCoverage = useMemo(() => {
    if (!sprayRecords.length) return 0;
    const ranges = sprayRecords
      .filter((r) => !r.is_avoided)
      .map((r) => [r.start_fraction, r.end_fraction])
      .sort((a, b) => a[0] - b[0]);
    if (!ranges.length) return 0;
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i][0] <= merged[merged.length - 1][1]) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], ranges[i][1]);
      } else {
        merged.push(ranges[i]);
      }
    }
    return Math.min(1, merged.reduce((sum, r) => sum + (r[1] - r[0]), 0));
  }, [sprayRecords]);

  const canSaveEdit = editState.name || editState.client || editState.area;

  async function handleSaveEdit() {
    if (!onSavePipeline || !pipeline) return;
    const wasSuccessful = await onSavePipeline(pipeline, {
      name: editState.name || null,
      client: editState.client || null,
      area: editState.area || null,
    });
    if (wasSuccessful) {
      setIsEditing(false);
    }
  }

  if (!pipeline) return null;

  const isSprayed = pipeline.status === 'sprayed';
  const statusColor = isSprayed ? '#22c55e' : '#ef4444';
  const statusLabel = isSprayed ? 'Sprayed' : 'Not Sprayed';

  return (
    <div className="panel" style={{ padding: 0 }}>
      {/* Header info */}
      <div style={{ padding: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>{pipeline.name || 'Unnamed Pipeline'}</h3>
          <span style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '0.75rem',
            fontWeight: 600,
            background: statusColor,
            color: '#fff',
          }}>
            {statusLabel}
          </span>
        </div>

        <div className="small-text" style={{ marginBottom: '0.25rem' }}>
          <strong>Client:</strong> {pipeline.client || '—'} &nbsp;|&nbsp; <strong>Area:</strong> {pipeline.area || '—'}
        </div>
        <div className="small-text" style={{ marginBottom: '0.25rem' }}>
          <strong>Length:</strong> {pipeline.total_length_km?.toFixed(2) || '?'} km &nbsp;|&nbsp;
          <strong>Points:</strong> {pipeline.simplified_point_count || '?'}
          {pipeline.original_point_count ? ` (from ${pipeline.original_point_count})` : ''}
        </div>
        {pipeline.approval_state === 'pending_review' && (
          <div className="small-text" style={{ color: '#fbbf24', marginBottom: '0.25rem' }}>
            ⏳ Pending approval
          </div>
        )}

        {/* Coverage bar */}
        <div style={{ marginTop: '0.5rem' }}>
          <div className="small-text" style={{ marginBottom: '0.25rem' }}>
            Spray coverage: {(totalCoverage * 100).toFixed(0)}%
            {pipeline.total_length_km ? ` (${(totalCoverage * pipeline.total_length_km).toFixed(2)} / ${pipeline.total_length_km.toFixed(2)} km)` : ''}
          </div>
          <div style={{
            width: '100%',
            height: '8px',
            background: 'rgba(255,255,255,0.1)',
            borderRadius: '4px',
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${totalCoverage * 100}%`,
              height: '100%',
              background: totalCoverage >= 0.95 ? '#22c55e' : '#f59e0b',
              borderRadius: '4px',
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ padding: '0 0.75rem 0.75rem' }}>
        <div className="button-row" style={{ marginBottom: '0.5rem' }}>
          <button
            className="primary-button"
            type="button"
            onClick={() => onMarkInspection?.(pipeline)}
            disabled={adminBusy || pipeline.approval_state === 'pending_review'}
            style={{ flex: 1 }}
          >
            Mark Inspection
          </button>
        </div>
        {/* "⚠ Issue with Pipeline" entry. After the reason prompt, App.jsx
            takes over: it puts the map into segment-selection mode and
            shows a confirm popup with Yes-Fill-Sheet / Skip / Cancel
            applied to whatever stretch the worker taps. The legacy
            inline Yes/Skip prompt that used to render here is gone — it
            forced the choice before the worker had picked a segment,
            which made the "Skip" path always cover the whole pipeline. */}
        <div className="button-row" style={{ marginBottom: '0.5rem' }}>
          <button
            className="secondary-button"
            type="button"
            disabled={adminBusy || pipeline.approval_state === 'pending_review'}
            style={{ flex: 1, background: '#64748b' }}
            onClick={async () => {
              // The prompt's `validate` hook collapses what used to be
              // two dialogs (window.prompt then a follow-up alert when
              // empty) into one round-trip — the error renders inline
              // below the input on Enter without dismissing.
              const reason = await prompt({
                title: 'Issue with pipeline',
                message: 'Why is there an issue with this pipeline? (This will be saved on the spray record so the next person can see why.)',
                placeholder: 'Reason',
                validate: (v) => v.trim() ? null : 'A reason is required.',
              });
              if (reason === null) return;
              onMarkIssueNotInspected?.(pipeline, reason);
            }}
          >
            ⚠ Issue with Pipeline
          </button>
        </div>

        {canManage && !isEditing && (
          <div className="button-row">
            <button className="secondary-button" type="button" onClick={() => setIsEditing(true)} style={{ flex: 1 }}>
              Edit
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={adminBusy}
              onClick={() => onDeletePipeline?.(pipeline)}
              style={{ flex: 1 }}
            >
              Delete
            </button>
          </div>
        )}

        {isEditing && (
          <div className="list-grid" style={{ marginTop: '0.5rem' }}>
            <input
              value={editState.name}
              onChange={(e) => setEditState((s) => ({ ...s, name: e.target.value }))}
              placeholder="Pipeline name"
            />
            {/* Autocomplete on Client / Area mirrors the in-map
                pipeline drawing form so an admin editing an existing
                pipeline gets the same spelling-consistency hints a
                worker does when drawing a new one. */}
            <AutocompleteInput
              value={editState.client}
              onChange={(next) => setEditState((s) => ({ ...s, client: next }))}
              placeholder="Client"
              suggestions={clientSuggestions}
            />
            <AutocompleteInput
              value={editState.area}
              onChange={(next) => setEditState((s) => ({ ...s, area: next }))}
              placeholder="Area"
              suggestions={getAreasForClient ? getAreasForClient(editState.client) : []}
            />
            <div className="button-row">
              <button className="primary-button" type="button" disabled={adminBusy} onClick={handleSaveEdit} style={{ flex: 1 }}>
                Save Changes
              </button>
              <button className="secondary-button" type="button" onClick={() => { setIsEditing(false); setEditState(buildEditState(pipeline)); }} style={{ flex: 1 }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Spray records */}
      {sprayRecords.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(143,182,255,0.1)', padding: '0.75rem' }}>
          <div className="small-text" style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
            Spray History ({sprayRecords.length})
          </div>
          <div className="list-grid">
            {sprayRecords.map((record) => {
              const isHighlighted = highlightedSprayRecordId === record.id;
              return (
                <div 
                  key={record.id} 
                  className="site-row" 
                  style={{ 
                    padding: '0.5rem',
                    background: isHighlighted ? 'rgba(234, 179, 8, 0.2)' : undefined,
                    border: isHighlighted ? '1px solid rgba(234, 179, 8, 0.5)' : undefined,
                    borderRadius: '6px',
                    cursor: 'pointer',
                  }}
                  onClick={() => onHighlightSprayRecord?.(isHighlighted ? null : record.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div className="small-text" style={{ fontWeight: 600 }}>
                        {record.spray_date} — {(() => {
                          const sectionLength = Math.abs(record.end_fraction - record.start_fraction) * (pipeline.total_length_km || 0);
                          return `${(sectionLength * 1000).toFixed(0)}m`;
                        })()}
                        {record.is_avoided ? ' (Not Sprayed/Issue)' : ''}
                        {record.lease_sheet_data ? ' 📄' : ''}
                      </div>
                      <div className="small-text">
                        By: {record.sprayed_by_name || 'Unknown'}
                        {record.ticket_number ? ` — Ticket: ${record.ticket_number}` : ''}
                        {record.notes ? ` — ${record.notes}` : ''}
                      </div>
                      {(record.lease_sheet_data || record.pdf_url) ? (
                        <div style={{ display: 'flex', gap: '6px', marginTop: '0.35rem', flexWrap: 'wrap' }}>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onViewRecord?.(record);
                            }}
                            style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                          >
                            📄 View
                          </button>
                          {record.pdf_url ? (
                            <a
                              href={record.pdf_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: '#3b82f6', textDecoration: 'underline', fontSize: '0.75rem', alignSelf: 'center' }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              Open PDF ↗
                            </a>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    {canManage && (
                      <button
                        className="danger-button"
                        type="button"
                        disabled={adminBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSprayRecord?.(record.id, pipeline.id);
                        }}
                        style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
