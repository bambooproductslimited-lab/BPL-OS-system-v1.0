-- The staff page (staffPage.service.js, frontend /staff): every employee
-- signs in on their own phone with the phone number on their record and a
-- six-digit code sent to it by text, and sees their own attendance, leave
-- and work — no OS account needed, nothing of anyone else's.

-- A code texted to a number: kept hashed, ten minutes, five tries.
CREATE TABLE staff_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,                  -- international digits, 233XXXXXXXXX
  code_hash   text NOT NULL,
  tries       integer NOT NULL DEFAULT 0,
  ip          text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz NULL
);
CREATE INDEX idx_staff_codes_phone ON staff_codes (phone, created_at DESC);

-- A phone signed in. Who it is: the employee with that number (picked
-- when two share one). It ends when the number leaves their record, they
-- leave, HR signs them out, or after 90 days.
CREATE TABLE staff_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  phone         text NOT NULL,
  employee_id   uuid NULL REFERENCES employees(id) ON DELETE CASCADE,
  ip            text NOT NULL DEFAULT '',
  user_agent    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX idx_staff_sessions_employee ON staff_sessions (employee_id);
