-- ============================================================================
-- Pineview Maps · Lone-worker check-ins (Phase 2 unified)
-- ============================================================================
-- Run this ONCE in your Supabase project's SQL Editor (Dashboard -> SQL).
--
-- Creates the seven tables that back the check-in feature set:
--   1. user_profiles            Per-worker prefs (notify_push, email opt-in,
--                               last shift mode for start-shift defaults).
--   2. shifts                   One row per lone-worker shift, with mode
--                               (alone/crew) and next_deadline_at.
--   3. checkins                 Append-only "I'm OK" pings against a shift.
--   4. shift_changes            Audit trail of mid-shift mode / crew edits.
--   5. push_subscriptions       Web Push endpoints (one per worker device).
--   6. checkin_alerts           Idempotency ledger so the cron scanner
--                               never double-sends the same alert.
--   7. office_alert_recipients  Configurable email list for overdue alerts.
--                               Exactly one row is is_primary=TRUE (the
--                               always-on office email) and can't be
--                               disabled or deleted by the UI.
--
-- Everything follows the existing app patterns from devices_setup.sql and
-- calendar_setup.sql:
--   - updated_at maintained by the shared trigger function (re-declared
--     here with CREATE OR REPLACE so the migration runs standalone)
--   - REPLICA IDENTITY FULL + supabase_realtime publication on every
--     read-relevant table so the frontend can subscribe to live updates
--   - ON DELETE CASCADE for child rows, ON DELETE SET NULL for audit FKs
--
-- Idempotency: every CREATE / ALTER / DO block can be re-run safely.
-- ============================================================================


-- -- Shared trigger function ------------------------------------------------
-- Already exists from herbicide_lease_sheet_setup.sql / devices_setup.sql,
-- re-declared with CREATE OR REPLACE so this migration is standalone-safe.

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- -- 1. user_profiles -------------------------------------------------------
-- One row per user, created lazily on first save. Stores notification
-- preferences plus last-used shift defaults so the StartShift form can
-- pre-select the worker's typical mode. Email is optional (default OFF);
-- push is the primary channel.

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- 'alone' | 'crew' for next-time defaults. NULL = no prior shift.
    last_mode            VARCHAR(16),
    -- JSON array of user ids the worker last crewed with. Pre-selected
    -- in the crew picker so a stable pair (e.g. Joe + Mark) doesn't
    -- need re-picking every morning.
    last_crew_user_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Web Push opt-in. Default ON because push is the primary safety
    -- channel; the worker still has to grant OS permission before any
    -- push is actually delivered (handled in pushClient.js).
    notify_push          BOOLEAN NOT NULL DEFAULT TRUE,
    -- Email opt-in. Default OFF because most workers won't need it
    -- (push handles the case). When TRUE, the recipient is either the
    -- notify_email_address override or the user's auth email.
    notify_email         BOOLEAN NOT NULL DEFAULT FALSE,
    notify_email_address VARCHAR(255),
    updated_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS user_profiles_updated_at ON user_profiles;
CREATE TRIGGER user_profiles_updated_at
    BEFORE UPDATE ON user_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- -- 2. shifts --------------------------------------------------------------
-- The core safety record. One row per lone-worker shift (alone OR crew).
-- ended_at NULL = active. device_id auto-linked at start to whichever
-- device has assigned_user_id = me. next_deadline_at is the single source
-- of truth for the countdown / forced-overlay / alert thresholds.

CREATE TABLE IF NOT EXISTS shifts (
    id                   BIGSERIAL PRIMARY KEY,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Auto-linked at start: SELECT id FROM devices WHERE
    -- assigned_user_id = me AND is_active. NULL if zero or >1 match
    -- (admin can fix later from the dashboard).
    device_id            INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    -- 'alone' (2 h interval), 'crew' (4 h interval), or 'off' (an
    -- intentional "I'm not working today" record that suppresses the
    -- soft morning banner).
    mode                 VARCHAR(16) NOT NULL CHECK (mode IN ('alone', 'crew', 'off')),
    -- JSON array of user ids in the crew. Empty when mode != 'crew'.
    crew_user_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Free-text additions for crew members who aren't system users
    -- (subcontractors, day labour). Newline-separated names.
    crew_freeform        TEXT NOT NULL DEFAULT '',
    started_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    ended_at             TIMESTAMP WITH TIME ZONE,
    ended_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    -- 'midnight' | 'stale_14h' | 'manual' | 'admin_override' | NULL.
    -- Populated by the lazy auto-end resolver in checkin_routes.py.
    auto_end_reason      VARCHAR(32),
    last_checkin_at      TIMESTAMP WITH TIME ZONE,
    -- The countdown / alert math hinges on this column. Updated on
    -- every successful check-in (next = now + interval), on mid-shift
    -- composition changes (recomputed sooner-only), and on shift start.
    next_deadline_at     TIMESTAMP WITH TIME ZONE NOT NULL,
    notes                TEXT NOT NULL DEFAULT ''
);

