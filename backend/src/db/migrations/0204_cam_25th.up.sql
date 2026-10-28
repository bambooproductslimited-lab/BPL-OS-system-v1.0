-- The service charge (CAM) runs from the 25th of one month to the 25th of
-- the next, and is invoiced on the 25th for the month just ended
-- (pokiRecurring.service.js). cycle_day is that day; cycle_from the first
-- day the charge covers, so the first invoice is pro rata to the next 25th.
-- Other recurring charges keep running from their own dates (cycle_day NULL).
ALTER TABLE poki_recurring_charges
  ADD COLUMN cycle_day smallint NULL CHECK (cycle_day IS NULL OR cycle_day BETWEEN 1 AND 28),
  ADD COLUMN cycle_from date NULL;

-- CAM charges still running carry on from the first day not yet billed (their
-- old next date) to the next 25th, then 25th to 25th; next_date becomes the
-- date their next invoice is raised.
UPDATE poki_recurring_charges SET
  cycle_day = 25,
  cycle_from = next_date,
  next_date = CASE WHEN extract(day FROM next_date) < 25
    THEN make_date(extract(year FROM next_date)::int, extract(month FROM next_date)::int, 25)
    ELSE (make_date(extract(year FROM next_date)::int, extract(month FROM next_date)::int, 25) + interval '1 month')::date END,
  updated_at = now()
WHERE kind = 'cam' AND status <> 'ended';
