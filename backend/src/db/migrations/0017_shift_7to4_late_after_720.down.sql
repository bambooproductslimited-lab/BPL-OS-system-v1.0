ALTER TABLE settings ALTER COLUMN late_after SET DEFAULT '08:15';
UPDATE settings SET late_after = '08:15' WHERE id = 1;

UPDATE employees SET shift = 'Day · 08:00–17:00' WHERE shift = 'Day · 07:00–16:00';
