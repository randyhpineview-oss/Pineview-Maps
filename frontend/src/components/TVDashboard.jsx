/**
 * TVDashboard — polished, always-on "Operations TV" board.
 *
 * Two modes, one component:
 *   • Kiosk mode  (no `onClose` prop): full-screen, no close button. This
 *     is what the dedicated `tv` role boots into on login.
 *   • Overlay mode (`onClose` provided): identical board with an × Close
 *     button, opened by admin/office from their own login (AdminPanel
 *     Tools row → "📺 Operations TV").
 *
 * Layout (single screen, no scroll):
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ 📺 Pineview Operations        clock · date   ● updated  ×│
 *   ├────────────────────────────────┬────────────────────────┤
 *   │ Check-ins safety board (~60%)  │ Site progress donut     │
 *   │  worst-tier-first cards        │ Today's throughput tiles│
 *   └────────────────────────────────┴────────────────────────┘
 *
 * Data freshness mirrors OverviewTab.jsx exactly (the proven pattern):
 *   - initial fetch + 60 s poll fallback
 *   - Supabase Realtime on shifts/checkins/devices/sites (debounced)
 *   - refetch on visibilitychange
 *   - 1 s local tick so countdowns + tier colours update smoothly
 *
 * Read-only: hits only /api/tv/checkin-overview and /api/tv/stats. No
 * mutations anywhere, safe for the least-privileged `tv` role.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../lib/api';
import { supabase } from '../lib/supabaseClient';
import { hashToHslColor, initials } from '../lib/avatarColor';
import { tier as computeTier, tierColors, tierLabel, formatCountdown } from '../lib/compliance';
import { localDateISO } from '../lib/dateUtil';
import { t } from '../lib/checkinTheme';

const POLL_MS = 60_000;
const REFETCH_DEBOUNCE_MS = 500;

// Site-status display config for the donut + legend. Order = ring order.
// Colours mirror the map pins exactly (see statusFill in lib/mapUtils.js):
//   inspected   -> green  #22c55e
//   in_progress -> orange #f59e0b
//   not_inspected -> red  #ef4444
//   issue       -> gray   #94a3b8  (merges issue + issue_not_inspected)
const STATUS_META = [
  { key: 'inspected', label: 'Inspected', color: '#22c55e' },
  { key: 'in_progress', label: 'In progress', color: '#f59e0b' },
  { key: 'not_inspected', label: 'Not inspected', color: '#ef4444' },
  { key: 'issue', label: 'Issue', color: '#94a3b8', sumKeys: ['issue', 'issue_not_inspected'] },
];

function firstName(name) {
  const s = String(name ?? '').trim();
  return s ? s.split(/\s+/)[0] : '';
}
function fmtTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return '—'; }
}
function fmtRelative(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return `${hr} h ago`;
}

/**
 * Pure-SVG segmented donut. No external chart dependency.
 * @param segments [{ label, value, color }]
 */
