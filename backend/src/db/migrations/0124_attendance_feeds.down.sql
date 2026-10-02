DROP TABLE IF EXISTS attendance_feed_deliveries;
DROP TABLE IF EXISTS attendance_feeds;
DROP TRIGGER IF EXISTS attendance_feed_log ON attendance;
DROP FUNCTION IF EXISTS attendance_feed_log();
DROP TABLE IF EXISTS attendance_changes;
