-- ============================================================================
-- Pineview Maps · Truck tracking (OwnTracks) setup
-- ============================================================================
-- Run this ONCE in your Supabase project's SQL Editor (Dashboard → SQL).
--
-- Creates two tables backing the truck-pins-on-map feature:
--   • devices       Registered iPads with label, color, OwnTracks token hash,
--                   and a denormalized last-known position
--   • device_pings  Append-only history of every OwnTracks ping
--
-- Everything follows the existing app patterns:
--   - updated_at maintained by the shared trigger function
--     update_updated_at_column() created in herbicide_lease_sheet_setup.sql
--   - REPLICA IDENTITY FULL + supabase_realtime publication so admin
--     dashboards and the map auto-update when a new ping lands
--   - ON DELETE SET NULL on every users.id FK so a hard-deleted user
--     doesn't break a device row (audit trail stays intact)
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


-- ── 1. devices ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS devices (
    id                     SERIAL PRIMARY KEY,
    -- Human-readable name shown on the map tooltip and admin list.
    label                  VARCHAR(120) NOT NULL,
    -- Required at creation. Stored as #RRGGBB so the map can paint the
    -- pin without a lookup. Default is the first preset (blue) — the
    -- frontend picks the next-unused preset on Add Device, but this
    -- keeps inserts via psql / direct SQL viable too.
    color_hex              VARCHAR(7) NOT NULL DEFAULT '#1E88E5',
    -- Tooltip label only. Does NOT affect pin color.
    assigned_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_user_name     VARCHAR(255),

    -- SHA-256 hex of the OwnTracks bearer token. Raw token is shown to
    -- the admin ONCE at create / rotate time. UNIQUE so a token lookup
    -- is an indexed equality check (the OwnTracks ping endpoint hits
    -- this on every request).
    token_hash             VARCHAR(64) NOT NULL UNIQUE,
    token_rotated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Denormalized last-known position so the map list endpoint is a
    -- single row read per truck instead of an N+1 sub-query against
    -- device_pings. Nullable until the first ping lands.
    last_lat               DOUBLE PRECISION,
    last_lng               DOUBLE PRECISION,
    last_seen_at           TIMESTAMP WITH TIME ZONE,
    last_battery_pct       INTEGER,
    last_speed_kph         NUMERIC(7, 2),
    last_accuracy_m        NUMERIC(8, 2),
    last_payload           JSONB,

    -- Soft-disable: hides from map + admin list but keeps the row +
    -- historical pings (audit trail). Hard delete is a separate action.
    is_active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_name        VARCHAR(255),
    updated_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by_name        VARCHAR(255)
);

-- Hot-path indexes: map render filters by is_active; admin search by
-- assigned_user; auto-refresh polling sorts by last_seen_at.
CREATE INDEX IF NOT EXISTS idx_devices_is_active
    ON devices (is_active);
CREATE INDEX IF NOT EXISTS idx_devices_assigned_user
    ON devices (assigned_user_id) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_last_seen_at
    ON devices (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_updated_at
    ON devices (updated_at);

DROP TRIGGER IF EXISTS devices_updated_at ON devices;
CREATE TRIGGER devices_updated_at
    BEFORE UPDATE ON devices
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- ── 2. device_pings ─────────────────────────────────────────────────────────
-- Append-only history. Phase 4 will add a daily auto-prune (last 30 days).

CREATE TABLE IF NOT EXISTS device_pings (
    id                     BIGSERIAL PRIMARY KEY,
    device_id              INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    lat                    DOUBLE PRECISION NOT NULL,
    lng                    DOUBLE PRECISION NOT NULL,
    -- OwnTracks ``tst`` claim (unix seconds) as the source of truth for
    -- when the device thought it was at this position. We trust this
    -- over server arrival time because Starlink + iPad clocks are
    -- accurate and devices may queue pings while temporarily disconnected.
    recorded_at            TIMESTAMP WITH TIME ZONE NOT NULL,
    battery_pct            INTEGER,
    speed_kph              NUMERIC(7, 2),
    accuracy_m             NUMERIC(8, 2),
    raw                    JSONB,
    created_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Composite index optimal for breadcrumb queries: "all pings for
-- device X between time A and B, newest first".
CREATE INDEX IF NOT EXISTS idx_device_pings_device_recorded
    ON device_pings (device_id, recorded_at DESC);


-- ── 3. Realtime: REPLICA IDENTITY FULL + supabase_realtime publication ─────
-- Mirrors the pattern in database/enable_realtime.sql + calendar_setup.sql.
-- The frontend subscribes to ``devices`` so admin dashboards refresh in
-- real time when a new ping moves a truck. device_pings is NOT in the
-- publication because pings fire every 15 min × N trucks — the firehose
-- is wasteful when the only thing the UI cares about is the latest
-- snapshot already denormalized onto ``devices``.

ALTER TABLE public.devices REPLICA IDENTITY FULL;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.devices;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── Verification ────────────────────────────────────────────────────────────
-- Run after the above to confirm the devices table is in the publication:
--
-- SELECT tablename FROM pg_publication_tables
--  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
--    AND tablename = 'devices';
--
-- Expected: devices
