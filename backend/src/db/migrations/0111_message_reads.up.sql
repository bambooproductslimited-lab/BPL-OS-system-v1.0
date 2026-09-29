-- When each member read each message (messages.service.js): written when a
-- chat is opened, for the messages that arrived since that member last
-- read it. Lets the sender (or a group admin) see who has seen a message
-- in a group, and when. Messages read before this existed still count as
-- seen from the member's last_read_at, just without a time.
CREATE TABLE message_reads (
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  read_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, employee_id)
);
CREATE INDEX idx_message_reads_employee ON message_reads (employee_id);
