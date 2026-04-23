-- ═════════════════════════════════════════════════════════════════════════════════
--  T&M ROWS: allow manually-added rows with no spray-record link
--
--  Problem:  `ck_tm_rows_exactly_one_spray_fk` enforces that EXACTLY ONE of
--            `spray_record_id` or `pipeline_spray_record_id` must be set.
--            This prevents admin users from adding manual "Sites Treated" rows
--            that don't originate from a spray record.
--
--  Fix:      Relax the constraint so that BOTH FKs may be NULL (manual row)
--            but they still may not BOTH be non-NULL at the same time.
--
--  Safety:   Idempotent. Drops and re-creates the CHECK constraint.
--            Existing rows (exactly one FK set) continue to pass.
--
--  Run in:   Supabase → SQL editor → paste & execute.
-- ═════════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
BEGIN
    -- 1. Drop the old XOR-only constraint if it exists
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'time_materials_rows'
          AND constraint_type = 'CHECK'
          AND constraint_name = 'ck_tm_rows_exactly_one_spray_fk'
    ) THEN
        ALTER TABLE time_materials_rows
            DROP CONSTRAINT ck_tm_rows_exactly_one_spray_fk;
    END IF;

    -- 2. Add the relaxed constraint: no row may have BOTH FKs set,
    --    but having zero or one set is fine.
    ALTER TABLE time_materials_rows
        ADD CONSTRAINT ck_tm_rows_exactly_one_spray_fk
        CHECK (
            NOT (spray_record_id IS NOT NULL AND pipeline_spray_record_id IS NOT NULL)
        );
END $$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run after migration):
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'time_materials_rows'::regclass AND contype = 'c';
-- -- Expected: ck_tm_rows_exactly_one_spray_fk CHECK (
-- --   NOT (spray_record_id IS NOT NULL AND pipeline_spray_record_id IS NOT NULL)
-- -- )
--
-- SELECT COUNT(*) FROM time_materials_rows
-- WHERE spray_record_id IS NULL AND pipeline_spray_record_id IS NULL;
-- -- Expected: 0 before any admin usage; >= 0 after manual rows are added.
