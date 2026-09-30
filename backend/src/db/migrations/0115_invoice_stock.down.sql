DROP TABLE invoice_stock_moves;
ALTER TABLE stock_sheet_lines DROP COLUMN invoiced;
ALTER TABLE catalog_item_variations DROP COLUMN product_id;
ALTER TABLE document_line_items DROP COLUMN product_id;
