-- Track who requested a pending change (currently used for pin-type-change
-- requests via /api/sites/{id}/request-type-change). For brand-new
-- field-added pins, the requester is already captured via created_by_user_id,
-- so this column stays NULL on those rows.
ALTER TABLE sites
ADD COLUMN IF NOT EXISTS pending_change_requested_by_user_id INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_sites_pending_change_requested_by_user_id
ON sites(pending_change_requested_by_user_id);
