ALTER TABLE settings DROP COLUMN IF EXISTS stock_sheet;
ALTER TABLE tasks DROP COLUMN IF EXISTS done_photos;
DROP TABLE IF EXISTS task_stock_items;
