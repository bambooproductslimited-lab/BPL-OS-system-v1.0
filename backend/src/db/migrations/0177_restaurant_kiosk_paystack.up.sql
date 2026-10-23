-- The self-order kiosk at the counter (restaurantKiosk.service.js): a
-- tablet paired with the till like the customer's screen (a display of
-- kind 'kiosk'). What a customer orders on it waits on the till with the
-- tables' QR orders (kind 'kiosk', no table), eaten here or taken away,
-- paid at the counter or on the kiosk itself (Paystack).
ALTER TABLE restaurant_displays ADD COLUMN kind text NOT NULL DEFAULT 'screen' CHECK (kind IN ('screen', 'kiosk'));
ALTER TABLE restaurant_table_orders
  ALTER COLUMN table_id DROP NOT NULL,
  ADD COLUMN kind text NOT NULL DEFAULT 'table' CHECK (kind IN ('table', 'kiosk')),
  ADD COLUMN kiosk_id uuid NULL REFERENCES restaurant_displays(id) ON DELETE SET NULL,
  ADD COLUMN dining text NULL CHECK (dining IS NULL OR dining IN ('here', 'away')),
  ADD COLUMN paystack_ref text NULL;
-- A kiosk order paid on the kiosk waits ('unpaid') until Paystack says so.
ALTER TABLE restaurant_table_orders DROP CONSTRAINT restaurant_table_orders_status_check;
ALTER TABLE restaurant_table_orders ADD CONSTRAINT restaurant_table_orders_status_check CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'unpaid'));
ALTER TABLE restaurant_table_orders ADD CONSTRAINT restaurant_table_orders_kind_table CHECK ((kind = 'table' AND table_id IS NOT NULL) OR (kind = 'kiosk' AND table_id IS NULL));

-- Card and Mobile Money paid online through Paystack (restaurantPaystack
-- .service.js): a payment the till (a QR code for the customer's phone) or
-- the kiosk starts, checked with Paystack before a sale may use it, once.
CREATE TABLE restaurant_paystack_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reference      text NOT NULL UNIQUE,
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  purpose        text NOT NULL CHECK (purpose IN ('till', 'kiosk')),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
  url            text NOT NULL DEFAULT '',
  channel        text NOT NULL DEFAULT '',
  card_brand     text NULL,
  card_last4     text NULL,
  fees           numeric(12,2) NULL,
  paid_at        timestamptz NULL,
  checked_at     timestamptz NULL,
  created_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  kiosk_order_id uuid NULL REFERENCES restaurant_table_orders(id) ON DELETE SET NULL,
  used_by_order  uuid NULL REFERENCES restaurant_orders(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_paystack_company ON restaurant_paystack_payments (company_id, created_at DESC);
