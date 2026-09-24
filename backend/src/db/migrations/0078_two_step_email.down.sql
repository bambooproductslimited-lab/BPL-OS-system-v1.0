DELETE FROM two_step_codes WHERE channel = 'email';
ALTER INDEX idx_two_step_codes_user RENAME TO idx_two_step_sms_codes_user;
ALTER TABLE two_step_codes DROP COLUMN channel;
ALTER TABLE two_step_codes RENAME COLUMN sent_to TO phone;
ALTER TABLE two_step_codes RENAME TO two_step_sms_codes;
ALTER TABLE users DROP COLUMN email_two_step_at;
