-- Back to leases. The booking shape is strictly richer than the lease it
-- replaced — a lease had no notion of days, and no per-unit daily rate — so
-- rolling back discards that: a booking of "6 months and 10 days" comes back
-- as a lease running the same dates on a monthly cycle, and the ten days
-- become part of a pro-rated final period again.
ALTER TABLE invoices RENAME COLUMN poki_booking_id TO poki_lease_id;
ALTER TABLE poki_maintenance_requests RENAME COLUMN booking_id TO lease_id;
ALTER TABLE poki_booking_reminders RENAME COLUMN booking_id TO lease_id;
ALTER TABLE poki_booking_reminders RENAME TO poki_lease_reminders;

ALTER TABLE poki_bookings DROP CONSTRAINT poki_bookings_no_overlap;
ALTER TABLE poki_bookings DROP CONSTRAINT poki_bookings_duration_nonzero;
ALTER TABLE poki_bookings DROP CONSTRAINT poki_bookings_duration_nonneg;

ALTER INDEX idx_poki_bookings_end_date      RENAME TO idx_poki_leases_end_date;
ALTER INDEX idx_poki_bookings_status        RENAME TO idx_poki_leases_status;
ALTER INDEX idx_poki_bookings_tenant        RENAME TO idx_poki_leases_tenant;
ALTER INDEX idx_poki_bookings_unit          RENAME TO idx_poki_leases_unit;
ALTER INDEX idx_poki_bookings_from_estimate RENAME TO idx_poki_leases_from_estimate;

ALTER TABLE poki_bookings ADD COLUMN rent_cycle text NOT NULL DEFAULT 'monthly'
  CHECK (rent_cycle = ANY (ARRAY['monthly','quarterly','semiannual','annual','one_off']));
ALTER TABLE poki_bookings ADD COLUMN payment_day integer NOT NULL DEFAULT 1
  CHECK (payment_day >= 1 AND payment_day <= 28);
ALTER TABLE poki_bookings ADD COLUMN next_invoice_on date;

-- The lease's rent_amount was per cycle; every restored lease is monthly, so
-- the monthly rate is the figure to put back.
UPDATE poki_bookings SET rent_total = monthly_rate WHERE monthly_rate > 0;

ALTER TABLE poki_bookings DROP COLUMN duration_months;
ALTER TABLE poki_bookings DROP COLUMN duration_days;
ALTER TABLE poki_bookings DROP COLUMN monthly_rate;
ALTER TABLE poki_bookings DROP COLUMN daily_rate;

UPDATE poki_bookings SET booking_no = replace(booking_no, 'BKG-', 'LSE-');

ALTER TABLE poki_bookings RENAME COLUMN rent_total TO rent_amount;
ALTER TABLE poki_bookings RENAME COLUMN booking_no TO lease_no;
ALTER TABLE poki_bookings RENAME TO poki_leases;

CREATE UNIQUE INDEX idx_poki_leases_one_active_per_unit
  ON poki_leases (unit_id) WHERE status = 'active';

ALTER TABLE poki_units ADD COLUMN rent_cycle text NOT NULL DEFAULT 'monthly'
  CHECK (rent_cycle = ANY (ARRAY['monthly','quarterly','semiannual','annual','one_off']));
ALTER TABLE poki_units DROP COLUMN daily_rate;

UPDATE settings
   SET commercial = jsonb_set(
         commercial::jsonb #- '{numbering,booking}',
         '{numbering,lease}',
         jsonb_set(commercial::jsonb -> 'numbering' -> 'booking', '{prefix}', '"LSE"')
       )
 WHERE id = 1 AND commercial::jsonb -> 'numbering' ? 'booking';
