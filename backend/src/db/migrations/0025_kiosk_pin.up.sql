-- The clock-in/out kiosk (an iPad in break rooms/factory floor, no login)
-- identifies an employee purely by a 4-digit PIN — no employee list is
-- shown on-screen, so the PIN alone must resolve to exactly one employee.
-- kiosk_pin_hash is an HMAC-SHA256(pin, server pepper) rather than a
-- bcrypt hash: a 4-digit PIN's entropy is too low for bcrypt's per-record
-- salt to meaningfully slow an offline guess anyway, and PIN-only lookup
-- needs an indexed equality match (one query, not "bcrypt.compare against
-- every employee"), which only a deterministic keyed hash allows. The
-- pepper lives in KIOSK_PIN_PEPPER (config.js), never in the database, so
-- a DB dump alone isn't enough to reverse a hash back to its PIN.
ALTER TABLE employees ADD COLUMN kiosk_pin_hash text NULL;
CREATE UNIQUE INDEX idx_employees_kiosk_pin_hash ON employees(kiosk_pin_hash) WHERE kiosk_pin_hash IS NOT NULL;
