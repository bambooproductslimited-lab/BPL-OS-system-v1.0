-- Names saved for numbers in the WhatsApp Business app on the company phone
-- (coexistence: Meta sends them as smb_app_state_sync). They can arrive
-- before the chats do, so they are kept here and used when a profile is made.
CREATE TABLE IF NOT EXISTS crm_contact_names (
  kind       text NOT NULL CHECK (kind IN ('phone')),
  value      text NOT NULL,
  name       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, value)
);
