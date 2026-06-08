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

// Two poll cadences, both paused while the screen is hidden:
//   - Overview (check-ins): SAFETY-CRITICAL and realtime delivery for
//     shifts/checkins is unreliable for a passive viewer (same reason the
//     admin OverviewTab keeps a 60 s poll + SW push alongside realtime), so
//     poll it fast. This is what makes "last check-in" feel live.
//   - Stats (donut + throughput): realtime works reliably for these tables,
//     so the poll is just a dropped-socket fallback — kept long for egress.
const OVERVIEW_POLL_MS = 30_000;
const STATS_POLL_MS = 5 * 60_000;
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
  // Track viewport width so the TV/desktop two-column layout collapses to a
  // single scrollable column on phones (iPhone PWA "glance" mode).
  const [vw, setVw] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  const isNarrow = vw < 760;

  const overviewTimerRef = useRef(null);
  const statsTimerRef = useRef(null);
  const overviewPollRef = useRef(null);
  const statsPollRef = useRef(null);

  // Two independent fetchers so a real-time event only re-pulls the half of
  // the board it affects (a check-in doesn't refetch the donut, etc.) —
  // roughly halves per-event egress on busy days.
  const fetchOverview = useCallback(async () => {
    try {
      const rows = await api.getTvCheckinOverview();
      setEntries(Array.isArray(rows) ? rows : []);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const statRes = await api.getTvStats({ day: localDateISO() });
      setStats(statRes || null);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    }
  }, []);

  const fetchAll = useCallback(() => Promise.all([fetchOverview(), fetchStats()]), [fetchOverview, fetchStats]);

  const scheduleOverview = useCallback(() => {
    if (overviewTimerRef.current) clearTimeout(overviewTimerRef.current);
    overviewTimerRef.current = setTimeout(() => {
      overviewTimerRef.current = null;
      fetchOverview();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchOverview]);

  const scheduleStats = useCallback(() => {
    if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
    statsTimerRef.current = setTimeout(() => {
      statsTimerRef.current = null;
      fetchStats();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchStats]);

  // Initial fetch + two safety-net polls (fast for check-ins, slow for
  // stats). Both only run while the screen is visible — an always-on TV
  // that's asleep/backgrounded burns no egress, and we do one immediate
  // full refetch the moment it wakes.
  useEffect(() => {
    fetchAll();

    const startPolls = () => {
      if (!overviewPollRef.current) overviewPollRef.current = setInterval(fetchOverview, OVERVIEW_POLL_MS);
      if (!statsPollRef.current) statsPollRef.current = setInterval(fetchStats, STATS_POLL_MS);
    };
    const stopPolls = () => {
      if (overviewPollRef.current) { clearInterval(overviewPollRef.current); overviewPollRef.current = null; }
      if (statsPollRef.current) { clearInterval(statsPollRef.current); statsPollRef.current = null; }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        fetchAll();
        startPolls();
      } else {
        stopPolls();
      }
    };

    if (document.visibilityState === 'visible') startPolls();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      stopPolls();
      if (overviewTimerRef.current) clearTimeout(overviewTimerRef.current);
      if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
    };
  }, [fetchAll, fetchOverview, fetchStats]);

  // Realtime: each table only refetches the half of the board it feeds.
  //   board (overview) -> shifts, checkins, devices
  //   donut + throughput (stats) -> sites, pipelines, site_spray_records,
  //                                 time_materials_tickets, hydroseed_daily_records
  // All of these are already in the Supabase `supabase_realtime` publication
  // (see database/enable_realtime.sql + hydroseed_setup.sql), so events
  // stream instantly; the poll above is just a dropped-socket fallback.
  useEffect(() => {
    if (!supabase) return undefined;
    const overviewTables = ['shifts', 'checkins', 'devices'];
    const statsTables = [
      'sites',
      'pipelines',
      'site_spray_records',
      'time_materials_tickets',
      'hydroseed_daily_records',
    ];
    let channel = supabase.channel('tv-dashboard');
    for (const table of overviewTables) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleOverview);
    }
    for (const table of statsTables) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleStats);
    }
    channel.subscribe();
    return () => {
      try { supabase.removeChannel(channel); } catch { /* ignore */ }
    };
  }, [scheduleOverview, scheduleStats]);

  // Service-worker push (check-in alert) → refresh the board half only.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return undefined;
    const onMessage = (event) => {
      const data = event && event.data;
      if (data && data.type === 'CHECKIN_ALERT') scheduleOverview();
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [scheduleOverview]);

  // 1 s tick: drives the wall clock + countdown digits + tier colours.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Track viewport width for the responsive (phone) layout switch.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
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
        display: 'flex', alignItems: 'center', gap: isNarrow ? 10 : 16,
        flexWrap: isNarrow ? 'wrap' : 'nowrap',
        padding: isNarrow
          ? 'calc(10px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right)) 10px calc(12px + env(safe-area-inset-left))'
          : 'calc(12px + env(safe-area-inset-top)) 22px 12px',
        background: t.cardBgRaised,
        borderBottom: `1px solid ${t.border}`, flexShrink: 0,
      }}>
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: isNarrow ? 8 : 12, fontSize: 'clamp(17px, 2vw, 26px)', fontWeight: 800, letterSpacing: 0.3 }}>
          <img
            src="/logo.png"
            alt="Pineview"
            style={{ height: isNarrow ? 26 : 'clamp(28px, 3vw, 42px)', width: 'auto', display: 'block' }}
          />
          Pineview Operations
        </h1>
        <div style={{ flex: 1 }} />
        <div style={{ textAlign: 'right', lineHeight: 1.15 }}>
          <div style={{ fontSize: isNarrow ? 18 : 'clamp(20px, 2.4vw, 34px)', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(isNarrow ? {} : { second: '2-digit' }) })}
          </div>
          {!isNarrow ? (
            <div style={{ fontSize: 'clamp(11px, 1vw, 14px)', color: t.textMuted }}>
              {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
            </div>
          ) : null}
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: isNarrow ? '5px 8px' : '6px 10px', borderRadius: 999,
          background: error ? t.dangerBg : t.successBg,
          border: `1px solid ${error ? t.dangerBorder : t.successBorder}`,
          fontSize: 12, color: error ? t.danger : t.success, whiteSpace: 'nowrap',
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: error ? t.danger : '#22c55e', display: 'inline-block',
          }} />
          {isNarrow
            ? (error ? 'Offline' : 'Live')
            : (error ? 'Connection issue' : (updatedAgo == null ? 'Loading…' : `Updated ${updatedAgo}s ago`))}
        </div>
        {isOverlay ? (
          <button
            type="button"
            onClick={onClose}
            style={{
              background: t.dangerStrong, color: '#fff', border: 'none',
              borderRadius: 8, padding: isNarrow ? '6px 10px' : '8px 14px', fontSize: 14,
              cursor: 'pointer', fontWeight: 700,
            }}
          >× {isNarrow ? '' : 'Close'}</button>
        ) : null}
      </header>

      {/* ── Body ───────────────────────────────────────────────── */}
      {/* Desktop/TV: two columns, each scrolls internally. Phone: one column
          that scrolls as a page, with the at-a-glance progress + throughput
          pulled to the top (order) above the check-ins list. */}
      <div style={{
        flex: 1, display: 'flex',
        flexDirection: isNarrow ? 'column' : 'row',
        gap: isNarrow ? 14 : 16,
        padding: isNarrow
          ? '12px 12px calc(16px + env(safe-area-inset-bottom)) 12px'
          : 16,
        minHeight: 0,
        overflowY: isNarrow ? 'auto' : 'hidden',
        WebkitOverflowScrolling: 'touch',
      }}>
        {/* Check-ins safety board */}
        <section style={{
          flex: isNarrow ? '0 0 auto' : '1 1 60%', display: 'flex', flexDirection: 'column',
          minWidth: 0, minHeight: 0, order: isNarrow ? 2 : 0,
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
          <div style={{
            flex: isNarrow ? 'none' : 1,
            overflowY: isNarrow ? 'visible' : 'auto',
            minHeight: 0,
          }}>
            {loading && entries.length === 0 ? (
              <div style={{ padding: 24, color: t.textMuted }}>Loading…</div>
            ) : visibleEntries.length === 0 ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: isNarrow ? 'auto' : '100%', padding: isNarrow ? 24 : 0,
                color: t.textMuted, fontSize: 16, textAlign: 'center',
              }}>
                No active shifts or truck assignments today.
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: isNarrow ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 12, alignContent: 'start',
              }}>
                {visibleEntries.map((entry) => (
                  <CheckinCard key={entry.user_id} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Progress donut + throughput */}
        <aside style={{
          flex: isNarrow ? '0 0 auto' : '1 1 40%', display: 'flex', flexDirection: 'column',
          gap: isNarrow ? 14 : 16, minWidth: isNarrow ? 0 : 300, minHeight: 0,
          order: isNarrow ? 1 : 0,
        }}>
          <div style={{
            background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 14,
            padding: isNarrow ? 14 : 18, display: 'flex', flexDirection: 'column', alignItems: 'center',
          }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 'clamp(15px, 1.5vw, 20px)', fontWeight: 700, alignSelf: 'flex-start' }}>
              Site inspection progress
            </h2>
            <Donut
              segments={siteSegments}
              size={isNarrow ? 190 : 230}
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
