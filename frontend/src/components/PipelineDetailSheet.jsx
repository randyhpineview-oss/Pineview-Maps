import { useEffect, useMemo, useState } from 'react';

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
  adminBusy = false,
  sprayRecords = [],
  onDeleteSprayRecord,
  highlightedSprayRecordId = null,
  onHighlightSprayRecord,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editState, setEditState] = useState(() => buildEditState(pipeline));

  useEffect(() => {
    setIsEditing(false);
    setEditState(buildEditState(pipeline));
  }, [pipeline?.id]);

  const totalCoverage = useMemo(() => {
    if (!sprayRecords.length) return 0;
    const ranges = sprayRecords
      .map((r) => [r.start_fraction, r.end_fraction])
      .sort((a, b) => a[0] - b[0]);
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
            <input
              value={editState.client}
              onChange={(e) => setEditState((s) => ({ ...s, client: e.target.value }))}
              placeholder="Client"
            />
            <input
              value={editState.area}
              onChange={(e) => setEditState((s) => ({ ...s, area: e.target.value }))}
              placeholder="Area"
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
                      {record.pdf_url && (
                        <div className="small-text" style={{ marginTop: '0.25rem' }}>
                          <a 
                            href={record.pdf_url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            style={{ color: '#3b82f6', textDecoration: 'underline' }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            📄 View Lease Sheet PDF
                          </a>
                        </div>
                      )}
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
