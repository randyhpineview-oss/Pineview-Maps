-- Add the `crew_lead` value to the `roleenum` Postgres enum used by
-- `users.role`. Run once in the Supabase SQL Editor.
--
-- Crew leads sit above worker but below office/admin: they can approve
-- map pins, view the Check-ins Dashboard read-only, and import
-- standalone lease sheets onto new pins. They do NOT get T&M / hydroseed
-- approval, Reports, Quote Builder, Calendar, Lookup Tables, User
-- Management, or the destructive "Permanently delete all" tools.
--
-- `IF NOT EXISTS` makes this idempotent (PostgreSQL 12+). Re-running is
-- safe; if the value is already present the statement is a no-op.
--
-- After running this:
--   1. Promote individual users to Crew Lead from the User Management
--      panel in the app (Admin tab → User Management).
--   2. Promoted users must sign out and back in to refresh their JWT
--      before the new permissions take effect.

ALTER TYPE roleenum ADD VALUE IF NOT EXISTS 'crew_lead';
