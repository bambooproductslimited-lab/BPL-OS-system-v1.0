-- Two-step sign-in with an authenticator app (src/services/twoStep.service.js).
-- Optional: each person turns it on in My space.
--
-- The secret the app and the OS share is stored encrypted (AES-256-GCM, key
-- derived from JWT_SECRET), so a copy of the database alone doesn't give
-- anyone the codes. totp_last_step stops a code being used twice.
-- mfa_valid_after ends every "don't ask again on this device" at once — set
-- when two-step is turned on, off, or reset by an administrator.
ALTER TABLE users ADD COLUMN totp_secret_enc  text NULL;
ALTER TABLE users ADD COLUMN totp_pending_enc text NULL;
ALTER TABLE users ADD COLUMN totp_enabled_at  timestamptz NULL;
ALTER TABLE users ADD COLUMN totp_last_step   bigint NULL;
ALTER TABLE users ADD COLUMN mfa_valid_after  timestamptz NULL;

-- One-use codes for when the phone is lost, stored as SHA-256 hashes.
CREATE TABLE user_backup_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_backup_codes_user ON user_backup_codes (user_id) WHERE used_at IS NULL;
