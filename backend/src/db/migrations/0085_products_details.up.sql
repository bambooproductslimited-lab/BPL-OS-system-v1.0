-- Products & inventory (products.service.js): a photo and a description
-- for each product, and archiving a product that is no longer made or sold
-- (it drops off the page and the daily stock sheet, with its history kept).
ALTER TABLE products
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN photo_key text,
  ADD COLUMN photo_updated_at timestamptz,
  ADD COLUMN updated_at timestamptz;
