-- Add is_hidden column to sites table for external/standalone lease sheets
ALTER TABLE sites ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_sites_is_hidden ON sites(is_hidden);
