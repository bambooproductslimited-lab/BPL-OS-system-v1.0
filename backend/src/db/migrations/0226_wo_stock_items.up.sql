-- Workshop work orders (tasks) that make items kept on the daily stock
-- sheet, and photos of the finished work (tasks.service.js, woStock.service.js).
--
-- task_stock_items: what a work order makes for the stock sheet, by product
-- and quantity. When the work order is completed they go onto that day's
-- stock sheet as Received (added_on, added_qty say what went on, so
-- reopening it takes the same back off); the people in
-- settings.stock_sheet.textIds get a text.
CREATE TABLE task_stock_items (
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty         numeric(12,2) NOT NULL CHECK (qty > 0),
  added_on    date NULL,
  added_qty   numeric(12,2) NULL,
  PRIMARY KEY (task_id, product_id)
);
CREATE INDEX idx_task_stock_items_product ON task_stock_items (product_id);

-- Photos of the finished work, taken when it is marked completed:
-- [{ key, type, at, by }] in file storage, as maintenance jobs keep theirs.
ALTER TABLE tasks ADD COLUMN done_photos jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Who is texted when a work order puts items on the stock sheet:
-- { textIds: [employee id, …] }, set on the Daily stock sheet page. It
-- starts with the stores team's Hayford, if he is on the staff list.
ALTER TABLE settings ADD COLUMN stock_sheet jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE settings SET stock_sheet = jsonb_build_object('textIds', (
  SELECT coalesce(jsonb_agg(e.id ORDER BY e.first_name), '[]'::jsonb) FROM employees e
  WHERE e.status = 'active' AND (e.first_name ILIKE 'hayford%' OR e.last_name ILIKE 'hayford%')
)) WHERE id = 1;
