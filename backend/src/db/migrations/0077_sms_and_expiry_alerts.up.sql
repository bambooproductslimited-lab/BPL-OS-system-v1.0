-- Text messages through mNotify, and alerts for things that run out.
--
-- ── text messages (src/services/sms.service.js) ─────────────────────────
-- Every text the OS sends, sent or failed, so there is a record of what was
-- said to whom and what it cost. Sign-in codes are stored masked.
CREATE TABLE sms_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_phone      text NOT NULL,
  message       text NOT NULL,
  purpose       text NOT NULL,
  ref_id        uuid NULL,
  status        text NOT NULL CHECK (status IN ('sent', 'failed')),
  error         text NULL,
  provider_ref  text NULL,
  credits_used  numeric(10,2) NULL,
  sent_by       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sms_messages_created ON sms_messages (created_at DESC);

-- Which automatic texts are on (all off until someone turns them on).
ALTER TABLE settings ADD COLUMN messaging jsonb NOT NULL DEFAULT '{}';

-- Payment reminders can now go by text too, typed by a person or sent by
-- the OS on its own.
ALTER TABLE payment_reminders DROP CONSTRAINT payment_reminders_channel_check;
ALTER TABLE payment_reminders ADD CONSTRAINT payment_reminders_channel_check CHECK (channel IN ('whatsapp', 'sms'));
ALTER TABLE payment_reminders ADD COLUMN automatic boolean NOT NULL DEFAULT false;

-- Notices to a tenant that their booking is ending.
CREATE TABLE booking_notices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES poki_bookings(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  phone       text NOT NULL,
  message     text NOT NULL,
  automatic   boolean NOT NULL DEFAULT false,
  sent_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_booking_notices_booking ON booking_notices (booking_id, sent_at DESC);

-- One automatic text per bill or booking per milestone. ref_date is part of
-- the key so a moved due date or an extended booking starts afresh.
CREATE TABLE auto_texts (
  kind       text NOT NULL,
  ref_id     uuid NOT NULL,
  milestone  text NOT NULL,
  ref_date   date NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref_id, milestone, ref_date)
);

-- ── two-step sign-in by text message (src/services/twoStep.service.js) ──
-- A second way to get the code, next to the authenticator app. The phone is
-- the one confirmed during set-up (a code was texted to it and typed back).
ALTER TABLE users ADD COLUMN two_step_phone   text NULL;
ALTER TABLE users ADD COLUMN sms_two_step_at  timestamptz NULL;

-- Codes texted for signing in or for confirming a phone: hashed, short-lived,
-- used once, and limited in how many are sent.
CREATE TABLE two_step_sms_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('login', 'setup')),
  phone       text NOT NULL,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_two_step_sms_codes_user ON two_step_sms_codes (user_id, created_at DESC);

-- ── things that expire ──────────────────────────────────────────────────
-- Company documents (licences, permits, insurance, tax clearance …) and staff
-- ID cards and passports can carry the date they run out; the OS warns
-- before it arrives (src/jobs/dailyAlerts.js).
ALTER TABLE documents ADD COLUMN expires_on date NULL;
ALTER TABLE employee_documents ADD COLUMN expires_on date NULL;

-- One alert per thing per milestone; expires_on in the key so a renewed
-- document (new date) is warned about again next time.
CREATE TABLE expiry_alerts (
  kind        text NOT NULL,
  ref_id      uuid NOT NULL,
  milestone   text NOT NULL,
  expires_on  date NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref_id, milestone, expires_on)
);
