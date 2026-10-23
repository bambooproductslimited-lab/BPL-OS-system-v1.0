ALTER TABLE restaurant_kitchen_tickets DROP COLUMN IF EXISTS ready_text;
ALTER TABLE restaurant_orders DROP COLUMN IF EXISTS tip;
DROP TABLE IF EXISTS restaurant_displays;
