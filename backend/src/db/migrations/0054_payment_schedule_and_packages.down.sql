ALTER TABLE document_line_items DROP COLUMN package_label;
ALTER TABLE invoices DROP COLUMN payment_schedule;
ALTER TABLE estimates DROP COLUMN payment_schedule;
ALTER TABLE quotations DROP COLUMN payment_schedule;
