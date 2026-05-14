-- ============================================================================
-- Pineview Maps · Calendar feature setup
-- ============================================================================
-- Run this ONCE in your Supabase project's SQL Editor (Dashboard → SQL).
--
-- Creates four tables backing the admin/office Calendar overlay:
--   • calendar_tasks      Daily to-dos with priority, assignee, roll-forward
--   • calendar_contacts   Company / contact directory, grouped by client
--   • calendar_events     Conferences, shows, anything on a date
--   • calendar_bids       Bid postings (manual now; scraper plugs in later)
--
-- Everything follows the existing app patterns:
--   - soft-delete via deleted_at IS NULL
--   - updated_at maintained by the shared trigger function
--     update_updated_at_column() created in herbicide_lease_sheet_setup.sql
--   - REPLICA IDENTITY FULL + supabase_realtime publication for live sync
--   - ON DELETE SET NULL on every users.id FK so a hard-deleted user
--     doesn't break a calendar row
--
-- Idempotency: every CREATE / ALTER / DO block can be re-run safely.
-- ============================================================================


-- ── Shared trigger function ─────────────────────────────────────────────────
-- Already exists from herbicide_lease_sheet_setup.sql; re-declared here with
-- CREATE OR REPLACE so this migration can run standalone on a fresh project.

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ── 1. calendar_tasks ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calendar_tasks (
    id                     SERIAL PRIMARY KEY,
    task_date              DATE NOT NULL,
    -- Stamped on the FIRST roll-forward and never changed after, so the audit
    -- trail survives multiple consecutive misses. NULL means the task has
    -- never been rolled (task_date is still the originally chosen date).
    original_task_date     DATE,
    -- Optional time-of-day window. Both NULL = the task is all-day; the
    -- frontend renders it as a chip on the daygrid. start_time set =
    -- timed task (FullCalendar shows it on the timeGrid views at the
    -- right slot). end_time is optional even when start_time is set; if
    -- absent we treat the task as a 1-hour block for rendering only.
    start_time             TIME,
    end_time               TIME,
    task_text              TEXT NOT NULL,
    priority               VARCHAR(16) NOT NULL DEFAULT 'normal'
                              CHECK (priority IN ('important', 'attention', 'normal')),
    assigned_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    -- Denormalized snapshot — survives a renamed/deleted user row so old
    -- tasks still show who they were for. Same pattern as
    -- site_spray_records.sprayed_by_name.
    assigned_user_name     VARCHAR(255),
    is_completed           BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at           TIMESTAMP WITH TIME ZONE,
    completed_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    completed_by_name      VARCHAR(255),
    -- Audit columns
    created_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at             TIMESTAMP WITH TIME ZONE,
    created_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_name        VARCHAR(255),
    updated_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by_name        VARCHAR(255)
);

