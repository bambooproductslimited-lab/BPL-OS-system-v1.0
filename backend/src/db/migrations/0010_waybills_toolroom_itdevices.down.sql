DELETE FROM document_line_items WHERE document_type = 'waybill';
ALTER TABLE document_line_items DROP CONSTRAINT document_line_items_document_type_check;
ALTER TABLE document_line_items ADD CONSTRAINT document_line_items_document_type_check
  CHECK (document_type IN ('quotation', 'estimate', 'sales_order', 'invoice'));

DROP TABLE IF EXISTS it_devices;
DROP TABLE IF EXISTS tool_room_items;
DROP TABLE IF EXISTS waybills;
