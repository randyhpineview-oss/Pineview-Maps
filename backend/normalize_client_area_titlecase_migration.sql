-- One-shot back-fill: rewrite existing `client` and `area` text columns
-- to the canonical Title-Case form ("Foothills", "Abc Energy") so the
-- DB matches the new normalize-on-save rule applied at the React layer
-- (lib/mapUtils#normalizeName).
--
-- Postgres `INITCAP` capitalizes the first letter of each
-- alphanumeric run separated by non-alphanumerics — exact parity with
-- the JS regex /(^|[\s\-'])(\p{L})/u used by normalizeName, so
-- "north-west pasture" → "North-West Pasture" and "o'brien farms" →
-- "O'Brien Farms" the same way in both layers.
--
-- BTRIM + regexp_replace(\s+, ' ') collapses whitespace before INITCAP
-- so "  ABC   ENERGY  " → "Abc Energy" matches the JS helper too.
--
-- The WHERE clause guards against pointless writes: only rows whose
-- current value differs from its canonical form are touched. We also
-- bump `updated_at` so the /delta sync endpoint actually ships these
-- changes to connected clients on their next poll — without that bump
-- a worker's local IndexedDB cache would keep the legacy casing until
-- the next full refresh.
--
-- Safe to re-run: idempotent. Wrapped in a single transaction so a
-- failure mid-flight rolls everything back.

BEGIN;

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

-- Time & materials tickets carry the same client/area pair and feed
-- the Reports dashboard's customer/area filter dropdowns. Migrate
-- them too so those dropdowns stay consistent with the map filters.
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

-- Quick post-migration sanity check: surface any rows that somehow
-- still don't match the canonical form. Should always return zero.
-- (Comment out before committing if the host complains about empty
-- result set output.)
SELECT 'sites.client' AS table_field, COUNT(*) AS unnormalized
FROM sites
WHERE client IS NOT NULL
  AND client <> INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g'))
UNION ALL
SELECT 'sites.area', COUNT(*) FROM sites
WHERE area IS NOT NULL
  AND area <> INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g'))
UNION ALL
SELECT 'pipelines.client', COUNT(*) FROM pipelines
WHERE client IS NOT NULL
  AND client <> INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g'))
UNION ALL
SELECT 'pipelines.area', COUNT(*) FROM pipelines
WHERE area IS NOT NULL
  AND area <> INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g'))
UNION ALL
SELECT 'tm_tickets.client', COUNT(*) FROM time_materials_tickets
WHERE client IS NOT NULL
  AND client <> INITCAP(REGEXP_REPLACE(BTRIM(client), '\s+', ' ', 'g'))
UNION ALL
SELECT 'tm_tickets.area', COUNT(*) FROM time_materials_tickets
WHERE area IS NOT NULL
  AND area <> INITCAP(REGEXP_REPLACE(BTRIM(area), '\s+', ' ', 'g'));

COMMIT;
