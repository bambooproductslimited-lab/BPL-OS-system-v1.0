-- The till's money (restaurantTillMoney.service.js): the till takes cash,
-- Mobile Money, VIP, IOU and Other. Older methods stay valid for past and
-- imported (Square) sales.
--   VIP  a guest puts money down (a top-up, in cash or Mobile Money) and
--        spends it on sales; the balance is the sum of their entries.
--   IOU  a named guest owes the sale until it is paid, in cash or Mobile
--        Money, on a later day.
-- A refund gives back some or all of a sale's dishes, approved with a
-- manager's PIN; refunded_total keeps the sale's figures net of them.
ALTER TABLE restaurant_orders DROP CONSTRAINT restaurant_orders_payment_method_check;
ALTER TABLE restaurant_orders ADD CONSTRAINT restaurant_orders_payment_method_check
  CHECK (payment_method IN ('cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other', 'vip', 'iou'));
ALTER TABLE restaurant_orders ADD COLUMN refunded_total numeric NOT NULL DEFAULT 0;
ALTER TABLE restaurant_orders ADD COLUMN iou_paid_at timestamptz NULL;
ALTER TABLE restaurant_orders ADD COLUMN iou_paid_method text NULL CHECK (iou_paid_method IN ('cash', 'mobile_money'));
ALTER TABLE restaurant_orders ADD COLUMN iou_paid_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE restaurant_orders ADD COLUMN iou_paid_amount numeric NULL;
CREATE INDEX idx_restaurant_orders_iou_open ON restaurant_orders(company_id, created_at) WHERE payment_method = 'iou' AND iou_paid_at IS NULL AND status = 'completed';
CREATE INDEX idx_restaurant_orders_iou_paid ON restaurant_orders(iou_paid_by, iou_paid_at) WHERE iou_paid_at IS NOT NULL;

CREATE TABLE restaurant_refunds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES restaurant_orders(id) ON DELETE CASCADE,
  amount      numeric NOT NULL CHECK (amount > 0),
  -- How it went back: cash from the drawer, Mobile Money, to the guest's
  -- VIP balance, or off what they still owe (an unpaid IOU).
  method      text NOT NULL CHECK (method IN ('cash', 'mobile_money', 'vip', 'iou')),
  reason      text NOT NULL,
  cashier_id  uuid NOT NULL REFERENCES employees(id),
  approved_by uuid NOT NULL REFERENCES employees(id),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_restaurant_refunds_order ON restaurant_refunds(order_id);
CREATE INDEX idx_restaurant_refunds_company ON restaurant_refunds(company_id, created_at);
CREATE INDEX idx_restaurant_refunds_cashier ON restaurant_refunds(cashier_id, created_at);

CREATE TABLE restaurant_refund_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id     uuid NOT NULL REFERENCES restaurant_refunds(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES restaurant_order_items(id) ON DELETE CASCADE,
  name          text NOT NULL,
  qty           numeric NOT NULL CHECK (qty > 0),
  amount        numeric NOT NULL
);
CREATE INDEX idx_restaurant_refund_items_refund ON restaurant_refund_items(refund_id);
CREATE INDEX idx_restaurant_refund_items_item ON restaurant_refund_items(order_item_id);

-- A VIP guest's money: + top-ups and refunds back to the balance, - sales.
CREATE TABLE restaurant_vip_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  guest_id    uuid NOT NULL REFERENCES restaurant_guests(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('topup', 'sale', 'refund')),
  amount      numeric NOT NULL CHECK (amount <> 0),
  method      text NULL CHECK (method IN ('cash', 'mobile_money')),
  order_id    uuid NULL REFERENCES restaurant_orders(id) ON DELETE SET NULL,
  refund_id   uuid NULL REFERENCES restaurant_refunds(id) ON DELETE SET NULL,
  cashier_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'topup') = (method IS NOT NULL))
);
CREATE INDEX idx_restaurant_vip_entries_guest ON restaurant_vip_entries(guest_id, created_at);
CREATE INDEX idx_restaurant_vip_entries_cashier ON restaurant_vip_entries(cashier_id, created_at) WHERE kind = 'topup';
