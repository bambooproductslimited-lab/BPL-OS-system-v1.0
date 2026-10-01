-- Meter readings on a utility bill that was voided before voiding put them
-- back: they are not billed any more, so they go back to not billed — to be
-- billed again or deleted. (Since then, voiding a bill does this itself.)
UPDATE poki_meter_readings r SET invoice_id = NULL
FROM invoices i WHERE i.id = r.invoice_id AND i.status = 'void';
