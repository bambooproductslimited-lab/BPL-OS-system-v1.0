-- The order an item's variations are shown in: the order of its options'
-- choices (Small, Medium, Large), not the alphabet (catalogOptions.service.js).
ALTER TABLE catalog_item_variations ADD COLUMN position integer NOT NULL DEFAULT 0;
