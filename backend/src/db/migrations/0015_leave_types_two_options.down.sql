UPDATE leave_types SET name = 'Annual leave' WHERE name = 'Annual staff leave';
ALTER TABLE leave_types DROP COLUMN active;
