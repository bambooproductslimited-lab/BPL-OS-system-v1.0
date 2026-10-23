DROP TABLE IF EXISTS restaurant_paystack_payments;
ALTER TABLE restaurant_table_orders DROP CONSTRAINT IF EXISTS restaurant_table_orders_kind_table;
DELETE FROM restaurant_table_orders WHERE kind = 'kiosk' OR status = 'unpaid';
ALTER TABLE restaurant_table_orders DROP CONSTRAINT restaurant_table_orders_status_check;
ALTER TABLE restaurant_table_orders ADD CONSTRAINT restaurant_table_orders_status_check CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled'));
ALTER TABLE restaurant_table_orders DROP COLUMN IF EXISTS paystack_ref, DROP COLUMN IF EXISTS dining, DROP COLUMN IF EXISTS kiosk_id, DROP COLUMN IF EXISTS kind;
ALTER TABLE restaurant_table_orders ALTER COLUMN table_id SET NOT NULL;
DELETE FROM restaurant_displays WHERE kind = 'kiosk';
ALTER TABLE restaurant_displays DROP COLUMN IF EXISTS kind;
