-- "Forgot your password?" on the sign-in screen: a one-time code sent to the
-- person's email (or their phone, when email isn't set up on the server)
-- lets them choose a new password. The codes live with the two-step ones
-- (twoStep.service.js), under their own purpose.
ALTER TABLE two_step_codes DROP CONSTRAINT IF EXISTS two_step_sms_codes_purpose_check;
ALTER TABLE two_step_codes DROP CONSTRAINT IF EXISTS two_step_codes_purpose_check;
ALTER TABLE two_step_codes ADD CONSTRAINT two_step_codes_purpose_check CHECK (purpose IN ('login', 'setup', 'reset'));
