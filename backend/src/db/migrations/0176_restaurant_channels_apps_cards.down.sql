DROP INDEX IF EXISTS uq_restaurant_order_payments_provider_ref;
ALTER TABLE restaurant_order_payments DROP COLUMN IF EXISTS provider_ref, DROP COLUMN IF EXISTS provider, DROP COLUMN IF EXISTS card_ref,
  DROP COLUMN IF EXISTS card_entry, DROP COLUMN IF EXISTS card_last4, DROP COLUMN IF EXISTS card_brand;
DELETE FROM restaurant_order_payments WHERE method IN ('card', 'app');
UPDATE restaurant_orders SET payment_method = 'other' WHERE payment_method = 'app';
DELETE FROM restaurant_refunds WHERE method = 'card';
ALTER TABLE restaurant_refunds DROP CONSTRAINT restaurant_refunds_method_check;
ALTER TABLE restaurant_refunds ADD CONSTRAINT restaurant_refunds_method_check
  CHECK (method IN ('cash', 'mobile_money', 'vip', 'iou', 'alipay', 'wechat', 'gift_card'));
ALTER TABLE restaurant_orders DROP CONSTRAINT restaurant_orders_payment_method_check;
ALTER TABLE restaurant_orders ADD CONSTRAINT restaurant_orders_payment_method_check
  CHECK (payment_method IN ('cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other', 'vip', 'iou', 'alipay', 'wechat', 'split', 'gift_card'));
ALTER TABLE restaurant_order_payments DROP CONSTRAINT restaurant_order_payments_method_check;
ALTER TABLE restaurant_order_payments ADD CONSTRAINT restaurant_order_payments_method_check
  CHECK (method IN ('cash', 'mobile_money', 'alipay', 'wechat', 'vip', 'iou', 'gift_card', 'other'));
ALTER TABLE restaurant_orders DROP CONSTRAINT IF EXISTS restaurant_orders_app_payout_fkey;
DROP TABLE IF EXISTS restaurant_app_payouts;
DROP INDEX IF EXISTS idx_restaurant_orders_app_unpaid;
DROP INDEX IF EXISTS idx_restaurant_orders_channel;
ALTER TABLE restaurant_orders DROP COLUMN IF EXISTS app_payout_id, DROP COLUMN IF EXISTS app_commission, DROP COLUMN IF EXISTS app_ref,
  DROP COLUMN IF EXISTS app, DROP COLUMN IF EXISTS channel;
