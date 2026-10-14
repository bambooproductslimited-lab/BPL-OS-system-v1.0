-- Marketing requests: the team working on one, besides the person leading
-- it (assigned_to). They see the request, can talk about it and attach
-- files, and are told as it moves.
CREATE TABLE marketing_request_members (
  request_id   uuid NOT NULL REFERENCES marketing_requests(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  added_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, employee_id)
);
CREATE INDEX idx_marketing_request_members_employee ON marketing_request_members(employee_id);
