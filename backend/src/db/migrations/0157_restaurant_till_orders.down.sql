DROP TABLE IF EXISTS restaurant_activity;
ALTER TABLE restaurant_guests DROP COLUMN IF EXISTS iou_limit, DROP COLUMN IF EXISTS iou_allowed;
ALTER TABLE restaurant_tables DROP COLUMN IF EXISTS area, DROP COLUMN IF EXISTS seats, DROP COLUMN IF EXISTS shape, DROP COLUMN IF EXISTS map_y, DROP COLUMN IF EXISTS map_x;
ALTER TABLE restaurant_kitchen_tickets DROP COLUMN IF EXISTS printed_at, DROP COLUMN IF EXISTS delivery_address, DROP COLUMN IF EXISTS customer_phone, DROP COLUMN IF EXISTS fulfillment;
ALTER TABLE restaurant_open_tabs DROP COLUMN IF EXISTS delivery_address, DROP COLUMN IF EXISTS customer_phone, DROP COLUMN IF EXISTS customer_name, DROP COLUMN IF EXISTS fulfillment;
ALTER TABLE restaurant_kitchen_items DROP COLUMN IF EXISTS note;
ALTER TABLE restaurant_order_items DROP COLUMN IF EXISTS sort_order, DROP COLUMN IF EXISTS custom, DROP COLUMN IF EXISTS note;
UPDATE restaurant_refunds SET method = 'cash' WHERE method IN ('alipay', 'wechat');
ALTER TABLE restaurant_refunds DROP CONSTRAINT restaurant_refunds_method_check;
ALTER TABLE restaurant_refunds ADD CONSTRAINT restaurant_refunds_method_check CHECK (method IN ('cash', 'mobile_money', 'vip', 'iou'));
ALTER TABLE restaurant_orders DROP COLUMN IF EXISTS delivery_address;
UPDATE restaurant_orders SET payment_method = 'other' WHERE payment_method IN ('alipay', 'wechat', 'split');
ALTER TABLE restaurant_orders DROP CONSTRAINT restaurant_orders_payment_method_check;
ALTER TABLE restaurant_orders ADD CONSTRAINT restaurant_orders_payment_method_check
  CHECK (payment_method IN ('cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other', 'vip', 'iou'));
DROP TABLE IF EXISTS restaurant_order_payments;
