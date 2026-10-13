-- Public holidays paid on a payslip: the company's holidays on the
-- employee's working days in the period that they didn't already work.
-- They are part of days_worked (days paid); this says how many of them
-- were holidays, for the payslip to show.
ALTER TABLE payslips ADD COLUMN holidays_paid integer NOT NULL DEFAULT 0;
