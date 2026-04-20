-- ═════════════════════════════════════════════════════════════════════════════════
--  T&M ROWS: allow one "main" row + one "Roadside" row per spray record
--
--  Problem:  `time_materials_rows.spray_record_id` has a single-column UNIQUE
--            constraint. When a worker submits a lease sheet that includes a
--            roadside (access-road) portion, the backend tries to insert TWO
--            rows for the same spray record:
--                (spray_record_id, site_type='Wellsite'|'Water'|...)   -- main
--                (spray_record_id, site_type='Roadside')               -- roadside
--            The second row hits the unique constraint → 500 on /spray,
--            worker's submission gets stuck in the retry queue forever.
--
--  Fix:      Replace the single-column UNIQUE with a COMPOSITE unique on
--            (spray_record_id, site_type). Now a spray record may have:
--                at most one "main" row (one per site_type value), and
--                at most one "Roadside" row.
--            The backend's _upsert_row() in time_materials_routes.py already
--            keys off (spray_record_id, site_type != 'Roadside'), so this
--            matches the intended behaviour.
--
--  Safety:   Idempotent. Only touches the unique index/constraint, does not
--            modify any rows. Re-creates a plain (non-unique) btree index
--            with the same name so existing query plans keep working.
--
--  Run in:   Supabase → SQL editor → paste & execute.
-- ═════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Drop the single-column unique. `unique=True` on the Column compiles to
--    a unique index named ix_time_materials_rows_spray_record_id; some
--    versions may have promoted it to a named constraint — handle both.
DROP INDEX IF EXISTS ix_time_materials_rows_spray_record_id;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'time_materials_rows'
          AND constraint_type = 'UNIQUE'
          AND constraint_name = 'time_materials_rows_spray_record_id_key'
    ) THEN
        ALTER TABLE time_materials_rows
            DROP CONSTRAINT time_materials_rows_spray_record_id_key;
    END IF;
END $$;

-- 2. Composite unique: one row per (spray_record_id, site_type) tuple.
--    This is what the application code has always assumed.
ALTER TABLE time_materials_rows
    ADD CONSTRAINT uq_tm_rows_spray_site_type
    UNIQUE (spray_record_id, site_type);

-- 3. Re-add a plain index for fast lookups by spray_record_id. We keep the
--    original name so any code / logs referencing it stay recognisable.
CREATE INDEX IF NOT EXISTS ix_time_materials_rows_spray_record_id
    ON time_materials_rows (spray_record_id);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run after migration):
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- -- Should list the NEW composite constraint:
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'time_materials_rows'::regclass AND contype = 'u';
-- -- Expected: uq_tm_rows_spray_site_type  UNIQUE (spray_record_id, site_type)
--
-- -- Should NOT find the old single-column unique index:
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'time_materials_rows' AND indexname LIKE '%spray_record_id%';
-- -- Expected: ix_time_materials_rows_spray_record_id  (plain, non-unique)
