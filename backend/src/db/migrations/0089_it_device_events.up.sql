-- IT devices (itDevices.service.js): when a device was handed to the person
-- who has it, when IT last checked it was there and working, and a log of
-- every handover, return, change of status and check — so a device's
-- history shows who had it before, and the page can spot devices still with
-- people who have left.
ALTER TABLE it_devices
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN last_checked_on date,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz;

CREATE TABLE it_device_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL REFERENCES it_devices(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('assign', 'return', 'status', 'check')),
  employee_id  uuid REFERENCES employees(id) ON DELETE SET NULL,
  status       text,
  condition    text,
  note         text NOT NULL DEFAULT '',
  created_by   uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_it_device_events_device ON it_device_events(device_id, created_at DESC);
