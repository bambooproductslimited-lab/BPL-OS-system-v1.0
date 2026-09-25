UPDATE procurement_requests SET status = 'approved' WHERE status IN ('ordered', 'received');
ALTER TABLE procurement_requests DROP CONSTRAINT procurement_requests_status_check;
ALTER TABLE procurement_requests ADD CONSTRAINT procurement_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));
ALTER TABLE procurement_requests
  DROP COLUMN received_by,
  DROP COLUMN received_at,
  DROP COLUMN ordered_by,
  DROP COLUMN ordered_at,
  DROP COLUMN actual_cost,
  DROP COLUMN supplier_name,
  DROP COLUMN supplier_id,
  DROP COLUMN decision_note;
