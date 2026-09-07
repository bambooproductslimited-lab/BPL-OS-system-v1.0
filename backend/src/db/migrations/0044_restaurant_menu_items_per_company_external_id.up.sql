-- Restaurant module, Phase 4 correction: Star Bar Restaurant and Bamboo
-- Garden turned out to be two *locations* under one shared Square merchant
-- account, not two separate accounts — so a Square catalog item that's
-- present at both locations (e.g. a shared drink) has the same Square
-- catalog object id for both restaurants. Migration 0041's unique index on
-- restaurant_menu_items(external_id) was written assuming one external_id
-- could only ever belong to one company; under the real shared-catalog
-- setup that would make the second restaurant's upsert silently overwrite
-- the first's menu row instead of creating its own. Uniqueness needs to be
-- per company, not global.
DROP INDEX idx_restaurant_menu_items_external;
CREATE UNIQUE INDEX idx_restaurant_menu_items_company_external ON restaurant_menu_items(company_id, external_id) WHERE external_id IS NOT NULL;
