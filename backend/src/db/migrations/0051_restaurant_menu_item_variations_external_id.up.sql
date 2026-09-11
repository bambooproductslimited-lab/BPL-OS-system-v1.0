-- Lets the Square import upsert variation rows idempotently (same pattern
-- as restaurant_menu_items.external_id, migration 0041/0044) — needed so a
-- restaurant with a genuinely multi-priced Square item (several
-- "variations" on one catalog ITEM) can be re-imported without duplicating
-- its variation rows on every run.
ALTER TABLE restaurant_menu_item_variations ADD COLUMN external_id text;
CREATE UNIQUE INDEX idx_restaurant_menu_item_variations_item_external ON restaurant_menu_item_variations(menu_item_id, external_id) WHERE external_id IS NOT NULL;
