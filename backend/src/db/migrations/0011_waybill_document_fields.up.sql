-- Extends waybills with what a real printed waybill/packing-slip needs
-- beyond the original dispatch record: a full "shipped to" contact block,
-- shipping date, sales rep, and optional packaged-by/approved-by names
-- (printed with a blank signature line beneath — see WaybillPreview.jsx).

ALTER TABLE waybills ADD COLUMN shipped_to_name    text NOT NULL DEFAULT '';
ALTER TABLE waybills ADD COLUMN shipped_to_address text NOT NULL DEFAULT '';
ALTER TABLE waybills ADD COLUMN shipped_to_phone   text NOT NULL DEFAULT '';
ALTER TABLE waybills ADD COLUMN shipped_to_email   text NOT NULL DEFAULT '';
ALTER TABLE waybills ADD COLUMN shipping_date      date NULL;
ALTER TABLE waybills ADD COLUMN sales_rep_id        uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE waybills ADD COLUMN packaged_by        text NOT NULL DEFAULT '';
ALTER TABLE waybills ADD COLUMN approved_by        text NOT NULL DEFAULT '';
