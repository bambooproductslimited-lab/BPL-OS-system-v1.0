-- Paying at the table (restaurantTablePay.service.js): a guest scans the
-- table's QR code (or the printed bill's) and pays the bill, or their share
-- of it, with a tip, by card or Mobile Money through Paystack; the payment
-- waits on the table's open order until the till closes it with it.
ALTER TABLE restaurant_paystack_payments DROP CONSTRAINT restaurant_paystack_payments_purpose_check;
ALTER TABLE restaurant_paystack_payments ADD CONSTRAINT restaurant_paystack_payments_purpose_check CHECK (purpose IN ('till', 'kiosk', 'table'));
ALTER TABLE restaurant_paystack_payments
  ADD COLUMN tab_id uuid NULL REFERENCES restaurant_open_tabs(id) ON DELETE SET NULL,
  ADD COLUMN tip numeric(12,2) NOT NULL DEFAULT 0 CHECK (tip >= 0),
  ADD COLUMN payer text NOT NULL DEFAULT '';
CREATE INDEX idx_restaurant_paystack_tab ON restaurant_paystack_payments (tab_id) WHERE tab_id IS NOT NULL;

-- Tips shared out (restaurantTips.service.js): what each person was given
-- from the tips, by a manager, for the days up to a date.
CREATE TABLE restaurant_tip_payouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  through     date NOT NULL,
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  method      text NOT NULL CHECK (method IN ('cash', 'mobile_money', 'payroll', 'other')),
  note        text NOT NULL DEFAULT '',
  paid_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_tip_payouts ON restaurant_tip_payouts (company_id, employee_id, created_at DESC);
