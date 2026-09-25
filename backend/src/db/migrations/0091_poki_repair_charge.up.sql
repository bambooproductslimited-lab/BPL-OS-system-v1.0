-- Poki maintenance (pokiBilling.service.js): the invoice a repair was
-- recharged to the tenant on, so the same repair can't be charged twice and
-- the request can say which invoice carries it.
ALTER TABLE poki_maintenance_requests
  ADD COLUMN charge_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL;
