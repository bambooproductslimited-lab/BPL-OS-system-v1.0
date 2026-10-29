DROP INDEX IF EXISTS idx_poki_bookings_moved_from;
ALTER TABLE poki_bookings DROP COLUMN IF EXISTS moved_from_id;
UPDATE poki_bookings SET status = 'terminated' WHERE status = 'moved';
ALTER TABLE poki_bookings DROP CONSTRAINT poki_leases_status_check;
ALTER TABLE poki_bookings ADD CONSTRAINT poki_leases_status_check
  CHECK (status IN ('draft', 'active', 'expired', 'terminated', 'renewed'));
