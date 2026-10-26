DROP INDEX IF EXISTS idx_maintenance_records_open;
DELETE FROM maintenance_records WHERE status = 'reported';
ALTER TABLE maintenance_records
  DROP COLUMN source,
  DROP COLUMN reported_at,
  DROP COLUMN reported_by,
  DROP COLUMN urgency,
  DROP COLUMN photos;
ALTER TABLE maintenance_records DROP CONSTRAINT maintenance_records_status_check;
ALTER TABLE maintenance_records ADD CONSTRAINT maintenance_records_status_check CHECK (status IN ('scheduled', 'in_progress', 'completed'));

DELETE FROM role_permissions WHERE permission_key IN ('bill.read', 'bill.manage', 'bill.approve');
DELETE FROM permissions WHERE key IN ('bill.read', 'bill.manage', 'bill.approve');
ALTER TABLE settings DROP COLUMN bills;
DROP TABLE supplier_bill_payments;
DROP TABLE supplier_bills;
