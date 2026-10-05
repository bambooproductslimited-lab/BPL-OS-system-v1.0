-- The WhatsApp number connected from the OS with Meta's Embedded Signup
-- (Integrations → WhatsApp). With coexistence the number stays in the
-- WhatsApp Business app on the company phone. One row at most; when it is
-- there it is used instead of WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_ACCESS_TOKEN.
CREATE TABLE IF NOT EXISTS whatsapp_connection (
  id                    int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  waba_id               text NOT NULL,
  phone_number_id       text NOT NULL,
  display_phone         text NOT NULL DEFAULT '',
  verified_name         text NOT NULL DEFAULT '',
  access_token          text NOT NULL,
  coexistence           boolean NOT NULL DEFAULT false,
  connected_by          uuid REFERENCES employees(id) ON DELETE SET NULL,
  connected_at          timestamptz NOT NULL DEFAULT now(),
  history_requested_at  timestamptz,
  contacts_requested_at timestamptz,
  last_error            text
);
