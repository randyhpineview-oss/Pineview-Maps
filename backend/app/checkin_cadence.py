"""Single source of truth for check-in compliance math.

Used by:
  * ``checkin_routes.py``       -- shift-start deadline math, scan endpoint
  * ``push_service.py`` callers -- urgent flag on payload
  * Frontend `compliance.js`    -- mirrors these constants in JS so the
                                    countdown pill and forced-overlay
                                    threshold match what the server fires

Keep this file simple and dependency-free: it's imported by the scan
endpoint that runs every minute under cron, plus the per-request shift
start handler. Anything heavier than a list of constants + pure helpers
belongs elsewhere.

Timezone handling: deadlines are stored UTC in the DB. The "local
midnight" check uses ``America/Vancouver`` (matches the rest of the
codebase) -- see ``local_midnight_passed``.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Literal, Optional
from zoneinfo import ZoneInfo


# -- Intervals -------------------------------------------------------------
# Minutes between required check-ins by shift mode. Alone is half the
# crew interval because there's no buddy to notice a problem.
WORKER_INTERVAL_MIN: dict[str, int] = {
    "alone": 120,   # 2 h
    "crew": 240,    # 4 h
    "off": 24 * 60 * 365,  # "off shift today" sentinel: 1 year (never overdue)
}

# Auto-end an active shift if no check-in for this long (lazy on read).
STALE_END_HOURS = 14

# Worker repeat-overdue cadence after T+3 (push/email reminder every 10 min).
WORKER_REPEAT_INTERVAL_MIN = 10

# Office escalation thresholds (minutes overdue, i.e. minutes past
# next_deadline_at). T+30 standard, T+60 urgent, no further repeats.
# Flip OFFICE_REPEAT_AFTER_URGENT_MIN to a positive value to keep
# escalating beyond T+60.
OFFICE_FIRST_ALERT_MINUTES = 30
OFFICE_URGENT_ALERT_MINUTES = 60
OFFICE_REPEAT_AFTER_URGENT_MIN = 0


# -- Alert schedule --------------------------------------------------------
# Each entry: (kind, threshold_minutes, urgent_flag).
# threshold_minutes is signed: negative = before deadline (T-X), positive
# = after deadline (T+X). The scan endpoint walks both lists every minute
# and fires any entry whose threshold the shift just crossed AND for
# which no checkin_alerts row exists yet.
@dataclass(frozen=True)
class AlertSpec:
    kind: str
    threshold_minutes: int   # signed; negative = before deadline
    urgent: bool


WORKER_ALERTS: tuple[AlertSpec, ...] = (
    AlertSpec("worker_t-15",       -15, False),
    AlertSpec("worker_t0",           0, False),
    AlertSpec("worker_overdue_3",    3, True),
    # Then every WORKER_REPEAT_INTERVAL_MIN beyond T+3 (handled dynamically
    # in the scan endpoint by generating worker_overdue_repeat_N kinds).
)

OFFICE_ALERTS: tuple[AlertSpec, ...] = (
    AlertSpec("office_first",   OFFICE_FIRST_ALERT_MINUTES,  False),
    AlertSpec("office_urgent",  OFFICE_URGENT_ALERT_MINUTES, True),
    # If OFFICE_REPEAT_AFTER_URGENT_MIN > 0, the scan endpoint generates
    # office_repeat_N kinds dynamically. Default 0 = stop at T+60.
)


# -- Compliance tier (mirrors frontend `compliance.js`) -------------------
ComplianceTier = Literal[
    "green",   # On shift, > 15 min to next check-in
    "yellow",  # T-15 to T+2 (approaching deadline)
    "red",     # > T+3 overdue
    "blue",    # Shift started < 5 min ago, no check-in yet
    "idle",    # Truck-assigned but no shift today
    "off",     # Shift ended or mode='off'
]


def _now_utc() -> datetime:
    """UTC now. Helper so tests can monkeypatch one function."""
    return datetime.now(timezone.utc)


def tier(
    shift,
    *,
    now: Optional[datetime] = None,
) -> ComplianceTier:
    """Return the compliance tier for a shift row.

    Accepts either an ORM Shift instance or any object with the matching
    attributes (``started_at``, ``ended_at``, ``last_checkin_at``,
    ``next_deadline_at``). Returns 'off' when the shift is ended or in
    'off' mode, else one of green/yellow/red/blue based on minutes to
    deadline.

    Caller passes a non-naive datetime for ``now`` to override the clock
    (testing). Default = utcnow.
    """
    if shift is None or getattr(shift, "ended_at", None) is not None:
        return "off"
    if getattr(shift, "mode", None) == "off":
        return "off"

    now = now or _now_utc()
    started_at = getattr(shift, "started_at", None)
    last_checkin_at = getattr(shift, "last_checkin_at", None)
    deadline = getattr(shift, "next_deadline_at", None)

    # Blue: just-started shifts with no check-in yet. The 5 min window
    # lets the Overview tab show a distinct "starting up" state before
    # the worker has their first ping under their belt.
    if last_checkin_at is None and started_at is not None:
        # Make both sides timezone-aware (DB returns aware on Postgres,
        # naive on SQLite); normalise to UTC for the subtraction.
        started_at_aware = _ensure_aware(started_at)
        if (now - started_at_aware) < timedelta(minutes=5):
            return "blue"

    if deadline is None:
        # Shouldn't happen (column is NOT NULL) but defensive: treat as
        # green so the UI doesn't render garbage.
        return "green"

    deadline_aware = _ensure_aware(deadline)
    minutes_to = (deadline_aware - now).total_seconds() / 60.0
    if minutes_to > 15:
        return "green"
    if minutes_to > -3:
        return "yellow"
    return "red"


def _ensure_aware(dt: datetime) -> datetime:
    """Coerce naive datetimes (from SQLite reads) to UTC-aware."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def compute_next_deadline(
    *,
    mode: str,
    last_checkin_at: Optional[datetime] = None,
    started_at: Optional[datetime] = None,
) -> datetime:
    """Return the next deadline for a shift.

    Anchor: last_checkin_at if present, else started_at, else now. Adds
    the per-mode interval. Caller is responsible for passing a UTC-aware
    datetime (or naive UTC) -- result is in the same kind.

    Used on shift start (anchor=started_at) and on every check-in
    (anchor=last_checkin_at=now).
    """
    interval = WORKER_INTERVAL_MIN.get(mode, WORKER_INTERVAL_MIN["alone"])
    anchor = last_checkin_at or started_at or _now_utc()
    return anchor + timedelta(minutes=interval)


