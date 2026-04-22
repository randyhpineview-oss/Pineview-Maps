-- ═════════════════════════════════════════════════════════════════════════════════
--  EGRESS / COMPUTE — indexes on sync-status watermark columns
--
--  Problem:  /api/sync-status runs every 5 min × N workers and issues three
--            `SELECT MAX(updated_at)` / `SELECT MAX(created_at)` scans. With
--            no index on those columns Postgres must read the entire table
--            every tick; at 20 workers × ~288 polls/day that's 17k+ full-
--            table scans per day per resource. Cheap now, painful at scale.
--
--            Same story for the delta endpoints (`WHERE updated_at > :since`)
--            and for the site-spray-records list query (`WHERE site_id = :id
--            ORDER BY created_at DESC`).
--
--  Fix:      B-tree indexes on the columns the hot paths filter / sort on.
--            All are `IF NOT EXISTS` so rerunning is safe.
--
--  Safety:   Idempotent. Zero app-side changes required. At Pineview's
--            current table sizes (sites ~413 rows, pipelines ~hundreds,
--            site_spray_records ~dozens) each CREATE INDEX takes <100 ms
--            of ACCESS EXCLUSIVE lock — imperceptible to live traffic.
--
--  Run in:   Supabase → SQL editor → paste & execute.
--            NOTE: We deliberately do NOT use `CREATE INDEX CONCURRENTLY`
--            here. CONCURRENTLY refuses to run inside a transaction block
--            and the Supabase SQL editor auto-wraps every query in one.
--            Plain `CREATE INDEX` works perfectly fine at this scale.
-- ═════════════════════════════════════════════════════════════════════════════════

-- 1. sync-status + /api/sites/delta on sites: MAX(updated_at), WHERE updated_at > :since.
--    Verified working: 3,805 scans served in the first 24 h after deploy.
CREATE INDEX IF NOT EXISTS idx_sites_updated_at
  ON sites (updated_at DESC);

-- 2. sync-status + /api/pipelines/delta on pipelines: same pattern.
CREATE INDEX IF NOT EXISTS idx_pipelines_updated_at
  ON pipelines (updated_at DESC);

-- 3. sync-status on spray records: MAX(created_at), also used by
--    /api/recent-submissions/delta (`WHERE created_at > :since`).
CREATE INDEX IF NOT EXISTS idx_site_spray_records_created_at
  ON site_spray_records (created_at DESC);

-- NOTE: A composite `(site_id, created_at DESC)` index was considered for
-- the /api/sites/{id}/spray list, but pg_stat_user_indexes confirmed it
-- was wholly shadowed by the pre-existing single-column
-- `ix_site_spray_records_site_id` and never picked by the planner. It was
-- dropped to avoid write-amplification on every spray-record INSERT.
-- If spray_records volume grows 100× AND per-site ORDER BY created_at
-- becomes a measurable bottleneck, reintroduce it.

-- ─────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- After running, confirm the indexes exist:
--
-- SELECT indexname, tablename FROM pg_indexes
-- WHERE indexname IN (
--   'idx_sites_updated_at',
--   'idx_pipelines_updated_at',
--   'idx_site_spray_records_created_at'
-- );
--
-- Confirm the planner is picking them up (note: pg_stat_user_indexes uses
-- `indexrelname`, not `indexname`):
--
-- SELECT indexrelname AS index_name, idx_scan, idx_tup_read, idx_tup_fetch
-- FROM pg_stat_user_indexes
-- WHERE indexrelname IN (
--   'idx_sites_updated_at',
--   'idx_pipelines_updated_at',
--   'idx_site_spray_records_created_at'
-- );
--
-- EXPLAIN ANALYZE SELECT MAX(updated_at) FROM sites;
-- -- Expect: "Index Only Scan using idx_sites_updated_at" (not a Seq Scan)
--
-- EXPLAIN ANALYZE SELECT id FROM sites
-- WHERE updated_at > NOW() - INTERVAL '5 minutes'
--   AND deleted_at IS NULL;
-- -- Expect: "Index Scan using idx_sites_updated_at"

-- ─────────────────────────────────────────────────────────────────────────────────
-- ONE-TIME CLEANUP (run only if you previously executed an older version of
-- this file that included the composite index).
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- DROP INDEX IF EXISTS idx_site_spray_records_site_id_created_at;
