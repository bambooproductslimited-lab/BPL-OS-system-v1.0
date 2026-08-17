-- Corrections found while porting the remaining kernel.js handlers (beyond
-- auth + leave): several CHECK constraints in migrations 0002-0008 were
-- guessed ahead of reading the handlers that actually validate these enums,
-- and don't match kernel.js's real V.oneOf(...) allow-lists. Fixed here as a
-- follow-up migration rather than editing already-applied history.

ALTER TABLE employees DROP CONSTRAINT employees_employment_type_check;
ALTER TABLE employees ADD CONSTRAINT employees_employment_type_check
  CHECK (employment_type IN ('permanent', 'contract', 'casual', 'intern'));

ALTER TABLE attendance DROP CONSTRAINT attendance_status_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_status_check
  CHECK (status IN ('present', 'late', 'absent', 'leave', 'off'));

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('not_started', 'in_progress', 'waiting', 'under_review', 'completed', 'cancelled'));

ALTER TABLE projects DROP CONSTRAINT projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('planning', 'active', 'on_hold', 'delayed', 'completed', 'cancelled'));

ALTER TABLE expenses DROP CONSTRAINT expenses_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'paid', 'cancelled'));

ALTER TABLE quotations DROP CONSTRAINT quotations_status_check;
ALTER TABLE quotations ADD CONSTRAINT quotations_status_check
  CHECK (status IN ('draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'cancelled'));
ALTER TABLE quotations ADD COLUMN from_estimate_id uuid NULL REFERENCES estimates(id) ON DELETE SET NULL;

ALTER TABLE estimates DROP CONSTRAINT estimates_status_check;
ALTER TABLE estimates ADD CONSTRAINT estimates_status_check
  CHECK (status IN ('draft', 'finalized', 'converted', 'archived'));

ALTER TABLE sales_orders ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE sales_orders DROP CONSTRAINT sales_orders_status_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_status_check
  CHECK (status IN ('pending', 'processing', 'delivered', 'cancelled'));

ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('bank_transfer', 'cash', 'mobile_money', 'card', 'cheque', 'other'));

ALTER TABLE customers DROP CONSTRAINT customers_category_check;
ALTER TABLE customers ADD CONSTRAINT customers_category_check
  CHECK (category IN ('lead', 'prospect', 'active', 'inactive', 'vip'));

ALTER TABLE raw_batches DROP CONSTRAINT raw_batches_status_check;
ALTER TABLE raw_batches ADD CONSTRAINT raw_batches_status_check
  CHECK (status IN ('in_stock', 'depleted', 'consumed', 'disposed'));
ALTER TABLE raw_batches ADD CONSTRAINT raw_batches_quality_grade_check
  CHECK (quality_grade IN ('', 'A', 'B', 'C'));

-- warehouses.create/update (kernel.js) writes a `capacity` field the seed
-- data itself never populated — add it now that the handler is being ported.
ALTER TABLE warehouses ADD COLUMN capacity numeric(12,2) NOT NULL DEFAULT 0;
