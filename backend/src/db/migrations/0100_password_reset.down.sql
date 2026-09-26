DELETE FROM two_step_codes WHERE purpose = 'reset';
ALTER TABLE two_step_codes DROP CONSTRAINT IF EXISTS two_step_codes_purpose_check;
ALTER TABLE two_step_codes ADD CONSTRAINT two_step_codes_purpose_check CHECK (purpose IN ('login', 'setup'));
