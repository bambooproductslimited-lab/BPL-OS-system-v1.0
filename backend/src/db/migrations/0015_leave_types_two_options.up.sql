-- The company only wants staff choosing between two leave types going
-- forward: Sick leave and Annual staff leave. Existing leave_requests and
-- leave_balances rows referencing other types (compassionate, unpaid,
-- maternity/paternity) must not be deleted — that would destroy real
-- historical records and leave_requests.leave_type_id is ON DELETE
-- RESTRICT anyway. Instead, add an `active` flag: inactive types stay in
-- the table (and any history referencing them keeps working) but are
-- filtered out of the picker shown when requesting new leave.
ALTER TABLE leave_types ADD COLUMN active boolean NOT NULL DEFAULT true;

UPDATE leave_types SET name = 'Annual staff leave' WHERE name = 'Annual leave';
UPDATE leave_types SET active = false WHERE name NOT IN ('Annual staff leave', 'Sick leave');
