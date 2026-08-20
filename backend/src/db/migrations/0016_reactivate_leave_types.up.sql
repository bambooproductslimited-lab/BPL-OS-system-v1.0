-- HR wants Compassionate leave, Unpaid leave, and Maternity/paternity
-- available again alongside Annual staff leave and Sick leave. 0015
-- deactivated (not deleted) them precisely so this could be reversed
-- without losing any history tied to them.
UPDATE leave_types SET active = true;
