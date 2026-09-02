-- Kiosk clock-in/out is the only caller that ever populates these — see
-- kiosk.service.js. Stored as JSONB ({lat, lng, accuracy}) rather than
-- separate numeric columns since it's a single small, self-contained blob
-- with no need to query on individual fields.
ALTER TABLE attendance ADD COLUMN clock_in_location JSONB NULL;
ALTER TABLE attendance ADD COLUMN clock_out_location JSONB NULL;
