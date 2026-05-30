-- SQL Script to Normalize Client and Area Names in Supabase (PostgreSQL)
--
-- This script normalizes existing `client` and `area` values in all relevant tables.
-- It collapses whitespace, trims leading/trailing spaces, and converts to Title Case (INITCAP).
-- 
-- Run this in the Supabase SQL Editor to clean up legacy data and ensure consistency
-- with the new frontend/backend lookup matching.

BEGIN;

-- 1. Normalize time_materials_tickets
UPDATE time_materials_tickets
SET
    client = INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g')),
    updated_at = NOW()
WHERE client IS NOT NULL
  AND client <> INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g'));

UPDATE time_materials_tickets
SET
    area = INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g')),
    updated_at = NOW()
WHERE area IS NOT NULL
  AND area <> INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g'));

-- 2. Normalize hydroseed_tickets
UPDATE hydroseed_tickets
SET
    client = INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g')),
    updated_at = NOW()
WHERE client IS NOT NULL
  AND client <> INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g'));

UPDATE hydroseed_tickets
SET
    area = INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g')),
    updated_at = NOW()
WHERE area IS NOT NULL
  AND area <> INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g'));

-- 3. Normalize hydroseed_daily_records
UPDATE hydroseed_daily_records
SET
    client = INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g')),
    updated_at = NOW()
WHERE client IS NOT NULL
  AND client <> INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g'));

UPDATE hydroseed_daily_records
SET
    area = INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g')),
    updated_at = NOW()
WHERE area IS NOT NULL
  AND area <> INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g'));

-- 4. Normalize sites (just in case)
UPDATE sites
SET
    client = INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g')),
    updated_at = NOW()
WHERE client IS NOT NULL
  AND client <> INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g'));

UPDATE sites
SET
    area = INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g')),
    updated_at = NOW()
WHERE area IS NOT NULL
  AND area <> INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g'));

-- 5. Normalize pipelines (just in case)
UPDATE pipelines
SET
    client = INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g')),
    updated_at = NOW()
WHERE client IS NOT NULL
  AND client <> INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g'));

UPDATE pipelines
SET
    area = INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g')),
    updated_at = NOW()
WHERE area IS NOT NULL
  AND area <> INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g'));

COMMIT;
