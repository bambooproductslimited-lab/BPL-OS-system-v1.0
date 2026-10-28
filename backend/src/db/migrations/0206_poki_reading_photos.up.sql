-- A photo of the meter with each utility reading (water, electricity): the
-- proof of the figure billed. { key, type, at } in the file store.
ALTER TABLE poki_meter_readings ADD COLUMN IF NOT EXISTS photo jsonb NULL;
