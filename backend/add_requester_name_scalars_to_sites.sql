-- Denormalized requester-name columns. The existing `created_by_user_id` and
-- `pending_change_requested_by_user_id` FKs are great for the relational
-- joinedload path, but Supabase Realtime ships the raw `sites` row to
-- subscribers without joins, so the admin's pending-approvals card had no
-- way to render a name when the realtime INSERT/UPDATE event was the
-- channel that delivered the row. Mirrors the existing
-- `last_inspected_by_name` / `last_inspected_by_email` pattern on the same
-- table.
ALTER TABLE sites
ADD COLUMN IF NOT EXISTS created_by_name TEXT;

ALTER TABLE sites
ADD COLUMN IF NOT EXISTS pending_change_requested_by_name TEXT;

-- Backfill existing rows so previously-submitted pending sites still show
-- the correct requester name in the UI.
UPDATE sites
SET created_by_name = users.name
FROM users
WHERE sites.created_by_user_id = users.id
  AND sites.created_by_name IS NULL;

UPDATE sites
SET pending_change_requested_by_name = users.name
FROM users
WHERE sites.pending_change_requested_by_user_id = users.id
  AND sites.pending_change_requested_by_name IS NULL;
