-- Recipes and food cost (restaurantCosts.service.js): what goes into a dish
-- (or one of its sizes) from the ingredients in stock, so each sale draws
-- them down and its cost is known; or a cost set by hand for a dish with
-- no recipe (a bought-in drink). Each sold line keeps its cost at the time
-- of the sale, for the cost of goods sold and the margins.
CREATE TABLE restaurant_recipes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  menu_item_id  uuid NOT NULL REFERENCES restaurant_menu_items(id) ON DELETE CASCADE,
  variation_id  uuid NULL REFERENCES restaurant_menu_item_variations(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES restaurant_ingredients(id) ON DELETE CASCADE,
  qty           numeric(12,4) NOT NULL CHECK (qty > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_restaurant_recipe_line ON restaurant_recipes (menu_item_id, coalesce(variation_id, '00000000-0000-0000-0000-000000000000'::uuid), ingredient_id);
CREATE INDEX idx_restaurant_recipes_company ON restaurant_recipes (company_id);
ALTER TABLE restaurant_menu_items ADD COLUMN unit_cost numeric(12,2) NULL CHECK (unit_cost IS NULL OR unit_cost >= 0);
ALTER TABLE restaurant_menu_item_variations ADD COLUMN unit_cost numeric(12,2) NULL CHECK (unit_cost IS NULL OR unit_cost >= 0);
ALTER TABLE restaurant_order_items ADD COLUMN unit_cost numeric(12,4) NULL;
