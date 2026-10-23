-- Loyalty points (restaurantLoyalty.service.js): a customer earns points on
-- what they spend (the till's settings: one point for every so many cedis)
-- and spends them on the restaurant's rewards (an amount or a percentage
-- off the bill). The balance is the sum of the entries, never stored.
CREATE TABLE restaurant_loyalty_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  guest_id     uuid NOT NULL REFERENCES restaurant_guests(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('earn', 'redeem', 'refund', 'adjust')),
  points       integer NOT NULL CHECK (points <> 0),
  order_id     uuid NULL REFERENCES restaurant_orders(id) ON DELETE SET NULL,
  reward       text NULL,
  employee_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_loyalty_guest ON restaurant_loyalty_entries (guest_id, created_at DESC);
CREATE INDEX idx_restaurant_loyalty_company ON restaurant_loyalty_entries (company_id, created_at DESC);
ALTER TABLE restaurant_orders
  ADD COLUMN points_earned integer NOT NULL DEFAULT 0,
  ADD COLUMN points_used integer NOT NULL DEFAULT 0;

-- Gift cards (restaurantGiftCards.service.js): sold at the till for cash or
-- Mobile Money (money in the drawer, not a sale), spent as a way of paying
-- (gift_card) until the balance — the sum of its entries — is used up. Its
-- code is printed on it; its token is the link to the card's own page.
CREATE TABLE restaurant_gift_cards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code         text NOT NULL UNIQUE,
  token        text NOT NULL UNIQUE,
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  to_name      text NOT NULL DEFAULT '',
  to_phone     text NOT NULL DEFAULT '',
  from_name    text NOT NULL DEFAULT '',
  message      text NOT NULL DEFAULT '',
  sold_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  sold_method  text NOT NULL CHECK (sold_method IN ('cash', 'mobile_money')),
  voided_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  voided_at    timestamptz NULL,
  void_reason  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_gift_cards_company ON restaurant_gift_cards (company_id, created_at DESC);
CREATE TABLE restaurant_gift_card_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id     uuid NOT NULL REFERENCES restaurant_gift_cards(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('sold', 'redeem', 'refund', 'void')),
  amount      numeric(12,2) NOT NULL CHECK (amount <> 0),
  method      text NULL,
  order_id    uuid NULL REFERENCES restaurant_orders(id) ON DELETE SET NULL,
  cashier_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_gift_card_entries_card ON restaurant_gift_card_entries (card_id, created_at);
CREATE INDEX idx_restaurant_gift_card_entries_cashier ON restaurant_gift_card_entries (cashier_id, created_at) WHERE cashier_id IS NOT NULL;

-- Paying with a gift card: a way of paying, and which card paid.
ALTER TABLE restaurant_order_payments DROP CONSTRAINT restaurant_order_payments_method_check;
ALTER TABLE restaurant_order_payments ADD CONSTRAINT restaurant_order_payments_method_check
  CHECK (method IN ('cash', 'mobile_money', 'alipay', 'wechat', 'vip', 'iou', 'gift_card', 'other'));
ALTER TABLE restaurant_order_payments ADD COLUMN gift_card_id uuid NULL REFERENCES restaurant_gift_cards(id) ON DELETE SET NULL;
ALTER TABLE restaurant_orders DROP CONSTRAINT restaurant_orders_payment_method_check;
ALTER TABLE restaurant_orders ADD CONSTRAINT restaurant_orders_payment_method_check
  CHECK (payment_method IN ('cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other', 'vip', 'iou', 'alipay', 'wechat', 'split', 'gift_card'));
ALTER TABLE restaurant_refunds DROP CONSTRAINT restaurant_refunds_method_check;
ALTER TABLE restaurant_refunds ADD CONSTRAINT restaurant_refunds_method_check
  CHECK (method IN ('cash', 'mobile_money', 'vip', 'iou', 'alipay', 'wechat', 'gift_card'));
