-- Two-step sign-in codes by email (src/services/twoStep.service.js), next to
-- the authenticator app and text messages. The code goes to the address the
-- person signs in with, sent through the company's own mailbox
-- (src/services/mail.service.js).
ALTER TABLE users ADD COLUMN email_two_step_at timestamptz NULL;

-- The one-time codes table now holds texted and emailed codes alike.
ALTER TABLE two_step_sms_codes RENAME TO two_step_codes;
ALTER TABLE two_step_codes RENAME COLUMN phone TO sent_to;
ALTER TABLE two_step_codes ADD COLUMN channel text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'email'));
ALTER INDEX idx_two_step_sms_codes_user RENAME TO idx_two_step_codes_user;
