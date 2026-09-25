-- Recurring charges for Poki tenants (services/pokiRecurring.service.js):
-- the service charge (CAM — common area maintenance) and flat utility fees
-- a tenant pays every month, quarter or year for as long as their booking
-- runs. Each charge belongs to one booking; on its next date the OS raises
-- an invoice for the coming period (billed in advance), due a set number of
-- days later, and moves the date on. Several charges due the same day for
-- the same booking go on one invoice.
--
-- poki_recurring_charge_runs records which period of which charge went on
-- which invoice; its UNIQUE (charge_id, period_start) is what makes a
-- period impossible to bill twice, whether the daily run and a manual
-- "bill now" meet, or the run is repeated.
ALTER TABLE invoices DROP CONSTRAINT invoices_doc_kind_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_doc_kind_check CHECK (doc_kind IN ('sale', 'rent', 'utility', 'deposit', 'maintenance', 'cam', 'other'));

CREATE TABLE poki_recurring_charges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES poki_bookings(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('cam', 'utility', 'other')),
  description  text NOT NULL,
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  frequency    text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  start_date   date NOT NULL,
  end_date     date NULL,
  next_date    date NOT NULL,
  net_days     integer NOT NULL DEFAULT 14 CHECK (net_days BETWEEN 0 AND 90),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  created_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX idx_poki_recurring_booking ON poki_recurring_charges (booking_id);
CREATE INDEX idx_poki_recurring_due ON poki_recurring_charges (next_date) WHERE status = 'active';

CREATE TABLE poki_recurring_charge_runs (
  charge_id     uuid NOT NULL REFERENCES poki_recurring_charges(id) ON DELETE CASCADE,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  amount        numeric(14,2) NOT NULL,
  invoice_id    uuid NULL REFERENCES invoices(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (charge_id, period_start)
);
CREATE INDEX idx_poki_recurring_runs_invoice ON poki_recurring_charge_runs (invoice_id);
