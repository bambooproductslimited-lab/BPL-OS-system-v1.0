-- Money passed on becomes an expense of the same size, so balances stay
-- the same.
UPDATE expense_sheet_lines SET kind = 'expense', amount = -amount, category = 'Passed on'
  WHERE kind = 'funding' AND amount < 0;
ALTER TABLE expense_sheet_lines ADD CONSTRAINT expense_sheet_lines_check CHECK (kind = 'expense' OR amount > 0);
