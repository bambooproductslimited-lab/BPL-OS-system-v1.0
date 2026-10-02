-- Attendance feeds (attendanceFeeds.service.js): one company's clock-ins and
-- attendance, sent to an outside system as they happen (signed POSTs to its
-- address) and/or read by it with a read-only key.
--
-- attendance_changes is the order things happened in. A trigger fills it,
-- so every way attendance is written — the kiosk, TimeStation, HR's edits,
-- the automatic clock-out, merging two employees — reaches the feeds
-- without each of them having to remember to. The department is kept on
-- the change, so a deleted row (or a deleted employee's rows) can still be
-- matched to the right feed.
CREATE TABLE attendance_changes (
  seq            bigserial PRIMARY KEY,
  attendance_id  uuid NOT NULL,
  employee_id    uuid NOT NULL,
  department_id  uuid NULL,
  op             text NOT NULL CHECK (op IN ('upsert', 'delete')),
  -- For a delete: the row as it was, and who it belonged to.
  before         jsonb NULL,
  -- The moment of the write (not of its transaction's start): the feeds
  -- only read changes a little older than now, so one saved a moment
  -- later with an earlier number is never passed over.
  changed_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_attendance_changes_changed_at ON attendance_changes(changed_at);
CREATE INDEX idx_attendance_changes_department ON attendance_changes(department_id, seq);

CREATE FUNCTION attendance_feed_log() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  dep uuid;
  who jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND
     (NEW.employee_id, NEW.date, NEW.clock_in, NEW.clock_out, NEW.clock_out_date, NEW.status, NEW.source,
      NEW.shift_no, NEW.auto_clocked_out, NEW.adjusted_by)
     IS NOT DISTINCT FROM
     (OLD.employee_id, OLD.date, OLD.clock_in, OLD.clock_out, OLD.clock_out_date, OLD.status, OLD.source,
      OLD.shift_no, OLD.auto_clocked_out, OLD.adjusted_by) THEN
    RETURN NEW; -- only bookkeeping changed (e.g. a notice was seen)
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.employee_id <> OLD.employee_id) THEN
    SELECT e.department_id, jsonb_build_object('code', e.code, 'name', e.first_name || ' ' || e.last_name, 'position', e.position_title, 'department', d.name)
      INTO dep, who
      FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = OLD.employee_id;
    INSERT INTO attendance_changes (attendance_id, employee_id, department_id, op, before)
      VALUES (OLD.id, OLD.employee_id, dep, 'delete', to_jsonb(OLD) || jsonb_build_object('employee', who));
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  END IF;
  SELECT department_id INTO dep FROM employees WHERE id = NEW.employee_id;
  INSERT INTO attendance_changes (attendance_id, employee_id, department_id, op) VALUES (NEW.id, NEW.employee_id, dep, 'upsert');
  RETURN NEW;
END $$;

CREATE TRIGGER attendance_feed_log AFTER INSERT OR UPDATE OR DELETE ON attendance
  FOR EACH ROW EXECUTE FUNCTION attendance_feed_log();

CREATE TABLE attendance_feeds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  department_ids   uuid[] NOT NULL DEFAULT '{}', -- empty: the whole company
  active           boolean NOT NULL DEFAULT true,
  -- Sending: their address and the secret each POST is signed with
  -- (encrypted here; shown once when made).
  push_url         text NULL,
  signing_secret   text NOT NULL,
  cursor_seq       bigint NOT NULL DEFAULT 0, -- sent up to here
  failures         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NULL,
  failing_since    timestamptz NULL,
  last_error       text NULL,
  last_success_at  timestamptz NULL,
  -- Reading: only the key's hash is kept; the key is shown once.
  read_key_hash    text NULL UNIQUE,
  read_key_hint    text NULL,
  last_read_at     timestamptz NULL,
  reads            bigint NOT NULL DEFAULT 0,
  created_by       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attendance_feed_deliveries (
  id           bigserial PRIMARY KEY,
  feed_id      uuid NOT NULL REFERENCES attendance_feeds(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('live', 'resend', 'test')),
  at           timestamptz NOT NULL DEFAULT now(),
  events       integer NOT NULL DEFAULT 0,
  status_code  integer NULL,
  ok           boolean NOT NULL,
  error        text NULL,
  ms           integer NULL
);
CREATE INDEX idx_attendance_feed_deliveries_feed ON attendance_feed_deliveries(feed_id, id DESC);
