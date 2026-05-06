-- Widen phone_number column to accommodate longer phone numbers with notes
ALTER TABLE sites ALTER COLUMN phone_number TYPE VARCHAR(255);