-- Hot-path indexes: grid render filters by date + deleted_at, creator filter
-- filters by created_by_user_id + deleted_at. Partial indexes skip the
-- soft-deleted rows so an active-row scan is essentially free.
CREATE INDEX IF NOT EXISTS idx_calendar_tasks_task_date_not_deleted
    ON calendar_tasks (task_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_tasks_created_by
    ON calendar_tasks (created_by_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_tasks_updated_at
    ON calendar_tasks (updated_at);

DROP TRIGGER IF EXISTS calendar_tasks_updated_at ON calendar_tasks;
CREATE TRIGGER calendar_tasks_updated_at
    BEFORE UPDATE ON calendar_tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- ── 2. calendar_contacts ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calendar_contacts (
    id                     SERIAL PRIMARY KEY,
    company_name           VARCHAR(255) NOT NULL,
    contact_name           VARCHAR(255),
    phone                  VARCHAR(64),
    email                  VARCHAR(255),
    role                   VARCHAR(120),
    -- Free-form, mirrors sites.client so the Calendar can group contacts by
    -- the same client names that drive the rest of the app. No FK on
    -- purpose — clients are derived from data, not a fixed lookup table.
    client                 VARCHAR(120),
    notes                  TEXT,
    -- Audit columns
    created_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at             TIMESTAMP WITH TIME ZONE,
    created_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_name        VARCHAR(255),
    updated_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by_name        VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_calendar_contacts_client
    ON calendar_contacts (client) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_contacts_updated_at
    ON calendar_contacts (updated_at);

DROP TRIGGER IF EXISTS calendar_contacts_updated_at ON calendar_contacts;
CREATE TRIGGER calendar_contacts_updated_at
    BEFORE UPDATE ON calendar_contacts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- ── 3. calendar_events ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calendar_events (
    id                     SERIAL PRIMARY KEY,
    event_date             DATE NOT NULL,
    -- Nullable for single-day events. When set, FullCalendar renders the
    -- event as a multi-day bar spanning [event_date, end_date].
    end_date               DATE,
    -- Optional time window. Same semantics as calendar_tasks.start_time:
    -- both NULL = all-day event, start_time set = timed event. For
    -- multi-day events the time pair applies to event_date (start) and
    -- end_date (end) — the typical "conference runs 9am Mon to 4pm Wed".
    start_time             TIME,
    end_time               TIME,
    title                  VARCHAR(255) NOT NULL,
    location               VARCHAR(255),
    notes                  TEXT,
    url                    TEXT,
    -- Audit columns
    created_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at             TIMESTAMP WITH TIME ZONE,
    created_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_name        VARCHAR(255),
    updated_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by_name        VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_event_date_not_deleted
    ON calendar_events (event_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_events_created_by
    ON calendar_events (created_by_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_events_updated_at
    ON calendar_events (updated_at);

DROP TRIGGER IF EXISTS calendar_events_updated_at ON calendar_events;
CREATE TRIGGER calendar_events_updated_at
    BEFORE UPDATE ON calendar_events
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- ── 4. calendar_bids ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calendar_bids (
    id                     SERIAL PRIMARY KEY,
    bid_title              VARCHAR(500) NOT NULL,
    -- Nullable: scraper rows occasionally have un-parseable closing dates;
    -- the UI shows those in a separate "no close date" bucket above the
    -- grid so they're not silently dropped.
    closing_date           DATE,
    -- 'manual' for admin-entered bids; later 'bcbid' / 'merx' / etc. as the
    -- scraper lands. Keep as VARCHAR rather than enum so a new source can
    -- be added without an ALTER TYPE migration.
    source                 VARCHAR(64) NOT NULL DEFAULT 'manual',
    source_url             TEXT,
    summary                TEXT,
    -- ["hydroseeding", "drone", ...] populated by the scraper based on the
    -- keyword list configured in the future bid_scanner.py module.
    matched_keywords       JSONB,
    -- Stable ID from the source system (e.g. BC Bid's posting ID). Used by
    -- the scraper to dedup on each daily run. NULL for manual rows.
    external_id            VARCHAR(255),
    is_dismissed           BOOLEAN NOT NULL DEFAULT FALSE,
    -- Audit columns
    created_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at             TIMESTAMP WITH TIME ZONE,
    created_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_name        VARCHAR(255),
    updated_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by_name        VARCHAR(255)
);

-- Partial unique on (source, external_id) only when external_id is set, so
-- the daily scraper's "INSERT … ON CONFLICT (source, external_id) DO UPDATE"
-- pattern works for scraped rows without blocking manual rows (which all
-- carry external_id = NULL) from being inserted in unlimited quantity.
CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_bids_source_external_id
    ON calendar_bids (source, external_id)
    WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_bids_closing_date_not_deleted
    ON calendar_bids (closing_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_bids_updated_at
    ON calendar_bids (updated_at);

DROP TRIGGER IF EXISTS calendar_bids_updated_at ON calendar_bids;
CREATE TRIGGER calendar_bids_updated_at
    BEFORE UPDATE ON calendar_bids
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- ── 4b. Idempotent ADD COLUMN IF NOT EXISTS for existing databases ─────────
-- The CREATE TABLE blocks above only run on a fresh install. For projects
-- that already ran this migration before the optional time-of-day columns
-- were added, these ALTERs bring them up to date. ADD COLUMN IF NOT EXISTS
-- is a no-op when the column already exists, so re-running the whole file
-- stays safe.

ALTER TABLE calendar_tasks  ADD COLUMN IF NOT EXISTS start_time TIME;
ALTER TABLE calendar_tasks  ADD COLUMN IF NOT EXISTS end_time   TIME;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS start_time TIME;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS end_time   TIME;


-- ── 5. Realtime: REPLICA IDENTITY FULL + supabase_realtime publication ─────
-- Mirrors the pattern in database/enable_realtime.sql so the Calendar
-- overlay's own Supabase channel receives row-level events when an admin
-- on another device adds / edits / deletes a calendar item.

ALTER TABLE public.calendar_tasks    REPLICA IDENTITY FULL;
ALTER TABLE public.calendar_contacts REPLICA IDENTITY FULL;
ALTER TABLE public.calendar_events   REPLICA IDENTITY FULL;
ALTER TABLE public.calendar_bids     REPLICA IDENTITY FULL;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.calendar_tasks;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.calendar_contacts;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.calendar_events;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.calendar_bids;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── Verification ────────────────────────────────────────────────────────────
-- Run after the above to confirm all four new tables are in the publication:
--
-- SELECT tablename FROM pg_publication_tables
--  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
--    AND tablename LIKE 'calendar_%' ORDER BY tablename;
--
-- Expected:
--   calendar_bids
--   calendar_contacts
--   calendar_events
--   calendar_tasks
