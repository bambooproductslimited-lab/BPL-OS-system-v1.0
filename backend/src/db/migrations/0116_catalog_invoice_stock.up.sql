-- Invoices take stock off Products & Services too (inventorySales.service.js):
-- a line that is a catalogue item not linked to a stock product takes its
-- quantity off the item's own stock; voiding or deleting the invoice puts
-- it back. Every movement is kept, so it goes back exactly.
CREATE TABLE catalog_stock_moves (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    uuid NULL REFERENCES invoices(id) ON DELETE SET NULL,
  invoice_no    text NOT NULL,
  variation_id  uuid NOT NULL REFERENCES catalog_item_variations(id) ON DELETE CASCADE,
  qty           numeric(12,2) NOT NULL CHECK (qty <> 0),
  reason        text NOT NULL CHECK (reason IN ('invoiced', 'voided', 'deleted')),
  created_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_catalog_stock_moves_invoice ON catalog_stock_moves (invoice_id);
CREATE INDEX idx_catalog_stock_moves_variation ON catalog_stock_moves (variation_id, created_at DESC);
