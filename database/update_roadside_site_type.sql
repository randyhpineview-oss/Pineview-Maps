-- Migration to move Roadside to a main site type instead of an access road add-on.
UPDATE location_types 
SET is_access_road = FALSE 
WHERE name = 'Roadside';
