DROP INDEX IF EXISTS idx_attendance_auto_unseen;
DROP INDEX IF EXISTS idx_attendance_open_shifts;
ALTER TABLE attendance DROP COLUMN auto_clock_out_seen_at;
ALTER TABLE attendance DROP COLUMN auto_clocked_out;
