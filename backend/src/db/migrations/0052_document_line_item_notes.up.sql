-- Quotations/estimates/invoices (and waybills/sales orders, sharing this
-- same table) need a free-text description under each line item, separate
-- from the item's own name/title (the existing "description" column) —
-- e.g. specs, dimensions, or scope-of-work detail that doesn't belong in
-- the title itself.
ALTER TABLE document_line_items ADD COLUMN notes text NOT NULL DEFAULT '';
