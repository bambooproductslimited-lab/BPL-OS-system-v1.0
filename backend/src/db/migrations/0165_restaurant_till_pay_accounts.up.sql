-- Paying in and out of the till for a customer's account (restaurantTillMoney):
--
--   VIP, out   money on a VIP balance given back in cash (a manager's PIN):
--              a 'cashout' entry, less on the balance.
--   IOU, out   cash lent on a customer's IOU account, within its limit, owed
--              like an unpaid sale until it is paid back at the till.
--
-- (In: VIP money put down and IOUs paid back were there already.)
ALTER TABLE restaurant_vip_entries DROP CONSTRAINT restaurant_vip_entries_kind_check;
ALTER TABLE restaurant_vip_entries ADD CONSTRAINT restaurant_vip_entries_kind_check CHECK (kind IN ('topup', 'sale', 'refund', 'cashout'));
ALTER TABLE restaurant_vip_entries DROP CONSTRAINT restaurant_vip_entries_check;
ALTER TABLE restaurant_vip_entries ADD CONSTRAINT restaurant_vip_entries_check CHECK ((kind IN ('topup', 'cashout')) = (method IS NOT NULL));
ALTER TABLE restaurant_vip_entries ADD COLUMN approved_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
DROP INDEX IF EXISTS idx_restaurant_vip_entries_cashier;
CREATE INDEX idx_restaurant_vip_entries_cashier ON restaurant_vip_entries(cashier_id, created_at) WHERE kind IN ('topup', 'cashout');

CREATE TABLE restaurant_iou_advances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number      integer NOT NULL,
  guest_id    uuid NOT NULL REFERENCES restaurant_guests(id) ON DELETE CASCADE,
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  note        text NOT NULL DEFAULT '',
  cashier_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  paid_at     timestamptz NULL,
  paid_method text NULL CHECK (paid_method IN ('cash', 'mobile_money')),
  paid_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  paid_amount numeric(12,2) NULL,
  UNIQUE (company_id, number)
);
CREATE INDEX idx_restaurant_iou_advances_guest ON restaurant_iou_advances(guest_id) WHERE paid_at IS NULL;
CREATE INDEX idx_restaurant_iou_advances_cashier ON restaurant_iou_advances(cashier_id, created_at);
CREATE INDEX idx_restaurant_iou_advances_paid ON restaurant_iou_advances(paid_by, paid_at);
