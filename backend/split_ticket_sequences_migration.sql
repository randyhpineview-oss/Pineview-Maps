-- ═════════════════════════════════════════════════════════════════════════════════
--  SPLIT TICKET SEQUENCES: HL (herbicide lease sheets) + TM (time & materials)
--
--  Before:  All ticket numbers came from a single shared `ticket_seq` → T000001,
--           T000002, T000003 … — impossible to tell lease sheets from T&M tickets
--           at a glance, and sequences were intermixed so gaps were confusing.
--
--  After:   Two dedicated sequences, each starting at 1.
--              herb_lease_seq → HL000001, HL000002 … (wellsite + pipeline lease sheets)
--              tm_ticket_seq  → TM000001, TM000002 … (Time & Materials tickets)
--           Old `ticket_seq` is LEFT IN PLACE — existing T###### tickets keep
--           their numbers and any lingering code paths still work.
--
--  Safety:  Idempotent (CREATE SEQUENCE IF NOT EXISTS). No table rows touched,
--           no constraints added or dropped. Pure sequence-creation.
--
--  Run in:  Supabase → SQL editor → paste & execute. Must run BEFORE the next
--           backend deploy reaches production, otherwise the first attempt to
--           create a new lease sheet or T&M ticket will 500 on
--           `nextval('herb_lease_seq')` / `nextval('tm_ticket_seq')`.
-- ═════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Wellsite and pipeline herbicide lease sheets share this sequence. The "HL"
-- prefix is added by the application (backend/app/main.py, pipeline_routes.py).
CREATE SEQUENCE IF NOT EXISTS herb_lease_seq
    START WITH 1
    INCREMENT BY 1
    MINVALUE 1
    NO MAXVALUE
    CACHE 1;

-- Time & Materials tickets. The "TM" prefix is added by the application
-- (backend/app/time_materials_routes.py _allocate_ticket_number).
CREATE SEQUENCE IF NOT EXISTS tm_ticket_seq
    START WITH 1
    INCREMENT BY 1
    MINVALUE 1
    NO MAXVALUE
    CACHE 1;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run after migration):
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- SELECT sequence_name, start_value, last_value, is_called
-- FROM information_schema.sequences s
-- LEFT JOIN pg_sequences ps ON ps.sequencename = s.sequence_name
-- WHERE s.sequence_name IN ('herb_lease_seq', 'tm_ticket_seq', 'ticket_seq');
--
-- Expected: herb_lease_seq and tm_ticket_seq both exist, last_value NULL (unused yet).
--           ticket_seq still present (untouched).
--
-- Quick sanity test (does NOT actually consume the value in a way that matters):
-- SELECT nextval('herb_lease_seq');   -- should return 1 the first time
-- SELECT nextval('tm_ticket_seq');    -- should return 1 the first time
-- -- If you ran the sanity test, reset back to 1 so the first real ticket is HL000001 / TM000001:
-- SELECT setval('herb_lease_seq', 1, false);
-- SELECT setval('tm_ticket_seq',  1, false);
