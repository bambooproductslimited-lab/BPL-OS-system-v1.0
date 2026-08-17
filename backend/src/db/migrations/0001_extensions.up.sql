-- UUID generation used as the primary key strategy for every table
-- (the prototype's short string ids like 'e_001' are kept as a human-readable
-- "code" column on employees only, where the UI actually shows it).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
