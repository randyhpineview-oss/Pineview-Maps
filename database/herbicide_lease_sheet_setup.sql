-- ============================================
-- Herbicide Lease Sheet + Bandwidth Fix SQL
-- Run this in Supabase SQL Editor
-- ============================================

-- 1. Global Ticket Number Sequence
CREATE SEQUENCE IF NOT EXISTS ticket_seq
    START WITH 1001
    INCREMENT BY 1
    NO MAXVALUE
    CACHE 1;

-- 2. Lookup Tables for Admin Management

-- Herbicides (global list for both sites and roadside)
CREATE TABLE IF NOT EXISTS herbicides (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    pcp_number VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Applicators
CREATE TABLE IF NOT EXISTS applicators (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    license_number VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Noxious Weeds
CREATE TABLE IF NOT EXISTS noxious_weeds (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Location Types
CREATE TABLE IF NOT EXISTS location_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    is_access_road BOOLEAN DEFAULT FALSE,  -- triggers roadside fields in form
    is_pipeline BOOLEAN DEFAULT FALSE,     -- triggers the Total Metres field + Pipeline T&M row
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Add columns to existing spray records tables

-- Site Spray Records
ALTER TABLE site_spray_records 
ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(50),
ADD COLUMN IF NOT EXISTS lease_sheet_data JSONB,
ADD COLUMN IF NOT EXISTS photo_urls TEXT[],
ADD COLUMN IF NOT EXISTS pdf_dropbox_path TEXT,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Pipeline Spray Records (table name is 'spray_records')
ALTER TABLE spray_records 
ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(50),
ADD COLUMN IF NOT EXISTS lease_sheet_data JSONB,
ADD COLUMN IF NOT EXISTS photo_urls TEXT[],
ADD COLUMN IF NOT EXISTS pdf_dropbox_path TEXT,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- 4. Add updated_at to sites and pipelines for bandwidth sync
ALTER TABLE sites 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

ALTER TABLE pipelines 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- 5. Create function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. Create triggers for auto-updating updated_at

-- Sites trigger
DROP TRIGGER IF EXISTS sites_updated_at ON sites;
CREATE TRIGGER sites_updated_at
    BEFORE UPDATE ON sites
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Pipelines trigger  
DROP TRIGGER IF EXISTS pipelines_updated_at ON pipelines;
CREATE TRIGGER pipelines_updated_at
    BEFORE UPDATE ON pipelines
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Site Spray Records trigger
DROP TRIGGER IF EXISTS site_spray_records_updated_at ON site_spray_records;
CREATE TRIGGER site_spray_records_updated_at
    BEFORE UPDATE ON site_spray_records
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Pipeline Spray Records trigger
DROP TRIGGER IF EXISTS spray_records_updated_at ON spray_records;
CREATE TRIGGER spray_records_updated_at
    BEFORE UPDATE ON spray_records
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Lookup tables triggers
DROP TRIGGER IF EXISTS herbicides_updated_at ON herbicides;
CREATE TRIGGER herbicides_updated_at
    BEFORE UPDATE ON herbicides
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS applicators_updated_at ON applicators;
CREATE TRIGGER applicators_updated_at
    BEFORE UPDATE ON applicators
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS noxious_weeds_updated_at ON noxious_weeds;
CREATE TRIGGER noxious_weeds_updated_at
    BEFORE UPDATE ON noxious_weeds
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS location_types_updated_at ON location_types;
CREATE TRIGGER location_types_updated_at
    BEFORE UPDATE ON location_types
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 7. Insert default location types
INSERT INTO location_types (name, is_access_road, is_pipeline) VALUES
    ('Compressor', FALSE, FALSE),
    ('Wellsite', FALSE, FALSE),
    ('Riser', FALSE, FALSE),
    ('Access Road', TRUE, FALSE),
    ('Plant Site', FALSE, FALSE),
    ('Roadside', TRUE, FALSE),
    ('Municipal', FALSE, FALSE),
    ('Pipeline', FALSE, TRUE)
ON CONFLICT DO NOTHING;

-- 8. Insert sample herbicides
INSERT INTO herbicides (name, pcp_number) VALUES
    ('Tordon', 'PCP9005'),
    ('Glyphosate', 'PCP28487'),
    ('Milestone', 'PCP28519'),
    ('Escort', 'PCP28487'),
    ('MCPA', 'PCP31327'),
    ('Par III', 'PCP27884')
ON CONFLICT DO NOTHING;

-- 9. Enable RLS on lookup tables (if needed)
ALTER TABLE herbicides ENABLE ROW LEVEL SECURITY;
ALTER TABLE applicators ENABLE ROW LEVEL SECURITY;
ALTER TABLE noxious_weeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_types ENABLE ROW LEVEL SECURITY;

-- 10. Create policies for lookup tables (readable by all, writable by admin)
CREATE POLICY "Herbicides readable by all" ON herbicides FOR SELECT USING (true);
CREATE POLICY "Applicators readable by all" ON applicators FOR SELECT USING (true);
CREATE POLICY "Noxious weeds readable by all" ON noxious_weeds FOR SELECT USING (true);
CREATE POLICY "Location types readable by all" ON location_types FOR SELECT USING (true);

-- 11. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sites_updated_at ON sites(updated_at);
CREATE INDEX IF NOT EXISTS idx_pipelines_updated_at ON pipelines(updated_at);
CREATE INDEX IF NOT EXISTS idx_site_spray_records_ticket ON site_spray_records(ticket_number);
CREATE INDEX IF NOT EXISTS idx_spray_records_ticket ON spray_records(ticket_number);

-- ============================================
-- DONE! Your database is ready for:
-- - Global ticket numbering
-- - Admin-managed lookup tables
-- - Herbicide lease sheet data storage
-- - Bandwidth-efficient sync (updated_at tracking)
-- ============================================
