-- A free-text S/N or item number per document line item — the main use is
-- waybills, so a driver/warehouse clerk can write in a real serial number
-- or the catalogue's item code instead of relying on plain row position.
-- Shared table across quotation/estimate/sales_order/invoice/waybill; the
-- other document types just leave it blank.
ALTER TABLE document_line_items ADD COLUMN item_no text NOT NULL DEFAULT '';
