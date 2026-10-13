-- Money an officer passed on or handed back out of their float — payroll
-- cash handed to staff, money returned to whoever gave it — is a funding
-- line below zero: it lowers the balance without counting as spending.
-- Officers' workbooks keep it this way on their funding tab.
ALTER TABLE expense_sheet_lines DROP CONSTRAINT expense_sheet_lines_check;
