DELETE FROM role_permissions WHERE permission_key IN ('expensesheet.read.all', 'expensesheet.manage');
DELETE FROM permissions WHERE key IN ('expensesheet.read.all', 'expensesheet.manage');
DROP TABLE IF EXISTS expense_sheet_lists;
DROP TABLE IF EXISTS expense_sheet_topups;
DROP TABLE IF EXISTS expense_sheet_lines;
DROP TABLE IF EXISTS expense_sheet_checks;
DROP TABLE IF EXISTS expense_sheets;
