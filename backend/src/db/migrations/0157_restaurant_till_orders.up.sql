-- The till's orders, grown up (restaurantPos.service.js and friends):
--
-- 1. How a sale was paid, part by part (restaurant_order_payments): one
--    row per way of paying, so a bill can be split (part cash, part Mobile
--    Money...) and paid in US dollars or Chinese yuan at the manager's
--    rate. amount is the part of the bill it pays, in cedis; a foreign
--    payment keeps its currency, the rate and the amount in that currency;
--    cash keeps what was handed over and the change given back (in cedis).
--    Sales from before this keep only restaurant_orders.payment_method.
--    New ways of paying: Alipay and WeChat Pay; 'split' on the order when
--    it was paid more than one way.
-- 2. A note on each dish ("no onions"), on the sale and the kitchen
--    ticket; and dishes not on the menu (custom, priced at the till).
-- 3. Dine in, pickup or delivery for an order kept open and its kitchen
--    tickets; a delivery's address (restaurant_orders already has
--    fulfillment, customer_name and customer_phone from migration 0134).
-- 4. Where each table stands on the floor map, its shape, seats and area.
-- 5. A customer's IOU account: allowed to owe, and up to how much. Anyone
--    who already has an IOU keeps theirs.
-- 6. Everything that happens on the till and the kitchen screen, for the
--    settings' activity report.

CREATE TABLE restaurant_order_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES restaurant_orders(id) ON DELETE CASCADE,
  method          text NOT NULL CHECK (method IN ('cash', 'mobile_money', 'alipay', 'wechat', 'vip', 'iou', 'other')),
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  currency        text NOT NULL DEFAULT 'GHS' CHECK (currency IN ('GHS', 'USD', 'CNY')),
  rate            numeric(14,6) NOT NULL DEFAULT 1 CHECK (rate > 0),
  foreign_amount  numeric(12,2) NULL,
  tendered        numeric(12,2) NULL,
  change_given    numeric(12,2) NOT NULL DEFAULT 0 CHECK (change_given >= 0),
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_order_payments_order ON restaurant_order_payments (order_id);

ALTER TABLE restaurant_orders DROP CONSTRAINT restaurant_orders_payment_method_check;
ALTER TABLE restaurant_orders ADD CONSTRAINT restaurant_orders_payment_method_check
  CHECK (payment_method IN ('cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other', 'vip', 'iou', 'alipay', 'wechat', 'split'));
ALTER TABLE restaurant_orders ADD COLUMN delivery_address text NOT NULL DEFAULT '';
ALTER TABLE restaurant_refunds DROP CONSTRAINT restaurant_refunds_method_check;
ALTER TABLE restaurant_refunds ADD CONSTRAINT restaurant_refunds_method_check CHECK (method IN ('cash', 'mobile_money', 'vip', 'iou', 'alipay', 'wechat'));

ALTER TABLE restaurant_order_items ADD COLUMN note text NOT NULL DEFAULT '', ADD COLUMN custom boolean NOT NULL DEFAULT false, ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE restaurant_kitchen_items ADD COLUMN note text NOT NULL DEFAULT '';

ALTER TABLE restaurant_open_tabs
  ADD COLUMN fulfillment text NOT NULL DEFAULT 'dine_in' CHECK (fulfillment IN ('dine_in', 'pickup', 'delivery')),
  ADD COLUMN customer_name text NOT NULL DEFAULT '',
  ADD COLUMN customer_phone text NOT NULL DEFAULT '',
  ADD COLUMN delivery_address text NOT NULL DEFAULT '';
ALTER TABLE restaurant_kitchen_tickets
  ADD COLUMN fulfillment text NOT NULL DEFAULT '',
  ADD COLUMN customer_phone text NOT NULL DEFAULT '',
  ADD COLUMN delivery_address text NOT NULL DEFAULT '',
  ADD COLUMN printed_at timestamptz NULL;

ALTER TABLE restaurant_tables
  ADD COLUMN map_x numeric(5,2) NULL CHECK (map_x BETWEEN 0 AND 100),
  ADD COLUMN map_y numeric(5,2) NULL CHECK (map_y BETWEEN 0 AND 100),
  ADD COLUMN shape text NOT NULL DEFAULT 'square' CHECK (shape IN ('square', 'round', 'long')),
  ADD COLUMN seats integer NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 40),
  ADD COLUMN area text NOT NULL DEFAULT '';

ALTER TABLE restaurant_guests ADD COLUMN iou_allowed boolean NOT NULL DEFAULT false, ADD COLUMN iou_limit numeric(12,2) NULL CHECK (iou_limit > 0);
UPDATE restaurant_guests g SET iou_allowed = true WHERE EXISTS (SELECT 1 FROM restaurant_orders o WHERE o.guest_id = g.id AND o.payment_method = 'iou');

CREATE TABLE restaurant_activity (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  employee_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  app          text NOT NULL CHECK (app IN ('till', 'kds', 'settings')),
  action       text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  amount       numeric(12,2) NULL,
  ref_type     text NULL,
  ref_id       uuid NULL,
  details      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_restaurant_activity_company ON restaurant_activity (company_id, at DESC);
