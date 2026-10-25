DROP TABLE IF EXISTS shop_quote_requests;
DROP TABLE IF EXISTS shop_reviews;
ALTER TABLE shop_orders DROP COLUMN IF EXISTS review_asked_at, DROP COLUMN IF EXISTS reminded_at;
ALTER TABLE restaurant_bookings DROP COLUMN IF EXISTS deposit_status, DROP COLUMN IF EXISTS deposit_amount;
UPDATE restaurant_online_orders SET status = 'cancelled' WHERE status = 'unpaid';
UPDATE restaurant_online_orders SET pay_method = 'cash' WHERE pay_method = 'online';
ALTER TABLE restaurant_online_orders DROP CONSTRAINT restaurant_online_orders_pay_method_check;
ALTER TABLE restaurant_online_orders ADD CONSTRAINT restaurant_online_orders_pay_method_check CHECK (pay_method IN ('cash', 'mobile_money'));
ALTER TABLE restaurant_online_orders DROP CONSTRAINT restaurant_online_orders_status_check;
ALTER TABLE restaurant_online_orders ADD CONSTRAINT restaurant_online_orders_status_check CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'done'));
DROP INDEX IF EXISTS idx_restaurant_paystack_booking;
DROP INDEX IF EXISTS idx_restaurant_paystack_online;
ALTER TABLE restaurant_paystack_payments DROP COLUMN IF EXISTS refunded_at, DROP COLUMN IF EXISTS refund_note, DROP COLUMN IF EXISTS refund_status,
  DROP COLUMN IF EXISTS booking_id, DROP COLUMN IF EXISTS online_order_id;
DELETE FROM restaurant_paystack_payments WHERE purpose IN ('online', 'deposit');
ALTER TABLE restaurant_paystack_payments DROP CONSTRAINT restaurant_paystack_payments_purpose_check;
ALTER TABLE restaurant_paystack_payments ADD CONSTRAINT restaurant_paystack_payments_purpose_check CHECK (purpose IN ('till', 'kiosk', 'table', 'gift'));
