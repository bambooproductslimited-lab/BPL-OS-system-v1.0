-- A tenant moving to another unit mid-stay (poki.service.js moveBooking).
-- The booking on the old unit ends as 'moved' the day they move, and a new
-- booking carries on in the new unit for the time that is left, pointing
-- back at it (moved_from_id): each unit keeps its own dates and rent, the
-- deposit and the running charges go with the tenant.
ALTER TABLE poki_bookings DROP CONSTRAINT poki_leases_status_check;
ALTER TABLE poki_bookings ADD CONSTRAINT poki_leases_status_check
  CHECK (status IN ('draft', 'active', 'expired', 'terminated', 'renewed', 'moved'));
ALTER TABLE poki_bookings ADD COLUMN moved_from_id uuid REFERENCES poki_bookings(id) ON DELETE SET NULL;
CREATE INDEX idx_poki_bookings_moved_from ON poki_bookings (moved_from_id) WHERE moved_from_id IS NOT NULL;
