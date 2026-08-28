ALTER TABLE pay_runs DROP CONSTRAINT pay_runs_cycle_check;
ALTER TABLE pay_runs ADD CONSTRAINT pay_runs_cycle_check CHECK (cycle IN ('monthly', 'biweekly'));

ALTER TABLE employees DROP CONSTRAINT employees_pay_cycle_check;
ALTER TABLE employees ADD CONSTRAINT employees_pay_cycle_check CHECK (pay_cycle IN ('monthly', 'biweekly'));

ALTER TABLE employees DROP COLUMN shift_start;
ALTER TABLE employees DROP COLUMN shift_end;
