ALTER TABLE restaurant_online_orders DROP COLUMN IF EXISTS charges;
ALTER TABLE restaurant_open_tabs DROP COLUMN IF EXISTS adjust;
DROP INDEX IF EXISTS ux_restaurant_orders_receipt_token;
ALTER TABLE restaurant_orders
  DROP COLUMN IF EXISTS receipt_sends, DROP COLUMN IF EXISTS receipt_token, DROP COLUMN IF EXISTS adjustments, DROP COLUMN IF EXISTS taxes,
  DROP COLUMN IF EXISTS tax_total, DROP COLUMN IF EXISTS service_charge, DROP COLUMN IF EXISTS discount_total;
ALTER TABLE restaurant_order_items
  DROP COLUMN IF EXISTS comp_reason, DROP COLUMN IF EXISTS discount_name, DROP COLUMN IF EXISTS discount, DROP COLUMN IF EXISTS modifiers;
ALTER TABLE restaurant_kitchen_items DROP COLUMN IF EXISTS mods;
DROP TABLE IF EXISTS restaurant_menu_item_modifier_groups;
DROP TABLE IF EXISTS restaurant_modifiers;
DROP TABLE IF EXISTS restaurant_modifier_groups;
