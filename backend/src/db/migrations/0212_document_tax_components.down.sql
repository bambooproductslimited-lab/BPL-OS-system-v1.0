ALTER TABLE invoices DROP COLUMN IF EXISTS tax_components;
ALTER TABLE quotations DROP COLUMN IF EXISTS tax_components;
ALTER TABLE estimates DROP COLUMN IF EXISTS tax_components;