-- Hot-path indexes: countdown / overdue scanners filter by ended_at IS
-- NULL and order by next_deadline_at; admin Overview tab and worker's
-- "today" lookup filter by user_id.
CREATE INDEX IF NOT EXISTS idx_shifts_user_active
    ON shifts (user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shifts_active_deadline
    ON shifts (next_deadline_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shifts_started
    ON shifts (started_at);


-- -- 3. checkins ------------------------------------------------------------
-- Append-only "I'm OK" record. Position is optional (worker may have
-- denied geolocation) and recorded_by_user_id is non-NULL only for the
-- rare admin-force-checkin case (records who did the override).

CREATE TABLE IF NOT EXISTS checkins (
    id                   BIGSERIAL PRIMARY KEY,
    shift_id             BIGINT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    user_id              INTEGER NOT NULL REFERENCES users(id),
    -- Set to the admin's id ONLY when an admin used the "Force check-in"
    -- override from the dashboard. NULL for normal worker-initiated.
    recorded_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    lat                  DOUBLE PRECISION,
    lon                  DOUBLE PRECISION,
    accuracy_m           NUMERIC(8, 2),
    notes                TEXT,
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkins_shift
    ON checkins (shift_id);
CREATE INDEX IF NOT EXISTS idx_checkins_user_day
    ON checkins (user_id, created_at);


-- -- 4. shift_changes -------------------------------------------------------
-- Mid-shift composition audit. Writes one row per Edit-crew/mode save,
-- including the old + new mode and crew so the admin History tab can
-- show a timeline of changes ("Crew changed from Joe+Mark to Joe at 14:32").

CREATE TABLE IF NOT EXISTS shift_changes (
    id                   BIGSERIAL PRIMARY KEY,
    shift_id             BIGINT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    changed_by_user_id   INTEGER NOT NULL REFERENCES users(id),
    old_mode             VARCHAR(16),
    new_mode             VARCHAR(16),
    old_crew             JSONB,
    new_crew             JSONB,
    old_deadline         TIMESTAMP WITH TIME ZONE,
    new_deadline         TIMESTAMP WITH TIME ZONE,
    changed_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shift_changes_shift
    ON shift_changes (shift_id, changed_at);


-- -- 5. push_subscriptions --------------------------------------------------
-- One row per device the worker has subscribed for Web Push. Endpoint is
-- the URL Apple/Google/Mozilla gives us; we POST encrypted payloads to it
-- via pywebpush. On 404/410 from the endpoint, the row is deleted (the
-- worker uninstalled the PWA / cleared site data).

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id                   BIGSERIAL PRIMARY KEY,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint             TEXT NOT NULL UNIQUE,
    p256dh               TEXT NOT NULL,
    auth                 TEXT NOT NULL,
    user_agent           TEXT,
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_used_at         TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user
    ON push_subscriptions (user_id);


-- -- 6. checkin_alerts ------------------------------------------------------
-- Idempotency ledger for the every-minute cron scanner. Each (shift, kind)
-- combo fires AT MOST ONCE. A delayed cron run can't double-send because
-- the scanner checks for the row before sending.
--
-- kind values:
--   worker_t-15        Worker reminder 15 min before deadline (push/email)
--   worker_t0          Worker reminder at deadline
--   worker_overdue_3   Worker urgent at T+3
--   worker_overdue_repeat_N  Worker repeats every 10 min after T+3 (N=10, 20, 30...)
--   office_first       Office email at T+30 (standard tone)
--   office_urgent      Office email at T+60 (urgent tone)

CREATE TABLE IF NOT EXISTS checkin_alerts (
    id                   BIGSERIAL PRIMARY KEY,
    shift_id             BIGINT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    kind                 VARCHAR(64) NOT NULL,
    due_at               TIMESTAMP WITH TIME ZONE NOT NULL,
    sent_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    channel              VARCHAR(16) NOT NULL,
    recipient            TEXT NOT NULL,
    result               VARCHAR(16) NOT NULL DEFAULT 'sent',
    error                TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkin_alerts_shift_kind
    ON checkin_alerts (shift_id, kind, due_at);


-- -- 7. office_alert_recipients ---------------------------------------------
-- Configurable office email list managed from the Settings tab of the
-- Check-ins Dashboard. Exactly one row has is_primary=TRUE -- this is
-- the always-on office email. Server returns 400 on any attempt to
-- disable or delete the primary.

CREATE TABLE IF NOT EXISTS office_alert_recipients (
    id                   BIGSERIAL PRIMARY KEY,
    email                VARCHAR(255) NOT NULL UNIQUE,
    display_name         VARCHAR(255),
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    is_primary           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- The primary row must always be active. Enforced both here and in
    -- the API layer for defense-in-depth.
    CONSTRAINT chk_primary_active CHECK (NOT is_primary OR is_active)
);

-- Partial unique index: at most ONE row may have is_primary = TRUE.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_office_recipients_primary
    ON office_alert_recipients ((is_primary)) WHERE is_primary = TRUE;


-- -- Realtime: REPLICA IDENTITY FULL + supabase_realtime publication -------
-- Match the pattern in enable_realtime.sql + devices_setup.sql. The frontend
-- subscribes to shifts (worker countdown, admin Overview), checkins (timeline),
-- shift_changes (admin History), and office_alert_recipients (Settings tab).
-- push_subscriptions and checkin_alerts are server-side only -- no need to
-- broadcast to clients.

ALTER TABLE public.user_profiles            REPLICA IDENTITY FULL;
ALTER TABLE public.shifts                   REPLICA IDENTITY FULL;
ALTER TABLE public.checkins                 REPLICA IDENTITY FULL;
ALTER TABLE public.shift_changes            REPLICA IDENTITY FULL;
ALTER TABLE public.office_alert_recipients  REPLICA IDENTITY FULL;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.user_profiles;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.shifts;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.checkins;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.shift_changes;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.office_alert_recipients;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- -- Verification ----------------------------------------------------------
-- After running, confirm all seven tables exist and the five publishable
-- ones are in supabase_realtime:
--
-- SELECT tablename FROM pg_tables
--  WHERE schemaname = 'public'
--    AND tablename IN ('user_profiles','shifts','checkins','shift_changes',
--                      'push_subscriptions','checkin_alerts',
--                      'office_alert_recipients')
--  ORDER BY tablename;
--
-- SELECT tablename FROM pg_publication_tables
--  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
--    AND tablename IN ('user_profiles','shifts','checkins','shift_changes',
--                      'office_alert_recipients')
--  ORDER BY tablename;
