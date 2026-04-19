-- ═════════════════════════════════════════════════════════════════════════════════
--  EGRESS CLEANUP — strip photos[].data from existing lease_sheet_data rows
--
--  Problem:  `site_spray_records.lease_sheet_data` historically stored every
--            lease-sheet photo as a base64 string inside the JSONB column.
--            Combined with /api/sites and /api/recent-submissions returning
--            the full blob, this blew through the Supabase free-tier egress
--            budget.
--
--  Fix:      Drop the `data` key from every element of `lease_sheet_data.photos`.
--            The photos themselves are still safe in Dropbox (URLs tracked in
--            the sibling `photo_urls` column) — only the embedded DB copy goes.
--
--  Safety:   Idempotent. Affects only rows where `lease_sheet_data.photos`
--            is a JSONB array. Rows without photos are untouched.
--
--  Run in:   Supabase → SQL editor → paste & execute.
-- ═════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Strip photos[].data from site_spray_records.lease_sheet_data
UPDATE site_spray_records
SET lease_sheet_data = jsonb_set(
    lease_sheet_data,
    '{photos}',
    COALESCE(
        (
            SELECT jsonb_agg(elem - 'data')
            FROM jsonb_array_elements(lease_sheet_data->'photos') AS elem
        ),
        '[]'::jsonb
    )
)
WHERE lease_sheet_data ? 'photos'
  AND jsonb_typeof(lease_sheet_data->'photos') = 'array';

-- 2. Same for the legacy `spray_records` table, if it still exists and still
--    carries photos. Wrapped in DO $$ so it's a no-op when the table/column
--    isn't present.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'spray_records' AND column_name = 'lease_sheet_data'
    ) THEN
        EXECUTE $sql$
            UPDATE spray_records
            SET lease_sheet_data = jsonb_set(
                lease_sheet_data,
                '{photos}',
                COALESCE(
                    (
                        SELECT jsonb_agg(elem - 'data')
                        FROM jsonb_array_elements(lease_sheet_data->'photos') AS elem
                    ),
                    '[]'::jsonb
                )
            )
            WHERE lease_sheet_data ? 'photos'
              AND jsonb_typeof(lease_sheet_data->'photos') = 'array'
        $sql$;
    END IF;
END $$;

COMMIT;

-- 3. Reclaim the disk space that the base64 strings were holding. VACUUM FULL
--    cannot run inside a transaction, so it's outside the BEGIN/COMMIT above.
VACUUM (FULL, ANALYZE) site_spray_records;

-- Optional: same on legacy table if present.
-- VACUUM (FULL, ANALYZE) spray_records;

-- ─────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run these after the migration to confirm):
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- -- How many rows still have any photo-data?
-- SELECT COUNT(*) AS rows_with_remaining_photo_data
-- FROM site_spray_records
-- WHERE lease_sheet_data ? 'photos'
--   AND EXISTS (
--       SELECT 1 FROM jsonb_array_elements(lease_sheet_data->'photos') elem
--       WHERE elem ? 'data'
--   );
-- -- Expected: 0
--
-- -- Table size (should shrink drastically after VACUUM FULL):
-- SELECT pg_size_pretty(pg_total_relation_size('site_spray_records')) AS total_size;
