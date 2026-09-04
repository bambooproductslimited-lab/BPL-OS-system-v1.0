-- Face enrollment for kiosk verification. An HR/admin user (employee.write,
-- same gate as Kiosk PIN) captures the employee's face once via the browser
-- and the client-side face-api.js model reduces it to a 128-number
-- descriptor vector — no raw photo is stored, only that vector, so there is
-- no image of the employee sitting in the database. At the kiosk, after a
-- PIN match, a live capture is reduced to the same kind of descriptor and
-- compared (Euclidean distance) against the one stored here — see
-- kiosk.service.js's clock() for the comparison and threshold.
--
-- An employee with no row here simply isn't required to face-verify (the
-- PIN alone still clocks them in/out, unchanged) — this lets the feature
-- roll out gradually as HR enrolls people, instead of breaking the kiosk
-- for the whole floor on day one.
ALTER TABLE employees ADD COLUMN face_descriptor jsonb NULL;
ALTER TABLE employees ADD COLUMN face_enrolled_at timestamptz NULL;
ALTER TABLE employees ADD COLUMN face_enrolled_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
