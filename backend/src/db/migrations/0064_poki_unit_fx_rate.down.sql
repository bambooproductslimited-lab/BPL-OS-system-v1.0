ALTER TABLE poki_units DROP CONSTRAINT IF EXISTS poki_units_fx_rate_positive;
ALTER TABLE poki_units DROP COLUMN IF EXISTS fx_rate;
