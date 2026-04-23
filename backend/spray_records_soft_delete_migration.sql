-- ═════════════════════════════════════════════════════════════════════════════════
--  SPRAY RECORDS SOFT DELETE
--
--  Problem:  Site spray records (wellsite herbicide lease sheets) and pipeline
--            spray records (pipeline lease sheets) are currently hard-deleted
--            by admin/office users. There is no way to recover a deleted lease
--            sheet, and the Recently Submitted list cannot show removals in
--            delta sync.
--
--  Solution: Add deleted_at + deleted_by_user_id to both tables, mirroring
--            the existing sites/pipelines/time_materials_tickets pattern.
--            Old hard deletes are converted to soft deletes via the API.
--
--  T&M row impact: when a spray record is soft-deleted, its child
--            time_materials_rows become manual rows (FKs set to NULL).
--            The ticket itself stays intact. This matches user preference.
-- ═════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. site_spray_records
ALTER TABLE site_spray_records
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_site_spray_records_deleted_at
    ON site_spray_records (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_site_spray_records_updated_at
    ON site_spray_records (updated_at DESC);

-- Ensure updated_at exists for delta sync (used by the incremental
-- recent-submissions endpoint). If it doesn't, add it.
ALTER TABLE site_spray_records
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Trigger to auto-bump updated_at on any change (same as sites/pipelines)
CREATE OR REPLACE FUNCTION _trg_bump_site_spray_records_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bump_site_spray_records_updated_at ON site_spray_records;
CREATE TRIGGER trg_bump_site_spray_records_updated_at
    BEFORE UPDATE ON site_spray_records
    FOR EACH ROW
    EXECUTE FUNCTION _trg_bump_site_spray_records_updated_at();

-- 2. spray_records (pipeline side)
ALTER TABLE spray_records
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_spray_records_deleted_at
    ON spray_records (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_spray_records_updated_at
    ON spray_records (updated_at DESC);

-- Ensure updated_at exists for delta sync
ALTER TABLE spray_records
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

CREATE OR REPLACE FUNCTION _trg_bump_spray_records_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bump_spray_records_updated_at ON spray_records;
CREATE TRIGGER trg_bump_spray_records_updated_at
    BEFORE UPDATE ON spray_records
    FOR EACH ROW
    EXECUTE FUNCTION _trg_bump_spray_records_updated_at();

COMMIT;
