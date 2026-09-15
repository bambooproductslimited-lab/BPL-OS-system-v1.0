-- Rent is taken as a booking, not a rolling tenancy.
--
-- The model built first assumed a subscription: a rate per billing cycle, an
-- invoice raised each cycle as the tenancy ran, and the final period
-- pro-rated. That is not how Poki lets units. A tenant takes a block of time
-- — three months, six months, a year or more, or a handful of days — and
-- pays for the whole block up front, priced from a monthly rate.
--
-- The difference showed up as a trap in the UI. poki_units.base_rent meant
-- "per rent_cycle", so warehouse bay WH-A stored 24000 against 'annual' and
-- its Rent field meant GHS 24,000 a year, not a month. After this migration
-- a unit has one monthly rate and the booking's duration decides the rest.
--
-- Money is preserved for every existing booking except one; see the notice
-- raised at the end.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── units: one rate, per month, plus a rate per day ───────────────────────
-- daily_rate is optional. Left at 0 the booking falls back to monthly/30,
-- which is the right default for a day or two tacked onto a longer booking.
-- Set it where a short let should cost more per day than a long one — which
-- is the usual commercial reality, and cannot be derived from the monthly
-- figure.
ALTER TABLE poki_units ADD COLUMN daily_rate numeric(14,2) NOT NULL DEFAULT 0;

UPDATE poki_units SET base_rent = round(base_rent / CASE rent_cycle
  WHEN 'monthly' THEN 1
  WHEN 'quarterly' THEN 3
  WHEN 'semiannual' THEN 6
  WHEN 'annual' THEN 12
  ELSE 1                     -- one_off had no monthly rate; the figure stands
END, 2);

ALTER TABLE poki_units DROP COLUMN rent_cycle;

-- ── leases become bookings ────────────────────────────────────────────────
ALTER TABLE poki_leases RENAME TO poki_bookings;
ALTER TABLE poki_bookings RENAME COLUMN lease_no TO booking_no;
ALTER TABLE poki_bookings RENAME COLUMN rent_amount TO rent_total;

-- Duration is months + days, either of which may be zero: "6 months",
-- "5 days", or "a year and 12 days" are all the same shape.
ALTER TABLE poki_bookings ADD COLUMN duration_months integer       NOT NULL DEFAULT 0;
ALTER TABLE poki_bookings ADD COLUMN duration_days   integer       NOT NULL DEFAULT 0;
ALTER TABLE poki_bookings ADD COLUMN monthly_rate    numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE poki_bookings ADD COLUMN daily_rate      numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE poki_bookings ADD CONSTRAINT poki_bookings_duration_nonneg
  CHECK (duration_months >= 0 AND duration_days >= 0);

-- ── convert the existing leases ───────────────────────────────────────────
-- A booking of M months and D days starting on S ends on
--   S + M months + D days - 1 day
-- (inclusive), so the largest M whose month-end lands on or before the
-- recorded end date is taken, and whatever is left over becomes days. Done
-- row by row rather than in one clever UPDATE: there are four of them, and
-- being able to read the arithmetic matters more than brevity.
DO $$
DECLARE
  r          record;
  months     integer;
  rate       numeric(14,2);
  per_day    numeric(14,2);
  tail_days  integer;
  note       text := '';
