DROP TABLE it_device_events;
ALTER TABLE it_devices DROP COLUMN updated_at, DROP COLUMN created_at, DROP COLUMN last_checked_on, DROP COLUMN assigned_at;
