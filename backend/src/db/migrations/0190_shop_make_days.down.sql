ALTER TABLE shop_orders DROP COLUMN IF EXISTS ready_by, DROP COLUMN IF EXISTS ready_from;
ALTER TABLE catalog_items DROP CONSTRAINT IF EXISTS catalog_items_make_days, DROP COLUMN IF EXISTS make_days_max, DROP COLUMN IF EXISTS make_days_min;
