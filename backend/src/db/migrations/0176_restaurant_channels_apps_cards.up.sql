-- Where each sale came from (restaurantTillSales, restaurantTillInsights,
-- the Square-format downloads): rung up on the till, a website order, a
-- table's QR order, the self-order kiosk, a delivery app (Bolt Food,
-- Glovo…, restaurantApps.service.js) or brought in from Square.
ALTER TABLE restaurant_orders
  ADD COLUMN channel text NOT NULL DEFAULT 'till' CHECK (channel IN ('till', 'website', 'table', 'kiosk', 'app', 'square')),
  ADD COLUMN app text NULL,
  ADD COLUMN app_ref text NOT NULL DEFAULT '',
  ADD COLUMN app_commission numeric(12,2) NOT NULL DEFAULT 0 CHECK (app_commission >= 0),
  ADD COLUMN app_payout_id uuid NULL;
UPDATE restaurant_orders SET channel = 'square' WHERE source = 'square';
UPDATE restaurant_orders o SET channel = 'website' WHERE channel = 'till' AND EXISTS (SELECT 1 FROM restaurant_online_orders w WHERE w.order_id = o.id);
UPDATE restaurant_orders o SET channel = 'table' WHERE channel = 'till' AND o.id IN (
  SELECT k.order_id FROM restaurant_table_orders t JOIN restaurant_kitchen_tickets k ON k.id = t.kitchen_ticket_id WHERE k.order_id IS NOT NULL);
CREATE INDEX idx_restaurant_orders_channel ON restaurant_orders (company_id, channel, created_at);
CREATE INDEX idx_restaurant_orders_app_unpaid ON restaurant_orders (company_id, app, created_at) WHERE app IS NOT NULL AND app_payout_id IS NULL;

-- What a delivery app paid the restaurant for its orders up to a day.
CREATE TABLE restaurant_app_payouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  app         text NOT NULL,
  through     date NOT NULL,
  orders      integer NOT NULL DEFAULT 0,
  expected    numeric(12,2) NOT NULL DEFAULT 0,
  amount      numeric(12,2) NOT NULL CHECK (amount >= 0),
  received_on date NOT NULL,
  method      text NOT NULL CHECK (method IN ('mobile_money', 'bank_transfer', 'cash', 'other')),
  note        text NOT NULL DEFAULT '',
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_app_payouts ON restaurant_app_payouts (company_id, app, received_on DESC);
ALTER TABLE restaurant_orders ADD CONSTRAINT restaurant_orders_app_payout_fkey FOREIGN KEY (app_payout_id) REFERENCES restaurant_app_payouts(id) ON DELETE SET NULL;

-- New ways of paying: a card (on the bank's terminal, or online through
-- Paystack) and "paid on the app" (a delivery app's order).
ALTER TABLE restaurant_order_payments DROP CONSTRAINT restaurant_order_payments_method_check;
ALTER TABLE restaurant_order_payments ADD CONSTRAINT restaurant_order_payments_method_check
  CHECK (method IN ('cash', 'mobile_money', 'alipay', 'wechat', 'vip', 'iou', 'gift_card', 'card', 'app', 'other'));
ALTER TABLE restaurant_orders DROP CONSTRAINT restaurant_orders_payment_method_check;
ALTER TABLE restaurant_orders ADD CONSTRAINT restaurant_orders_payment_method_check
  CHECK (payment_method IN ('cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other', 'vip', 'iou', 'alipay', 'wechat', 'split', 'gift_card', 'app'));
ALTER TABLE restaurant_refunds DROP CONSTRAINT restaurant_refunds_method_check;
ALTER TABLE restaurant_refunds ADD CONSTRAINT restaurant_refunds_method_check
  CHECK (method IN ('cash', 'mobile_money', 'vip', 'iou', 'alipay', 'wechat', 'gift_card', 'card'));
-- A card part: its brand, last 4 digits, how it was read, the terminal's
-- approval code; and, paid through Paystack, its reference (used once).
ALTER TABLE restaurant_order_payments
  ADD COLUMN card_brand text NULL,
  ADD COLUMN card_last4 text NULL CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  ADD COLUMN card_entry text NULL CHECK (card_entry IS NULL OR card_entry IN ('tap', 'chip', 'swipe', 'online')),
  ADD COLUMN card_ref text NOT NULL DEFAULT '',
  ADD COLUMN provider text NULL CHECK (provider IS NULL OR provider IN ('terminal', 'paystack')),
  ADD COLUMN provider_ref text NULL;
CREATE UNIQUE INDEX uq_restaurant_order_payments_provider_ref ON restaurant_order_payments (provider_ref) WHERE provider = 'paystack';
