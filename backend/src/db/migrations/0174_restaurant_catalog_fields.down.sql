ALTER TABLE restaurant_menu_item_variations DROP COLUMN IF EXISTS sku;
ALTER TABLE restaurant_menu_items DROP COLUMN IF EXISTS customer_name, DROP COLUMN IF EXISTS contains_alcohol, DROP COLUMN IF EXISTS item_type,
  DROP COLUMN IF EXISTS description, DROP COLUMN IF EXISTS sku;
