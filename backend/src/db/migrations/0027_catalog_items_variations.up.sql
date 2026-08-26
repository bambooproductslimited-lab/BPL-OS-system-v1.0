-- Restructures Products & Services from a flat one-row-per-product list into
-- a real Item -> Variations model matching Square's own catalog shape
-- exactly (CatalogItem -> CatalogItemVariation[]), so a Square import can
-- group real variations (e.g. "039 Lighting" having "bedside lamp",
-- "hanged light", "8ft Pole light" as separate variations, up to dozens per
-- item on this account) under one parent item instead of flattening every
-- variation into its own unrelated top-level product. Real Categories
-- (Square: CatalogCategory) replace the old free-text category column.

CREATE TABLE catalog_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  external_id text NULL,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'square'))
);
CREATE UNIQUE INDEX idx_catalog_categories_external_id ON catalog_categories(external_id) WHERE external_id IS NOT NULL;

CREATE TABLE catalog_item_variations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  -- 'Regular' mirrors Square's own convention for an item with just one,
  -- unnamed variation — catalog.service.js only displays the variation name
  -- alongside the item name when it isn't 'Regular', same rule
  -- squareImport.service.js already used for the flat pre-redesign import.
  name        text NOT NULL DEFAULT 'Regular',
  code        text NOT NULL,
  unit        text NOT NULL DEFAULT 'each',
  default_qty numeric(12,2) NOT NULL DEFAULT 1,
  unit_price  numeric(12,2) NOT NULL DEFAULT 0,
  cost_price  numeric(12,2) NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  external_id text NULL,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'square'))
);
CREATE UNIQUE INDEX idx_catalog_item_variations_code ON catalog_item_variations(code);
CREATE UNIQUE INDEX idx_catalog_item_variations_external_id ON catalog_item_variations(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_catalog_item_variations_item_id ON catalog_item_variations(item_id);

-- Every existing catalog_items row today already represents one sellable
-- product (this app had no variation concept before), so it becomes its
-- item's sole 'Regular' variation, carrying over every sellable field
-- unchanged — lossless.
INSERT INTO catalog_item_variations (item_id, name, code, unit, default_qty, unit_price, cost_price, active, external_id, source)
SELECT id, 'Regular', code, unit, default_qty, unit_price, cost_price, active, external_id, source FROM catalog_items;

-- Real categories, seeded from whatever free-text category values are
-- already in use so existing grouping isn't lost.
INSERT INTO catalog_categories (name)
SELECT DISTINCT category FROM catalog_items WHERE trim(category) <> '';

ALTER TABLE catalog_items ADD COLUMN category_id uuid NULL REFERENCES catalog_categories(id) ON DELETE SET NULL;
UPDATE catalog_items ci SET category_id = cc.id FROM catalog_categories cc WHERE cc.name = ci.category AND trim(ci.category) <> '';

ALTER TABLE catalog_items DROP COLUMN category;
ALTER TABLE catalog_items DROP COLUMN code;
ALTER TABLE catalog_items DROP COLUMN unit;
ALTER TABLE catalog_items DROP COLUMN default_qty;
ALTER TABLE catalog_items DROP COLUMN unit_price;
ALTER TABLE catalog_items DROP COLUMN cost_price;
