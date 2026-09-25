DROP TABLE poki_recurring_charge_runs;
DROP TABLE poki_recurring_charges;
ALTER TABLE invoices DROP CONSTRAINT invoices_doc_kind_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_doc_kind_check CHECK (doc_kind IN ('sale', 'rent', 'utility', 'deposit', 'maintenance', 'other'));
