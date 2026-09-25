-- Purchase requests after the decision (procurement.service.js): the
-- approver's note, then the order (who from, what it really cost) and the
-- delivery. A requester can cancel a request still waiting for a decision.
ALTER TABLE procurement_requests
  ADD COLUMN decision_note text NOT NULL DEFAULT '',
  ADD COLUMN supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN supplier_name text NOT NULL DEFAULT '',
  ADD COLUMN actual_cost numeric(14,2),
  ADD COLUMN ordered_at timestamptz,
  ADD COLUMN ordered_by uuid REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN received_at timestamptz,
  ADD COLUMN received_by uuid REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE procurement_requests DROP CONSTRAINT procurement_requests_status_check;
ALTER TABLE procurement_requests ADD CONSTRAINT procurement_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'ordered', 'received'));
