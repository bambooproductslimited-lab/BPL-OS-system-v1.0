ALTER TABLE warehouses DROP COLUMN capacity;

ALTER TABLE raw_batches DROP CONSTRAINT raw_batches_quality_grade_check;
ALTER TABLE raw_batches DROP CONSTRAINT raw_batches_status_check;
ALTER TABLE raw_batches ADD CONSTRAINT raw_batches_status_check
  CHECK (status IN ('in_stock', 'consumed', 'disposed'));

ALTER TABLE customers DROP CONSTRAINT customers_category_check;
ALTER TABLE customers ADD CONSTRAINT customers_category_check
  CHECK (category IN ('lead', 'prospect', 'active', 'vip'));

ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('bank_transfer', 'cash', 'mobile_money', 'card', 'cheque'));

ALTER TABLE sales_orders DROP CONSTRAINT sales_orders_status_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_status_check
  CHECK (status IN ('processing', 'fulfilled', 'cancelled'));
ALTER TABLE sales_orders ALTER COLUMN status SET DEFAULT 'processing';

ALTER TABLE estimates DROP CONSTRAINT estimates_status_check;
ALTER TABLE estimates ADD CONSTRAINT estimates_status_check
  CHECK (status IN ('draft', 'finalized'));

ALTER TABLE quotations DROP COLUMN from_estimate_id;
ALTER TABLE quotations DROP CONSTRAINT quotations_status_check;
ALTER TABLE quotations ADD CONSTRAINT quotations_status_check
  CHECK (status IN ('draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired'));

ALTER TABLE expenses DROP CONSTRAINT expenses_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));

ALTER TABLE projects DROP CONSTRAINT projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'cancelled'));

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('not_started', 'in_progress', 'under_review', 'done'));

ALTER TABLE attendance DROP CONSTRAINT attendance_status_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_status_check
  CHECK (status IN ('present', 'late', 'absent', 'half_day'));

ALTER TABLE employees DROP CONSTRAINT employees_employment_type_check;
ALTER TABLE employees ADD CONSTRAINT employees_employment_type_check
  CHECK (employment_type IN ('permanent', 'contract', 'temporary', 'intern'));
