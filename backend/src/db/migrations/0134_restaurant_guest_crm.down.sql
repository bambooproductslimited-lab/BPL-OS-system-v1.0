DROP TABLE IF EXISTS restaurant_guest_orders;
ALTER TABLE restaurant_orders DROP COLUMN IF EXISTS source_name, DROP COLUMN IF EXISTS fulfillment, DROP COLUMN IF EXISTS customer_name,
  DROP COLUMN IF EXISTS customer_phone, DROP COLUMN IF EXISTS square_customer_id, DROP COLUMN IF EXISTS ticket_name;
DROP INDEX IF EXISTS uq_restaurant_guests_square;
ALTER TABLE restaurant_guests DROP COLUMN IF EXISTS square_customer_id;
DROP TRIGGER IF EXISTS restaurant_guests_keys ON restaurant_guests;
DROP FUNCTION IF EXISTS restaurant_guests_keys();
ALTER TABLE restaurant_guests DROP COLUMN IF EXISTS source;
ALTER TABLE restaurant_guests DROP COLUMN IF EXISTS name_key;
ALTER TABLE restaurant_guests DROP COLUMN IF EXISTS phone_key;
DROP FUNCTION IF EXISTS restaurant_name_key(text);
DROP FUNCTION IF EXISTS restaurant_phone_key(text);
