-- Lossy for any item with more than one variation (only one variation's
-- sellable fields survive back onto the flat catalog_items row) — accepted,
-- same as any down-migration that reverses a genuine shape change.

ALTER TABLE catalog_items ADD COLUMN category text NOT NULL DEFAULT '';
UPDATE catalog_items ci SET category = cc.name FROM catalog_categories cc WHERE cc.id = ci.category_id;
ALTER TABLE catalog_items DROP COLUMN category_id;

ALTER TABLE catalog_items ADD COLUMN code text;
ALTER TABLE catalog_items ADD COLUMN unit text NOT NULL DEFAULT 'each';
ALTER TABLE catalog_items ADD COLUMN default_qty numeric(12,2) NOT NULL DEFAULT 1;
ALTER TABLE catalog_items ADD COLUMN unit_price numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE catalog_items ADD COLUMN cost_price numeric(12,2) NOT NULL DEFAULT 0;

UPDATE catalog_items ci SET
  code = v.code, unit = v.unit, default_qty = v.default_qty, unit_price = v.unit_price, cost_price = v.cost_price
FROM (
  SELECT DISTINCT ON (item_id) item_id, code, unit, default_qty, unit_price, cost_price
  FROM catalog_item_variations ORDER BY item_id, code
) v
WHERE v.item_id = ci.id;

-- Items that ended up with no variation (shouldn't normally happen) get a
-- generated placeholder code so the NOT NULL UNIQUE constraint can be restored.
UPDATE catalog_items SET code = 'ITEM-' || substr(id::text, 1, 8) WHERE code IS NULL;
ALTER TABLE catalog_items ALTER COLUMN code SET NOT NULL;
ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_code_key UNIQUE (code);

DROP TABLE catalog_item_variations;
DROP TABLE catalog_categories;
