-- A dish as Square's item library keeps it (restaurantSquareExport.service.js
-- writes the item library and the item sales in Square's own layout): its
-- SKU, its description, its item type ('Physical good', 'Prepared food and
-- beverage', 'Service'…), whether it contains alcohol, the name customers
-- see if not its own; and each size's SKU. Filled by the Square import and
-- the till's menu.
ALTER TABLE restaurant_menu_items
  ADD COLUMN sku text NOT NULL DEFAULT '',
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN item_type text NOT NULL DEFAULT '',
  ADD COLUMN contains_alcohol boolean NULL,
  ADD COLUMN customer_name text NOT NULL DEFAULT '';
ALTER TABLE restaurant_menu_item_variations ADD COLUMN sku text NOT NULL DEFAULT '';
