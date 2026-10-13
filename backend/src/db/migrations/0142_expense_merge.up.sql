-- Expense sheets (0141) become the one place for spending company money.
--
-- Float top-ups wait in the Approval centre beside leave, purchases and
-- (older) expense claims, decided by finance (expensesheet.manage). Top-ups
-- already waiting get their approval row here.
ALTER TABLE approvals DROP CONSTRAINT approvals_subject_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_subject_type_check
  CHECK (subject_type IN ('leave_request', 'procurement_request', 'expense', 'expense_topup'));

INSERT INTO approvals (subject_type, subject_id, title, requested_by, assignee_permission, department_id, status, created_at)
SELECT 'expense_topup', t.id, 'Float top-up: GHS ' || t.amount, s.employee_id, 'expensesheet.manage', e.department_id, 'pending', t.requested_at
FROM expense_sheet_topups t JOIN expense_sheets s ON s.id = t.sheet_id JOIN employees e ON e.id = s.employee_id
WHERE t.status = 'pending';

-- Paying an officer back what they spent beyond their float (or from their
-- own pocket on a sheet with no float) is money received on their sheet,
-- marked as a pay-back.
ALTER TABLE expense_sheet_lines DROP CONSTRAINT expense_sheet_lines_source_check;
ALTER TABLE expense_sheet_lines ADD CONSTRAINT expense_sheet_lines_source_check
  CHECK (source IN ('os', 'import', 'topup', 'payback'));
