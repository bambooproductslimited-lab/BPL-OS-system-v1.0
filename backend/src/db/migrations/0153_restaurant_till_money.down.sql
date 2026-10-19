DROP TABLE IF EXISTS restaurant_vip_entries;
DROP TABLE IF EXISTS restaurant_refund_items;
DROP TABLE IF EXISTS restaurant_refunds;
DROP INDEX IF EXISTS idx_restaurant_orders_iou_paid;
DROP INDEX IF EXISTS idx_restaurant_orders_iou_open;
ALTER TABLE restaurant_orders DROP COLUMN IF EXISTS iou_paid_amount;
ALTER TABLE restaurant_orders DROP COLUMN IF EXISTS iou_paid_by;
ALTER TABLE restaurant_orders DROP COLUMN IF EXISTS iou_paid_method;
ALTER TABLE restaurant_orders DROP COLUMN IF EXISTS iou_paid_at;
ALTER TABLE restaurant_orders DROP COLUMN IF EXISTS refunded_total;
UPDATE restaurant_orders SET payment_method = 'other' WHERE payment_method IN ('vip', 'iou');
ALTER TABLE restaurant_orders DROP CONSTRAINT restaurant_orders_payment_method_check;
ALTER TABLE restaurant_orders ADD CONSTRAINT restaurant_orders_payment_method_check
  CHECK (payment_method IN ('cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other'));
