DROP TABLE document_shares;

ALTER TABLE invoices DROP COLUMN terms;
ALTER TABLE invoices DROP COLUMN notes;
ALTER TABLE invoices DROP COLUMN tax_rate;
ALTER TABLE invoices DROP COLUMN discount_type;
ALTER TABLE invoices DROP COLUMN discount_value;

ALTER TABLE estimates DROP COLUMN tax_rate;
ALTER TABLE estimates DROP COLUMN discount_type;
ALTER TABLE estimates DROP COLUMN discount_value;

ALTER TABLE quotations DROP COLUMN tax_rate;
ALTER TABLE quotations DROP COLUMN discount_type;
ALTER TABLE quotations DROP COLUMN discount_value;
