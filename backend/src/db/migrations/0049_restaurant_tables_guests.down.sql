ALTER TABLE restaurant_orders DROP COLUMN table_id;
ALTER TABLE restaurant_orders DROP COLUMN waiter_id;
ALTER TABLE restaurant_orders DROP COLUMN guest_id;
DROP TABLE restaurant_guests;
DROP TABLE restaurant_tables;
