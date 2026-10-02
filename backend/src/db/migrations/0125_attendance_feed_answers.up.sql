-- What their site answered to each send (attendanceFeeds.service.js): the
-- start of its reply and its type, so a reply that is a whole web page (a
-- homepage answering "OK" instead of their receiving code) shows on the log.
ALTER TABLE attendance_feed_deliveries ADD COLUMN answer text NULL;
ALTER TABLE attendance_feed_deliveries ADD COLUMN answer_type text NULL;
