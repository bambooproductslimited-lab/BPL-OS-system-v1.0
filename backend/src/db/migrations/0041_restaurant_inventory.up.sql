-- Restaurant module, Phase 1 (inventory): Star Bar Restaurant and Bamboo
-- Garden (companies.code 'SBR'/'BGN', migration 0032) each get their own
-- sellable menu and two separate stock trackers — general supplies
-- (glassware, napkins, cleaning stock — doesn't expire) and food
-- ingredients (does expire, and will later be depleted by recipe when a
-- menu item sells, once Phase 2's POS exists). Scoped by company_id rather
-- than restricted to those two specific companies, so a future third
-- restaurant needs no schema change — same approach as departments.

CREATE TABLE restaurant_menu_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  category    text NOT NULL DEFAULT 'General',
  price       numeric NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  -- external_id/source: same idempotency pattern as customers/catalog_items/
  -- invoices/payments (migration 0026) — Square's own Catalog "Items" are
  -- this business's menu, so a future per-restaurant Square sync can
  -- upsert here without duplicating rows on re-run.
  external_id text,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'square')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_menu_items_company ON restaurant_menu_items(company_id);
CREATE UNIQUE INDEX idx_restaurant_menu_items_external ON restaurant_menu_items(external_id) WHERE external_id IS NOT NULL;

CREATE TABLE restaurant_supplies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  category      text NOT NULL DEFAULT 'General',
  unit          text NOT NULL DEFAULT 'each',
  stock_qty     numeric NOT NULL DEFAULT 0,
  reorder_level numeric NOT NULL DEFAULT 0,
  unit_cost     numeric NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_supplies_company ON restaurant_supplies(company_id);

CREATE TABLE restaurant_ingredients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  unit          text NOT NULL DEFAULT 'kg',
  stock_qty     numeric NOT NULL DEFAULT 0,
  reorder_level numeric NOT NULL DEFAULT 0,
  unit_cost     numeric NOT NULL DEFAULT 0,
  expiry_date   date,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_ingredients_company ON restaurant_ingredients(company_id);
