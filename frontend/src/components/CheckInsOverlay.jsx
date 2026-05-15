/**
 * CheckInsOverlay — admin/office Check-ins Dashboard, full-page overlay.
 *
 * Lazy-loaded from App.jsx, opened from AdminPanel Tools row. Four tabs:
 *
 *   1. Active    (default)  Per-shift detail tiles for the workers who
 *                           are currently in the field. Heaviest admin
 *                           controls live here (force check-in, end
 *                           shift) which is why it leads.
 *   2. Overview             Same rich Active-style cards, plus a
 *                           slimmer card per truck-assigned worker who
 *                           hasn't started a shift yet. Shows everyone
 *                           the office needs to keep eyes on today.
 *   3. History              Date picker + compact rows. Click a row to
 *                           expand into the shift_changes audit timeline.
 *   4. Settings             Office alert recipients (primary + extras),
 *                           cadence preview, per-worker pref overview.
 *
 * Realtime: each tab manages its own subscription so we only refetch
 * what's visible. OverviewTab handles its own; ActiveTab/HistoryTab
 * subscribe locally.
 */
import { lazy, Suspense, useState } from 'react';

// ActiveTab is the default landing tab so we eager-import it; everything
// else stays lazy so the dashboard's initial JS chunk stays slim.
import ActiveTab from './CheckInsTabs/ActiveTab';

const OverviewTab = lazy(() => import('./OverviewTab'));
const HistoryTab = lazy(() => import('./CheckInsTabs/HistoryTab'));
const SettingsTab = lazy(() => import('./CheckInsTabs/SettingsTab'));

const TABS = [
  { id: 'active',   label: 'Active' },
  { id: 'overview', label: 'Overview' },
  { id: 'history',  label: 'History' },
  { id: 'settings', label: 'Settings' },
];

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
  tabBtn: (active) => ({
    background: active ? '#2563eb' : '#1e293b',
    color: active ? '#fff' : '#e5eefb',
    border: '1px solid ' + (active ? '#2563eb' : 'rgba(143,182,255,0.18)'),
    borderRadius: 8,
    padding: '6px 14px',
    fontSize: '0.85rem',
    cursor: 'pointer',
    fontWeight: active ? 600 : 500,
  }),
  closeBtn: {
    background: '#dc2626', color: '#fff', border: 'none',
    borderRadius: 8, padding: '6px 12px', fontSize: '0.82rem',
    cursor: 'pointer', fontWeight: 600,
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 18px',
    background: '#0b1220',
    color: '#e5eefb',
  },
};

export default function CheckInsOverlay({ onClose, isAdmin = true }) {
  const [activeTab, setActiveTab] = useState('active');

  return (
    <div style={S.overlay}>
      <header style={S.header}>
        <h2 style={S.title}>🛟 Check-ins Dashboard</h2>
        <nav style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              style={S.tabBtn(activeTab === t.id)}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span style={S.spacer} />
        <button type="button" style={S.closeBtn} onClick={onClose}>
          × Close
        </button>
      </header>
      <main style={S.body}>
        {activeTab === 'active' ? <ActiveTab isAdmin={isAdmin} /> : null}
        {activeTab === 'overview' ? (
          <Suspense fallback={<div style={{ padding: 24, color: '#9ab1d6' }}>Loading…</div>}>
            <OverviewTab isAdmin={isAdmin} />
          </Suspense>
        ) : null}
        {activeTab === 'history' ? (
          <Suspense fallback={<div style={{ padding: 24, color: '#9ab1d6' }}>Loading…</div>}>
            <HistoryTab />
          </Suspense>
        ) : null}
        {activeTab === 'settings' ? (
          <Suspense fallback={<div style={{ padding: 24, color: '#9ab1d6' }}>Loading…</div>}>
            <SettingsTab />
          </Suspense>
        ) : null}
      </main>
    </div>
  );
}
