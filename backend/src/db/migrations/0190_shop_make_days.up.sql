-- Made to order (shop.service.js): how many days an item takes to make,
-- from and to (3 to 7), set on the online shop's settings and shown to the
-- customer on the item and at checkout; an order keeps the days it will be
-- ready between.
ALTER TABLE catalog_items
  ADD COLUMN make_days_min smallint NULL,
  ADD COLUMN make_days_max smallint NULL,
  ADD CONSTRAINT catalog_items_make_days CHECK (
    (make_days_min IS NULL AND make_days_max IS NULL)
    OR (make_days_min >= 0 AND make_days_max >= make_days_min AND make_days_max <= 180));

ALTER TABLE shop_orders
  ADD COLUMN ready_from date NULL,
  ADD COLUMN ready_by date NULL;