BEGIN
  FOR r IN SELECT b.id, b.booking_no, b.start_date, b.end_date, b.rent_total, b.rent_cycle, u.base_rent
             FROM poki_bookings b JOIN poki_units u ON u.id = b.unit_id LOOP

    -- the old per-cycle figure, restated per month
    rate := round(r.rent_total / CASE r.rent_cycle
      WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3 WHEN 'semiannual' THEN 6
      WHEN 'annual' THEN 12 ELSE 1 END, 2);

    months := 0;
    WHILE (r.start_date + ((months + 1) || ' months')::interval - interval '1 day')::date <= r.end_date LOOP
      months := months + 1;
    END LOOP;

    tail_days := r.end_date - (r.start_date + (months || ' months')::interval - interval '1 day')::date;
    per_day := round(rate / 30.0, 2);

    UPDATE poki_bookings
       SET duration_months = months,
           duration_days   = tail_days,
           monthly_rate    = rate,
           daily_rate      = per_day,
           rent_total      = round(rate * months + per_day * tail_days, 2)
     WHERE id = r.id;

    IF tail_days > 0 THEN
      note := note || r.booking_no || ' (' || months || ' months + ' || tail_days || ' days) ';
    END IF;
  END LOOP;

  IF note <> '' THEN
    RAISE NOTICE 'Bookings with a part-day tail, priced at monthly/30 — check the total: %', note;
  END IF;
END $$;

-- Added only now that every row has a duration: the columns default to 0,
-- so this check cannot be declared before the conversion above has run.
ALTER TABLE poki_bookings ADD CONSTRAINT poki_bookings_duration_nonzero
  CHECK (duration_months > 0 OR duration_days > 0);

ALTER TABLE poki_bookings DROP COLUMN rent_cycle;
ALTER TABLE poki_bookings DROP COLUMN payment_day;     -- paid up front; no due day
ALTER TABLE poki_bookings DROP COLUMN next_invoice_on; -- nothing recurs

-- ── a unit cannot be double-booked ────────────────────────────────────────
-- The old rule was one ACTIVE lease per unit, which is too weak once units
-- are let by the day: two bookings for the same week are both perfectly
-- "active" and the rule would allow them. Overlap is the real constraint,
-- and it belongs in the database — an application check alone loses to two
-- people booking the same unit at the same moment.
DROP INDEX IF EXISTS idx_poki_leases_one_active_per_unit;

ALTER TABLE poki_bookings ADD CONSTRAINT poki_bookings_no_overlap
  EXCLUDE USING gist (
    unit_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status IN ('draft', 'active'));

ALTER INDEX idx_poki_leases_end_date      RENAME TO idx_poki_bookings_end_date;
ALTER INDEX idx_poki_leases_status        RENAME TO idx_poki_bookings_status;
ALTER INDEX idx_poki_leases_tenant        RENAME TO idx_poki_bookings_tenant;
ALTER INDEX idx_poki_leases_unit          RENAME TO idx_poki_bookings_unit;
ALTER INDEX idx_poki_leases_from_estimate RENAME TO idx_poki_bookings_from_estimate;

-- ── everything that points at a booking follows the rename ────────────────
-- invoices.poki_lease_id is how a rent invoice is tied back to what it is
-- for, and poki_maintenance_requests.lease_id is how a repair is attributed
-- to the occupant. Both keep their foreign keys; only the names change.
ALTER TABLE invoices RENAME COLUMN poki_lease_id TO poki_booking_id;
ALTER TABLE poki_maintenance_requests RENAME COLUMN lease_id TO booking_id;

-- ── expiry reminders follow the rename ────────────────────────────────────
ALTER TABLE poki_lease_reminders RENAME TO poki_booking_reminders;
ALTER TABLE poki_booking_reminders RENAME COLUMN lease_id TO booking_id;

-- ── document numbering ────────────────────────────────────────────────────
-- Keep the running sequence (so the next booking is 0005, not 0001) and
-- change only the prefix and the key. The four existing rows are renumbered
-- to match: nothing outside this table references their old numbers — no
-- invoice, no line item, and no agreement body embeds one, all checked
-- before writing this.
UPDATE poki_bookings SET booking_no = replace(booking_no, 'LSE-', 'BKG-');

UPDATE settings
   SET commercial = jsonb_set(
         commercial::jsonb #- '{numbering,lease}',
         '{numbering,booking}',
         jsonb_set(commercial::jsonb -> 'numbering' -> 'lease', '{prefix}', '"BKG"')
       )
 WHERE id = 1 AND commercial::jsonb -> 'numbering' ? 'lease';
