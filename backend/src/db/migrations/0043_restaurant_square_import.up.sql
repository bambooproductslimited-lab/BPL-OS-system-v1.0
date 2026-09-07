-- Restaurant module, Phase 4: one-time historical Square import, run
-- separately per restaurant (each has its own Square account/token — see
-- config.js's restaurantSquare). restaurant_menu_items already carries
-- external_id/source (migration 0041, written in anticipation of this);
-- restaurant_orders needs the same idempotency columns so re-running an
-- import updates the same rows instead of duplicating them, matching the
-- customers/catalog_items/invoices/payments pattern from migration 0026.
ALTER TABLE restaurant_orders ADD COLUMN external_id text NULL;
ALTER TABLE restaurant_orders ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'square'));
CREATE UNIQUE INDEX idx_restaurant_orders_external_id ON restaurant_orders(external_id) WHERE external_id IS NOT NULL;

-- restaurant_orders.cashier_id is NOT NULL (every POS sale has a real till
-- operator) but an imported historical Square sale has no such person —
-- the importer resolves this with a per-company placeholder employee row
-- (see restaurantSquareImport.service.js's ensureImportCashier), not a
-- schema change here, so the existing NOT NULL / listOrders() inner join
-- on employees needs no change.
