-- Payment reminders (src/services/reminders.service.js).
--
-- Customers and tenants are reminded through the staff member's own
-- WhatsApp: the OS writes the message and opens WhatsApp with it ready, and
-- the staff member presses send. (There is no SMS or WhatsApp Business
-- sending — no budget for it — so the OS can't send by itself.) This keeps a
-- record of each reminder opened, so the list can say "reminded 2 days ago
-- by Ama" and nobody chases the same tenant twice in a morning.
CREATE TABLE payment_reminders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel     text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  phone       text NOT NULL,
  message     text NOT NULL,
  sent_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_reminders_invoice ON payment_reminders (invoice_id, sent_at DESC);

-- The morning "who owes what" alert to staff: once per person per day.
CREATE TABLE staff_digests (
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  date        date NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, kind, date)
);
