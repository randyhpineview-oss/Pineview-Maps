-- ═════════════════════════════════════════════════════════════════════════════════
--  LOCATION TYPES: add is_pipeline flag
--
--  Problem:  Pipeline lease sheets need special handling on the T&M ticket
--            (site_type="Pipeline", area as km from totalDistanceSprayed) and
--            the Herbicide Lease Sheet form hides the "Total Metres" input
--            unless a pipeline location type is selected. Hard-coding the
--            string 'Pipeline' is fragile if admins rename the row, so mirror
--            the existing `is_access_road` pattern with a new boolean flag.
--
--  Fix:      Add `is_pipeline BOOLEAN DEFAULT FALSE` to location_types and
--            backfill TRUE for the seeded 'Pipeline' row (case-insensitive).
--
--  Safety:   Idempotent. Adds column with a safe default; no existing row
--            behaviour changes unless the name matches 'pipeline'.
--
--  Run in:   Supabase → SQL editor → paste & execute.
-- ═════════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE location_types
    ADD COLUMN IF NOT EXISTS is_pipeline BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill the flag on any existing "Pipeline" row(s). Case-insensitive so
-- common admin variants ('pipeline', 'PIPELINE') get flagged too.
UPDATE location_types
    SET is_pipeline = TRUE
    WHERE LOWER(name) = 'pipeline'
      AND is_pipeline = FALSE;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run after migration):
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- SELECT name, is_access_road, is_pipeline FROM location_types ORDER BY name;
-- -- Expected: the 'Pipeline' row has is_pipeline = TRUE, all others FALSE.
