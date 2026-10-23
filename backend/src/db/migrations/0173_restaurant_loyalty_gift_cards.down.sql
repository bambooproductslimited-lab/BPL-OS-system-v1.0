DELETE FROM restaurant_refunds WHERE method = 'gift_card';
ALTER TABLE restaurant_refunds DROP CONSTRAINT restaurant_refunds_method_check;
ALTER TABLE restaurant_refunds ADD CONSTRAINT restaurant_refunds_method_check
  CHECK (method IN ('cash', 'mobile_money', 'vip', 'iou', 'alipay', 'wechat'));
UPDATE restaurant_orders SET payment_method = 'other' WHERE payment_method = 'gift_card';
ALTER TABLE restaurant_orders DROP CONSTRAINT restaurant_orders_payment_method_check;
ALTER TABLE restaurant_orders ADD CONSTRAINT restaurant_orders_payment_method_check
  CHECK (payment_method IN ('cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other', 'vip', 'iou', 'alipay', 'wechat', 'split'));
ALTER TABLE restaurant_order_payments DROP COLUMN IF EXISTS gift_card_id;
UPDATE restaurant_order_payments SET method = 'other' WHERE method = 'gift_card';
ALTER TABLE restaurant_order_payments DROP CONSTRAINT restaurant_order_payments_method_check;
ALTER TABLE restaurant_order_payments ADD CONSTRAINT restaurant_order_payments_method_check
  CHECK (method IN ('cash', 'mobile_money', 'alipay', 'wechat', 'vip', 'iou', 'other'));
DROP TABLE IF EXISTS restaurant_gift_card_entries;
DROP TABLE IF EXISTS restaurant_gift_cards;
ALTER TABLE restaurant_orders DROP COLUMN IF EXISTS points_used, DROP COLUMN IF EXISTS points_earned;
DROP TABLE IF EXISTS restaurant_loyalty_entries;
