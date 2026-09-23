-- Other names a product has had on the Finish Inventory sheet.
--
-- The stores team renames lines over time ("Thinner — Standard Thinner" in
-- April is "Thinner" today) and sometimes mistypes one for a day (a blank
-- variation on 31 August). When importing, a line the OS can't match is
-- shown with the products it might be, and whoever imports says which — or
-- that it is new. That answer is kept here, keyed by the SKU the importer
-- works out for the line (productImport.service.js), so the next import of
-- that name finds the product by itself.
CREATE TABLE product_aliases (
  alias       text PRIMARY KEY,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_product_aliases_product ON product_aliases (product_id);
