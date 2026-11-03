-- The taxes a quotation, estimate or invoice charges on its whole amount,
-- by name: [{ "name": "VAT", "rate": 15 }, { "name": "NHIL", "rate": 2.5 },
-- { "name": "GETFund", "rate": 2.5 }]. Each is charged on the same amount
-- (after discounts), so tax_rate stays their sum and every total is worked
-- out as before; the document prints one line for each (utils/documents.js
-- docTaxOf, taxLines). Empty for a document with a single plain rate.
ALTER TABLE estimates ADD COLUMN tax_components jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE quotations ADD COLUMN tax_components jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE invoices ADD COLUMN tax_components jsonb NOT NULL DEFAULT '[]'::jsonb;
