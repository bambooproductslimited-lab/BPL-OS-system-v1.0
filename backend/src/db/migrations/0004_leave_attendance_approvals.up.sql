-- kernel.js: db.leaveTypes, db.leaveBalances, db.leaveRequests, db.approvals, db.attendance

CREATE TABLE leave_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  days_per_year  integer NOT NULL DEFAULT 0,
  paid           boolean NOT NULL DEFAULT true
);

CREATE TABLE leave_balances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year          integer NOT NULL,
  entitled      integer NOT NULL DEFAULT 0,
  used          integer NOT NULL DEFAULT 0,
  UNIQUE (employee_id, leave_type_id, year)
);

CREATE TABLE leave_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id   uuid NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
  start_date      date NOT NULL,
  end_date        date NOT NULL CHECK (end_date >= start_date),
  days            integer NOT NULL CHECK (days > 0),
  reason          text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at      timestamptz NULL,
  decision_note   text NOT NULL DEFAULT ''
);

CREATE INDEX idx_leave_requests_employee_id ON leave_requests(employee_id);
CREATE INDEX idx_leave_requests_status ON leave_requests(status);

-- Generic polymorphic approval queue: subject_type + subject_id lets one Approval
-- Centre serve leave_request | procurement_request | expense, exactly as in kernel.js.
-- No FK on subject_id since it targets different tables depending on subject_type.
CREATE TABLE approvals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type         text NOT NULL CHECK (subject_type IN ('leave_request', 'procurement_request', 'expense')),
  subject_id           uuid NOT NULL,
  title                text NOT NULL,
  requested_by         uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  assignee_permission  text NOT NULL REFERENCES permissions(key) ON DELETE RESTRICT,
  department_id        uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  decided_by           uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at           timestamptz NULL,
  comment              text NOT NULL DEFAULT ''
);

CREATE INDEX idx_approvals_subject ON approvals(subject_type, subject_id);
CREATE INDEX idx_approvals_status ON approvals(status);

CREATE TABLE attendance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date         date NOT NULL,
  clock_in     time NULL,
  clock_out    time NULL,
  status       text NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'late', 'absent', 'half_day')),
  source       text NOT NULL DEFAULT 'web',
  note         text NOT NULL DEFAULT '',
  adjusted_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  UNIQUE (employee_id, date)
);

CREATE INDEX idx_attendance_employee_id ON attendance(employee_id);
CREATE INDEX idx_attendance_date ON attendance(date);
