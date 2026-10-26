DROP TABLE IF EXISTS bpl_visits;
DROP TABLE IF EXISTS bpl_service_requests;
ALTER TABLE settings DROP COLUMN IF EXISTS visits;

DELETE FROM restaurant_displays WHERE kind = 'menu';
ALTER TABLE restaurant_displays DROP COLUMN IF EXISTS options;
ALTER TABLE restaurant_displays DROP CONSTRAINT restaurant_displays_kind_check;
ALTER TABLE restaurant_displays ADD CONSTRAINT restaurant_displays_kind_check CHECK (kind IN ('screen', 'kiosk', 'board'));

ALTER TABLE restaurant_paystack_payments DROP COLUMN IF EXISTS event_id;
DELETE FROM restaurant_paystack_payments WHERE purpose = 'event';
ALTER TABLE restaurant_paystack_payments DROP CONSTRAINT restaurant_paystack_payments_purpose_check;
ALTER TABLE restaurant_paystack_payments ADD CONSTRAINT restaurant_paystack_payments_purpose_check CHECK (purpose IN ('till', 'kiosk', 'table', 'gift', 'online', 'deposit'));
DROP TABLE IF EXISTS restaurant_events;

DROP TABLE IF EXISTS restaurant_safe_moves;
ALTER TABLE restaurant_drawer_movements DROP COLUMN IF EXISTS approved_by;
ALTER TABLE restaurant_drawer_movements DROP COLUMN IF EXISTS by_id;
ALTER TABLE restaurant_drawer_movements DROP COLUMN IF EXISTS photo;
ALTER TABLE restaurant_drawer_movements DROP COLUMN IF EXISTS paid_to;
ALTER TABLE restaurant_drawer_movements DROP COLUMN IF EXISTS category;
ALTER TABLE restaurant_drawer_movements DROP COLUMN IF EXISTS kind;

DROP TABLE IF EXISTS restaurant_more_settings;
