DROP TABLE user_backup_codes;
ALTER TABLE users DROP COLUMN mfa_valid_after;
ALTER TABLE users DROP COLUMN totp_last_step;
ALTER TABLE users DROP COLUMN totp_enabled_at;
ALTER TABLE users DROP COLUMN totp_pending_enc;
ALTER TABLE users DROP COLUMN totp_secret_enc;
