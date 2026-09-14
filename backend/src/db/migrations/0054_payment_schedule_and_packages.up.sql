ALTER TABLE quotations ADD COLUMN payment_schedule jsonb NOT NULL DEFAULT '[]';
ALTER TABLE estimates ADD COLUMN payment_schedule jsonb NOT NULL DEFAULT '[]';
ALTER TABLE invoices ADD COLUMN payment_schedule jsonb NOT NULL DEFAULT '[]';
ALTER TABLE document_line_items ADD COLUMN package_label text NOT NULL DEFAULT '';
