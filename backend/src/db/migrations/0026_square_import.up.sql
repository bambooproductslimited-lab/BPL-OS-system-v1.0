-- Support a one-time historical import from Square (POS/payments platform)
-- into customers, catalog_items, invoices and payments, using the same
-- external_id/source idempotency pattern already established for
-- marketing_posts (0021) and marketing_inbox_items (0024): external_id lets
-- re-running the importer update the same row instead of duplicating it,
-- while records created by hand in Bamboo OS (source='manual',
-- external_id NULL) are untouched.
--
-- Square's Orders and Invoices are two different API objects, but for
-- already-completed historical sales they represent the same underlying
-- fact, so both import into this one invoices table — external_id holds
-- whichever Square ID (an Order id or an Invoice id) the row came from.

ALTER TABLE customers ADD COLUMN external_id text NULL;
ALTER TABLE customers ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'square'));
CREATE UNIQUE INDEX idx_customers_external_id ON customers(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE catalog_items ADD COLUMN external_id text NULL;
ALTER TABLE catalog_items ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'square'));
CREATE UNIQUE INDEX idx_catalog_items_external_id ON catalog_items(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE invoices ADD COLUMN external_id text NULL;
ALTER TABLE invoices ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'square'));
CREATE UNIQUE INDEX idx_invoices_external_id ON invoices(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE payments ADD COLUMN external_id text NULL;
ALTER TABLE payments ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'square'));
CREATE UNIQUE INDEX idx_payments_external_id ON payments(external_id) WHERE external_id IS NOT NULL;
