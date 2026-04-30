-- ============================================================================
-- Pineview Maps · Enable Supabase Realtime
-- ============================================================================
-- Run this ONCE in your Supabase project's SQL Editor (Dashboard → SQL).
--
-- What it does
-- ------------
-- Switches on Postgres logical replication for the twelve tables the
-- Pineview frontend wants live updates for, then registers each of them
-- with Supabase's `supabase_realtime` publication so the Realtime service
-- streams INSERT / UPDATE / DELETE events to subscribed clients over a
-- single WebSocket per device.
--
-- After this runs, your FastAPI backend (which writes via the service-role
-- key) does NOT need any changes — Postgres replication captures every
-- write regardless of which client made it, so updates from /api/* routes
-- still flow to subscribed users automatically.
--
-- Idempotency
-- -----------
-- Every block below is wrapped in a DO block that catches the
-- `duplicate_object` exception. Re-running this script on a project that
-- already has Realtime enabled is safe — it'll skip the already-added
-- tables and not raise.
--
-- Tables covered (12 total)
-- -------------------------
-- Map data:
--   • sites
--   • pipelines
--   • site_spray_records      (site lease sheets)
--   • spray_records           (pipeline lease sheets)
--   • site_updates            (status-history rows)
--   • time_materials_tickets  (T&M tickets)
--   • time_materials_rows     (T&M ticket line items)
--
-- Admin / lookups:
--   • users                   (worker / office / admin roster + role changes)
--   • herbicides
--   • applicators
--   • noxious_weeds
--   • location_types
-- ============================================================================


-- ── Step 1 of 2: REPLICA IDENTITY FULL ──────────────────────────────────────
-- By default Postgres logical replication includes only the primary key in
-- UPDATE / DELETE event payloads. That's enough to identify the row but the
-- frontend can't do an "old vs new" diff and, more importantly, the entire
-- row is missing from a DELETE payload, which means we'd lose the data we
-- need to remove the matching pin from the local map cache.
--
-- REPLICA IDENTITY FULL tells Postgres to include the *entire old row* in
-- every UPDATE and DELETE payload. Storage cost is zero (it just changes
-- what flows over the WAL stream); the only effect is slightly bigger
-- replication packets, which is exactly what we want.

ALTER TABLE public.sites                  REPLICA IDENTITY FULL;
ALTER TABLE public.pipelines              REPLICA IDENTITY FULL;
ALTER TABLE public.site_spray_records     REPLICA IDENTITY FULL;
ALTER TABLE public.spray_records          REPLICA IDENTITY FULL;
ALTER TABLE public.site_updates           REPLICA IDENTITY FULL;
ALTER TABLE public.time_materials_tickets REPLICA IDENTITY FULL;
ALTER TABLE public.time_materials_rows    REPLICA IDENTITY FULL;
ALTER TABLE public.users                  REPLICA IDENTITY FULL;
ALTER TABLE public.herbicides             REPLICA IDENTITY FULL;
ALTER TABLE public.applicators            REPLICA IDENTITY FULL;
ALTER TABLE public.noxious_weeds          REPLICA IDENTITY FULL;
ALTER TABLE public.location_types         REPLICA IDENTITY FULL;


-- ── Step 2 of 2: Add tables to the supabase_realtime publication ────────────
-- The `supabase_realtime` publication is created automatically on every
-- Supabase project. Adding a table to it tells the Realtime service to
-- relay that table's WAL events to subscribed clients.
--
-- ALTER PUBLICATION ... ADD TABLE will raise `duplicate_object` if the
-- table is already in the publication, so each statement is wrapped in a
-- DO block that swallows that specific exception. Any *other* error
-- (e.g. table doesn't exist, publication doesn't exist) still bubbles up
-- so the operator sees the real failure.

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.sites;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.pipelines;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.site_spray_records;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.spray_records;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.site_updates;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.time_materials_tickets;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.time_materials_rows;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.herbicides;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.applicators;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.noxious_weeds;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.location_types;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── Verification query ──────────────────────────────────────────────────────
-- Run this AFTER the above to confirm all twelve tables are now part of
-- the realtime publication. You should see exactly 12 rows.
--
-- SELECT schemaname, tablename
--   FROM pg_publication_tables
--  WHERE pubname = 'supabase_realtime'
--    AND schemaname = 'public'
--  ORDER BY tablename;


-- ── Notes on Row Level Security ─────────────────────────────────────────────
-- This script does NOT touch RLS. Realtime delivers an event to a client
-- only if that client's auth role passes the table's SELECT policy.
--
-- If your tables currently have NO RLS enabled (the common setup for
-- backends that talk to Postgres exclusively via the service-role key —
-- which yours does, through FastAPI), Realtime will deliver every event
-- to every authenticated subscriber and you don't need to do anything
-- else.
--
-- If you later turn RLS on for any of these tables, you'll need a
-- corresponding `FOR SELECT TO authenticated USING (...)` policy or
-- subscribers will silently stop receiving events for that table. The
-- frontend will fall back to its 5-minute /api/sync-status poll loop in
-- that case, so the app keeps working — it just won't be live.
