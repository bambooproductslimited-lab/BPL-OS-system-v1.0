DROP INDEX IF EXISTS idx_payments_external_id;
ALTER TABLE payments DROP COLUMN IF EXISTS source;
ALTER TABLE payments DROP COLUMN IF EXISTS external_id;

DROP INDEX IF EXISTS idx_invoices_external_id;
ALTER TABLE invoices DROP COLUMN IF EXISTS source;
ALTER TABLE invoices DROP COLUMN IF EXISTS external_id;

DROP INDEX IF EXISTS idx_catalog_items_external_id;
ALTER TABLE catalog_items DROP COLUMN IF EXISTS source;
ALTER TABLE catalog_items DROP COLUMN IF EXISTS external_id;

DROP INDEX IF EXISTS idx_customers_external_id;
ALTER TABLE customers DROP COLUMN IF EXISTS source;
ALTER TABLE customers DROP COLUMN IF EXISTS external_id;
