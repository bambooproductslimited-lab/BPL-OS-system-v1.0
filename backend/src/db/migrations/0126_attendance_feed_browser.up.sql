-- The one website (e.g. https://publicfigah.com) whose pages may read an
-- attendance feed straight from the browser with its read key
-- (attendanceFeeds.service.js); empty: only servers can read it.
ALTER TABLE attendance_feeds ADD COLUMN allowed_origin text NULL;
