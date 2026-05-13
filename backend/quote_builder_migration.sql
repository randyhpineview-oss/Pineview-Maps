-- ═════════════════════════════════════════════════════════════════════════════════
--  Quote Builder — Supabase SQL migration
--  Run once against your Supabase / Postgres database (SQL editor).
--  Safe to re-run (all statements are idempotent via IF NOT EXISTS / ON CONFLICT).
--
--  Creates:
--    1. quote_seq                 — Postgres sequence used to produce Q######.
--    2. quote_rate_categories     — Hydroseeding / Herbicide / Drone Map / Drone Seed.
--    3. quote_rate_items          — Catalog of line items per category, with
--                                   optional per-item default markup % and label.
--    4. quotes                    — Submitted quotes (line items kept as JSONB so
--                                   we don't need a separate quote_lines table).
--    5. Seed: 4 categories + ~30 catalog items at 2026 rates.
-- ═════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Sequence for Q###### numbering (mirrors herb_lease_seq / tm_ticket_seq) ──
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'quote_seq') THEN
        CREATE SEQUENCE quote_seq START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE;
    END IF;
END $$;

-- ── 2. Categories ──
CREATE TABLE IF NOT EXISTS quote_rate_categories (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(120) NOT NULL UNIQUE,
    notes        TEXT,
    sort_order   INTEGER      NOT NULL DEFAULT 0,
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_quote_rate_categories_sort   ON quote_rate_categories(sort_order);
CREATE INDEX IF NOT EXISTS ix_quote_rate_categories_active ON quote_rate_categories(is_active) WHERE is_active = TRUE;

-- ── 3. Items ──
CREATE TABLE IF NOT EXISTS quote_rate_items (
    id                   SERIAL PRIMARY KEY,
    category_id          INTEGER        NOT NULL REFERENCES quote_rate_categories(id) ON DELETE CASCADE,
    name                 VARCHAR(200)   NOT NULL,
    unit                 VARCHAR(60)    NOT NULL DEFAULT '',
    rate                 NUMERIC(12, 4) NOT NULL DEFAULT 0,
    notes                TEXT,
    default_markup_pct   NUMERIC(6, 2),
    default_markup_label VARCHAR(60),
    sort_order           INTEGER        NOT NULL DEFAULT 0,
    is_active            BOOLEAN        NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMP      NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMP      NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_quote_rate_items_category_name UNIQUE (category_id, name)
);

CREATE INDEX IF NOT EXISTS ix_quote_rate_items_category ON quote_rate_items(category_id);
CREATE INDEX IF NOT EXISTS ix_quote_rate_items_sort     ON quote_rate_items(category_id, sort_order);
CREATE INDEX IF NOT EXISTS ix_quote_rate_items_active   ON quote_rate_items(is_active) WHERE is_active = TRUE;

-- ── 4. Submitted quotes ──
CREATE TABLE IF NOT EXISTS quotes (
    id                    SERIAL PRIMARY KEY,
    quote_number          VARCHAR(20)    NOT NULL UNIQUE,
    client                VARCHAR(120)   NOT NULL,
    area                  VARCHAR(120),
    project_description   TEXT,
    quote_date            DATE           NOT NULL,
    mix_categories        BOOLEAN        NOT NULL DEFAULT FALSE,
    tax_enabled           BOOLEAN        NOT NULL DEFAULT FALSE,
    tax_label             VARCHAR(60),
    tax_rate              NUMERIC(6, 3),
    subtotal              NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tax_amount            NUMERIC(14, 2) NOT NULL DEFAULT 0,
    grand_total           NUMERIC(14, 2) NOT NULL DEFAULT 0,
    line_items_json       JSONB          NOT NULL,
    notes                 TEXT,
    pdf_url               TEXT,
    created_by_user_id    INTEGER        REFERENCES users(id) ON DELETE SET NULL,
    created_by_email      VARCHAR(255),
    created_by_name       VARCHAR(255),
    created_at            TIMESTAMP      NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMP      NOT NULL DEFAULT NOW(),
    deleted_at            TIMESTAMP WITH TIME ZONE,
    deleted_by_user_id    INTEGER        REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ix_quotes_quote_number ON quotes(quote_number);
CREATE INDEX IF NOT EXISTS ix_quotes_client       ON quotes(client);
CREATE INDEX IF NOT EXISTS ix_quotes_quote_date   ON quotes(quote_date);
CREATE INDEX IF NOT EXISTS ix_quotes_created_at   ON quotes(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_quotes_created_by   ON quotes(created_by_user_id);
CREATE INDEX IF NOT EXISTS ix_quotes_deleted_at   ON quotes(deleted_at) WHERE deleted_at IS NOT NULL;

-- ── 5. Seed categories ──
INSERT INTO quote_rate_categories (name, notes, sort_order) VALUES
    ('Hydroseeding',
     'T&M basis, no standby or day rates. 10-hr days incl. travel. Mulch rate scales with slope (1:1 @ 3500 kg/ha → 4:1 @ 2400 kg/ha). Project quoted prior to commencing.',
     10),
    ('Herbicide Application',
     '',
     20),
    ('Drone — Mapping / Surveying / Weed ID',
     '',
     30),
    ('Drone — Seeding',
     'Seed cost is +10% on top (Pick Seeds; First Nation seed mix on request).',
     40)
ON CONFLICT (name) DO NOTHING;

-- ── 6. Seed items — Hydroseeding ──
INSERT INTO quote_rate_items (category_id, name, unit, rate, sort_order)
SELECT c.id, v.name, v.unit, v.rate, v.sort_order
FROM quote_rate_categories c
CROSS JOIN (VALUES
    ('T400 Hydroseeder',         'hr',           425.00, 10),
    ('T330 Hydroseeder',         'hr',           375.00, 20),
    ('1600 Hydroseeder',         'hr',           300.00, 30),
    ('MOB equipment & material', 'hr',           200.00, 40),
    ('Skid steer',               'hr',           150.00, 50),
    ('Crew truck',               'hr',           150.00, 60),
    ('Labourer',                 'hr',            95.00, 70),
    ('Supervisor with truck',    'hr',           160.00, 80),
    ('Lead',                     'hr',           135.00, 90),
    ('Mileage',                  'km',             1.30, 100),
    ('Mulch — low',              'bale',          75.00, 110),
    ('Mulch — high',             'bale',         115.00, 120),
    ('Seed (per bag)',           '22.8 kg bag',  750.00, 130),
    ('Fertilizer',               '22.8 kg bag',  105.00, 140),
    ('Micro nutrients',          'litre / tank', 200.00, 150)
) AS v(name, unit, rate, sort_order)
WHERE c.name = 'Hydroseeding'
ON CONFLICT (category_id, name) DO NOTHING;

-- ── 7. Seed items — Herbicide Application ──
INSERT INTO quote_rate_items (category_id, name, unit, rate, sort_order)
SELECT c.id, v.name, v.unit, v.rate, v.sort_order
FROM quote_rate_categories c
CROSS JOIN (VALUES
    ('Truck Spray Unit',      'hr',  120.000, 10),
    ('Lead Applicator',       'hr',  115.000, 20),
    ('Assistant Applicator',  'hr',   90.000, 30),
    ('UTV',                   'day', 300.000, 40),
    ('Backpack sprayer',      'day', 100.000, 50),
    ('One-herbicide mix',     'm²',    0.025, 60),
    ('Two-herbicide mix',     'm²',    0.035, 70),
    ('Three-herbicide mix',   'm²',    0.040, 80)
) AS v(name, unit, rate, sort_order)
WHERE c.name = 'Herbicide Application'
ON CONFLICT (category_id, name) DO NOTHING;

-- ── 8. Seed items — Drone Mapping / Surveying / Weed ID ──
INSERT INTO quote_rate_items (category_id, name, unit, rate, sort_order)
SELECT c.id, v.name, v.unit, v.rate, v.sort_order
FROM quote_rate_categories c
CROSS JOIN (VALUES
    ('Drone Unit (Matrice 300/400 RTK package)', 'day', 850.00, 10),
    ('Pilot / Supervisor',                       'hr',  135.00, 20),
    ('Additional labour',                        'hr',   95.00, 30),
    ('Truck / Trailer',                          'hr',  120.00, 40),
    ('SXS / UTV',                                'day', 300.00, 50),
    ('Reporting',                                'hr',  135.00, 60)
) AS v(name, unit, rate, sort_order)
WHERE c.name = 'Drone — Mapping / Surveying / Weed ID'
ON CONFLICT (category_id, name) DO NOTHING;

-- ── 9a. Seed items — Drone Seeding (no markup) ──
INSERT INTO quote_rate_items (category_id, name, unit, rate, sort_order)
SELECT c.id, v.name, v.unit, v.rate, v.sort_order
FROM quote_rate_categories c
CROSS JOIN (VALUES
    ('Drone Unit (DJI T50 seeding package)', 'day', 1750.00, 10),
    ('Seeding Drone application',            'm²',    0.100, 20),
    ('Truck / Trailer',                      'hr',  120.000, 30),
    ('Pilot / Supervisor',                   'hr',  135.000, 40),
    ('Additional labour',                    'hr',   95.000, 50)
) AS v(name, unit, rate, sort_order)
WHERE c.name = 'Drone — Seeding'
ON CONFLICT (category_id, name) DO NOTHING;

-- ── 9b. Seed item — Drone Seeding: Seed (sourced at cost) with default 10% markup ──
INSERT INTO quote_rate_items (category_id, name, unit, rate, default_markup_pct, default_markup_label, sort_order)
SELECT c.id, 'Seed (sourced at cost)', 'actual cost', 0.00, 10.00, 'cost', 60
FROM quote_rate_categories c
WHERE c.name = 'Drone — Seeding'
ON CONFLICT (category_id, name) DO NOTHING;

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (paste into the SQL editor after running the migration):
-- ───────────────────────────────────────────────────────────────────────────────────────
-- SELECT * FROM quote_rate_categories ORDER BY sort_order;
-- SELECT c.name AS category, i.name, i.unit, i.rate, i.default_markup_pct, i.default_markup_label
--   FROM quote_rate_items i JOIN quote_rate_categories c ON c.id = i.category_id
--   ORDER BY c.sort_order, i.sort_order;
-- SELECT last_value FROM quote_seq;        -- expect 1 before any quotes submitted
