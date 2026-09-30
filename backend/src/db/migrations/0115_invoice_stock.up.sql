-- Selling from stock (inventorySales.service.js): an invoice takes what it
-- sells off Products & inventory the moment it is made, and a voided or
-- deleted invoice puts it back.

-- A document line can say which stock product it is. Carried from an
-- estimate or quotation to the invoice made from it.
ALTER TABLE document_line_items ADD COLUMN product_id uuid NULL REFERENCES products(id) ON DELETE SET NULL;

-- A sellable item in Products & Services can say which stock product it
-- takes from, so picking it on an invoice links the line by itself. Learned
-- the first time someone links such a line by hand.
ALTER TABLE catalog_item_variations ADD COLUMN product_id uuid NULL REFERENCES products(id) ON DELETE SET NULL;

-- The daily stock sheet gets a column the OS fills in: what went out on
-- invoices that day (less what came back from voided ones). It counts like
-- Sold, which stays for sales that aren't on an invoice.
ALTER TABLE stock_sheet_lines ADD COLUMN invoiced numeric(12,2) NOT NULL DEFAULT 0;

-- Every movement, so an invoice's stock can be put back exactly and each
-- product shows which invoices took from it. qty > 0 went out, < 0 came back.
CREATE TABLE invoice_stock_moves (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NULL REFERENCES invoices(id) ON DELETE SET NULL,
  invoice_no  text NOT NULL,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty         numeric(12,2) NOT NULL CHECK (qty <> 0),
  date        date NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('invoiced', 'voided', 'deleted')),
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoice_stock_moves_invoice ON invoice_stock_moves (invoice_id);
CREATE INDEX idx_invoice_stock_moves_product ON invoice_stock_moves (product_id, created_at DESC);
