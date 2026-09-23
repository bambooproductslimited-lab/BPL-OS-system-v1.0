-- The daily stock sheet: the stores team's "BPL Finish Inventory" day tab,
-- kept in the OS instead of a spreadsheet (src/services/stockSheet.service.js).
--
-- One line per product per day, with the same columns as the sheet:
-- opening stock, received, transferred, breakage and sold are entered;
-- expected closing (opening + received - transferred - breakage - sold) and
-- the variance are worked out. physical is the count on the shelf, NULL when
-- nobody counted — then the day closes at the expected figure, as the
-- sheet's "=K" formula does.
--
-- The monthly summary tab is not stored: it is these lines, read by month.
CREATE TABLE stock_sheet_lines (
  date         date NOT NULL,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  opening      numeric(12,2) NOT NULL DEFAULT 0,
  received     numeric(12,2) NOT NULL DEFAULT 0,
  transferred  numeric(12,2) NOT NULL DEFAULT 0,
  breakage     numeric(12,2) NOT NULL DEFAULT 0,
  sold         numeric(12,2) NOT NULL DEFAULT 0,
  physical     numeric(12,2) NULL,
  note         text NOT NULL DEFAULT '',
  updated_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, date)
);
CREATE INDEX idx_stock_sheet_lines_date ON stock_sheet_lines (date);

-- The order lines appear in on the sheet (001 Bamboo Slats first, then
-- poles, …), so the OS lists them the way the stores team is used to.
-- Set by the count-sheet import; products added in the OS go after.
ALTER TABLE products ADD COLUMN sheet_order integer NULL;
