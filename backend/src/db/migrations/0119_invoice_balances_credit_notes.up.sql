-- 1. An invoice's balance and status always follow its money.
--
-- Square imports marked every order "unpaid" and only corrected the ones
-- that had payments, so GHS 0.00 orders (comps, voided tickets, staff
-- meals) sat as "unpaid, overdue" forever, and a few invoices ended up with
-- a balance that matched neither their total nor what was paid. Rather than
-- trust every place that writes an invoice to get it right, the database
-- works it out: what is owed is the total, less any credit notes, less
-- what was paid (refunds are negative payments). Void stays void.
ALTER TABLE invoices ADD COLUMN credit_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_total >= 0);

CREATE FUNCTION invoice_follows_money() RETURNS trigger AS $$
DECLARE owed numeric;
BEGIN
  IF NEW.status = 'void' THEN RETURN NEW; END IF;
  owed := round(NEW.grand_total - NEW.credit_total - NEW.amount_paid, 2);
  IF owed <= 0.01 THEN
    NEW.balance_due := 0;
    NEW.status := 'paid';
    IF NEW.paid_at IS NULL THEN
      NEW.paid_at := coalesce((SELECT max(date) FROM payments WHERE invoice_id = NEW.id), NEW.issued_at, CURRENT_DATE);
    END IF;
  ELSE
    NEW.balance_due := owed;
    NEW.status := CASE WHEN NEW.amount_paid > 0 THEN 'partially_paid' ELSE 'unpaid' END;
    NEW.paid_at := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER invoices_follow_money BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoice_follows_money();

-- Put every existing invoice right once.
UPDATE invoices SET amount_paid = amount_paid WHERE status <> 'void';

-- 2. Nothing is due before it was issued. Square re-imports moved an
-- order's issue date on but left its first due date behind, so some
-- invoices were overdue on the day they appeared.
UPDATE invoices SET due_date = issued_at WHERE due_date < issued_at;

-- 3. Credit notes: taking some or all of an invoice back (a booking
-- shortened, goods returned, a price agreed down), and refunding money the
-- customer then has paid over what they owe. The refund is a negative
-- payment (source 'refund'), so collections and reports net it off.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_source_check;
ALTER TABLE payments ADD CONSTRAINT payments_source_check CHECK (source IN ('manual', 'square', 'refund'));

CREATE TABLE credit_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_no        text NOT NULL UNIQUE,
  invoice_id       uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  currency         text NOT NULL DEFAULT 'GHS',
  amount           numeric(14,2) NOT NULL CHECK (amount >= 0),
  refund_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  refund_payment_id uuid NULL REFERENCES payments(id) ON DELETE SET NULL,
  reason           text NOT NULL,
  created_by       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (amount > 0 OR refund_amount > 0)
);
CREATE INDEX idx_credit_notes_invoice ON credit_notes (invoice_id, created_at);

UPDATE settings SET commercial = jsonb_set(commercial, '{numbering,creditNote}',
  '{"prefix":"CN","padding":4,"includeYear":true,"nextNumber":1}'::jsonb)
WHERE id = 1 AND NOT (commercial->'numbering' ? 'creditNote');
