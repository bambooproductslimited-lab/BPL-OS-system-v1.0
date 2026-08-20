ALTER TABLE waybills DROP COLUMN IF EXISTS shipped_to_name;
ALTER TABLE waybills DROP COLUMN IF EXISTS shipped_to_address;
ALTER TABLE waybills DROP COLUMN IF EXISTS shipped_to_phone;
ALTER TABLE waybills DROP COLUMN IF EXISTS shipped_to_email;
ALTER TABLE waybills DROP COLUMN IF EXISTS shipping_date;
ALTER TABLE waybills DROP COLUMN IF EXISTS sales_rep_id;
ALTER TABLE waybills DROP COLUMN IF EXISTS packaged_by;
ALTER TABLE waybills DROP COLUMN IF EXISTS approved_by;