function Donut({ segments, size = 230, stroke = 30, centerTop, centerBottom }) {
  const total = segments.reduce((acc, s) => acc + (s.value || 0), 0);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Site inspection progress">
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(143,182,255,0.10)"
          strokeWidth={stroke}
        />
        {total > 0 && segments.map((seg) => {
          const value = seg.value || 0;
          if (value <= 0) return null;
          const dash = (value / total) * circumference;
          const gap = circumference - dash;
          const offset = -((cumulative / total) * circumference);
          cumulative += value;
          return (
            <circle
              key={seg.key || seg.label}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${gap}`}
              strokeDashoffset={offset}
            />
          );
        })}
      </g>
      {/* Center label (drawn upright, no rotation) */}
      <text x="50%" y="46%" textAnchor="middle" dominantBaseline="middle" fill={t.text} fontSize={size * 0.22} fontWeight="700">
        {centerTop}
      </text>
      <text x="50%" y="62%" textAnchor="middle" dominantBaseline="middle" fill={t.textMuted} fontSize={size * 0.075} fontWeight="600">
        {centerBottom}
      </text>
    </svg>
  );
}

function ThroughputTile({ value, label, accent }) {
  return (
    <div style={{
      flex: 1,
      background: t.cardBg,
      border: `1px solid ${t.border}`,
      borderTop: `3px solid ${accent}`,
      borderRadius: 12,
      padding: '14px 10px',
      textAlign: 'center',
      minWidth: 0,
    }}>
      <div style={{ fontSize: 'clamp(28px, 4vw, 52px)', fontWeight: 800, color: t.text, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 'clamp(11px, 1vw, 14px)', color: t.textMuted, marginTop: 6, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function CheckinCard({ entry }) {
  const s = entry.shift;
  const tierValue = s ? computeTier(s, new Date()) : 'idle';
  const colors = tierColors(tierValue);
  const av = hashToHslColor(entry.avatar_seed || entry.display_name);
  // Registered crew (resolved {id,name,email}) + freeform crew (newline-
  // separated custom names typed by the worker). Show first names only.
  const registeredCrew = s && Array.isArray(s.crew_members) ? s.crew_members : [];
  const freeformCrew = s && s.crew_freeform
    ? String(s.crew_freeform).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  const crewNames = [
    ...registeredCrew.map((m, i) => ({ key: `u${m.id ?? i}`, name: firstName(m.name) })),
    ...freeformCrew.map((n, i) => ({ key: `f${i}`, name: firstName(n) })),
  ].filter((c) => c.name);

  return (
    <div style={{
      background: t.cardBg,
      borderRadius: 12,
      padding: 14,
      border: `2px solid ${colors.accent}`,
      boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
      color: t.text,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 44, height: 44, borderRadius: '50%',
          background: av.bg, color: av.fg, fontWeight: 700, fontSize: 16, flexShrink: 0,
        }}>{initials(entry.display_name)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 18, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{firstName(entry.display_name)}</div>
          <div style={{ fontSize: 12, color: t.textMuted }}>
            {s ? `Started ${fmtTime(s.started_at)}` : (entry.truck_label ? `🚚 ${entry.truck_label}` : 'Not started yet')}
          </div>
        </div>
        <span style={{
          background: colors.bg, color: colors.fg, padding: '5px 12px',
          borderRadius: 999, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap',
        }}>{tierLabel(tierValue)}</span>
      </div>

      {s ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, color: t.textSubtle }}>
          <span><strong style={{ color: t.text }}>Last:</strong> {fmtRelative(s.last_checkin_at)}</span>
          <span style={{ fontWeight: 700, color: colors.bg }}>{formatCountdown(s, new Date()) || '—'}</span>
        </div>
      ) : (
        <div style={{ fontSize: 13, color: t.textMuted }}>No shift started yet today.</div>
      )}

      {crewNames.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 5px', alignItems: 'center' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>Crew</span>
          {crewNames.map((c) => (
            <span
              key={c.key}
              style={{
                fontSize: 11, lineHeight: 1.3, color: t.textSubtle,
                background: 'rgba(143,182,255,0.08)', borderRadius: 4, padding: '1px 6px',
              }}
            >{c.name}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function TVDashboard({ onClose }) {
  const isOverlay = typeof onClose === 'function';

  const [entries, setEntries] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [now, setNow] = useState(() => new Date());

  const refetchTimerRef = useRef(null);
  const pollTimerRef = useRef(null);

  const fetchAll = useCallback(async () => {
    try {
      const [rows, statRes] = await Promise.all([
        api.getTvCheckinOverview(),
        api.getTvStats({ day: localDateISO() }),
      ]);
      setEntries(Array.isArray(rows) ? rows : []);
      setStats(statRes || null);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      fetchAll();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchAll]);

  // Initial fetch + 60 s poll.
  useEffect(() => {
    fetchAll();
    pollTimerRef.current = setInterval(fetchAll, POLL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, [fetchAll]);

  // Realtime: shifts/checkins/devices drive the board; sites drives the donut.
  useEffect(() => {
    if (!supabase) return undefined;
    const channel = supabase
      .channel('tv-dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'checkins' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sites' }, scheduleRefetch)
      .subscribe();
    return () => {
      try { supabase.removeChannel(channel); } catch { /* ignore */ }
    };
  }, [scheduleRefetch]);

  // Refetch when the tab/display becomes visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchAll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchAll]);

  // Service-worker push → instant refresh (same as OverviewTab).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return undefined;
    const onMessage = (event) => {
      const data = event && event.data;
      if (data && data.type === 'CHECKIN_ALERT') scheduleRefetch();
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [scheduleRefetch]);

  // 1 s tick: drives the wall clock + countdown digits + tier colours.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Server already sorts worst-tier-first; preserve that order.
  const visibleEntries = useMemo(() => entries, [entries]);

  const overdueCount = useMemo(
    () => entries.filter((e) => e.shift && computeTier(e.shift, now) === 'red').length,
    [entries, now],
  );

  const siteSegments = useMemo(() => {
    const ss = stats?.site_status || {};
    return STATUS_META.map((m) => {
      const keys = m.sumKeys || [m.key];
      const value = keys.reduce((acc, k) => acc + Number(ss[k] || 0), 0);
      return { ...m, value };
    });
  }, [stats]);

  const siteTotal = Number(stats?.site_status?.total || 0);
  const inspectedCount = Number(stats?.site_status?.inspected || 0);
  const pctComplete = siteTotal > 0 ? Math.round((inspectedCount / siteTotal) * 100) : 0;

  const updatedAgo = lastUpdated
    ? Math.max(0, Math.round((now.getTime() - lastUpdated.getTime()) / 1000))
    : null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: isOverlay ? 95 : 50,
      background: t.pageBg, color: t.text,
      display: 'flex', flexDirection: 'column',
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    }}>
      {/* ── Top bar ─────────────────────────────────────────────── */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '12px 22px', background: t.cardBgRaised,
        borderBottom: `1px solid ${t.border}`, flexShrink: 0,
      }}>
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 12, fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 800, letterSpacing: 0.3 }}>
          <img
            src="/logo.png"
            alt="Pineview"
            style={{ height: 'clamp(28px, 3vw, 42px)', width: 'auto', display: 'block' }}
          />
          Pineview Operations
        </h1>
        <div style={{ flex: 1 }} />
        <div style={{ textAlign: 'right', lineHeight: 1.15 }}>
          <div style={{ fontSize: 'clamp(20px, 2.4vw, 34px)', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
          <div style={{ fontSize: 'clamp(11px, 1vw, 14px)', color: t.textMuted }}>
            {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 10px', borderRadius: 999,
          background: error ? t.dangerBg : t.successBg,
          border: `1px solid ${error ? t.dangerBorder : t.successBorder}`,
          fontSize: 12, color: error ? t.danger : t.success, whiteSpace: 'nowrap',
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: error ? t.danger : '#22c55e', display: 'inline-block',
          }} />
          {error ? 'Connection issue' : (updatedAgo == null ? 'Loading…' : `Updated ${updatedAgo}s ago`)}
        </div>
        {isOverlay ? (
          <button
            type="button"
            onClick={onClose}
            style={{
              background: t.dangerStrong, color: '#fff', border: 'none',
              borderRadius: 8, padding: '8px 14px', fontSize: 14,
              cursor: 'pointer', fontWeight: 700,
            }}
          >× Close</button>
        ) : null}
      </header>

      {/* ── Body ───────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', gap: 16, padding: 16, minHeight: 0 }}>
        {/* Left: check-ins safety board */}
        <section style={{
          flex: '1 1 60%', display: 'flex', flexDirection: 'column',
          minWidth: 0, minHeight: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 'clamp(15px, 1.5vw, 20px)', fontWeight: 700 }}>🛟 Check-ins</h2>
            {overdueCount > 0 ? (
              <span style={{
                background: t.dangerStrong, color: '#fff', padding: '3px 12px',
                borderRadius: 999, fontSize: 14, fontWeight: 800,
              }}>{overdueCount} OVERDUE</span>
            ) : (
              <span style={{ color: t.textMuted, fontSize: 13 }}>
                {visibleEntries.length} on the board
              </span>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {loading && entries.length === 0 ? (
              <div style={{ padding: 24, color: t.textMuted }}>Loading…</div>
            ) : visibleEntries.length === 0 ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', color: t.textMuted, fontSize: 16, textAlign: 'center',
              }}>
                No active shifts or truck assignments today.
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 12, alignContent: 'start',
              }}>
                {visibleEntries.map((entry) => (
                  <CheckinCard key={entry.user_id} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Right: progress donut + throughput */}
        <aside style={{
          flex: '1 1 40%', display: 'flex', flexDirection: 'column',
          gap: 16, minWidth: 300, minHeight: 0,
        }}>
          <div style={{
            background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 14,
            padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center',
          }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 'clamp(15px, 1.5vw, 20px)', fontWeight: 700, alignSelf: 'flex-start' }}>
              Site inspection progress
            </h2>
            <Donut
              segments={siteSegments}
              centerTop={`${pctComplete}%`}
              centerBottom={`${inspectedCount} / ${siteTotal} inspected`}
            />
            {/* Legend */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 14px',
              marginTop: 14, width: '100%',
            }}>
              {siteSegments.map((seg) => (
                <div key={seg.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: t.textSubtle }}>
                  <span style={{ width: 12, height: 12, borderRadius: 3, background: seg.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{seg.label}</span>
                  <strong style={{ color: t.text }}>{seg.value}</strong>
                </div>
              ))}
            </div>
          </div>

          <div style={{
            background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 14, padding: 18,
          }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 'clamp(15px, 1.5vw, 20px)', fontWeight: 700 }}>
              Today’s throughput
            </h2>
            <div style={{ display: 'flex', gap: 12 }}>
              <ThroughputTile value={stats?.throughput?.lease_sheets ?? 0} label="Lease sheets" accent="#16a34a" />
              <ThroughputTile value={stats?.throughput?.tm_tickets ?? 0} label="T&M tickets" accent="#2563eb" />
              <ThroughputTile value={stats?.throughput?.hydroseed ?? 0} label="Hydroseed" accent="#0d9488" />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
