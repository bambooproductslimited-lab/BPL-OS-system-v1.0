-- Multi-currency: quotations/estimates/sales_orders/invoices each get their
-- own currency (freely chosen per document, defaulting from the customer's
-- preferred_currency — see quotations/estimates/salesOrders/invoices
-- .service.js). payments.currency and customers.preferred_currency already
-- existed but were dead/hardcoded to 'GHS' — this migration only adds the
-- columns that were missing; the services wire everything else up.
ALTER TABLE quotations ADD COLUMN currency text NOT NULL DEFAULT 'GHS';
ALTER TABLE estimates ADD COLUMN currency text NOT NULL DEFAULT 'GHS';
ALTER TABLE sales_orders ADD COLUMN currency text NOT NULL DEFAULT 'GHS';
ALTER TABLE invoices ADD COLUMN currency text NOT NULL DEFAULT 'GHS';
