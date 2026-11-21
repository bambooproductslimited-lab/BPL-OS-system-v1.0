-- My Jobs (the maintenance & IT team's phone app, frontend /myjobs) signs
-- people in with their kiosk code (the 4-digit clock-in PIN), on a phone
-- that has the team code (services/myJobsAccess.service.js). The team code
-- is typed once per phone (or comes in the team's link); the work order
-- managers see it and can make a new one, which ends every sign-in made
-- with the old one. Only one code is in use at a time.
CREATE TABLE myjobs_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,                 -- 8 letters and digits, shown as ABCD-2345
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz NULL
);

-- A phone signed in with a kiosk code: only that person's own jobs, for 30
-- days, until they sign out, the team code is renewed, or their kiosk code
-- changes (pin_hash is the code it was opened with).
CREATE TABLE myjobs_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  link_id       uuid NOT NULL REFERENCES myjobs_links(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  pin_hash      text NOT NULL,
  ip            text NOT NULL DEFAULT '',
  user_agent    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX idx_myjobs_sessions_employee ON myjobs_sessions(employee_id);
