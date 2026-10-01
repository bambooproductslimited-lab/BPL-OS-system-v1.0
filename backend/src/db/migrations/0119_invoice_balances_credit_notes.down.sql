DROP TABLE credit_notes;
DELETE FROM payments WHERE source = 'refund';
ALTER TABLE payments DROP CONSTRAINT payments_source_check;
ALTER TABLE payments ADD CONSTRAINT payments_source_check CHECK (source IN ('manual', 'square'));
DROP TRIGGER invoices_follow_money ON invoices;
DROP FUNCTION invoice_follows_money();
ALTER TABLE invoices DROP COLUMN credit_total;
UPDATE settings SET commercial = commercial #- '{numbering,creditNote}' WHERE id = 1;
