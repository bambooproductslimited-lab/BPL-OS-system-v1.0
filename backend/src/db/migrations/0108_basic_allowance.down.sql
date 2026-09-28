ALTER TABLE payslips DROP COLUMN pay_basis, DROP COLUMN basic_pay, DROP COLUMN allowance_pay, DROP COLUMN monthly_basic,
  DROP COLUMN monthly_allowance, DROP COLUMN working_days, DROP COLUMN month_working_days, DROP COLUMN amounts_edited;
ALTER TABLE employees DROP COLUMN basic_salary, DROP COLUMN allowance;
