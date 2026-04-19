-- ═════════════════════════════════════════════════════════════════════════════════
--  Time & Materials Ticket Integration — Supabase SQL Migration
--  Run once against your Supabase / Postgres database.
--  Safe to re-run (all statements are idempotent via IF NOT EXISTS).
-- ═════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Enum for T&M ticket status ────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tmticketstatus') THEN
        CREATE TYPE tmticketstatus AS ENUM ('open', 'submitted', 'approved');
    END IF;
END $$;

-- ── time_materials_tickets ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS time_materials_tickets (
    id                     SERIAL PRIMARY KEY,
    ticket_number          VARCHAR(50)  NOT NULL UNIQUE,
    spray_date             DATE         NOT NULL,
    client                 VARCHAR(120) NOT NULL,
    area                   VARCHAR(120) NOT NULL,
    description_of_work    TEXT,
    po_approval_number     VARCHAR(120),
    created_by_user_id     INTEGER      REFERENCES users(id) ON DELETE SET NULL,
    created_by_name        VARCHAR(255),
    created_at             TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP    NOT NULL DEFAULT NOW(),
    pdf_url                TEXT,
    office_data            JSONB,
    approved_by_user_id    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
    approved_by_name       VARCHAR(255),
    approved_at            TIMESTAMP,
    approved_signature     TEXT,
    status                 tmticketstatus NOT NULL DEFAULT 'open'
);

CREATE INDEX IF NOT EXISTS ix_time_materials_tickets_ticket_number ON time_materials_tickets(ticket_number);
CREATE INDEX IF NOT EXISTS ix_time_materials_tickets_spray_date   ON time_materials_tickets(spray_date);
CREATE INDEX IF NOT EXISTS ix_time_materials_tickets_client        ON time_materials_tickets(client);
CREATE INDEX IF NOT EXISTS ix_time_materials_tickets_area          ON time_materials_tickets(area);
CREATE INDEX IF NOT EXISTS ix_time_materials_tickets_created_by    ON time_materials_tickets(created_by_user_id);
CREATE INDEX IF NOT EXISTS ix_time_materials_tickets_status        ON time_materials_tickets(status);

-- ── time_materials_rows (each row ⇔ one linked SiteSprayRecord) ──────────────
CREATE TABLE IF NOT EXISTS time_materials_rows (
    id                SERIAL PRIMARY KEY,
    ticket_id         INTEGER NOT NULL REFERENCES time_materials_tickets(id) ON DELETE CASCADE,
    spray_record_id   INTEGER NOT NULL UNIQUE REFERENCES site_spray_records(id) ON DELETE CASCADE,
    location          VARCHAR(255),
    site_type         VARCHAR(64),
    herbicides        VARCHAR(255),
    liters_used       NUMERIC(12, 2),
    area_ha           NUMERIC(12, 2),
    cost_code         VARCHAR(64),
    created_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_time_materials_rows_ticket_id       ON time_materials_rows(ticket_id);
CREATE INDEX IF NOT EXISTS ix_time_materials_rows_spray_record_id ON time_materials_rows(spray_record_id);

-- ── site_spray_records: add tm_ticket_id FK ──────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'site_spray_records' AND column_name = 'tm_ticket_id'
    ) THEN
        ALTER TABLE site_spray_records
            ADD COLUMN tm_ticket_id INTEGER
            REFERENCES time_materials_tickets(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_site_spray_records_tm_ticket_id ON site_spray_records(tm_ticket_id);

-- ── Shared ticket sequence (already exists in the deployed DB, but create if missing) ──
-- This ensures new installs work out of the box.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ticket_seq') THEN
        CREATE SEQUENCE ticket_seq START 1;
    END IF;
END $$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES (run these after the migration to confirm success):
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- -- Confirm the new tables exist with correct columns:
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'time_materials_tickets'
-- ORDER BY ordinal_position;
--
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'time_materials_rows'
-- ORDER BY ordinal_position;
--
-- -- Confirm tm_ticket_id on site_spray_records:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'site_spray_records' AND column_name = 'tm_ticket_id';
--
-- -- Confirm ticket_seq exists:
-- SELECT last_value FROM ticket_seq;
