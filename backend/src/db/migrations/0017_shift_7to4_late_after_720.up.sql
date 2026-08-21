-- Company-wide office/day shift is 7:00 AM – 4:00 PM (Production's own
-- Shift A, 06:00-14:00, is untouched — a separate factory shift pattern),
-- and attendance now counts a clock-in as late after 7:20 AM rather than
-- 8:15 AM.
ALTER TABLE settings ALTER COLUMN late_after SET DEFAULT '07:20';
UPDATE settings SET late_after = '07:20' WHERE id = 1;

UPDATE employees SET shift = 'Day · 07:00–16:00' WHERE shift = 'Day · 08:00–17:00';
