-- The fifteenth batch.
--
-- Bills to pay: what each company owes its suppliers — Bamboo Products,
-- the restaurants — with the supplier's own reference, a photo of the bill,
-- when it is due, who approved it, and what was paid, when and from where
-- (bills.service.js). A restaurant's purchase order, received and not paid
-- at the door, becomes one by itself.
CREATE TABLE supplier_bills (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  integer NOT NULL UNIQUE,
  company_id              uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id             uuid NULL REFERENCES suppliers(id) ON DELETE SET NULL,
  restaurant_supplier_id  uuid NULL REFERENCES restaurant_suppliers(id) ON DELETE SET NULL,
  supplier_name           text NOT NULL,
  reference               text NOT NULL DEFAULT '',
  category                text NOT NULL DEFAULT 'other',
  bill_date               date NOT NULL,
  due_date                date NOT NULL,
  amount                  numeric(14,2) NOT NULL CHECK (amount > 0),
  paid                    numeric(14,2) NOT NULL DEFAULT 0,
  status                  text NOT NULL DEFAULT 'to_approve' CHECK (status IN ('to_approve', 'approved', 'paid', 'cancelled')),
  note                    text NOT NULL DEFAULT '',
  files                   jsonb NOT NULL DEFAULT '[]',
  purchase_order_id       uuid NULL REFERENCES restaurant_purchase_orders(id) ON DELETE SET NULL,
  source                  text NOT NULL DEFAULT 'office' CHECK (source IN ('office', 'till', 'purchase_order')),
  created_by              uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  approved_by             uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  approved_at             timestamptz NULL,
  cancelled_reason        text NOT NULL DEFAULT '',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_supplier_bills_open ON supplier_bills (company_id, status, due_date);
CREATE INDEX idx_supplier_bills_supplier ON supplier_bills (lower(supplier_name));
CREATE UNIQUE INDEX idx_supplier_bills_po ON supplier_bills (purchase_order_id) WHERE purchase_order_id IS NOT NULL;

CREATE TABLE supplier_bill_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id     uuid NOT NULL REFERENCES supplier_bills(id) ON DELETE CASCADE,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_on     date NOT NULL,
  method      text NOT NULL CHECK (method IN ('bank', 'mobile_money', 'cash', 'cheque')),
  account     text NOT NULL DEFAULT '',
  reference   text NOT NULL DEFAULT '',
  photo       jsonb NULL,
  by_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_supplier_bill_payments_bill ON supplier_bill_payments (bill_id, paid_on);

-- { approveOver, accounts: [], dueDays }
ALTER TABLE settings ADD COLUMN bills jsonb NOT NULL DEFAULT '{}';

INSERT INTO permissions (key, "group", label) VALUES
  ('bill.read', 'Finance', 'View bills to pay'),
  ('bill.manage', 'Finance', 'Enter bills to pay and record what was paid'),
  ('bill.approve', 'Finance', 'Approve bills to pay')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r
JOIN (VALUES
  ('administrator', 'bill.read'), ('administrator', 'bill.manage'), ('administrator', 'bill.approve'),
  ('finance_manager', 'bill.read'), ('finance_manager', 'bill.manage'), ('finance_manager', 'bill.approve'),
  ('finance_hr_manager', 'bill.read'), ('finance_hr_manager', 'bill.manage'), ('finance_hr_manager', 'bill.approve'),
  ('executive', 'bill.read'), ('executive', 'bill.approve'),
  ('general_manager', 'bill.read'), ('general_manager', 'bill.approve')
) AS p(role_key, key) ON p.role_key = r.key
ON CONFLICT DO NOTHING;

-- Equipment: a problem reported — from a restaurant's till, or by anyone on
-- the factory floor — before anyone has planned the repair; how bad it is,
-- photos, and who said so (maintenance.service.js, restaurantEquipment).
ALTER TABLE maintenance_records DROP CONSTRAINT maintenance_records_status_check;
ALTER TABLE maintenance_records ADD CONSTRAINT maintenance_records_status_check CHECK (status IN ('reported', 'scheduled', 'in_progress', 'completed'));
ALTER TABLE maintenance_records
  ADD COLUMN photos       jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN urgency      text NOT NULL DEFAULT '' CHECK (urgency IN ('', 'stopped', 'working', 'unsafe')),
  ADD COLUMN reported_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN reported_at  timestamptz NULL,
  ADD COLUMN source       text NOT NULL DEFAULT 'office' CHECK (source IN ('office', 'till', 'floor'));
CREATE INDEX idx_maintenance_records_open ON maintenance_records (asset_id) WHERE status <> 'completed';
