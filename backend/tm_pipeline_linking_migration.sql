-- ═════════════════════════════════════════════════════════════════════════════════
--  T&M LINKING FOR PIPELINE SPRAY RECORDS
--
--  Problem:  T&M ticket linking (ticket_id + sites-treated row) was wired only
--            for SiteSprayRecord (`site_spray_records`). When a worker fills
--            out a herbicide lease sheet against a PIPELINE, the frontend
--            sends the same `time_materials_link` payload, but the pipeline
--            submit endpoint dropped it on the floor — no ticket was ever
--            created or appended to, and the lease sheet never showed up in
--            any T&M list (admin / office / worker).
--
--  Fix:      Extend the T&M schema so a row/ticket can reference EITHER a
--            site spray record (existing column) OR a pipeline spray record
--            (new column), via two nullable FKs guarded by a CHECK that
--            exactly one is set. Also gives pipeline `spray_records` its
--            own `tm_ticket_id` FK matching the one on `site_spray_records`
--            so the "this spray record is linked to ticket X" relationship
--            works identically on both sides.
--
--  Safety:   Idempotent. Adds nullable columns + constraints only; no data
--            rewrite. Existing site-only rows keep `spray_record_id` set
--            and `pipeline_spray_record_id` NULL — the CHECK passes.
--
--  Run in:   Supabase → SQL editor → paste & execute.
-- ═════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Pipeline spray_records gets a tm_ticket_id FK mirroring site_spray_records.
ALTER TABLE spray_records
    ADD COLUMN IF NOT EXISTS tm_ticket_id INTEGER NULL
        REFERENCES time_materials_tickets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_spray_records_tm_ticket_id
    ON spray_records (tm_ticket_id);

-- 2. time_materials_rows gets a second FK to pipeline spray_records, and the
--    existing site FK becomes nullable so a row can reference either side.
ALTER TABLE time_materials_rows
    ADD COLUMN IF NOT EXISTS pipeline_spray_record_id INTEGER NULL
        REFERENCES spray_records(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_time_materials_rows_pipeline_spray_record_id
    ON time_materials_rows (pipeline_spray_record_id);

ALTER TABLE time_materials_rows
    ALTER COLUMN spray_record_id DROP NOT NULL;

-- 3. CHECK: exactly one of the two FKs is set (XOR).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'time_materials_rows'
          AND constraint_type = 'CHECK'
          AND constraint_name = 'ck_tm_rows_exactly_one_spray_fk'
    ) THEN
        ALTER TABLE time_materials_rows
            ADD CONSTRAINT ck_tm_rows_exactly_one_spray_fk
            CHECK (
                (spray_record_id IS NOT NULL) <> (pipeline_spray_record_id IS NOT NULL)
            );
    END IF;
END $$;

-- 4. Composite unique on the pipeline side, matching the existing site-side
--    uq_tm_rows_spray_site_type. Per (pipeline_spray_record_id, site_type),
--    a pipeline lease sheet can have at most one "main" row + one "Roadside"
--    companion row. Postgres treats each NULL as distinct, so rows from the
--    site side (pipeline_spray_record_id IS NULL) are not constrained by
--    this index, and vice versa.
ALTER TABLE time_materials_rows
    ADD CONSTRAINT uq_tm_rows_pipeline_spray_site_type
    UNIQUE (pipeline_spray_record_id, site_type);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run after migration):
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- SELECT column_name, is_nullable, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'time_materials_rows'
--   AND column_name IN ('spray_record_id', 'pipeline_spray_record_id');
-- -- Expected: both nullable=YES, integer.
--
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'time_materials_rows'::regclass;
-- -- Expected: includes ck_tm_rows_exactly_one_spray_fk CHECK (...)
--
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'spray_records' AND column_name = 'tm_ticket_id';
-- -- Expected: 1 row.
