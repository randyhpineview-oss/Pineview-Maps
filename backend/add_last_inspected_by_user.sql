-- Add last_inspected_by_user_id column to sites table
ALTER TABLE sites 
ADD COLUMN last_inspected_by_user_id INTEGER REFERENCES users(id);

-- Create index for better performance
CREATE INDEX idx_sites_last_inspected_by_user_id ON sites(last_inspected_by_user_id);