def deadline_for_mode_change(
    *,
    old_deadline: datetime,
    new_mode: str,
    last_checkin_at: Optional[datetime],
    started_at: datetime,
) -> datetime:
    """Recompute deadline after a mid-shift mode/crew change.

    Sooner-only rule: deadlines never get pushed FURTHER OUT mid-shift.
    Flipping crew->alone shortens the interval, so deadline moves in
    (good: same-day safety holds). Flipping alone->crew would otherwise
    *extend* the deadline -- but that would let a worker game the system
    by flipping to crew just before being overdue. We disallow the
    extension: take ``min(old_deadline, anchor + new_interval)``.
    """
    candidate = compute_next_deadline(
        mode=new_mode,
        last_checkin_at=last_checkin_at,
        started_at=started_at,
    )
    return min(_ensure_aware(old_deadline), _ensure_aware(candidate))


# -- Lazy auto-end ---------------------------------------------------------
VANCOUVER = ZoneInfo("America/Vancouver")


def should_auto_end(shift, *, now: Optional[datetime] = None) -> Optional[str]:
    """Return an auto_end_reason if the shift should be ended on this read.

    Two conditions, in priority order:
      * 'stale_14h'  -- no check-in for >= STALE_END_HOURS
      * 'midnight'   -- local Vancouver midnight has passed since shift start

    Returns None if the shift is fine, or already ended, or in 'off' mode.
    Caller commits the ``ended_at = now`` + ``auto_end_reason = <returned>``
    update after this check.
    """
    if shift is None or getattr(shift, "ended_at", None) is not None:
        return None
    if getattr(shift, "mode", None) == "off":
        return None

    now = _ensure_aware(now or _now_utc())
    last = getattr(shift, "last_checkin_at", None) or getattr(shift, "started_at", None)
    if last is not None:
        last_aware = _ensure_aware(last)
        if (now - last_aware) >= timedelta(hours=STALE_END_HOURS):
            return "stale_14h"

    started = getattr(shift, "started_at", None)
    if started is not None:
        started_local = _ensure_aware(started).astimezone(VANCOUVER)
        now_local = now.astimezone(VANCOUVER)
        # "Midnight has passed" = the local date rolled over since the
        # shift started. Catches any shift left running overnight.
        if now_local.date() > started_local.date():
            return "midnight"

    return None


# -- Scanner thresholds (helper used by the scan endpoint) ----------------
def overdue_repeat_kinds(
    minutes_overdue: float,
    *,
    interval: int = WORKER_REPEAT_INTERVAL_MIN,
) -> Iterable[str]:
    """Yield ``worker_overdue_repeat_N`` kind strings whose N <= overdue.

    Used by the scan endpoint to dynamically generate repeat-alert kinds
    instead of pre-listing them. Yields N = 10, 20, 30, ... up to but
    not exceeding ``minutes_overdue``.
    """
    if minutes_overdue <= 3:
        return
    n = interval
    while n <= minutes_overdue:
        yield f"worker_overdue_repeat_{n}"
        n += interval


def office_repeat_kinds(
    minutes_overdue: float,
    *,
    interval: int = OFFICE_REPEAT_AFTER_URGENT_MIN,
) -> Iterable[str]:
    """Yield office repeat kinds after T+60, if configured.

    Returns nothing when interval == 0 (the default -- stop at T+60).
    Format: ``office_repeat_N``.
    """
    if interval <= 0 or minutes_overdue <= OFFICE_URGENT_ALERT_MINUTES:
        return
    n = OFFICE_URGENT_ALERT_MINUTES + interval
    while n <= minutes_overdue:
        yield f"office_repeat_{n}"
        n += interval
