-- ═════════════════════════════════════════════════════════════════════════════════
--  HYDROSEED MODULE: daily application records (HD######) + tickets (HT######)
--
--  Two new linked forms mirroring the herbicide lease sheet → T&M ticket flow:
--    • hydroseed_daily_records  — field data collection, one per crew per day per site
--    • hydroseed_tickets        — billing roll-up, many dailies aggregate into one HT
--    • hydroseed_ticket_rows    — per-material/equipment line items on the HT
--
--  Sequences:
--    • hydroseed_daily_seq      — produces HD000001, HD000002, …
--    • hydroseed_ticket_seq     — produces HT000001, HT000002, …
--
--  Status enum reused from time_materials_tickets (TMTicketStatus: open / submitted
--  / approved). Soft-delete via `deleted_at` matches the T&M / spray-records pattern.
--
--  Safety: Idempotent — CREATE { SEQUENCE | TABLE | INDEX } IF NOT EXISTS, ALTER
--  PUBLICATION wrapped in DO blocks that catch duplicate_object.
--
--  Run in: Supabase → SQL editor → paste & execute. Must run BEFORE the next
--  backend deploy reaches production.
-- ═════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Sequences ───────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS hydroseed_daily_seq
    START WITH 1 INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;

CREATE SEQUENCE IF NOT EXISTS hydroseed_ticket_seq
    START WITH 1 INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;


-- ── hydroseed_tickets ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hydroseed_tickets (
    id                      SERIAL PRIMARY KEY,
    ticket_number           VARCHAR(50)  NOT NULL UNIQUE,
    work_date               DATE         NOT NULL,
    client                  VARCHAR(120) NOT NULL,
    area                    VARCHAR(120) NOT NULL,
    description_of_work     TEXT,
    po_approval_number      VARCHAR(120),
    created_by_user_id      INTEGER REFERENCES users(id),
    created_by_name         VARCHAR(255),
    created_at              TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMP    NOT NULL DEFAULT NOW(),
    pdf_url                 TEXT,
    office_data             JSONB,
    approved_by_user_id     INTEGER REFERENCES users(id),
    approved_by_name        VARCHAR(255),
    approved_at             TIMESTAMP,
    approved_signature      TEXT,
    status                  VARCHAR(20)  NOT NULL DEFAULT 'open',
    deleted_at              TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_hydroseed_tickets_ticket_number ON hydroseed_tickets(ticket_number);
CREATE INDEX IF NOT EXISTS ix_hydroseed_tickets_work_date     ON hydroseed_tickets(work_date);
CREATE INDEX IF NOT EXISTS ix_hydroseed_tickets_client        ON hydroseed_tickets(client);
CREATE INDEX IF NOT EXISTS ix_hydroseed_tickets_area          ON hydroseed_tickets(area);
CREATE INDEX IF NOT EXISTS ix_hydroseed_tickets_created_by    ON hydroseed_tickets(created_by_user_id);
CREATE INDEX IF NOT EXISTS ix_hydroseed_tickets_created_at    ON hydroseed_tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_hydroseed_tickets_updated_at    ON hydroseed_tickets(updated_at);
CREATE INDEX IF NOT EXISTS ix_hydroseed_tickets_status        ON hydroseed_tickets(status);
CREATE INDEX IF NOT EXISTS ix_hydroseed_tickets_deleted_at    ON hydroseed_tickets(deleted_at);


-- ── hydroseed_daily_records ──────────────────────────────────────────────────
-- Standalone-by-default. Optional site_id FK for future map-pin integration.
CREATE TABLE IF NOT EXISTS hydroseed_daily_records (
    id                      SERIAL PRIMARY KEY,
    record_number           VARCHAR(50)  NOT NULL UNIQUE,
    work_date               DATE         NOT NULL,
    client                  VARCHAR(120) NOT NULL,
    area                    VARCHAR(120) NOT NULL,
    site_name               VARCHAR(255),
    description_of_work     TEXT,
    mulch_type              VARCHAR(50),
    comments                TEXT,
    -- Annotated map / canvas / photo images (Dropbox URLs after upload).
    photo_urls              JSONB        DEFAULT '[]'::jsonb,
    -- Seed bag tag photos — separate so the PDF renders them in their own section.
    seed_tag_photo_urls     JSONB        DEFAULT '[]'::jsonb,
    -- Full form snapshot (header + crew + equipment + ingredients + loads + comments).
    -- Acts the same way `lease_sheet_data` does on site_spray_records: source of
    -- truth for re-render and edit. Worker fills it offline; backend persists as-is.
    daily_data              JSONB,
    pdf_url                 TEXT,
    -- Optional link to a map pin (site). NULL for standalone records.
    site_id                 INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    -- Link to the parent HT ticket. NULLed on ticket soft-delete (the SET NULL
    -- here matches site_spray_records.tm_ticket_id behavior).
    hydroseed_ticket_id     INTEGER REFERENCES hydroseed_tickets(id) ON DELETE SET NULL,
    -- For standalone records, capture GPS at submit time for future map-pinning.
    latitude                DOUBLE PRECISION,
    longitude               DOUBLE PRECISION,
    created_by_user_id      INTEGER REFERENCES users(id),
    created_by_name         VARCHAR(255),
    created_at              TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMP    NOT NULL DEFAULT NOW(),
    -- Idempotency key for offline-queued submits (UUID minted client-side).
    client_submission_id    VARCHAR(64),
    deleted_at              TIMESTAMP,
    deleted_by_user_id      INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS ix_hydroseed_dailies_record_number    ON hydroseed_daily_records(record_number);
CREATE INDEX IF NOT EXISTS ix_hydroseed_dailies_work_date        ON hydroseed_daily_records(work_date);
CREATE INDEX IF NOT EXISTS ix_hydroseed_dailies_client           ON hydroseed_daily_records(client);
CREATE INDEX IF NOT EXISTS ix_hydroseed_dailies_area             ON hydroseed_daily_records(area);
CREATE INDEX IF NOT EXISTS ix_hydroseed_dailies_created_by       ON hydroseed_daily_records(created_by_user_id);
CREATE INDEX IF NOT EXISTS ix_hydroseed_dailies_updated_at       ON hydroseed_daily_records(updated_at);
CREATE INDEX IF NOT EXISTS ix_hydroseed_dailies_ticket_id        ON hydroseed_daily_records(hydroseed_ticket_id);
CREATE INDEX IF NOT EXISTS ix_hydroseed_dailies_site_id          ON hydroseed_daily_records(site_id);
CREATE INDEX IF NOT EXISTS ix_hydroseed_dailies_deleted_at       ON hydroseed_daily_records(deleted_at);

-- Partial unique index on client_submission_id so retries dedupe correctly without
-- blocking legacy nulls. Matches the site_spray_records idempotency pattern.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hydroseed_dailies_client_submission_id
    ON hydroseed_daily_records(client_submission_id)
    WHERE client_submission_id IS NOT NULL;


-- ── hydroseed_ticket_rows ────────────────────────────────────────────────────
-- One row per material / equipment / labour line that rolls up from linked dailies.
-- `kind` discriminates the section the row renders into on the HT PDF.
CREATE TABLE IF NOT EXISTS hydroseed_ticket_rows (
    id                      SERIAL PRIMARY KEY,
    ticket_id               INTEGER NOT NULL REFERENCES hydroseed_tickets(id) ON DELETE CASCADE,
    daily_record_id         INTEGER REFERENCES hydroseed_daily_records(id) ON DELETE CASCADE,
    kind                    VARCHAR(32) NOT NULL,        -- 'material' | 'equipment' | 'labour'
    label                   VARCHAR(255) NOT NULL,
    qty                     NUMERIC(14, 2),
    unit                    VARCHAR(60),
    cost_code               VARCHAR(64),
    created_at              TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_hydroseed_rows_ticket_id      ON hydroseed_ticket_rows(ticket_id);
CREATE INDEX IF NOT EXISTS ix_hydroseed_rows_daily_id       ON hydroseed_ticket_rows(daily_record_id);
CREATE INDEX IF NOT EXISTS ix_hydroseed_rows_kind           ON hydroseed_ticket_rows(kind);


-- ── Realtime publication + REPLICA IDENTITY FULL ─────────────────────────────
ALTER TABLE public.hydroseed_tickets        REPLICA IDENTITY FULL;
ALTER TABLE public.hydroseed_daily_records  REPLICA IDENTITY FULL;
ALTER TABLE public.hydroseed_ticket_rows    REPLICA IDENTITY FULL;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.hydroseed_tickets;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.hydroseed_daily_records;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.hydroseed_ticket_rows;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run after migration):
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- SELECT sequencename FROM pg_sequences
--   WHERE sequencename IN ('hydroseed_daily_seq', 'hydroseed_ticket_seq');
-- → 2 rows.
--
-- SELECT tablename FROM pg_tables
--   WHERE schemaname = 'public'
--     AND tablename IN ('hydroseed_tickets', 'hydroseed_daily_records', 'hydroseed_ticket_rows');
-- → 3 rows.
--
-- SELECT tablename FROM pg_publication_tables
--   WHERE pubname='supabase_realtime'
--     AND tablename LIKE 'hydroseed%';
-- → 3 rows.
