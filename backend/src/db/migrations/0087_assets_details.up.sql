-- Assets & maintenance (assets.service.js, maintenance.service.js): which
-- company an asset belongs to, its serial number, notes and whether it is in
-- use, in for repair or retired; how often it should be serviced (logging a
-- service then moves the next service date on by itself); and who logged
-- each maintenance record, so a planned service can be marked done later.
ALTER TABLE assets
  ADD COLUMN company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN serial_no text NOT NULL DEFAULT '',
  ADD COLUMN notes text NOT NULL DEFAULT '',
  ADD COLUMN status text NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use', 'in_repair', 'retired')),
  ADD COLUMN service_interval_days integer CHECK (service_interval_days IS NULL OR service_interval_days > 0),
  ADD COLUMN retired_on date,
  ADD COLUMN updated_at timestamptz;

ALTER TABLE maintenance_records
  ADD COLUMN created_by uuid REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN notes text NOT NULL DEFAULT '';
UPDATE maintenance_records SET completed_at = date::timestamptz WHERE status = 'completed';
