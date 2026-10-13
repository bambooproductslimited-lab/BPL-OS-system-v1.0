DELETE FROM approvals WHERE subject_type = 'expense_topup';
ALTER TABLE approvals DROP CONSTRAINT approvals_subject_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_subject_type_check
  CHECK (subject_type IN ('leave_request', 'procurement_request', 'expense'));

UPDATE expense_sheet_lines SET source = 'os' WHERE source = 'payback';
ALTER TABLE expense_sheet_lines DROP CONSTRAINT expense_sheet_lines_source_check;
ALTER TABLE expense_sheet_lines ADD CONSTRAINT expense_sheet_lines_source_check
  CHECK (source IN ('os', 'import', 'topup'));
