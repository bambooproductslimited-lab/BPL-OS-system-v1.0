DROP INDEX idx_restaurant_orders_external_id;
ALTER TABLE restaurant_orders DROP COLUMN source;
ALTER TABLE restaurant_orders DROP COLUMN external_id;
