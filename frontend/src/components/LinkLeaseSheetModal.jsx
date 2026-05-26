import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

const STATUS_OPTIONS = [
  { value: 'inspected', label: 'Mark as Inspected' },
  { value: 'in_progress', label: 'Inspected Not Complete' },
  { value: 'not_inspected', label: 'Mark Not Inspected' },
  { value: 'issue_not_inspected', label: 'Issue Not Inspected' },
];

export default function LinkLeaseSheetModal({ targetSite, onConfirm, onCancel }) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [records, setRecords] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedRecordId, setSelectedRecordId] = useState(null);
  const [targetStatus, setTargetStatus] = useState('inspected');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const searchRef = useRef(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    api.listStandaloneLeaseSheets(debouncedSearch || undefined)
      .then((data) => {
        if (!cancelled) setRecords(data || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Failed to load standalone lease sheets.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [debouncedSearch]);

  async function handleLink() {
    if (!selectedRecordId || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const updated = await api.moveSprayRecordToSite(selectedRecordId, targetSite.id, targetStatus);
      onConfirm(updated, targetStatus);
    } catch (err) {
      setError(err?.message || 'Failed to link lease sheet. Please try again.');
      setIsSubmitting(false);
    }
  }

  const selectedRecord = records.find((r) => r.id === selectedRecordId);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '1rem',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: '#1f2937',
          borderRadius: '12px',
          padding: '1.25rem',
          width: '100%',
          maxWidth: '520px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '1.05rem', color: '#f9fafb' }}>
            📥 Import Lease Sheet
          </h2>
          <button
            type="button"
            onClick={onCancel}
            style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.3rem', cursor: 'pointer', padding: '0 4px' }}
          >
            ✕
          </button>
        </div>

        <div style={{ fontSize: '0.8rem', color: '#9ca3af' }}>
          Linking to: <strong style={{ color: '#f9fafb' }}>
            {targetSite?.lsd || targetSite?.client || `Site #${targetSite?.id}`}
            {targetSite?.client ? ` — ${targetSite.client}` : ''}
            {targetSite?.area ? ` / ${targetSite.area}` : ''}
          </strong>
        </div>

        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by ticket #, LSD, client, area, worker…"
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: '6px',
            border: '1px solid #374151',
            background: '#111827',
            color: '#f9fafb',
            boxSizing: 'border-box',
            fontSize: '0.85rem',
          }}
        />

        <div style={{ flex: 1, overflowY: 'auto', minHeight: '80px', maxHeight: '35vh' }}>
          {isLoading && (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: '1rem', fontSize: '0.85rem' }}>
              Loading…
            </div>
          )}
          {!isLoading && error && (
            <div style={{ color: '#fca5a5', fontSize: '0.82rem', padding: '0.5rem' }}>{error}</div>
          )}
          {!isLoading && !error && records.length === 0 && (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: '1rem', fontSize: '0.85rem' }}>
              No standalone lease sheets found.
            </div>
          )}
          {!isLoading && !error && records.map((record) => {
            const isSelected = record.id === selectedRecordId;
            return (
              <div
                key={record.id}
                onClick={() => setSelectedRecordId(isSelected ? null : record.id)}
                style={{
                  padding: '0.6rem 0.75rem',
                  borderRadius: '8px',
                  marginBottom: '6px',
                  cursor: 'pointer',
                  border: `1px solid ${isSelected ? '#3b82f6' : '#374151'}`,
                  background: isSelected ? 'rgba(59,130,246,0.15)' : '#111827',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#f9fafb' }}>
                      {record.ticket_number || 'No Ticket'}
                      {isSelected && <span style={{ marginLeft: '8px', color: '#3b82f6', fontSize: '0.75rem' }}>✓ Selected</span>}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#d1d5db', marginTop: '2px' }}>
                      {record.spray_date} · {record.sprayed_by_name || 'Unknown applicator'}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '2px' }}>
                      {[record.site_lsd, record.site_client, record.site_area].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {selectedRecord && (
          <div>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#d1d5db', marginBottom: '6px' }}>
              Set pin status after linking:
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setTargetStatus(opt.value)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: '6px',
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                    border: `1px solid ${targetStatus === opt.value ? '#3b82f6' : '#374151'}`,
                    background: targetStatus === opt.value ? '#1d4ed8' : '#1f2937',
                    color: targetStatus === opt.value ? '#fff' : '#d1d5db',
                    transition: 'all 0.15s',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && !isLoading && (
          <div style={{ color: '#fca5a5', fontSize: '0.82rem' }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '7px 16px',
              borderRadius: '6px',
              background: '#374151',
              color: '#f9fafb',
              border: 'none',
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleLink}
            disabled={!selectedRecordId || isSubmitting}
            style={{
              padding: '7px 16px',
              borderRadius: '6px',
              background: selectedRecordId && !isSubmitting ? '#1d4ed8' : '#374151',
              color: '#fff',
              border: 'none',
              fontSize: '0.85rem',
              cursor: selectedRecordId && !isSubmitting ? 'pointer' : 'not-allowed',
              opacity: selectedRecordId && !isSubmitting ? 1 : 0.6,
              transition: 'all 0.15s',
            }}
          >
            {isSubmitting ? 'Linking…' : '📥 Link to This Pin'}
          </button>
        </div>
      </div>
    </div>
  );
}
