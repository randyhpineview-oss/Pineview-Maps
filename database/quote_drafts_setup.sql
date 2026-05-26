-- Quote drafts table — run once in Supabase SQL Editor.
-- Stores per-user in-progress quote drafts server-side so they are
-- accessible from any device. The full form state is kept in `data` JSONB.

CREATE TABLE IF NOT EXISTS quote_drafts (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL DEFAULT 'Untitled',
    data        JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_quote_drafts_user_id ON quote_drafts (user_id);
