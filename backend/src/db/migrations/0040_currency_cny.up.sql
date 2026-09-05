-- Add Chinese Yuan (CNY) to the enabled-currency list on the existing
-- settings row, in addition to referenceData.js's defaultCommercial()
-- (which only affects brand-new installs via seed.js/bootstrap.js).
-- Guarded so it's a no-op if CNY is already enabled or already removed
-- by an admin via Company Settings.
UPDATE settings
SET commercial = jsonb_set(
  commercial,
  '{currencies}',
  (commercial->'currencies') || '["CNY"]'::jsonb
)
WHERE id = 1
  AND NOT (commercial->'currencies' @> '["CNY"]'::jsonb);
