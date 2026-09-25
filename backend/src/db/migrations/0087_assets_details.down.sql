ALTER TABLE maintenance_records DROP COLUMN notes, DROP COLUMN completed_at, DROP COLUMN created_by;
ALTER TABLE assets
  DROP COLUMN updated_at, DROP COLUMN retired_on, DROP COLUMN service_interval_days,
  DROP COLUMN status, DROP COLUMN notes, DROP COLUMN serial_no, DROP COLUMN company_id;
