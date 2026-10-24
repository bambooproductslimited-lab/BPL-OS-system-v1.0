-- A fee for a booking (bookings.service.js; settings.booking services[].fee
-- and areas[].fee for a visit): the customer it is invoiced to, the amount,
-- its invoice and the invoice's link to pay it.
ALTER TABLE appointments ADD COLUMN customer_id uuid NULL REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE appointments ADD COLUMN area text NOT NULL DEFAULT '';
ALTER TABLE appointments ADD COLUMN fee numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE appointments ADD COLUMN fee_invoice_id uuid NULL REFERENCES invoices(id) ON DELETE SET NULL;
ALTER TABLE appointments ADD COLUMN fee_share_id uuid NULL REFERENCES document_shares(id) ON DELETE SET NULL;
