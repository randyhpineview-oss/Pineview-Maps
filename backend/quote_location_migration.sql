-- Quote Builder: add top-level "location" field
-- Run once in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- Safe to re-run — IF NOT EXISTS prevents errors on duplicate execution.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS location TEXT;
