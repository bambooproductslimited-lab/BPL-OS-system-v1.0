-- The day a product's stock was last physically counted (a day tab of the
-- Finish Inventory sheet — see productImport.service.js).
--
-- The sheet's monthly summary tab can now be imported too, but its figures
-- are the sheet's expected closing stock, not what was counted on the shelf.
-- So a summary never overwrites a count: products counted on or after the
-- summary's latest day keep their counted figure. This column is how the
-- import knows.
ALTER TABLE products ADD COLUMN last_counted_on date NULL;

-- Counts imported before this column existed.
UPDATE products p SET last_counted_on = t.last
FROM (SELECT item_id, max(date) AS last FROM inventory_tx WHERE item_type = 'product' AND type = 'stock_count' GROUP BY item_id) t
WHERE t.item_id = p.id;
