-- Back to billing in advance from the first day not yet covered.
UPDATE poki_recurring_charges SET next_date = coalesce(
  (SELECT max(r.period_end) FROM poki_recurring_charge_runs r WHERE r.charge_id = poki_recurring_charges.id), cycle_from, next_date)
WHERE cycle_day IS NOT NULL AND status <> 'ended';
ALTER TABLE poki_recurring_charges DROP COLUMN IF EXISTS cycle_from, DROP COLUMN IF EXISTS cycle_day;
