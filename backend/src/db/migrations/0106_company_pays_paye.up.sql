-- Payroll: a company can pay its staff's PAYE itself (company policy), so
-- it isn't taken off take-home pay and counts as a cost to the company
-- instead. Each payslip keeps who paid it, so a run already approved or
-- paid never changes when the setting does.
ALTER TABLE companies ADD COLUMN pays_staff_paye boolean NOT NULL DEFAULT false;
ALTER TABLE payslips ADD COLUMN paye_by_company boolean NOT NULL DEFAULT false;
