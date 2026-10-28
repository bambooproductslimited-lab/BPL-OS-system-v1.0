DELETE FROM role_permissions WHERE permission_key = 'agreement.manage';
DELETE FROM permissions WHERE key = 'agreement.manage';

ALTER TABLE holidays DROP COLUMN source, DROP COLUMN estimated;

ALTER TABLE bpl_visits DROP COLUMN claim_id;
DROP TABLE warranty_claims;

DROP TABLE gate_scans;
DROP TABLE staff_cards;

DELETE FROM approvals WHERE subject_type = 'overtime';
ALTER TABLE approvals DROP CONSTRAINT approvals_subject_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_subject_type_check
  CHECK (subject_type IN ('leave_request', 'procurement_request', 'expense', 'expense_topup'));
ALTER TABLE payslips DROP COLUMN overtime_pay, DROP COLUMN overtime_hours;
DROP TABLE overtime_requests;

DROP TABLE agreement_periods;
DROP TABLE agreements;

DROP TABLE export_shipments;
ALTER TABLE products DROP COLUMN weight_kg, DROP COLUMN hs_code;
