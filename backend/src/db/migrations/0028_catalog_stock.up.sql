-- Per-variation on-hand quantity for Products & Services — Square tracks
-- inventory at the variation level too (item_variation_data.track_inventory
-- on this account's real catalog), and this module had no stock concept at
-- all before now. A plain running quantity, not a warehouse-location
-- ledger — that finer-grained tracking already exists separately in the
-- Products & Inventory / Raw bamboo & production modules for warehouse
-- stock; this is just "how many of this sellable variation do we have."
ALTER TABLE catalog_item_variations ADD COLUMN stock_qty numeric(12,2) NOT NULL DEFAULT 0;
